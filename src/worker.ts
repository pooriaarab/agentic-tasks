import { Hono, type Context } from "hono";
import { TaskError, type TaskErrorCode, type TaskStatus } from "./model.js";
import {
  createStoreAuth,
  parseRegion,
  type Auth,
  type PrincipalContext,
  type Region,
  type Role,
  type Store,
  type Subject,
} from "agentic-identity";
import { trustedContext } from "./principal.js";
import { createD1Store, type D1Like } from "agentic-identity/cloudflare";
import { createTasks, type Tasks } from "./tasks.js";

const STATUS_BY_CODE: Record<TaskErrorCode, 400 | 403 | 404 | 409> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  INVALID_INPUT: 400,
  CLAIM_HELD: 409,
  NOT_HOLDER: 403,
  TASK_CLOSED: 409,
};

const LOOPBACK_CLIENTS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The local-only test `Auth`. It reads the principal from headers, and nothing
// checks them, so it serves only a request that names a loopback host and a
// loopback client address. wrangler dev sets that address, and the Cloudflare
// edge sets a real one. Both are headers, not the socket: a caller that can
// reach a dev server bound to a non-loopback address can forge them. Keep
// wrangler dev on its default loopback address. Any other request gets no
// principal.
export const localTestAuth: Auth = {
  async authenticate(request) {
    if (!isLoopbackRequest(request)) return null;
    const id = request.headers.get("x-principal-id");
    const kind = request.headers.get("x-principal-kind");
    return id && kind ? trustedContext(id, kind) : null;
  },
};

export function isLoopbackRequest(request: Request): boolean {
  const client = request.headers.get("cf-connecting-ip");
  if (client === null || !LOOPBACK_CLIENTS.has(client)) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(request.url).hostname);
  } catch {
    return false;
  }
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
  // Local dev and tests only. Swaps the stored credentials for principal headers,
  // and only for requests on a loopback host and client address. Never set it in production.
  TASKS_UNSAFE_LOCAL_TEST_AUTH?: string;
  // The D1 database. Create it in the EU: wrangler d1 create <name> --location weur
  DB?: D1Like;
  // Where the database lives. It is a claim that the operator makes: "eu" or "us".
  TASKS_REGION?: string;
  // Local dev only. Lets TASKS_REGION be "unknown". Local D1 reports no served
  // region, so the store cannot check a claim there. Never set it in production.
  TASKS_UNSAFE_LOCAL_REGION?: string;
}

