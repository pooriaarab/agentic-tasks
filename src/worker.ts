import { Hono, type Context } from "hono";
import { TaskError, type Principal, type PrincipalKind, type TaskErrorCode, type TaskStatus } from "./model.js";
import { createMemoryStore } from "./store.js";
import { createTasks, type Tasks } from "./tasks.js";

const STATUS_BY_CODE: Record<TaskErrorCode, 400 | 403 | 404 | 409> = {
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  CLAIM_HELD: 409,
  NOT_HOLDER: 403,
  TASK_CLOSED: 409,
};

// The actor comes from headers. Nothing checks these headers yet, so the
// Worker must not face the public internet until the identity port lands.
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

export function createApp(tasks: Tasks) {
  const api = new Hono().basePath("/api/v1/tasks");

  api.onError((error, c) => {
    if (error instanceof TaskError) {
      return c.json(
        { error: { code: error.code, message: error.message } },
        STATUS_BY_CODE[error.code],
      );
    }
    return c.json({ error: { code: "INTERNAL", message: "unexpected error" } }, 500);
  });

  api.post("/boards", async (c) => {
    const body = await jsonBody<{ title?: string }>(c);
    return c.json(await tasks.createBoard({ title: body.title ?? "" }, actorOf(c)), 201);
  });

  api.get("/boards/:boardId", async (c) =>
    c.json(await tasks.getBoard(c.req.param("boardId"))),
  );

  api.post("/boards/:boardId/columns", async (c) => {
    const body = await jsonBody<{ name?: string }>(c);
    return c.json(
      await tasks.addColumn(c.req.param("boardId"), body.name ?? "", actorOf(c)),
      201,
    );
  });

  api.post("/tasks", async (c) => {
    const body = await jsonBody<Parameters<Tasks["createTask"]>[0]>(c);
    return c.json(await tasks.createTask(body, actorOf(c)), 201);
  });

  api.get("/tasks", async (c) => {
    const status = c.req.query("status");
    if (status !== undefined && status !== "open" && status !== "closed") {
      throw new TaskError("INVALID_INPUT", "status must be open or closed");
    }
    return c.json(
      await tasks.listTasks({
        boardId: c.req.query("boardId"),
        columnId: c.req.query("columnId"),
        status: status as TaskStatus | undefined,
      }),
    );
  });

  api.get("/tasks/:taskId", async (c) => c.json(await tasks.getTask(c.req.param("taskId"))));

  api.patch("/tasks/:taskId", async (c) => {
    const body = await jsonBody<Parameters<Tasks["updateTask"]>[1]>(c);
    return c.json(await tasks.updateTask(c.req.param("taskId"), body, actorOf(c)));
  });

  api.post("/tasks/:taskId/move", async (c) => {
    const body = await jsonBody<Parameters<Tasks["moveTask"]>[1]>(c);
    return c.json(await tasks.moveTask(c.req.param("taskId"), body, actorOf(c)));
  });

  api.post("/tasks/:taskId/claim", async (c) => {
    const body = await jsonBody<{ ttlMs?: number }>(c);
    return c.json(await tasks.claim(c.req.param("taskId"), actorOf(c), body));
  });

  api.post("/tasks/:taskId/release", async (c) =>
    c.json(await tasks.release(c.req.param("taskId"), actorOf(c))),
  );

  api.post("/tasks/:taskId/close", async (c) =>
    c.json(await tasks.closeTask(c.req.param("taskId"), actorOf(c))),
  );

  api.post("/tasks/:taskId/progress", async (c) => {
    const body = await jsonBody<{ note?: string }>(c);
    return c.json(
      await tasks.progress(c.req.param("taskId"), body.note ?? "", actorOf(c)),
      201,
    );
  });

  api.get("/tasks/:taskId/progress", async (c) =>
    c.json(await tasks.listProgress(c.req.param("taskId"))),
  );

  return api;
}

export default createApp(createTasks({ store: createMemoryStore() }));
