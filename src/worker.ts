import { Hono, type Context } from "hono";
import { TaskError, type Principal, type PrincipalKind, type TaskErrorCode, type TaskStatus } from "./model.js";
import { parseRegion, type Region } from "agentic-identity";
import { createD1Store, type D1Like } from "agentic-identity/cloudflare";
import { createTasks, type Tasks } from "./tasks.js";

const STATUS_BY_CODE: Record<TaskErrorCode, 400 | 403 | 404 | 409> = {
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  CLAIM_HELD: 409,
  NOT_HOLDER: 403,
  TASK_CLOSED: 409,
};

// The actor comes from headers. Nothing checks these headers yet. Any caller
// can name any principal, so the Worker serves nothing until the operator opts in.
function actorOf(c: Context): Principal {
  return {
    id: c.req.header("x-principal-id") ?? "",
    kind: (c.req.header("x-principal-kind") ?? "") as PrincipalKind,
  };
}

// An empty body counts as {} so actions like claim need no body.
async function jsonBody<T>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (text.trim() === "") return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TaskError("INVALID_INPUT", "body must be JSON");
  }
}

interface Bindings {
  TASKS_UNSAFE_TRUST_HEADERS?: string;
  // The D1 database. Create it in the EU: wrangler d1 create <name> --location weur
  DB?: D1Like;
  // Where the database lives. It is a claim that the operator makes: "eu" or "us".
  TASKS_REGION?: string;
}

// The region has no default, and "unknown" is not a place. A Worker with no
// valid region claim refuses to serve, as the trust flag does.
function regionOf(env: Bindings): Region | undefined {
  try {
    const region = parseRegion(env.TASKS_REGION);
    return region === "unknown" ? undefined : region;
  } catch {
    return undefined;
  }
}

function notConfigured(code: string, message: string) {
  return { error: { code, message } };
}

// Errors from a write that did not apply: local sqlite, the adapter, and the
// overload text of production D1, which rejects a query before it runs.
// "Network connection lost" is left out. The write may have applied.
const TRANSIENT_STORE_ERROR =
  /SQLITE_BUSY|database is locked|session commit token|transaction kept conflicting|D1 DB is overloaded/;

type Resolve = (env: Bindings) => Tasks;

// Tasks run on the D1 binding, so every Worker instance reads and writes the one database. A claim is a Store transaction, so two
// instances cannot both take it.
// The store keeps a queue that runs one transaction at a time in this isolate, so
// one store serves every request on a binding.
const cache = new WeakMap<D1Like, { region: Region; tasks: Tasks }>();

export const tasksOnD1: Resolve = (env) => {
  const db = env.DB as D1Like;
  const region = regionOf(env) as Region;
  const cached = cache.get(db);
  if (cached?.region === region) return cached.tasks;
  const tasks = createTasks({ store: createD1Store(db, { region }) });
  cache.set(db, { region, tasks });
  return tasks;
};

