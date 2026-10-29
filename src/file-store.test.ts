import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileStore } from "./file-store.js";

// Wraps rename so one test can make the final step of a save fail.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

describe("file store", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentic-tasks-file-store-"));
    file = join(dir, "tasks.json");
  });

  afterEach(async () => {
    vi.mocked(rename).mockClear();
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a missing parent directory on the first transaction", async () => {
    const nested = join(dir, "nested", "deeper", "tasks.json");
    const store = createFileStore(nested);
    await store.put("boards", "board-1", { id: "board-1" });
    expect(await store.get("boards", "board-1")).toEqual({ id: "board-1" });
    expect(JSON.parse(await readFile(nested, "utf8"))).toHaveProperty("tables.boards");
  });

  it("removes the temp file and keeps the old state when rename fails", async () => {
    const store = createFileStore(file);
    await store.put("boards", "board-1", { id: "board-1" });
    const before = await readFile(file, "utf8");

    vi.mocked(rename).mockRejectedValueOnce(new Error("EXDEV: cross-device link"));
    await expect(
      store.put("boards", "board-2", { id: "board-2" }),
    ).rejects.toThrow("EXDEV");

    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readdir(dir)).toEqual(["tasks.json"]);
  });

  // A version that repeats lets a stale transaction pass its check, so these
  // files are refused instead of read.
  it.each([
    ["a clock behind a row version", { clock: 0, tables: { t: { x: { doc: {}, version: 1 } } } }],
    ["a row with no version", { clock: 1, tables: { t: { x: { doc: {} } } } }],
    ["a row version of 0", { clock: 1, tables: { t: { x: { doc: {}, version: 0 } } } }],
    ["a fractional clock", { clock: 1.5, tables: {} }],
    ["a row whose doc is not an object", { clock: 1, tables: { t: { x: { doc: 5, version: 1 } } } }],
  ])("refuses a file with %s", async (_name, content) => {
    await writeFile(file, JSON.stringify(content));
    await expect(createFileStore(file).get("t", "x")).rejects.toThrow(/not an agentic-tasks store file/);
  });
});