// The region has no default, and "unknown" is not a place. A Worker with no
// valid region claim refuses to serve. The one exception
// is local dev with TASKS_UNSAFE_LOCAL_REGION=1.
function regionOf(env: Bindings): Region | undefined {
  try {
    const region = parseRegion(env.TASKS_REGION);
    if (region === "unknown") return env.TASKS_UNSAFE_LOCAL_REGION === "1" ? region : undefined;
    return region;
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
const cache = new WeakMap<D1Like, { region: Region; store: Store; tasks: Tasks }>();

function onD1(env: Bindings) {
  const db = env.DB as D1Like;
  const region = regionOf(env) as Region;
  const cached = cache.get(db);
  if (cached?.region === region) return cached;
  const store = createD1Store(db, { region });
  const entry = { region, store, tasks: createTasks({ store }) };
  cache.set(db, entry);
  return entry;
}

export const tasksOnD1: Resolve = (env) => onD1(env).tasks;

// Credentials live in the same D1 store as the tasks, so they last across
// restarts and every instance sees a revoke. The identity Worker issues them.
export const authOnD1 = (env: Bindings): Auth => createStoreAuth(onD1(env).store);

// With no `auth`, the Worker reads the credential from the D1 store. With an
// `auth`, that one decides instead. TASKS_UNSAFE_LOCAL_TEST_AUTH=1 swaps in
// `localTestAuth`, which refuses any request that is not on loopback.
export function createApp(resolve: Resolve, auth?: Auth | ((env: Bindings) => Auth)) {
  const api = new Hono<{ Bindings: Bindings; Variables: { ctx: PrincipalContext } }>().basePath(
    "/api/v1/tasks",
  );
  // Open on purpose: it names no data and checks no store.
  api.get("/health", (c) => c.json({ ok: true }));

  api.use("*", async (c, next) => {
    if (c.env.DB === undefined) {
      return c.json(notConfigured("STORE_NOT_CONFIGURED", "Bind a D1 database as DB."), 503);
    }
    if (regionOf(c.env) === undefined) {
      return c.json(
        notConfigured("REGION_NOT_CONFIGURED", "Set TASKS_REGION to eu or us. It names where the database lives."),
        503,
      );
    }
    // A Worker reads its env per request, not at import time.
    const local = auth === undefined && c.env.TASKS_UNSAFE_LOCAL_TEST_AUTH === "1";
    if (local && !isLoopbackRequest(c.req.raw)) {
      return c.json(
        { error: { code: "LOCAL_TEST_AUTH_NOT_LOOPBACK", message: "Test auth serves only loopback requests." } },
        403,
      );
    }
    const chosen = local ? localTestAuth : typeof auth === "function" ? auth(c.env) : (auth ?? authOnD1(c.env));
    const ctx = await chosen.authenticate(c.req.raw);
    if (ctx === null) {
      return c.json(
        { error: { code: "UNAUTHENTICATED", message: "Send a valid credential." } },
        401,
      );
    }
    c.set("ctx", ctx);
    await next();
  });

  const tasksOf = (c: Context): Tasks => resolve(c.env as Bindings);
  const ctxOf = (c: Context): PrincipalContext => c.get("ctx");

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
    return c.json(await tasksOf(c).createBoard({ title: body.title ?? "" }, ctxOf(c)), 201);
  });

  api.get("/boards", async (c) => c.json(await tasksOf(c).listBoards(ctxOf(c))));

  api.get("/export", async (c) => c.json(await tasksOf(c).exportData(ctxOf(c))));

  api.get("/boards/:boardId", async (c) =>
    c.json(await tasksOf(c).getBoard(c.req.param("boardId"), ctxOf(c))),
  );

  api.post("/boards/:boardId/columns", async (c) => {
    const body = await jsonBody<{ name?: string }>(c);
    return c.json(
      await tasksOf(c).addColumn(c.req.param("boardId"), body.name ?? "", ctxOf(c)),
      201,
    );
  });

  api.put("/boards/:boardId/members/:kind/:subjectId", async (c) => {
    const body = await jsonBody<{ role?: Role }>(c);
    await tasksOf(c).shareBoard(
      c.req.param("boardId"),
      { kind: c.req.param("kind") as Subject["kind"], id: c.req.param("subjectId") },
      body.role as Role,
      ctxOf(c),
    );
    return c.json({ shared: true });
  });

  api.delete("/boards/:boardId/members/:kind/:subjectId", async (c) => {
    await tasksOf(c).unshareBoard(
      c.req.param("boardId"),
      { kind: c.req.param("kind") as Subject["kind"], id: c.req.param("subjectId") },
      ctxOf(c),
    );
    return c.json({ unshared: true });
  });

  api.delete("/boards/:boardId", async (c) => {
    await tasksOf(c).eraseBoard(c.req.param("boardId"), ctxOf(c));
    return c.json({ erased: true });
  });

  api.post("/tasks", async (c) => {
    const body = await jsonBody<Parameters<Tasks["createTask"]>[0]>(c);
    return c.json(await tasksOf(c).createTask(body, ctxOf(c)), 201);
  });

  api.get("/tasks", async (c) => {
    const status = c.req.query("status");
    if (status !== undefined && status !== "open" && status !== "closed") {
      throw new TaskError("INVALID_INPUT", "status must be open or closed");
    }
    return c.json(
      await tasksOf(c).listTasks(
        {
          boardId: c.req.query("boardId") as string,
          columnId: c.req.query("columnId"),
          status: status as TaskStatus | undefined,
        },
        ctxOf(c),
      ),
    );
  });

  api.delete("/tasks/:taskId", async (c) => {
    await tasksOf(c).deleteTask(c.req.param("taskId"), ctxOf(c));
    return c.json({ deleted: true });
  });

  api.get("/tasks/:taskId", async (c) => c.json(await tasksOf(c).getTask(c.req.param("taskId"), ctxOf(c))));

  api.patch("/tasks/:taskId", async (c) => {
    const body = await jsonBody<Parameters<Tasks["updateTask"]>[1]>(c);
    return c.json(await tasksOf(c).updateTask(c.req.param("taskId"), body, ctxOf(c)));
  });

  api.post("/tasks/:taskId/move", async (c) => {
    const body = await jsonBody<Parameters<Tasks["moveTask"]>[1]>(c);
    return c.json(await tasksOf(c).moveTask(c.req.param("taskId"), body, ctxOf(c)));
  });

  api.post("/tasks/:taskId/claim", async (c) => {
    const body = await jsonBody<{ ttlMs?: number }>(c);
    return c.json(await tasksOf(c).claim(c.req.param("taskId"), ctxOf(c), body));
  });

  api.post("/tasks/:taskId/release", async (c) =>
    c.json(await tasksOf(c).release(c.req.param("taskId"), ctxOf(c))),
  );

  api.post("/tasks/:taskId/close", async (c) =>
    c.json(await tasksOf(c).closeTask(c.req.param("taskId"), ctxOf(c))),
  );

  api.post("/tasks/:taskId/progress", async (c) => {
    const body = await jsonBody<{ note?: string }>(c);
    return c.json(
      await tasksOf(c).progress(c.req.param("taskId"), body.note ?? "", ctxOf(c)),
      201,
    );
  });

  api.get("/tasks/:taskId/progress", async (c) =>
    c.json(await tasksOf(c).listProgress(c.req.param("taskId"), ctxOf(c))),
  );

  return api;
}

export default createApp(tasksOnD1);
