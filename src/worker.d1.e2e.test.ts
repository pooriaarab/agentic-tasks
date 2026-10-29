import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, startWorker, stopWorker, waitForWorker } from "./worker-harness.js";

// Two Worker instances, each its own `wrangler dev` process, on one local D1
// database. Failure list, written before the test:
//  1. A claim taken in one instance is refused in the other.
//  2. Claims at the same moment, sent to both instances: exactly one principal wins.
//     Local D1 is one sqlite file shared by two processes, so it can answer
//     503 STORE_BUSY. The client retries, and a retried winner renews its own claim.
//  3. After both instances restart, boards, tasks, and the claim are still there.
//  4. A Worker with no valid TASKS_REGION serves nothing, and says why.
const PORT_ONE = 18801;
const PORT_TWO = 18802;
const PORT_NO_REGION = 18803;
const base = (port: number) => `http://127.0.0.1:${port}/api/v1/tasks`;
const TRUST = "TASKS_UNSAFE_TRUST_HEADERS:1";
const ALICE = { "x-principal-id": "alice", "x-principal-kind": "human" };
const BOT = { "x-principal-id": "bot-1", "x-principal-kind": "agent_of_human" };

// A client follows the API contract: on 503 STORE_BUSY, wait and send the request again.
async function call(port: number, method: string, path: string, headers: Record<string, string>, body?: unknown) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(`${base(port)}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const reply = { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as Record<string, any>) };
    if (reply.body?.error?.code !== "STORE_BUSY" || attempt >= 20) return reply;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("two Worker instances on one D1 database", () => {
  const persist = mkdtempSync(join(tmpdir(), "agentic-tasks-d1-"));
  let one: ChildProcess;
  let two: ChildProcess;

  async function startBoth() {
    // Started one after the other: two wrangler processes that boot together
    // collide, and one dies. This holds even on different ports and directories.
    one = startWorker(PORT_ONE, persist, [TRUST]);
    await waitForWorker(base(PORT_ONE), one);
    two = startWorker(PORT_TWO, persist, [TRUST]);
    await waitForWorker(base(PORT_TWO), two);
  }

  beforeAll(async () => {
    migrate(persist);
    await startBoth();
  }, 180_000);

  afterAll(async () => {
    await Promise.all([stopWorker(one), stopWorker(two)]);
    rmSync(persist, { recursive: true, force: true });
  });

  async function openTask(): Promise<string> {
    const board = (await call(PORT_ONE, "POST", "/boards", ALICE, { title: "Sprint" })).body!;
    await call(PORT_ONE, "POST", `/boards/${board.id}/columns`, ALICE, { name: "Todo" });
    for (const bot of ["bot-1", ...Array.from({ length: 8 }, (_, i) => `bot-${i}`)]) {
      await call(PORT_ONE, "PUT", `/boards/${board.id}/members/${bot}`, ALICE, { role: "editor" });
    }
    return (await call(PORT_ONE, "POST", "/tasks", ALICE, { boardId: board.id, title: "Write spec" })).body!.id;
  }

  it("refuses in one instance a claim that the other instance took", async () => {
    const id = await openTask();
    expect((await call(PORT_ONE, "POST", `/tasks/${id}/claim`, ALICE, { ttlMs: 600_000 })).status).toBe(200);
    const refused = await call(PORT_TWO, "POST", `/tasks/${id}/claim`, BOT, { ttlMs: 600_000 });
    expect(refused.status).toBe(409);
    expect(refused.body?.error.code).toBe("CLAIM_HELD");
    expect((await call(PORT_TWO, "GET", `/tasks/${id}`, ALICE)).body?.claim.holder.id).toBe("alice");
  });

  // Five rounds, because one round can pass by luck when the guard is missing.
  it("lets exactly one of many simultaneous claims through, across both instances", async () => {
    for (let round = 0; round < 5; round += 1) {
      const id = await openTask();
      const bots = Array.from({ length: 8 }, (_, i) => ({
        "x-principal-id": `bot-${i}`,
        "x-principal-kind": "agent_of_human",
      }));
      const replies = await Promise.all(
        bots.map((who, i) => call(i % 2 === 0 ? PORT_ONE : PORT_TWO, "POST", `/tasks/${id}/claim`, who, { ttlMs: 600_000 })),
      );
      const winners = bots.filter((_, i) => replies[i]!.status === 200);
      expect(winners).toHaveLength(1);
      expect(replies.filter((r) => r.status === 409)).toHaveLength(7);
      const held = (await call(PORT_TWO, "GET", `/tasks/${id}`, ALICE)).body!;
      expect(held.claim.holder.id).toBe(winners[0]!["x-principal-id"]);
    }
  }, 120_000);

  it("keeps boards, tasks, and claims after both instances restart", async () => {
    const id = await openTask();
    await call(PORT_ONE, "POST", `/tasks/${id}/claim`, ALICE, { ttlMs: 600_000 });
    await call(PORT_TWO, "POST", `/tasks/${id}/progress`, BOT, { note: "outline done" });
    await Promise.all([stopWorker(one), stopWorker(two)]);
    await startBoth();
    const task = (await call(PORT_TWO, "GET", `/tasks/${id}`, ALICE)).body!;
    expect(task.title).toBe("Write spec");
    expect(task.claim.holder.id).toBe("alice");
    const refused = await call(PORT_ONE, "POST", `/tasks/${id}/claim`, BOT, { ttlMs: 600_000 });
    expect(refused.body?.error.code).toBe("CLAIM_HELD");
    expect((await call(PORT_ONE, "GET", `/tasks/${id}/progress`, ALICE)).body).toMatchObject([{ note: "outline done" }]);
  }, 180_000);
});

describe("a Worker with no valid region", () => {
  const persist = mkdtempSync(join(tmpdir(), "agentic-tasks-region-"));
  let server: ChildProcess;

  beforeAll(async () => {
    migrate(persist);
    server = startWorker(PORT_NO_REGION, persist, [TRUST, "TASKS_REGION:unknown"]);
    await waitForWorker(base(PORT_NO_REGION), server);
  }, 180_000);

  afterAll(async () => {
    await stopWorker(server);
    rmSync(persist, { recursive: true, force: true });
  });

  it.each(["/boards/x", "/tasks"])("answers 503 REGION_NOT_CONFIGURED on GET %s", async (path) => {
    const reply = await call(PORT_NO_REGION, "GET", path, {});
    expect(reply.status).toBe(503);
    expect(reply.body?.error.code).toBe("REGION_NOT_CONFIGURED");
  });
});
