import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskError, type Claim, type Principal, type Task } from "./model.js";
import { createMemoryStore, createSharing, type Doc, type PrincipalContext, type Store } from "agentic-identity";
import { createFileStore } from "./file-store.js";
import { createTasks, type Tasks } from "./tasks.js";
import { trustedContext } from "./principal.js";

const ALICE_P: Principal = { id: "alice", kind: "human" };
const BOT_P: Principal = { id: "bot-1", kind: "agent_of_human" };
const ALICE = trustedContext(ALICE_P.id, ALICE_P.kind);
const BOT = trustedContext(BOT_P.id, BOT_P.kind);
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
  const raw = createTasks({ store, now: () => new Date(ms) });
  // Most cases here test claims, not roles. A board that alice makes is also
  // shared with bot-1 as an editor. The role cases below use `raw` tasks.
  const tasks: Tasks = {
    ...raw,
    async createBoard(input, ctx) {
      const board = await raw.createBoard(input, ctx);
      if (ctx.principalId === ALICE.principalId) {
        await raw.shareBoard(board.id, { kind: "agent", id: "bot-1" }, "editor", ctx);
      }
      return board;
    },
  };
  return {
    tasks,
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
    expect(task.claim?.holder).toEqual(BOT_P);
    expect(task.claim?.expiresAt).toBe("2026-10-28T10:10:00.000Z");
  });

  it("rejects a second principal while the first claim is live", async () => {
    const id = await openTask();
    await h.tasks.claim(id, ALICE, { ttlMs: TEN_MINUTES });
    await expect(
      errorCode(h.tasks.claim(id, BOT, { ttlMs: TEN_MINUTES })),
    ).resolves.toBe("CLAIM_HELD");
    expect((await h.tasks.getTask(id, ALICE)).claim?.holder).toEqual(ALICE_P);
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
    expect(task.claim?.holder).toEqual(BOT_P);
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
      await expect(errorCode(h.tasks.getTask(id, ALICE))).resolves.toBe("NOT_FOUND");
      await expect(
        errorCode(h.tasks.claim(id, BOT, { ttlMs: TEN_MINUTES })),
      ).resolves.toBe("NOT_FOUND");
    }
    await expect(errorCode(h.tasks.listTasks({ boardId: "__proto__" }, ALICE))).resolves.toBe("NOT_FOUND");
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
    const impostor = trustedContext("bot-1", "root");
    await expect(
      errorCode(h.tasks.claim(id, impostor, { ttlMs: TEN_MINUTES })),
    ).resolves.toBe("INVALID_INPUT");
  });

  it("rejects a release by a principal that does not hold the claim", async () => {
    const id = await openTask();
    await h.tasks.claim(id, ALICE, { ttlMs: TEN_MINUTES });
    await expect(errorCode(h.tasks.release(id, BOT))).resolves.toBe("NOT_HOLDER");
    expect((await h.tasks.getTask(id, ALICE)).claim?.holder).toEqual(ALICE_P);
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
    expect(task.claim?.holder).toEqual(BOT_P);
  });

  it("treats the same id with another kind as another principal", async () => {
    const id = await openTask();
    await h.tasks.claim(id, ALICE, { ttlMs: TEN_MINUTES });
    const asAgent = trustedContext("alice", "agent_of_human");
    await h.tasks.shareBoard((await h.tasks.getTask(id, ALICE)).boardId, { kind: "agent", id: "alice" }, "editor", ALICE);
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
    const task = await h.tasks.getTask(id, ALICE);
    expect(task.status).toBe("open");
    expect(task.claim?.holder).toEqual(ALICE_P);
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
      holder: ALICE_P,
      claimedAt: "2026-10-28T10:00:00.000Z",
      expiresAt: "soon",
    });
    await expect(
      errorCode(h.tasks.claim(id, BOT, { ttlMs: TEN_MINUTES })),
    ).resolves.toBe("CLAIM_HELD");
    await expect(errorCode(h.tasks.closeTask(id, BOT))).resolves.toBe("CLAIM_HELD");
    expect((await h.tasks.getTask(id, ALICE)).claim?.holder).toEqual(ALICE_P);
  });

  it("counts a claim with a non-text expiry as live", async () => {
    const id = await openTask();
    await writeRawClaim(id, {
      holder: ALICE_P,
      claimedAt: "2026-10-28T10:00:00.000Z",
      expiresAt: 1 as unknown as string,
    });
    await expect(
      errorCode(h.tasks.claim(id, BOT, { ttlMs: TEN_MINUTES })),
    ).resolves.toBe("CLAIM_HELD");
    await expect(errorCode(h.tasks.closeTask(id, BOT))).resolves.toBe("CLAIM_HELD");
  });

  it.each(["1", "0", "foo 1", "2026-10-28"])(
    "counts a claim whose expiry %j is not the stored time format as live",
    async (expiresAt) => {
      const id = await openTask();
      await writeRawClaim(id, { holder: ALICE_P, claimedAt: "2026-10-28T10:00:00.000Z", expiresAt });
      await expect(
        errorCode(h.tasks.claim(id, BOT, { ttlMs: TEN_MINUTES })),
      ).resolves.toBe("CLAIM_HELD");
      await expect(errorCode(h.tasks.closeTask(id, BOT))).resolves.toBe("CLAIM_HELD");
    },
  );

  it("refuses a task whose stored status is not open", async () => {
    const id = await openTask();
    await h.store.transaction(async (tx) => {
      const task = (await tx.get("tasks", id))!;
      await tx.put("tasks", id, { ...task, status: "Closed" });
    });
    await expect(errorCode(h.tasks.claim(id, BOT))).resolves.toBe("TASK_CLOSED");
    await expect(
      errorCode(h.tasks.updateTask(id, { title: "x" }, BOT)),
    ).resolves.toBe("TASK_CLOSED");
  });

  it("writes a new claimedAt when a renewed claim has a bad one", async () => {
    const id = await openTask();
    await writeRawClaim(id, {
      holder: ALICE_P,
      claimedAt: 42 as unknown as string,
      expiresAt: "2026-10-28T10:05:00.000Z",
    });
    const renewed = await h.tasks.claim(id, ALICE, { ttlMs: TEN_MINUTES });
    expect(renewed.claim?.claimedAt).toBe("2026-10-28T10:00:00.000Z");
  });

  it("reports a claim that is not an object as held, with an error code", async () => {
    const id = await openTask();
    await writeRawClaim(id, null as unknown as Claim);
    await expect(
      errorCode(h.tasks.claim(id, BOT, { ttlMs: TEN_MINUTES })),
    ).resolves.toBe("CLAIM_HELD");
    await expect(errorCode(h.tasks.closeTask(id, BOT))).resolves.toBe("CLAIM_HELD");
    await expect(errorCode(h.tasks.release(id, BOT))).resolves.toBe("NOT_HOLDER");
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
    const entries = await h.tasks.listProgress(id, ALICE);
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

  it("still lists a task whose stored position is bad, and numbers new tasks from the good ones", async () => {
    const board = await h.tasks.createBoard({ title: "Sprint" }, ALICE);
    await h.tasks.addColumn(board.id, "Todo", ALICE);
    const first = await h.tasks.createTask({ boardId: board.id, title: "one" }, ALICE);
    await h.store.transaction(async (tx) => {
      const row = (await tx.get("tasks", first.id))!;
      await tx.put("tasks", first.id, { ...row, position: "abc" });
    });
    const second = await h.tasks.createTask({ boardId: board.id, title: "two" }, ALICE);
    // The counter holds the next number, so the bad row does not set it.
    expect(second.position).toBe(1);
    const listed = await h.tasks.listTasks({ boardId: board.id }, ALICE);
    expect(listed.map((task) => task.title).sort()).toEqual(["one", "two"]);
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
    const moved = await h.tasks.getTask(moveMe.id, ALICE);
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
    await h.tasks.shareBoard(board.id, { kind: "human", id: "alice" }, "editor", BOT);
    await h.tasks.addColumn(board.id, "Todo", BOT);
    const task = await h.tasks.createTask({ boardId: board.id, title: "A" }, BOT);
    const edited = await h.tasks.updateTask(task.id, { title: "B" }, ALICE);
    expect(edited.createdBy).toEqual(BOT_P);
    expect(edited.updatedBy).toEqual(ALICE_P);
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
      const claimants = Array.from({ length: 8 }, (_, i) => trustedContext(`bot-${i}`, "agent_of_human"));
      for (const who of claimants) await one.shareBoard(board.id, { kind: "agent", id: who.principalId }, "editor", ALICE);
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

describe("a claim that loses a race", () => {
  // Fires a competing claim after the first read, before the commit. No timing
  // involved, so a missing version check fails this test every time.
  it("is refused when another store claimed between its read and its commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentic-tasks-race-"));
    try {
      const file = join(dir, "tasks.json");
      const winner = createTasks({ store: createFileStore(file) });
      const board = await winner.createBoard({ title: "Sprint" }, ALICE);
      await winner.addColumn(board.id, "Todo", ALICE);
      const task = await winner.createTask({ boardId: board.id, title: "Write spec" }, ALICE);
      await winner.shareBoard(board.id, { kind: "agent", id: "bot-1" }, "editor", ALICE);

      const inner = createFileStore(file);
      let fired = false;
      const loser = createTasks({
        store: {
          ...inner,
          transaction: (fn) =>
            inner.transaction((tx) =>
              fn({
                ...tx,
                get: async <T extends Doc>(collection: string, id: string) => {
                  const row = await tx.get<T>(collection, id);
                  if (!fired) {
                    fired = true;
                    await winner.claim(task.id, ALICE);
                  }
                  return row;
                },
              }),
            ),
        },
      });
      await expect(errorCode(loser.claim(task.id, BOT))).resolves.toBe("CLAIM_HELD");
      expect((await winner.getTask(task.id, ALICE)).claim?.holder).toEqual(ALICE_P);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Failure list for access, written before the code:
//  1. A caller with no role on the board cannot read or write it.
//  2. A viewer reads but cannot add a note, change a task, or claim.
//  3. A commenter adds notes but cannot change a task or claim.
//  4. An editor changes tasks and claims, but cannot share the board.
//  5. A role on one board gives nothing on another board.
//  6. After unshare the access is gone, and the last owner cannot be removed.
//  7. An agent keeps only the scopes that are left after its chain narrows them,
//     even when the human it acts for owns the board.
//  8. Making a board needs the board:write scope.
//  9. Every check writes an audit entry that labels an agent action as machine-made.
describe("board roles", () => {
  const CAROL = trustedContext("carol", "human");
  let tasks: Tasks;
  let store: Store;
  let boardId: string;
  let taskId: string;

  beforeEach(async () => {
    store = createMemoryStore({ region: "eu" });
    tasks = createTasks({ store });
    const board = await tasks.createBoard({ title: "Sprint" }, ALICE);
    boardId = board.id;
    await tasks.addColumn(boardId, "Todo", ALICE);
    taskId = (await tasks.createTask({ boardId, title: "Write spec" }, ALICE)).id;
  });

  const code = (work: Promise<unknown>) => errorCode(work);

  it("keys a grant on kind and id, so an agent with a person's id gets nothing", async () => {
    await tasks.shareBoard(boardId, { kind: "human", id: "carol" }, "editor", ALICE);
    const agentCarol = trustedContext("carol", "agent");
    await expect(code(tasks.getBoard(boardId, agentCarol))).resolves.toBe("FORBIDDEN");
    await expect(code(tasks.getBoard(boardId, CAROL))).resolves.toBe("NO_ERROR");
    await tasks.unshareBoard(boardId, { kind: "agent", id: "carol" }, ALICE);
    await expect(code(tasks.getBoard(boardId, CAROL))).resolves.toBe("NO_ERROR");
  });

  it("refuses a subject with no kind or an unknown kind", async () => {
    for (const subject of [{ id: "carol" }, { kind: "root", id: "carol" }, { kind: "human", id: "" }]) {
      await expect(code(tasks.shareBoard(boardId, subject as never, "viewer", ALICE))).resolves.toBe("INVALID_INPUT");
    }
  });

  it("finishes an erase that stopped after the board row went", async () => {
    await tasks.progress(taskId, "started", ALICE);
    await store.delete("boards", boardId);
    await expect(code(tasks.eraseBoard(boardId, CAROL))).resolves.toBe("NOT_FOUND");
    await tasks.eraseBoard(boardId, ALICE);
    expect((await store.get("tasks", taskId)) ?? null).toBeNull();
    expect((await store.query("grants", { where: { resourceId: boardId } })).items).toHaveLength(0);
    await expect(code(tasks.eraseBoard(boardId, ALICE))).resolves.toBe("NOT_FOUND");
  });

  it("erases a board with its tasks, notes, and grants", async () => {
    await tasks.shareBoard(boardId, { kind: "human", id: "carol" }, "editor", ALICE);
    await tasks.progress(taskId, "started", ALICE);
    await expect(code(tasks.eraseBoard(boardId, CAROL))).resolves.toBe("FORBIDDEN");
    await tasks.eraseBoard(boardId, ALICE);
    expect((await store.get("boards", boardId)) ?? null).toBeNull();
    expect((await store.get("tasks", taskId)) ?? null).toBeNull();
    expect((await store.query("progress", { where: { taskId } })).items).toHaveLength(0);
    expect((await store.query("grants", { where: { resourceId: boardId } })).items).toHaveLength(0);
    await expect(code(tasks.getBoard(boardId, ALICE))).resolves.toBe("NOT_FOUND");
  });

  it("refuses a caller with no role", async () => {
    await expect(code(tasks.getBoard(boardId, CAROL))).resolves.toBe("FORBIDDEN");
    await expect(code(tasks.getTask(taskId, CAROL))).resolves.toBe("FORBIDDEN");
    await expect(code(tasks.listTasks({ boardId }, CAROL))).resolves.toBe("FORBIDDEN");
    await expect(code(tasks.claim(taskId, CAROL))).resolves.toBe("FORBIDDEN");
  });

  it("lets a viewer read and nothing else", async () => {
    await tasks.shareBoard(boardId, { kind: "human", id: "carol" }, "viewer", ALICE);
    await expect(code(tasks.getTask(taskId, CAROL))).resolves.toBe("NO_ERROR");
    await expect(code(tasks.listTasks({ boardId }, CAROL))).resolves.toBe("NO_ERROR");
    await expect(code(tasks.listProgress(taskId, CAROL))).resolves.toBe("NO_ERROR");
    await expect(code(tasks.progress(taskId, "note", CAROL))).resolves.toBe("FORBIDDEN");
    await expect(code(tasks.updateTask(taskId, { title: "x" }, CAROL))).resolves.toBe("FORBIDDEN");
    await expect(code(tasks.claim(taskId, CAROL))).resolves.toBe("FORBIDDEN");
  });

  it("lets a commenter add notes and nothing more", async () => {
    await tasks.shareBoard(boardId, { kind: "human", id: "carol" }, "commenter", ALICE);
    await expect(code(tasks.progress(taskId, "note", CAROL))).resolves.toBe("NO_ERROR");
    await expect(code(tasks.updateTask(taskId, { title: "x" }, CAROL))).resolves.toBe("FORBIDDEN");
    await expect(code(tasks.claim(taskId, CAROL))).resolves.toBe("FORBIDDEN");
  });

  it("lets an editor change and claim, but not share", async () => {
    await tasks.shareBoard(boardId, { kind: "human", id: "carol" }, "editor", ALICE);
    await expect(code(tasks.claim(taskId, CAROL))).resolves.toBe("NO_ERROR");
    await expect(code(tasks.addColumn(boardId, "Done", CAROL))).resolves.toBe("NO_ERROR");
    await expect(code(tasks.shareBoard(boardId, { kind: "human", id: "dave" }, "viewer", CAROL))).resolves.toBe("FORBIDDEN");
  });

  it("gives nothing on another board", async () => {
    await tasks.shareBoard(boardId, { kind: "human", id: "carol" }, "editor", ALICE);
    const other = await tasks.createBoard({ title: "Other" }, ALICE);
    await expect(code(tasks.getBoard(other.id, CAROL))).resolves.toBe("FORBIDDEN");
  });

  it("removes access on unshare and keeps the last owner", async () => {
    await tasks.shareBoard(boardId, { kind: "human", id: "carol" }, "editor", ALICE);
    await tasks.unshareBoard(boardId, { kind: "human", id: "carol" }, ALICE);
    await expect(code(tasks.getBoard(boardId, CAROL))).resolves.toBe("FORBIDDEN");
    await expect(code(tasks.unshareBoard(boardId, { kind: "human", id: "alice" }, ALICE))).resolves.toBe("INVALID_INPUT");
  });

  it("cuts an agent down to the scopes that its chain leaves", async () => {
    // alice owns the board. The agent acts for her with write scope only.
    const agent: PrincipalContext = {
      principalId: "bot-9",
      kind: "agent_of_human",
      chain: [
        { id: "alice", kind: "human" },
        { id: "bot-9", kind: "agent_of_human" },
      ],
      scopes: ["board:write"],
    };
    await expect(code(tasks.claim(taskId, agent))).resolves.toBe("NO_ERROR");
    await expect(code(tasks.shareBoard(boardId, { kind: "human", id: "dave" }, "viewer", agent))).resolves.toBe("FORBIDDEN");
    const readOnly = { ...agent, scopes: ["board:read"] };
    await expect(code(tasks.getTask(taskId, readOnly))).resolves.toBe("NO_ERROR");
    await expect(code(tasks.updateTask(taskId, { title: "x" }, readOnly))).resolves.toBe("FORBIDDEN");
  });

  // Failure list for admin audit entries, written before the fix:
  //  a. An editor closes a task with no claim: no admin entry at all.
  //  b. An editor holds a claim, then releases it or closes: no admin entry.
  //  c. An editor is refused on another's claim (release or close): one real
  //     admin denial, and the refusal itself still stands.
  //  d. An owner who breaks another's claim: one admin allowed entry.
  describe("admin audit entries", () => {
    const adminEntries = async () =>
      (await createSharing(store).listAudit(ALICE, boardId, { limit: 200 })).entries.filter(
        (e) => e.principalId === "carol" && e.action === "admin",
      );

    beforeEach(async () => {
      await tasks.shareBoard(boardId, { kind: "human", id: "carol" }, "editor", ALICE);
    });

    it("writes none when a non-owner closes a task that has no claim", async () => {
      await tasks.closeTask(taskId, CAROL);
      expect(await adminEntries()).toEqual([]);
    });

    it("writes none when a non-owner releases a task that has no claim", async () => {
      await expect(code(tasks.release(taskId, CAROL))).resolves.toBe("NOT_HOLDER");
      expect(await adminEntries()).toEqual([]);
    });

    it("writes none when a non-owner holder releases or closes its own claim", async () => {
      await tasks.claim(taskId, CAROL);
      await tasks.release(taskId, CAROL);
      await tasks.claim(taskId, CAROL);
      await tasks.closeTask(taskId, CAROL);
      expect(await adminEntries()).toEqual([]);
    });

    it("writes one denial when a non-owner is refused another's claim", async () => {
      await tasks.claim(taskId, ALICE);
      await expect(code(tasks.release(taskId, CAROL))).resolves.toBe("NOT_HOLDER");
      expect(await adminEntries()).toMatchObject([{ outcome: "denied" }]);
      await expect(code(tasks.closeTask(taskId, CAROL))).resolves.toBe("CLAIM_HELD");
      expect(await adminEntries()).toMatchObject([{ outcome: "denied" }, { outcome: "denied" }]);
    });

    it("writes one allowed entry when an owner breaks another's claim", async () => {
      const mine = async () =>
        (await createSharing(store).listAudit(ALICE, boardId, { limit: 200 })).entries.filter(
          (e) => e.principalId === "alice" && e.action === "admin",
        );
      await tasks.claim(taskId, CAROL);
      const before = (await mine()).length;
      await tasks.release(taskId, ALICE);
      const after = await mine();
      expect(after).toHaveLength(before + 1);
      expect(after.every((e) => e.outcome === "allowed")).toBe(true);
    });
  });

  it("needs the board:write scope to make a board", async () => {
    const narrow = { ...ALICE, scopes: ["board:read"] };
    await expect(code(tasks.createBoard({ title: "No" }, narrow))).resolves.toBe("FORBIDDEN");
  });

  it("writes an audit entry that labels an agent as machine-made", async () => {
    const agent: PrincipalContext = {
      principalId: "bot-9",
      kind: "agent_of_human",
      chain: [
        { id: "alice", kind: "human" },
        { id: "bot-9", kind: "agent_of_human" },
      ],
      scopes: ["board:write"],
    };
    await tasks.claim(taskId, agent);
    const { entries: audit } = await createSharing(store).listAudit(ALICE, boardId);
    const entry = audit.find((e) => e.principalId === "bot-9");
    expect(entry).toMatchObject({ principalKind: "agent_of_human", machineMade: true, outcome: "allowed" });
    expect(entry?.chain.map((step) => step.id)).toEqual(["alice", "bot-9"]);
  });

  // Each guard is checked on its own: a refactor that drops or weakens one fails here.
  describe.each([
    ["a caller with no role", undefined],
    ["a viewer", "viewer"],
    ["a commenter", "commenter"],
  ] as const)("%s", (_who, role) => {
    beforeEach(async () => {
      if (role !== undefined) await tasks.shareBoard(boardId, { kind: "human", id: "carol" }, role, ALICE);
    });

    it.each([
      ["closeTask", (t: Tasks) => t.closeTask(taskId, CAROL)],
      ["moveTask", (t: Tasks) => t.moveTask(taskId, { columnId: "x" }, CAROL)],
      ["addColumn", (t: Tasks) => t.addColumn(boardId, "Done", CAROL)],
      ["createTask", (t: Tasks) => t.createTask({ boardId, title: "T" }, CAROL)],
      ["release", (t: Tasks) => t.release(taskId, CAROL)],
      ["updateTask", (t: Tasks) => t.updateTask(taskId, { title: "x" }, CAROL)],
      ["claim", (t: Tasks) => t.claim(taskId, CAROL)],
    ])("is refused on %s", async (_name, call) => {
      await expect(code(call(tasks))).resolves.toBe("FORBIDDEN");
    });
  });

  it("refuses a caller with no role the progress list", async () => {
    await expect(code(tasks.listProgress(taskId, CAROL))).resolves.toBe("FORBIDDEN");
  });

  it("refuses a claim with a time to live over one day", async () => {
    await expect(code(tasks.claim(taskId, ALICE, { ttlMs: 86_400_001 }))).resolves.toBe("INVALID_INPUT");
    await expect(code(tasks.claim(taskId, ALICE, { ttlMs: 86_400_000 }))).resolves.toBe("NO_ERROR");
  });

  it("lets an owner release and close over a claim that an editor holds", async () => {
    await tasks.shareBoard(boardId, { kind: "human", id: "carol" }, "editor", ALICE);
    await tasks.claim(taskId, CAROL);
    await tasks.unshareBoard(boardId, { kind: "human", id: "carol" }, ALICE);
    // carol has no role now, so she cannot release. The owner can.
    await expect(code(tasks.release(taskId, CAROL))).resolves.toBe("FORBIDDEN");
    await expect(code(tasks.release(taskId, ALICE))).resolves.toBe("NO_ERROR");
    await tasks.shareBoard(boardId, { kind: "human", id: "dave" }, "editor", ALICE);
    const DAVE = trustedContext("dave", "human");
    await tasks.claim(taskId, DAVE);
    await expect(code(tasks.closeTask(taskId, ALICE))).resolves.toBe("NO_ERROR");
  });

  it("does not let an editor release or close over another principal's claim", async () => {
    await tasks.shareBoard(boardId, { kind: "human", id: "carol" }, "editor", ALICE);
    await tasks.shareBoard(boardId, { kind: "human", id: "dave" }, "editor", ALICE);
    await tasks.claim(taskId, CAROL);
    const DAVE = trustedContext("dave", "human");
    await expect(code(tasks.release(taskId, DAVE))).resolves.toBe("NOT_HOLDER");
    await expect(code(tasks.closeTask(taskId, DAVE))).resolves.toBe("CLAIM_HELD");
  });

  it("refuses an owner who lowers their own role, so a board keeps an owner", async () => {
    await expect(code(tasks.shareBoard(boardId, { kind: "human", id: "alice" }, "viewer", ALICE))).resolves.toBe("INVALID_INPUT");
    await expect(code(tasks.shareBoard(boardId, { kind: "human", id: "alice" }, "owner", ALICE))).resolves.toBe("NO_ERROR");
  });

  it("writes an audit entry when an agent makes a board", async () => {
    const agent: PrincipalContext = {
      principalId: "bot-9",
      kind: "agent_of_human",
      chain: [
        { id: "alice", kind: "human" },
        { id: "bot-9", kind: "agent_of_human" },
      ],
      scopes: ["board:write"],
    };
    const made = await tasks.createBoard({ title: "By agent" }, agent);
    const { entries: audit } = await createSharing(store).listAudit(ALICE, made.id);
    expect(audit.find((e) => e.principalId === "bot-9")).toMatchObject({ machineMade: true, outcome: "allowed" });
  });
});
