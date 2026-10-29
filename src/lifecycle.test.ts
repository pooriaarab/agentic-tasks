import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type Store } from "agentic-identity";
import { TaskError } from "./model.js";
import { createFileStore } from "./file-store.js";
import { createTasks, type Tasks } from "./tasks.js";
import { trustedContext } from "./principal.js";

const ALICE = trustedContext("alice", "human");
const BOB = trustedContext("bob", "human");
const BOT = trustedContext("bot-1", "agent_of_human");

async function code(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof TaskError) return error.code;
    throw error;
  }
  return "NO_ERROR";
}

type Backend = [string, () => Promise<{ store: Store; cleanup: () => Promise<void> }>];
const backends: Backend[] = [
  ["memory", async () => ({ store: createMemoryStore(), cleanup: async () => {} })],
  [
    "file",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "agentic-tasks-life-"));
      return { store: createFileStore(join(dir, "t.json")), cleanup: () => rm(dir, { recursive: true, force: true }) };
    },
  ],
];

describe.each(backends)("task lifecycle on the %s store", (_name, open) => {
  let tasks: Tasks;
  let store: Store;
  let cleanup: () => Promise<void>;
  let boardId: string;
  let taskId: string;

  beforeEach(async () => {
    ({ store, cleanup } = await open());
    tasks = createTasks({ store });
    const board = await tasks.createBoard({ title: "Sprint" }, ALICE);
    boardId = board.id;
    await tasks.addColumn(boardId, "Todo", ALICE);
    taskId = (await tasks.createTask({ boardId, title: "Write spec" }, ALICE)).id;
    await tasks.shareBoard(boardId, { kind: "human", id: "bob" }, "editor", ALICE);
    await tasks.shareBoard(boardId, { kind: "agent", id: "bot-1" }, "editor", ALICE);
  });

  afterEach(async () => {
    await cleanup();
  });

  it("deletes a task with its notes and counter", async () => {
    await tasks.progress(taskId, "started", ALICE);
    await tasks.deleteTask(taskId, ALICE);
    await expect(code(tasks.getTask(taskId, ALICE))).resolves.toBe("NOT_FOUND");
    expect((await store.query("progress", { where: { taskId } })).items).toHaveLength(0);
    expect((await store.get("counters", `seq:${taskId}`)) ?? null).toBeNull();
    await expect(code(tasks.deleteTask(taskId, ALICE))).resolves.toBe("NOT_FOUND");
  });

  it("refuses a delete from a viewer and from a stranger", async () => {
    await tasks.shareBoard(boardId, { kind: "human", id: "carol" }, "viewer", ALICE);
    await expect(code(tasks.deleteTask(taskId, trustedContext("carol", "human")))).resolves.toBe("FORBIDDEN");
    await expect(code(tasks.deleteTask(taskId, trustedContext("zed", "human")))).resolves.toBe("FORBIDDEN");
    await expect(code(tasks.getTask(taskId, ALICE))).resolves.toBe("NO_ERROR");
  });

  it("refuses a delete while another principal holds a live claim, but lets the holder and an owner", async () => {
    await tasks.claim(taskId, BOT);
    await expect(code(tasks.deleteTask(taskId, BOB))).resolves.toBe("CLAIM_HELD");
    await tasks.deleteTask(taskId, ALICE);
    await expect(code(tasks.getTask(taskId, ALICE))).resolves.toBe("NOT_FOUND");
    const second = (await tasks.createTask({ boardId, title: "Two" }, ALICE)).id;
    await tasks.claim(second, BOT);
    await tasks.deleteTask(second, BOT);
    await expect(code(tasks.getTask(second, ALICE))).resolves.toBe("NOT_FOUND");
  });

  it("lists only the boards the caller holds a role on", async () => {
    const other = await tasks.createBoard({ title: "Private" }, BOB);
    expect((await tasks.listBoards(ALICE)).map((b) => b.id)).toEqual([boardId]);
    expect((await tasks.listBoards(BOB)).map((b) => b.id).sort()).toEqual([boardId, other.id].sort());
    expect(await tasks.listBoards(trustedContext("zed", "human"))).toEqual([]);
    // A person and an agent with one id are two subjects.
    expect(await tasks.listBoards(trustedContext("alice", "agent"))).toEqual([]);
  });

  it("drops a board that is erased from the list", async () => {
    await tasks.eraseBoard(boardId, ALICE);
    expect(await tasks.listBoards(ALICE)).toEqual([]);
  });

  it("exports the caller's own data and nobody else's", async () => {
    await tasks.progress(taskId, "alice note", ALICE);
    await tasks.progress(taskId, "bob note", BOB);
    const bobs = (await tasks.createTask({ boardId, title: "Bob task" }, BOB)).id;
    const data = await tasks.exportData(BOB);
    expect(data.principal).toEqual({ id: "bob", kind: "human" });
    expect(data.boards).toHaveLength(1);
    const [entry] = data.boards;
    expect(entry?.role).toBe("editor");
    expect(entry?.notes.map((n) => n.note)).toEqual(["bob note"]);
    // Bob wrote a note on alice's task, which bumps updatedBy only on tasks he edits.
    expect(entry?.tasks.map((t) => t.id)).toEqual([bobs]);
    const alices = await tasks.exportData(ALICE);
    expect(alices.boards[0]?.role).toBe("owner");
    expect(alices.boards[0]?.notes.map((n) => n.note)).toEqual(["alice note"]);
    expect(alices.boards[0]?.tasks.map((t) => t.id)).toContain(taskId);
    expect((await tasks.exportData(trustedContext("zed", "human"))).boards).toEqual([]);
  });
});
