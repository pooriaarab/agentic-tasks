import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, TasksApiError, type TasksClient } from "./client.js";
import { LOCAL_REGION, migrate, seedCredential, startWorker, stopWorker, waitForWorker } from "./worker-harness.js";

// The client against the real Worker under `wrangler dev`, with stored credentials.
const PERSIST = mkdtempSync(join(tmpdir(), "agentic-tasks-client-"));
const PORT = 18791;
const ORIGIN = `http://127.0.0.1:${PORT}`;

async function refusal(promise: Promise<unknown>): Promise<TasksApiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TasksApiError);
  return error as TasksApiError;
}

describe("createClient against the Worker", () => {
  let server: ChildProcess;
  let alice: TasksClient;
  let bob: TasksClient;

  beforeAll(async () => {
    migrate(PERSIST);
    const aliceToken = await seedCredential(PERSIST, "alice");
    const bobToken = await seedCredential(PERSIST, "bob");
    server = startWorker(PORT, PERSIST, [...LOCAL_REGION]);
    await waitForWorker(`${ORIGIN}/api/v1/tasks`, server);
    alice = createClient({ baseUrl: ORIGIN, token: aliceToken });
    bob = createClient({ baseUrl: `${ORIGIN}/`, token: bobToken });
  }, 180_000);

  afterAll(async () => {
    await stopWorker(server);
    rmSync(PERSIST, { recursive: true, force: true });
  });

  it("walks a task through every route", async () => {
    const board = await alice.createBoard({ title: "Sprint" });
    expect(board.createdBy).toEqual({ id: "alice", kind: "human" });
    const withColumn = await alice.addColumn(board.id, "Todo");
    const done = (await alice.addColumn(board.id, "Done")).columns[1]!.id;
    const todo = withColumn.columns[0]!.id;
    expect((await alice.getBoard(board.id)).columns).toHaveLength(2);

    const task = await alice.createTask({ boardId: board.id, title: "Write spec", labels: ["docs"] });
    expect((await alice.getTask(task.id)).title).toBe("Write spec");
    expect((await alice.updateTask(task.id, { description: "Draft it" })).description).toBe("Draft it");
    expect((await alice.moveTask(task.id, { columnId: done })).columnId).toBe(done);
    expect((await alice.listTasks({ boardId: board.id, columnId: done, status: "open" })).map((t) => t.id)).toEqual([task.id]);
    expect(await alice.listTasks({ boardId: board.id, columnId: todo })).toEqual([]);

    const claimed = await alice.claim(task.id, { ttlMs: 600_000 });
    expect(claimed.claim?.holder.id).toBe("alice");
    expect((await alice.release(task.id)).claim).toBeUndefined();
    const note = await alice.progress(task.id, "Halfway");
    expect(note.seq).toBe(1);
    expect((await alice.listProgress(task.id)).map((n) => n.note)).toEqual(["Halfway"]);
    expect((await alice.closeTask(task.id)).status).toBe("closed");
  });

  it("shares, unshares, and erases a board", async () => {
    const board = await alice.createBoard({ title: "Shared" });
    await refusal(bob.getBoard(board.id));
    await alice.shareBoard(board.id, { kind: "human", id: "bob" }, "viewer");
    expect((await bob.getBoard(board.id)).id).toBe(board.id);
    await alice.unshareBoard(board.id, { kind: "human", id: "bob" });
    expect((await refusal(bob.getBoard(board.id))).code).toBe("FORBIDDEN");
    await alice.eraseBoard(board.id);
    expect((await refusal(alice.getBoard(board.id))).code).toBe("NOT_FOUND");
  });

  it("throws UNAUTHENTICATED with status 401 for a credential that is not stored", async () => {
    const stranger = createClient({ baseUrl: ORIGIN, token: "aid_not-stored" });
    const error = await refusal(stranger.createBoard({ title: "Nope" }));
    expect(error.code).toBe("UNAUTHENTICATED");
    expect(error.status).toBe(401);
  });

  it("throws NOT_FOUND with status 404 for a task that does not exist", async () => {
    const error = await refusal(alice.getTask("task-not-there"));
    expect(error.code).toBe("NOT_FOUND");
    expect(error.status).toBe(404);
  });

  it("throws CLAIM_HELD with status 409 for a second claim", async () => {
    const board = await alice.createBoard({ title: "Claims" });
    await alice.addColumn(board.id, "Todo");
    await alice.shareBoard(board.id, { kind: "human", id: "bob" }, "editor");
    const task = await alice.createTask({ boardId: board.id, title: "One" });
    await alice.claim(task.id, { ttlMs: 600_000 });
    const error = await refusal(bob.claim(task.id, { ttlMs: 600_000 }));
    expect(error.code).toBe("CLAIM_HELD");
    expect(error.status).toBe(409);
  });

  it("rejects with an abort error when the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(alice.getBoard("x", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("createClient requests", () => {
  it("sends each call once, with no retry, even on a 503", async () => {
    let calls = 0;
    const client = createClient({
      baseUrl: "https://tasks.example.com",
      token: "t",
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { code: "STORE_BUSY", message: "busy" } }), { status: 503 });
      },
    });
    const error = await client.claim("t1").then(() => undefined, (e: unknown) => e as TasksApiError);
    expect(error?.code).toBe("STORE_BUSY");
    expect(error?.status).toBe(503);
    expect(calls).toBe(1);
  });

  it("reports a reply that is not an API error as UNKNOWN with its status", async () => {
    const client = createClient({
      baseUrl: "https://tasks.example.com",
      token: "t",
      fetch: async () => new Response("<html>bad gateway</html>", { status: 502 }),
    });
    const error = await client.getTask("t1").then(() => undefined, (e: unknown) => e as TasksApiError);
    expect(error?.code).toBe("UNKNOWN");
    expect(error?.status).toBe(502);
  });

  const reply = (status: number, body: string) => async () => new Response(body, { status });
  const fake = (f: typeof fetch) => createClient({ baseUrl: "https://tasks.example.com", token: "t", fetch: f });

  it("fails a 200 reply that has the wrong shape, so a claim is never assumed", async () => {
    for (const body of ["null", '{"ok":true}', "[]", '{"error":{"code":"NOT_FOUND"}}', "not json", ""]) {
      const error = await fake(reply(200, body)).claim("t1").then(() => undefined, (e: unknown) => e as TasksApiError);
      expect(error).toBeInstanceOf(TasksApiError);
      expect(error?.code).toBe("UNKNOWN");
    }
    const unshared = await fake(reply(200, "{}")).unshareBoard("b", { kind: "human", id: "x" }).then(() => undefined, (e: unknown) => e);
    expect(unshared).toBeInstanceOf(TasksApiError);
    await expect(fake(reply(200, '{"unshared":true}')).unshareBoard("b", { kind: "human", id: "x" })).resolves.toBeUndefined();
  });

  it("maps an error code that it does not know to UNKNOWN", async () => {
    const body = JSON.stringify({ error: { code: "RATE_LIMITED", message: "slow down" } });
    const error = await fake(reply(429, body)).getTask("t1").then(() => undefined, (e: unknown) => e as TasksApiError);
    expect(error?.code).toBe("UNKNOWN");
    expect(error?.status).toBe(429);
  });

  it("calls a custom fetch as a plain function", async () => {
    const holder = {
      marker: 1,
      fetch(this: unknown) {
        return Promise.resolve(new Response('{"unshared":true}'));
      },
    };
    await expect(fake(holder.fetch).unshareBoard("b", { kind: "human", id: "x" })).resolves.toBeUndefined();
  });

  it("refuses a baseUrl that is not absolute or has a query or hash", () => {
    for (const baseUrl of ["tasks.example.com", "mailto:a@b", "ftp://h", "https://h/?x=1", "https://h/#a", "https://u:p@h"]) {
      expect(() => createClient({ baseUrl, token: "t" })).toThrow(TypeError);
    }
  });

  it("fails a task whose status is not open or closed", async () => {
    const task = { id: "t1", boardId: "b", status: "weird" };
    const error = await fake(reply(200, JSON.stringify(task))).getTask("t1").then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(TasksApiError);
  });

  it("does not follow a redirect", async () => {
    let init: RequestInit | undefined;
    const client = fake(async (_input, i) => {
      init = i;
      return new Response('{"id":"b","columns":[]}');
    });
    await client.getBoard("b");
    expect(init?.redirect).toBe("error");
  });

  // Reads the file that tsup writes. ci:local builds before it tests.
  it("keeps Node and runtime imports out of the built client", () => {
    const built = readFileSync(new URL("../dist/client.js", import.meta.url), "utf8");
    expect(built).not.toMatch(/^\s*import\s/m);
    expect(built).not.toContain("node:");
  });

  it("refuses to build without a token", () => {
    expect(() => createClient({ baseUrl: "https://x", token: "" })).toThrow(TypeError);
  });
});
