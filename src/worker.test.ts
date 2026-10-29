import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryAuth, createMemoryStore, type PrincipalContext } from "agentic-identity";
import { D1_SCHEMA } from "agentic-identity/cloudflare";
import { TaskError } from "./model.js";
import { createApp, tasksOnD1 } from "./worker.js";
import { createTasks, type Tasks } from "./tasks.js";

// Failure list, written before the code. A store error that did not apply a write
// must answer a retryable 503. One that may have applied it must not.
//  1. Each busy text from local sqlite, the adapter, and production D1 gives 503 STORE_BUSY with retry-after.
//  2. "Network connection lost" may have applied the write, so it stays 500.
//  3. A TaskError keeps its own status, and an unknown error stays 500.
//  4. With an Auth port, a request needs a credential that it resolves. The header
//     trust flag plays no part, and the headers are ignored.
//  4b. Local test auth serves a loopback request only. A real host, or a request
//      that carries cf-connecting-ip, gets 403 and never reaches the task code.
//  5. The migration holds the adapter schema, so the two cannot drift apart.
const ENV = { TASKS_UNSAFE_LOCAL_TEST_AUTH: "1", DB: {}, TASKS_REGION: "eu" };

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

describe("local test auth", () => {
  const WHO = { "x-principal-id": "alice", "x-principal-kind": "human" };
  const app = createApp(() => ({ getBoard: async () => ({ id: "b" }) }) as unknown as Tasks);
  const get = async (url: string, headers: Record<string, string> = WHO) =>
    (await app.request(url, { headers }, ENV)).status;

  it.each(["http://localhost/", "http://127.0.0.1:8787/", "http://[::1]:8787/"])("serves %s", async (origin) => {
    expect(await get(`${origin}api/v1/tasks/boards/b`)).toBe(200);
  });

  it.each(["https://tasks.example.com/", "http://10.0.0.5/", "http://localhost.example.com/"])(
    "refuses %s with 403",
    async (origin) => {
      expect(await get(`${origin}api/v1/tasks/boards/b`)).toBe(403);
    },
  );

  it("refuses a request that came through the edge, even on a loopback host", async () => {
    expect(await get("http://localhost/api/v1/tasks/boards/b", { ...WHO, "cf-connecting-ip": "203.0.113.9" })).toBe(403);
  });

  it("serves wrangler dev, which names a loopback client", async () => {
    expect(await get("http://localhost/api/v1/tasks/boards/b", { ...WHO, "cf-connecting-ip": "127.0.0.1" })).toBe(200);
  });

  it("is off unless the flag is exactly 1", async () => {
    const off = await app.request("/api/v1/tasks/boards/b", { headers: WHO }, { ...ENV, TASKS_UNSAFE_LOCAL_TEST_AUTH: "true" });
    expect(off.status).not.toBe(200);
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

// Failure list for the region claim, written before the code:
//  6. "eu" and "us" serve with or without the local flag.
//  7. "unknown" without the local flag answers 503 REGION_NOT_CONFIGURED.
//  8. "unknown" with the flag set to anything but "1" answers 503.
//  9. A missing or unknown region answers 503, even with the flag set.
// 10. "eu" with the flag still runs the store's served-region check.
describe("region claim", () => {
  const member: PrincipalContext = {
    principalId: "alice",
    kind: "human",
    chain: [{ id: "alice", kind: "human" }],
    scopes: ["board:admin"],
  };

  async function statusWith(vars: Record<string, string>) {
    const { auth, issue } = createMemoryAuth();
    const tasks = createTasks({ store: createMemoryStore({ region: "unknown" }) });
    const app = createApp(() => tasks, auth);
    const token = await issue(member);
    const response = await app.request(
      "/api/v1/tasks/boards/none",
      { headers: { authorization: `Bearer ${token}` } },
      { DB: {}, ...vars },
    );
    return response.status;
  }

  it.each([
    [{ TASKS_REGION: "eu" }, 404],
    [{ TASKS_REGION: "us" }, 404],
    [{ TASKS_REGION: "eu", TASKS_UNSAFE_LOCAL_REGION: "1" }, 404],
    [{ TASKS_REGION: "unknown", TASKS_UNSAFE_LOCAL_REGION: "1" }, 404],
    [{ TASKS_REGION: "unknown" }, 503],
    [{ TASKS_REGION: "unknown", TASKS_UNSAFE_LOCAL_REGION: "true" }, 503],
    [{ TASKS_REGION: "unknown", TASKS_UNSAFE_LOCAL_REGION: "yes" }, 503],
    [{ TASKS_REGION: "unknown", TASKS_UNSAFE_LOCAL_REGION: "1 " }, 503],
    [{ TASKS_REGION: "unknown", TASKS_UNSAFE_LOCAL_REGION: "" }, 503],
    [{ TASKS_UNSAFE_LOCAL_REGION: "1" }, 503],
    [{ TASKS_REGION: "moon", TASKS_UNSAFE_LOCAL_REGION: "1" }, 503],
  ])("for %j answers %i", async (vars, status) => {
    expect(await statusWith(vars)).toBe(status);
  });

  it("keeps the served-region check for eu, even with the local flag", async () => {
    // A D1 that reports no served region, as local D1 does.
    const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [], meta: {} }) }) }) };
    const tasks = tasksOnD1({ DB: db, TASKS_REGION: "eu", TASKS_UNSAFE_LOCAL_REGION: "1" } as never);
    await expect(tasks.getBoard("b", member)).rejects.toThrow("did not report where it served");
  });

  it("skips the served-region check for unknown with the local flag", async () => {
    const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [], meta: {} }) }) }) };
    const tasks = tasksOnD1({ DB: db, TASKS_REGION: "unknown", TASKS_UNSAFE_LOCAL_REGION: "1" } as never);
    await expect(tasks.getBoard("b", member)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
