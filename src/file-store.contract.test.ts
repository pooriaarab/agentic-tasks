import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { runStoreContract } from "agentic-identity/testing";
import { createFileStore } from "./file-store.js";

// The shared Store contract, run against the file adapter. Stores made with the
// same `shared` name open the same file, as two CLI processes on one board do.
const dir = mkdtempSync(join(tmpdir(), "agentic-tasks-contract-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

runStoreContract((options) =>
  createFileStore(join(dir, `${options.shared ?? randomUUID()}.json`), options),
);
