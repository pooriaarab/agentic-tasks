import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskError, type Claim, type Principal, type Task } from "./model.js";
import { createMemoryStore, type Store } from "agentic-identity";
import { createFileStore } from "./file-store.js";
import { createTasks, type Tasks } from "./tasks.js";

const ALICE: Principal = { id: "alice", kind: "human" };
const BOT: Principal = { id: "bot-1", kind: "agent_of_human" };
const TEN_MINUTES = 600_000;

interface Harness {
  tasks: Tasks;
  store: Store;
  advance: (ms: number) => void;
  cleanup: () => Promise<void>;
}

type Backend = [string, () => Promise<{ store: Store; cleanup: () => Promise<void> }>];

const backends: Backend[] = [
  ["memory", async () => ({ store: createMemoryStore(), cleanup: async () => {} })],
  [
    "file",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "agentic-tasks-"));
      return {
        store: createFileStore(join(dir, "tasks.json")),
        cleanup: () => rm(dir, { recursive: true, force: true }),
      };
    },
  ],
];

async function harnessFor(open: Backend[1]): Promise<Harness> {
  const { store, cleanup } = await open();
  let ms = Date.parse("2026-10-28T10:00:00Z");
  return {
    tasks: createTasks({ store, now: () => new Date(ms) }),
    store,
    advance: (delta) => {
      ms += delta;
    },
    cleanup,
  };
}

// Resolves to the error code, or "NO_ERROR" when the call succeeds.
async function errorCode(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof TaskError) return error.code;
    throw error;
  }
  return "NO_ERROR";
}

