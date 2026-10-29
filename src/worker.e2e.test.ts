import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_REGION, migrate, startWorker, stopWorker, waitForWorker } from "./worker-harness.js";

// The real Worker under `wrangler dev`, on a local D1 database.
const PERSIST = mkdtempSync(join(tmpdir(), "agentic-tasks-e2e-"));
beforeAll(() => migrate(PERSIST), 120_000);
afterAll(() => rmSync(PERSIST, { recursive: true, force: true }));
const PORT = 18787;
const PORT_WITHOUT_FLAG = 18788;
const BASE = `http://127.0.0.1:${PORT}/api/v1/tasks`;
const BASE_WITHOUT_FLAG = `http://127.0.0.1:${PORT_WITHOUT_FLAG}/api/v1/tasks`;
const TRUST_FLAG = ["TASKS_UNSAFE_TRUST_HEADERS:1"];
const ALICE = { "x-principal-id": "alice", "x-principal-kind": "human" };
const BOT = { "x-principal-id": "bot-1", "x-principal-kind": "agent_of_human" };

interface Reply {
  status: number;
  body: unknown;
}

async function call(
  method: string,
  path: string,
  headers: Record<string, string> = ALICE,
  body?: unknown,
): Promise<Reply> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (text === "") return { status: response.status, body: undefined };
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

function errorCodeOf(reply: Reply): string | undefined {
  return (reply.body as { error?: { code: string } } | undefined)?.error?.code;
}

// A fresh board, column, and task for each case.
async function openTask(): Promise<{ boardId: string; columnId: string; taskId: string }> {
  const board = (await call("POST", "/boards", ALICE, { title: "Sprint" })).body as {
    id: string;
  };
  const withColumn = (
    await call("POST", `/boards/${board.id}/columns`, ALICE, { name: "Todo" })
  ).body as { columns: { id: string }[] };
  const columnId = withColumn.columns[0]!.id;
  await call("PUT", `/boards/${board.id}/members/bot-1`, ALICE, { role: "editor" });
  const task = (
    await call("POST", "/tasks", ALICE, { boardId: board.id, title: "Write spec" })
  ).body as { id: string };
  return { boardId: board.id, columnId, taskId: task.id };
}

