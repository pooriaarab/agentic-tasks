import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, TasksApiError, type TasksClient } from "./client.js";
import { LOCAL_REGION, migrate, seedCredential, startWorker, stopWorker, waitForWorker } from "./worker-harness.js";

// The client against the real Worker under `wrangler dev`, with stored credentials.
const PERSIST = mkdtempSync(join(tmpdir(), "agentic-tasks-client-"));
// A port that is free now, so a stray server on a fixed port cannot answer for the Worker.
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
let ORIGIN = "";

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
    const port = await freePort();
    ORIGIN = `http://127.0.0.1:${port}`;
    server = startWorker(port, PERSIST, [...LOCAL_REGION]);
    await waitForWorker(`${ORIGIN}/api/v1/tasks`, server);
    // This Worker answers a request with no credential as 401 UNAUTHENTICATED.
    const probe = await fetch(`${ORIGIN}/api/v1/tasks/boards/x`);
    expect(probe.status).toBe(401);
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

  it("persists board rename and returns typed refusals", async () => {
    const board = await alice.createBoard({ title: "Before" });
    await alice.addColumn(board.id, "Todo");
    const before = await alice.getBoard(board.id);
    expect((await alice.renameBoard(board.id, "  After  ")).title).toBe("After");
    const renamed = await alice.getBoard(board.id);
    expect(renamed).toMatchObject({ ...before, title: "After", updatedAt: renamed.updatedAt });
    expect(Date.parse(renamed.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
    await alice.shareBoard(board.id, { kind: "human", id: "bob" }, "viewer");
    const denied = await refusal(bob.renameBoard(board.id, "Denied"));
    expect([denied.code, denied.status]).toEqual(["FORBIDDEN", 403]);
    await alice.shareBoard(board.id, { kind: "human", id: "bob" }, "commenter");
    expect((await refusal(bob.renameBoard(board.id, "Denied"))).code).toBe("FORBIDDEN");
    await alice.shareBoard(board.id, { kind: "human", id: "bob" }, "editor");
    expect((await bob.renameBoard(board.id, "Editor")).title).toBe("Editor");
    for (const title of ["", "  ", "x".repeat(201), 42 as never]) {
      const error = await refusal(alice.renameBoard(board.id, title));
      expect([error.code, error.status]).toEqual(["INVALID_INPUT", 400]);
    }
    expect((await alice.getBoard(board.id)).title).toBe("Editor");
    expect((await alice.renameBoard(board.id, " " + "x".repeat(200) + " ")).title).toHaveLength(200);
    const missing = await refusal(alice.renameBoard("missing-board", "Title"));
    expect([missing.code, missing.status]).toEqual(["NOT_FOUND", 404]);
  });

  it("shares, unshares, and erases a board", async () => {
    const board = await alice.createBoard({ title: "Shared" });
    const denied = await refusal(bob.getBoard(board.id));
    expect([denied.code, denied.status]).toEqual(["FORBIDDEN", 403]);
    await alice.shareBoard(board.id, { kind: "human", id: "bob" }, "viewer");
    expect((await bob.getBoard(board.id)).id).toBe(board.id);
    await alice.unshareBoard(board.id, { kind: "human", id: "bob" });
    expect((await refusal(bob.getBoard(board.id))).code).toBe("FORBIDDEN");
    await alice.eraseBoard(board.id);
    expect((await refusal(alice.getBoard(board.id))).code).toBe("NOT_FOUND");
  });

  it("lists access, invites, and makes and revokes a share link", async () => {
    const board = await alice.createBoard({ title: "Shared" });
    const invite = await alice.inviteToBoard(board.id, { role: "viewer", email: "ada@example.com", expiresInMs: 86_400_000 });
    expect(typeof invite.id).toBe("string");
    const link = await alice.createBoardLink(board.id, { role: "viewer", signedInOnly: true });
    expect(link.token.length).toBeGreaterThan(20);

    const access = await alice.listAccess(board.id);
    expect(access.grants).toHaveLength(1);
    expect(access.invites.map((i) => i.id)).toEqual([invite.id]);
    expect(JSON.stringify(access)).not.toContain("ada@example.com");
    expect(JSON.stringify(access)).not.toContain(link.token);
    expect(access.links).toMatchObject([{ id: link.id, role: "viewer", signedInOnly: true }]);

    expect((await refusal(bob.listAccess(board.id))).code).toBe("FORBIDDEN");
    expect((await refusal(bob.createBoardLink(board.id, { role: "viewer" }))).code).toBe("FORBIDDEN");
    expect((await refusal(alice.inviteToBoard(board.id, { role: "owner" as never, handle: "bot" }))).code).toBe("INVALID_INPUT");

    await alice.revokeBoardLink(board.id, link.id);
    expect((await alice.listAccess(board.id)).links[0]?.revokedAt).toBeTypeOf("number");
    expect((await refusal(alice.revokeBoardLink(board.id, "nope"))).code).toBe("NOT_FOUND");
  });

  it("deletes a task, lists boards, and exports the caller's data", async () => {
    const board = await alice.createBoard({ title: "Lifecycle" });
    await alice.addColumn(board.id, "Todo");
    const task = await alice.createTask({ boardId: board.id, title: "Doomed" });
    await alice.progress(task.id, "note");
    expect((await alice.listBoards()).map((b) => b.id)).toContain(board.id);
    expect((await bob.listBoards()).map((b) => b.id)).not.toContain(board.id);
    const data = await alice.exportData();
    expect(data.principal).toEqual({ id: "alice", kind: "human" });
    const entry = data.boards.find((e) => e.board.id === board.id);
    expect(entry?.role).toBe("owner");
    expect(entry?.tasks.map((t) => t.id)).toEqual([task.id]);
    expect(entry?.notes.map((n) => n.note)).toEqual(["note"]);
    expect((await refusal(bob.deleteTask(task.id))).code).toBe("FORBIDDEN");
    await alice.deleteTask(task.id);
    expect((await refusal(alice.getTask(task.id))).code).toBe("NOT_FOUND");
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

  it("never follows a redirect, and fails a 3xx or an opaque redirect as UNKNOWN", async () => {
    let init: RequestInit | undefined;
    const client = fake(async (_input, i) => {
      init = i;
      return new Response(null, { status: 307, headers: { location: "https://elsewhere.example.com/" } });
    });
    const error = await client.claim("t1").then(() => undefined, (e: unknown) => e as TasksApiError);
    expect(init?.redirect).toBe("manual");
    expect(error?.code).toBe("UNKNOWN");
    expect(error?.status).toBe(307);
    const opaque = { ok: false, status: 0, text: async () => "" } as unknown as Response;
    const blocked = await fake(async () => opaque).claim("t1").then(() => undefined, (e: unknown) => e as TasksApiError);
    expect(blocked?.code).toBe("UNKNOWN");
    expect(blocked?.status).toBe(0);
  });

  it("rejects when the signal aborts while the request is in flight", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const controller = new AbortController();
    const pending = fake(hanging).getTask("t1", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps Node and runtime imports out of the client bundle", async () => {
    const out = mkdtempSync(join(tmpdir(), "agentic-tasks-bundle-"));
    try {
      await build({ entry: { client: "src/client.ts" }, outDir: out, format: ["esm"], dts: false, silent: true, config: false });
      const built = readFileSync(join(out, "client.js"), "utf8");
      expect(built).not.toMatch(/^\s*import\s/m);
      expect(built).not.toContain("node:");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("refuses an id that the URL parser would turn into another route", async () => {
    let sent = 0;
    const client = fake(async () => {
      sent += 1;
      return new Response("{}");
    });
    const calls = [
      (id: string) => client.getBoard(id),
      (id: string) => client.renameBoard(id, "Title"),
      (id: string) => client.eraseBoard(id),
      (id: string) => client.listAccess(id),
      (id: string) => client.revokeBoardLink("b", id),
      (id: string) => client.unshareBoard("b", { kind: "human", id }),
      (id: string) => client.unshareBoard(id, { kind: "human", id: "x" }),
      (id: string) => client.getTask(id),
      (id: string) => client.claim(id),
      (id: string) => client.closeTask(id),
      (id: string) => client.progress(id, "n"),
    ];
    for (const id of ["", ".", "..", "%2e%2E", "%2E"]) {
      for (const run of calls) await expect(run(id)).rejects.toBeInstanceOf(TypeError);
    }
    expect(sent).toBe(0);
  });

  it("refuses to build without a token", () => {
    expect(() => createClient({ baseUrl: "https://x", token: "" })).toThrow(TypeError);
  });
});