describe.each(backends)("claim rules on the %s store", (_name, open) => {
  let h: Harness;

  beforeEach(async () => {
    h = await harnessFor(open);
  });

  afterEach(async () => {
    await h.cleanup();
  });

  async function openTask(): Promise<string> {
    const board = await h.tasks.createBoard({ title: "Sprint" }, ALICE);
    await h.tasks.addColumn(board.id, "Todo", ALICE);
    const task = await h.tasks.createTask(
      { boardId: board.id, title: "Write spec" },
      ALICE,
    );
    return task.id;
  }

  // Writes a claim the API would never write, as a hand-edited file could hold.
  async function writeRawClaim(id: string, claim: Claim): Promise<void> {
    await h.store.transaction(async (tx) => {
      const task = (await tx.get("tasks", id)) as unknown as Task | null;
      if (!task) throw new Error("fixture task is missing");
      const corrupt = { ...task, claim };
      await tx.put("tasks", id, corrupt as unknown as Record<string, never>);
    });
  }

  it("claims an open task and records the holder and expiry", async () => {
    const id = await openTask();
    const task = await h.tasks.claim(id, BOT, { ttlMs: TEN_MINUTES });
    expect(task.claim?.holder).toEqual(BOT);
    expect(task.claim?.expiresAt).toBe("2026-10-28T10:10:00.000Z");
  });

  it("rejects a second principal while the first claim is live", async () => {
    const id = await openTask();
    await h.tasks.claim(id, ALICE, { ttlMs: TEN_MINUTES });
    await expect(
      errorCode(h.tasks.claim(id, BOT, { ttlMs: TEN_MINUTES })),
    ).resolves.toBe("CLAIM_HELD");
    expect((await h.tasks.getTask(id)).claim?.holder).toEqual(ALICE);
  });

  it("renews the claim when the holder claims again while it is live", async () => {
    const id = await openTask();
    const first = await h.tasks.claim(id, ALICE, { ttlMs: TEN_MINUTES });
    h.advance(300_000);
    const renewed = await h.tasks.claim(id, ALICE, { ttlMs: TEN_MINUTES });
    expect(renewed.claim?.expiresAt).toBe("2026-10-28T10:15:00.000Z");
    expect(renewed.claim?.claimedAt).toBe(first.claim?.claimedAt);
  });

  it("treats a claim as live one millisecond before it expires", async () => {
    const id = await openTask();
    await h.tasks.claim(id, ALICE, { ttlMs: TEN_MINUTES });
    h.advance(TEN_MINUTES - 1);
    await expect(
      errorCode(h.tasks.claim(id, BOT, { ttlMs: TEN_MINUTES })),
    ).resolves.toBe("CLAIM_HELD");
  });

  it("lets another principal claim once the claim expires", async () => {
    const id = await openTask();
    await h.tasks.claim(id, ALICE, { ttlMs: TEN_MINUTES });
    h.advance(TEN_MINUTES);
    const task = await h.tasks.claim(id, BOT, { ttlMs: TEN_MINUTES });
    expect(task.claim?.holder).toEqual(BOT);
  });

  it("rejects a claim on a closed task", async () => {
    const id = await openTask();
    await h.tasks.closeTask(id, ALICE);
    await expect(
      errorCode(h.tasks.claim(id, BOT, { ttlMs: TEN_MINUTES })),
    ).resolves.toBe("TASK_CLOSED");
  });

  it("rejects a claim on a task that does not exist", async () => {
    await expect(
      errorCode(h.tasks.claim("missing", BOT, { ttlMs: TEN_MINUTES })),
    ).resolves.toBe("NOT_FOUND");
  });

  it("treats ids that name object prototype members as missing", async () => {
    for (const id of ["__proto__", "constructor", "toString"]) {
      await expect(errorCode(h.tasks.getTask(id))).resolves.toBe("NOT_FOUND");
      await expect(
        errorCode(h.tasks.claim(id, BOT, { ttlMs: TEN_MINUTES })),
      ).resolves.toBe("NOT_FOUND");
    }
    await expect(h.tasks.listTasks({})).resolves.toEqual([]);
  });

  it("rejects a ttl that is not a positive integer of milliseconds", async () => {
    const id = await openTask();
    for (const ttlMs of [0, -1, 1.5, Number.NaN]) {
      await expect(errorCode(h.tasks.claim(id, BOT, { ttlMs }))).resolves.toBe(
        "INVALID_INPUT",
      );
    }
  });

  it("rejects a principal whose kind is not a known kind", async () => {
    const id = await openTask();
    const impostor = { id: "bot-1", kind: "root" } as unknown as Principal;
    await expect(
      errorCode(h.tasks.claim(id, impostor, { ttlMs: TEN_MINUTES })),
    ).resolves.toBe("INVALID_INPUT");
  });

  it("rejects a release by a principal that does not hold the claim", async () => {
    const id = await openTask();
    await h.tasks.claim(id, ALICE, { ttlMs: TEN_MINUTES });
    await expect(errorCode(h.tasks.release(id, BOT))).resolves.toBe("NOT_HOLDER");
    expect((await h.tasks.getTask(id)).claim?.holder).toEqual(ALICE);
  });

  it("rejects a release when no claim exists", async () => {
    const id = await openTask();
    await expect(errorCode(h.tasks.release(id, ALICE))).resolves.toBe("NOT_HOLDER");
  });

  it("clears the claim when the holder releases it", async () => {
    const id = await openTask();
    await h.tasks.claim(id, ALICE, { ttlMs: TEN_MINUTES });
    const released = await h.tasks.release(id, ALICE);
    expect(released.claim).toBeUndefined();
    const task = await h.tasks.claim(id, BOT, { ttlMs: TEN_MINUTES });
    expect(task.claim?.holder).toEqual(BOT);
  });

  it("treats the same id with another kind as another principal", async () => {
    const id = await openTask();
    await h.tasks.claim(id, ALICE, { ttlMs: TEN_MINUTES });
    const asAgent: Principal = { id: "alice", kind: "agent_of_human" };
    await expect(
      errorCode(h.tasks.claim(id, asAgent, { ttlMs: TEN_MINUTES })),
    ).resolves.toBe("CLAIM_HELD");
  });

  it("clears the claim when the task closes", async () => {
    const id = await openTask();
    await h.tasks.claim(id, ALICE, { ttlMs: TEN_MINUTES });
    const closed = await h.tasks.closeTask(id, ALICE);
    expect(closed.status).toBe("closed");
    expect(closed.claim).toBeUndefined();
  });

  it("refuses a close by another principal while the claim is live", async () => {
    const id = await openTask();
    await h.tasks.claim(id, ALICE, { ttlMs: TEN_MINUTES });
    await expect(errorCode(h.tasks.closeTask(id, BOT))).resolves.toBe("CLAIM_HELD");
    const task = await h.tasks.getTask(id);
    expect(task.status).toBe("open");
    expect(task.claim?.holder).toEqual(ALICE);
  });

  it("lets another principal close the task once the claim expires", async () => {
    const id = await openTask();
    await h.tasks.claim(id, ALICE, { ttlMs: TEN_MINUTES });
    h.advance(TEN_MINUTES);
    const closed = await h.tasks.closeTask(id, BOT);
    expect(closed.status).toBe("closed");
  });

  it("lets another principal close the task after the holder releases it", async () => {
    const id = await openTask();
    await h.tasks.claim(id, ALICE, { ttlMs: TEN_MINUTES });
    await h.tasks.release(id, ALICE);
    const closed = await h.tasks.closeTask(id, BOT);
    expect(closed.status).toBe("closed");
  });

  it("treats a claim with an unparseable expiry as live, so nobody takes it", async () => {
    const id = await openTask();
    await writeRawClaim(id, {
      holder: ALICE,
      claimedAt: "2026-10-28T10:00:00.000Z",
      expiresAt: "soon",
    });
    await expect(
      errorCode(h.tasks.claim(id, BOT, { ttlMs: TEN_MINUTES })),
    ).resolves.toBe("CLAIM_HELD");
    await expect(errorCode(h.tasks.closeTask(id, BOT))).resolves.toBe("CLAIM_HELD");
    expect((await h.tasks.getTask(id)).claim?.holder).toEqual(ALICE);
  });

  it("lets exactly one of two simultaneous claims succeed", async () => {
    const id = await openTask();
    const results = await Promise.allSettled([
      h.tasks.claim(id, ALICE, { ttlMs: TEN_MINUTES }),
      h.tasks.claim(id, BOT, { ttlMs: TEN_MINUTES }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(TaskError);
  });

  it("appends progress entries in order and records each author kind", async () => {
    const id = await openTask();
    await h.tasks.progress(id, "drafted the outline", BOT);
    await h.tasks.progress(id, "reviewed the outline", ALICE);
    const entries = await h.tasks.listProgress(id);
    expect(entries.map((e) => e.note)).toEqual([
      "drafted the outline",
      "reviewed the outline",
    ]);
    expect(entries.map((e) => e.by.kind)).toEqual(["agent_of_human", "human"]);
  });

  it("rejects progress on a closed task", async () => {
    const id = await openTask();
    await h.tasks.closeTask(id, ALICE);
    await expect(errorCode(h.tasks.progress(id, "late note", BOT))).resolves.toBe(
      "TASK_CLOSED",
    );
  });

  it("rejects an empty progress note", async () => {
    const id = await openTask();
    await expect(errorCode(h.tasks.progress(id, "   ", BOT))).resolves.toBe(
      "INVALID_INPUT",
    );
  });
});

describe.each(backends)("boards, columns, and tasks on the %s store", (_name, open) => {
  let h: Harness;

  beforeEach(async () => {
    h = await harnessFor(open);
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it("puts a new task in the first column", async () => {
    const board = await h.tasks.createBoard({ title: "Sprint" }, ALICE);
    const todo = await h.tasks.addColumn(board.id, "Todo", ALICE);
    await h.tasks.addColumn(board.id, "Doing", ALICE);
    const task = await h.tasks.createTask({ boardId: board.id, title: "A" }, ALICE);
    expect(task.columnId).toBe(todo.columns[0]?.id);
  });

  it("rejects a task on a board with no columns", async () => {
    const board = await h.tasks.createBoard({ title: "Empty" }, ALICE);
    await expect(
      errorCode(h.tasks.createTask({ boardId: board.id, title: "A" }, ALICE)),
    ).resolves.toBe("INVALID_INPUT");
  });

  it("rejects a duplicate column name on one board", async () => {
    const board = await h.tasks.createBoard({ title: "Sprint" }, ALICE);
    await h.tasks.addColumn(board.id, "Todo", ALICE);
    await expect(errorCode(h.tasks.addColumn(board.id, "Todo", ALICE))).resolves.toBe(
      "INVALID_INPUT",
    );
  });

  it("rejects a move to a column the board does not have", async () => {
    const board = await h.tasks.createBoard({ title: "Sprint" }, ALICE);
    await h.tasks.addColumn(board.id, "Todo", ALICE);
    const task = await h.tasks.createTask({ boardId: board.id, title: "A" }, ALICE);
    await expect(
      errorCode(h.tasks.moveTask(task.id, { columnId: "nowhere" }, ALICE)),
    ).resolves.toBe("INVALID_INPUT");
  });

  it("moves a task to the end of the target column when no position is given", async () => {
    const board = await h.tasks.createBoard({ title: "Sprint" }, ALICE);
    const todo = await h.tasks.addColumn(board.id, "Todo", ALICE);
    const doing = await h.tasks.addColumn(board.id, "Doing", ALICE);
    const columnDoing = doing.columns[1]?.id as string;
    await h.tasks.createTask({ boardId: board.id, title: "Already here" }, ALICE);
    const moveMe = await h.tasks.createTask({ boardId: board.id, title: "Mover" }, ALICE);
    await h.tasks.moveTask(moveMe.id, { columnId: columnDoing }, ALICE);
    const moved = await h.tasks.getTask(moveMe.id);
    expect(moved.columnId).toBe(columnDoing);
    expect(moved.position).toBe(0);
    expect(todo.columns[0]?.id).not.toBe(columnDoing);
  });

  it("rejects a move or an update of a closed task", async () => {
    const board = await h.tasks.createBoard({ title: "Sprint" }, ALICE);
    const todo = await h.tasks.addColumn(board.id, "Todo", ALICE);
    const task = await h.tasks.createTask({ boardId: board.id, title: "A" }, ALICE);
    await h.tasks.closeTask(task.id, ALICE);
    await expect(
      errorCode(h.tasks.moveTask(task.id, { columnId: todo.columns[0]?.id as string }, ALICE)),
    ).resolves.toBe("TASK_CLOSED");
    await expect(
      errorCode(h.tasks.updateTask(task.id, { title: "B" }, ALICE)),
    ).resolves.toBe("TASK_CLOSED");
  });

  it("records the creator and the last editor with their kinds", async () => {
    const board = await h.tasks.createBoard({ title: "Sprint" }, BOT);
    await h.tasks.addColumn(board.id, "Todo", BOT);
    const task = await h.tasks.createTask({ boardId: board.id, title: "A" }, BOT);
    const edited = await h.tasks.updateTask(task.id, { title: "B" }, ALICE);
    expect(edited.createdBy).toEqual(BOT);
    expect(edited.updatedBy).toEqual(ALICE);
    expect(edited.title).toBe("B");
  });

  it("trims and de-duplicates labels and rejects an impossible due date", async () => {
    const board = await h.tasks.createBoard({ title: "Sprint" }, ALICE);
    await h.tasks.addColumn(board.id, "Todo", ALICE);
    const task = await h.tasks.createTask(
      { boardId: board.id, title: "A", labels: [" bug ", "bug", "p1"], dueDate: "2026-10-30" },
      ALICE,
    );
    expect(task.labels).toEqual(["bug", "p1"]);
    expect(task.dueDate).toBe("2026-10-30");
    await expect(
      errorCode(h.tasks.updateTask(task.id, { dueDate: "2026-02-30" }, ALICE)),
    ).resolves.toBe("INVALID_INPUT");
  });
});

describe("claims across two stores on one file", () => {
  it("lets exactly one of many parallel claims through", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentic-tasks-two-"));
    try {
      const file = join(dir, "tasks.json");
      const one = createTasks({ store: createFileStore(file) });
      const two = createTasks({ store: createFileStore(file) });
      const board = await one.createBoard({ title: "Sprint" }, ALICE);
      await one.addColumn(board.id, "Todo", ALICE);
      const task = await one.createTask({ boardId: board.id, title: "Write spec" }, ALICE);
      const claimants = Array.from({ length: 8 }, (_, i): Principal => ({
        id: `bot-${i}`,
        kind: "agent_of_human",
      }));
      const codes = await Promise.all(
        claimants.map((who, i) => errorCode((i % 2 === 0 ? one : two).claim(task.id, who))),
      );
      expect(codes.filter((code) => code === "NO_ERROR")).toHaveLength(1);
      expect(codes.filter((code) => code === "CLAIM_HELD")).toHaveLength(7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
