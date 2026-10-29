import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { D1_SCHEMA } from "agentic-identity/cloudflare";
import { TaskError } from "./model.js";
import { createApp } from "./worker.js";
import type { Tasks } from "./tasks.js";

// Failure list, written before the code. A store error that did not apply a write
// must answer a retryable 503. One that may have applied it must not.
//  1. Each busy text from local sqlite, the adapter, and production D1 gives 503 STORE_BUSY with retry-after.
//  2. "Network connection lost" may have applied the write, so it stays 500.
//  3. A TaskError keeps its own status, and an unknown error stays 500.
//  4. The migration holds the adapter schema, so the two cannot drift apart.
const ENV = { TASKS_UNSAFE_TRUST_HEADERS: "1", DB: {}, TASKS_REGION: "eu" };

function failingWith(error: Error) {
  const app = createApp(() => ({ getBoard: async () => Promise.reject(error) }) as unknown as Tasks);
  return app.request("/api/v1/tasks/boards/b", {}, ENV);
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
