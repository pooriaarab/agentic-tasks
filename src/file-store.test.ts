import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileStore } from "./file-store.js";

describe("file store", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentic-tasks-file-store-"));
    file = join(dir, "tasks.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a missing parent directory on the first write", async () => {
    const nested = join(dir, "nested", "deeper", "tasks.json");
    const store = createFileStore(nested);
    await store.put("boards", "board-1", { id: "board-1" });
    expect(await store.get("boards", "board-1")).toEqual({ id: "board-1" });
    expect(JSON.parse(await readFile(nested, "utf8"))).toHaveProperty("collections.boards");
  });

  it("keeps the region it is given", () => {
    expect(createFileStore(file, { region: "eu" }).region).toBe("eu");
  });

  // The file format is not the format of earlier releases, and a file that is
  // not a store file is never read as an empty store.
  it.each([
    ["an earlier release file", { clock: 1, tables: { t: { x: { doc: {}, version: 1 } } } }],
    ["null", null],
    ["a list", []],
  ])("refuses %s", async (_name, content) => {
    await writeFile(file, JSON.stringify(content));
    await expect(createFileStore(file).get("t", "x")).rejects.toThrow(/not an agentic-identity store file/);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(content);
  });

  it("refuses a file that is not JSON", async () => {
    await writeFile(file, "{ not json");
    await expect(createFileStore(file).get("t", "x")).rejects.toThrow(/not an agentic-identity store file/);
    expect(await readFile(file, "utf8")).toBe("{ not json");
  });
});