describe("agentic-tasks Worker without the trust flag", () => {
  let server: ChildProcess;

  beforeAll(async () => {
    server = startWorker(PORT_WITHOUT_FLAG, PERSIST, []);
    await waitForWorker(BASE_WITHOUT_FLAG, server);
  }, 120_000);

  afterAll(() => stopWorker(server));

  it("answers 503 to a write even when it carries principal headers", async () => {
    const response = await fetch(`${BASE_WITHOUT_FLAG}/boards`, {
      method: "POST",
      headers: { ...ALICE, "content-type": "application/json" },
      body: JSON.stringify({ title: "Sprint" }),
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "HEADER_TRUST_NOT_ENABLED",
    );
  });

  it("answers 503 to a read, so no route is open", async () => {
    const response = await fetch(`${BASE_WITHOUT_FLAG}/boards/not-there`);
    expect(response.status).toBe(503);
  });
});

describe("agentic-tasks Worker over wrangler dev", () => {
  let server: ChildProcess;

  beforeAll(async () => {
    server = startWorker(PORT, PERSIST, [...TRUST_FLAG, ...LOCAL_REGION]);
    await waitForWorker(BASE, server);
  }, 120_000);

  afterAll(() => stopWorker(server));

  it("answers 404 for a route that does not exist", async () => {
    const reply = await call("GET", "/nope");
    expect(reply.status).toBe(404);
  });

  it("refuses a request without principal headers with 401 UNAUTHENTICATED", async () => {
    for (const [method, path] of [["POST", "/boards"], ["GET", "/tasks"], ["GET", "/boards/x"]] as const) {
      const reply = await call(method, path, {}, method === "POST" ? { title: "Sprint" } : undefined);
      expect(reply.status).toBe(401);
      expect(errorCodeOf(reply)).toBe("UNAUTHENTICATED");
    }
  });

  it("refuses a principal kind that is not known with 400 INVALID_INPUT", async () => {
    const reply = await call("POST", "/boards", { "x-principal-id": "x", "x-principal-kind": "root" }, { title: "Sprint" });
    expect(reply.status).toBe(400);
    expect(errorCodeOf(reply)).toBe("INVALID_INPUT");
  });

  it("refuses a principal with no role on the board with 403 FORBIDDEN", async () => {
    const { boardId, taskId } = await openTask();
    const stranger = { "x-principal-id": "eve", "x-principal-kind": "human" };
    for (const [method, path] of [["GET", `/boards/${boardId}`], ["GET", `/tasks/${taskId}`], ["GET", `/tasks?boardId=${boardId}`]] as const) {
      const reply = await call(method, path, stranger);
      expect(reply.status).toBe(403);
      expect(errorCodeOf(reply)).toBe("FORBIDDEN");
    }
    expect((await call("POST", `/tasks/${taskId}/claim`, stranger, {})).status).toBe(403);
  });

  it("shares a board by role over HTTP and takes the role away", async () => {
    const { boardId, taskId } = await openTask();
    const carol = { "x-principal-id": "carol", "x-principal-kind": "human" };
    expect((await call("PUT", `/boards/${boardId}/members/carol`, ALICE, { role: "viewer" })).status).toBe(200);
    expect((await call("GET", `/tasks/${taskId}`, carol)).status).toBe(200);
    expect(errorCodeOf(await call("POST", `/tasks/${taskId}/claim`, carol, {}))).toBe("FORBIDDEN");
    expect((await call("DELETE", `/boards/${boardId}/members/carol`, ALICE)).status).toBe(200);
    expect((await call("GET", `/tasks/${taskId}`, carol)).status).toBe(403);
  });

  it("refuses a body that is not JSON with 400 INVALID_INPUT", async () => {
    const response = await fetch(`${BASE}/boards`, {
      method: "POST",
      headers: { ...ALICE, "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });

  it("creates a board, adds a column, and creates a task in it", async () => {
    const { boardId, columnId, taskId } = await openTask();
    const task = (await call("GET", `/tasks/${taskId}`)).body as { columnId: string; boardId: string };
    expect(task.boardId).toBe(boardId);
    expect(task.columnId).toBe(columnId);
  });

  it("refuses a second principal's claim with 409 CLAIM_HELD", async () => {
    const { taskId } = await openTask();
    expect((await call("POST", `/tasks/${taskId}/claim`, ALICE, { ttlMs: 600_000 })).status).toBe(200);
    const refused = await call("POST", `/tasks/${taskId}/claim`, BOT, { ttlMs: 600_000 });
    expect(refused.status).toBe(409);
    expect(errorCodeOf(refused)).toBe("CLAIM_HELD");
  });

  it("refuses a release by a principal that does not hold the claim with 403 NOT_HOLDER", async () => {
    const { taskId } = await openTask();
    await call("POST", `/tasks/${taskId}/claim`, ALICE, { ttlMs: 600_000 });
    const refused = await call("POST", `/tasks/${taskId}/release`, BOT);
    expect(refused.status).toBe(403);
    expect(errorCodeOf(refused)).toBe("NOT_HOLDER");
  });

  it("refuses a claim on a closed task with 409 TASK_CLOSED", async () => {
    const { taskId } = await openTask();
    expect((await call("POST", `/tasks/${taskId}/close`, ALICE)).status).toBe(200);
    const refused = await call("POST", `/tasks/${taskId}/claim`, BOT, { ttlMs: 600_000 });
    expect(refused.status).toBe(409);
    expect(errorCodeOf(refused)).toBe("TASK_CLOSED");
  });

  it("answers 404 NOT_FOUND for a task that does not exist", async () => {
    const reply = await call("GET", "/tasks/missing");
    expect(reply.status).toBe(404);
    expect(errorCodeOf(reply)).toBe("NOT_FOUND");
  });

  it("appends progress and lists it oldest first", async () => {
    const { taskId } = await openTask();
    expect((await call("POST", `/tasks/${taskId}/progress`, BOT, { note: "outline done" })).status).toBe(201);
    const reply = await call("GET", `/tasks/${taskId}/progress`);
    expect(reply.status).toBe(200);
    expect((reply.body as { note: string }[]).map((entry) => entry.note)).toEqual(["outline done"]);
  });

  it("moves a task to another column and filters the list by it", async () => {
    const { boardId, taskId } = await openTask();
    const board = (await call("POST", `/boards/${boardId}/columns`, ALICE, { name: "Done" })).body as {
      columns: { id: string }[];
    };
    const done = board.columns[1]!.id;
    expect((await call("POST", `/tasks/${taskId}/move`, ALICE, { columnId: done })).status).toBe(200);
    const listed = (await call("GET", `/tasks?boardId=${boardId}&columnId=${done}`)).body as {
      id: string;
    }[];
    expect(listed.map((task) => task.id)).toEqual([taskId]);
  });

  it("lets exactly one of two simultaneous claims through", async () => {
    const { taskId } = await openTask();
    const [first, second] = await Promise.all([
      call("POST", `/tasks/${taskId}/claim`, ALICE, { ttlMs: 600_000 }),
      call("POST", `/tasks/${taskId}/claim`, BOT, { ttlMs: 600_000 }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
  });
});
