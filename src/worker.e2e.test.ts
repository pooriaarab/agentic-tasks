import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Starts the real Worker with `wrangler dev`. ci:local installs wrangler first.
const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}/api/v1/tasks`;
const ALICE = { "x-principal-id": "alice", "x-principal-kind": "human" };
const BOT = { "x-principal-id": "bot-1", "x-principal-kind": "agent_of_human" };

interface Reply {
  status: number;
  body: unknown;
}

async function call(
  method: string,
  path: string,
  headers: Record<string, string> = {},
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

// A fresh board, column, and task for each case. The Worker keeps state per instance.
async function openTask(): Promise<{ boardId: string; columnId: string; taskId: string }> {
  const board = (await call("POST", "/boards", ALICE, { title: "Sprint" })).body as {
    id: string;
  };
  const withColumn = (
    await call("POST", `/boards/${board.id}/columns`, ALICE, { name: "Todo" })
  ).body as { columns: { id: string }[] };
  const columnId = withColumn.columns[0]!.id;
  const task = (
    await call("POST", "/tasks", ALICE, { boardId: board.id, title: "Write spec" })
  ).body as { id: string };
  return { boardId: board.id, columnId, taskId: task.id };
}

describe("agentic-tasks Worker over wrangler dev", () => {
  let server: ChildProcess;

  beforeAll(async () => {
    server = spawn(process.execPath, [WRANGLER, "dev", "--ip", "127.0.0.1", "--port", String(PORT)], {
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
      stdio: "ignore",
    });
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        await fetch(`${BASE}/boards/not-there`);
        return;
      } catch {
        if (Date.now() > deadline) throw new Error("wrangler dev did not start in time");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }, 120_000);

  afterAll(async () => {
    server.kill("SIGTERM");
  });

  it("answers 404 for a route that does not exist", async () => {
    const reply = await call("GET", "/nope");
    expect(reply.status).toBe(404);
  });

  it("refuses a write without principal headers with 400 INVALID_INPUT", async () => {
    const reply = await call("POST", "/boards", {}, { title: "Sprint" });
    expect(reply.status).toBe(400);
    expect(errorCodeOf(reply)).toBe("INVALID_INPUT");
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