export function createApp(resolve: Resolve) {
  const api = new Hono<{ Bindings: Bindings }>().basePath("/api/v1/tasks");

  // A Worker reads its env per request, not at import time, so the gate runs
  // on every request. Set TASKS_UNSAFE_TRUST_HEADERS=1 only behind a gateway.
  api.use("*", async (c, next) => {
    if (c.env?.TASKS_UNSAFE_TRUST_HEADERS !== "1") {
      return c.json(
        {
          error: {
            code: "HEADER_TRUST_NOT_ENABLED",
            message:
              "Set TASKS_UNSAFE_TRUST_HEADERS=1 to serve. Trust only holds behind a gateway that checks identity.",
          },
        },
        503,
      );
    }
    if (c.env.DB === undefined) {
      return c.json(notConfigured("STORE_NOT_CONFIGURED", "Bind a D1 database as DB."), 503);
    }
    if (regionOf(c.env) === undefined) {
      return c.json(
        notConfigured("REGION_NOT_CONFIGURED", "Set TASKS_REGION to eu or us. It names where the database lives."),
        503,
      );
    }
    await next();
  });

  const tasksOf = (c: Context): Tasks => resolve(c.env as Bindings);

  api.onError((error, c) => {
    if (error instanceof TaskError) {
      return c.json(
        { error: { code: error.code, message: error.message } },
        STATUS_BY_CODE[error.code],
      );
    }
    // D1 can refuse a write for a moment, and the store gives up after many
    // conflicts. The write did not apply, so the caller may retry.
    if (error instanceof Error && TRANSIENT_STORE_ERROR.test(error.message)) {
      c.header("retry-after", "1");
      return c.json(
        { error: { code: "STORE_BUSY", message: "The database is busy. Retry the request." } },
        503,
      );
    }
    return c.json({ error: { code: "INTERNAL", message: "unexpected error" } }, 500);
  });

  api.post("/boards", async (c) => {
    const body = await jsonBody<{ title?: string }>(c);
    return c.json(await tasksOf(c).createBoard({ title: body.title ?? "" }, actorOf(c)), 201);
  });

  api.get("/boards/:boardId", async (c) =>
    c.json(await tasksOf(c).getBoard(c.req.param("boardId"))),
  );

  api.post("/boards/:boardId/columns", async (c) => {
    const body = await jsonBody<{ name?: string }>(c);
    return c.json(
      await tasksOf(c).addColumn(c.req.param("boardId"), body.name ?? "", actorOf(c)),
      201,
    );
  });

  api.post("/tasks", async (c) => {
    const body = await jsonBody<Parameters<Tasks["createTask"]>[0]>(c);
    return c.json(await tasksOf(c).createTask(body, actorOf(c)), 201);
  });

  api.get("/tasks", async (c) => {
    const status = c.req.query("status");
    if (status !== undefined && status !== "open" && status !== "closed") {
      throw new TaskError("INVALID_INPUT", "status must be open or closed");
    }
    return c.json(
      await tasksOf(c).listTasks({
        boardId: c.req.query("boardId"),
        columnId: c.req.query("columnId"),
        status: status as TaskStatus | undefined,
      }),
    );
  });

  api.get("/tasks/:taskId", async (c) => c.json(await tasksOf(c).getTask(c.req.param("taskId"))));

  api.patch("/tasks/:taskId", async (c) => {
    const body = await jsonBody<Parameters<Tasks["updateTask"]>[1]>(c);
    return c.json(await tasksOf(c).updateTask(c.req.param("taskId"), body, actorOf(c)));
  });

  api.post("/tasks/:taskId/move", async (c) => {
    const body = await jsonBody<Parameters<Tasks["moveTask"]>[1]>(c);
    return c.json(await tasksOf(c).moveTask(c.req.param("taskId"), body, actorOf(c)));
  });

  api.post("/tasks/:taskId/claim", async (c) => {
    const body = await jsonBody<{ ttlMs?: number }>(c);
    return c.json(await tasksOf(c).claim(c.req.param("taskId"), actorOf(c), body));
  });

  api.post("/tasks/:taskId/release", async (c) =>
    c.json(await tasksOf(c).release(c.req.param("taskId"), actorOf(c))),
  );

  api.post("/tasks/:taskId/close", async (c) =>
    c.json(await tasksOf(c).closeTask(c.req.param("taskId"), actorOf(c))),
  );

  api.post("/tasks/:taskId/progress", async (c) => {
    const body = await jsonBody<{ note?: string }>(c);
    return c.json(
      await tasksOf(c).progress(c.req.param("taskId"), body.note ?? "", actorOf(c)),
      201,
    );
  });

  api.get("/tasks/:taskId/progress", async (c) =>
    c.json(await tasksOf(c).listProgress(c.req.param("taskId"))),
  );

  return api;
}

export default createApp(tasksOnD1);
