import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryAuth, createMemoryStore, type PrincipalContext } from "agentic-identity";
import { D1_SCHEMA } from "agentic-identity/cloudflare";
import { TaskError } from "./model.js";
import { createApp } from "./worker.js";
import { createTasks, type Tasks } from "./tasks.js";

// Failure list, written before the code. A store error that did not apply a write
// must answer a retryable 503. One that may have applied it must not.
//  1. Each busy text from local sqlite, the adapter, and production D1 gives 503 STORE_BUSY with retry-after.
//  2. "Network connection lost" may have applied the write, so it stays 500.
//  3. A TaskError keeps its own status, and an unknown error stays 500.
//  4. With an Auth port, a request needs a credential that it resolves. The header
//     trust flag plays no part, and the headers are ignored.
//  5. The migration holds the adapter schema, so the two cannot drift apart.
const ENV = { TASKS_UNSAFE_TRUST_HEADERS: "1", DB: {}, TASKS_REGION: "eu" };

function failingWith(error: Error) {
  const app = createApp(() => ({ getBoard: async () => Promise.reject(error) }) as unknown as Tasks);
  return app.request(
    "/api/v1/tasks/boards/b",
    { headers: { "x-principal-id": "alice", "x-principal-kind": "human" } },
    ENV,
  );
}

describe("store errors", () => {
  it.each([
    "D1_ERROR: database is locked: SQLITE_BUSY (extended: SQLITE_BUSY_SNAPSHOT)",
    "D1_ERROR: Failed to get session commit token: internal error",
    "transaction kept conflicting",
    "D1 DB is overloaded. Requests queued for too long.",
    "D1 DB is overloaded. Too many requests queued.",
  ])("answers a retryable 503 for %s", async (message) => {
    const response = await failingWith(new Error(message));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("STORE_BUSY");
  });

  it.each([new Error("Network connection lost"), new Error("boom")])(
    "answers 500 for %s",
    async (error) => {
      const response = await failingWith(error);
      expect(response.status).toBe(500);
      expect(response.headers.get("retry-after")).toBeNull();
    },
  );

  it("keeps the status of a task error", async () => {
    expect((await failingWith(new TaskError("NOT_FOUND", "x"))).status).toBe(404);
  });
});

describe("migration", () => {
  it("holds the schema that the D1 adapter needs", () => {
    const sql = readFileSync(new URL("../migrations/0001_store.sql", import.meta.url), "utf8");
    expect(sql).toContain(D1_SCHEMA);
  });
});

describe("app on an Auth port", () => {
  const owner: PrincipalContext = {
    principalId: "alice",
    kind: "human",
    chain: [{ id: "alice", kind: "human" }],
    scopes: ["board:admin"],
  };
  const NO_FLAG = { DB: {}, TASKS_REGION: "eu" };

  async function setup() {
    const { auth, issue } = createMemoryAuth();
    // One Tasks for all requests, so the board that one request makes is there for the next.
    const tasks = createTasks({ store: createMemoryStore({ region: "eu" }) });
    return { app: createApp(() => tasks, auth), token: await issue(owner) };
  }

  it("serves a request with a credential, with no trust flag set", async () => {
    const { app, token } = await setup();
    const created = await app.request(
      "/api/v1/tasks/boards",
      { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ title: "Sprint" }) },
      NO_FLAG,
    );
    expect(created.status).toBe(201);
    expect(((await created.json()) as { createdBy: unknown }).createdBy).toEqual({ id: "alice", kind: "human" });
  });

  it("answers 401 without a credential, and ignores principal headers", async () => {
    const { app } = await setup();
    const response = await app.request(
      "/api/v1/tasks/boards/x",
      { headers: { "x-principal-id": "alice", "x-principal-kind": "human" } },
      NO_FLAG,
    );
    expect(response.status).toBe(401);
  });

  it("answers 401 for a credential that is not valid", async () => {
    const { app } = await setup();
    const response = await app.request(
      "/api/v1/tasks/boards/x",
      { headers: { authorization: "Bearer not-a-real-token" } },
      NO_FLAG,
    );
    expect(response.status).toBe(401);
  });
});
