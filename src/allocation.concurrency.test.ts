import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryStore, type Query, type Store, type StoreOps } from "agentic-identity";
import { createFileStore } from "./file-store.js";
import { trustedContext } from "./principal.js";
import { createTasks } from "./tasks.js";
import { openLocalD1 } from "./worker-harness.js";

// Failure list, written before the code. Writers on two Tasks over two stores
// that share the data all work at the same moment.
//  1. Many createTask calls on one column: every position is different.
//  2. Many moveTask calls into one column with no position: every position is different.
//  3. Many progress notes on one task: every seq is different.
//  4. A column that already holds rows with no counter (an older store) still
//     gets positions above the highest one that exists.
// One lucky round is not proof, so each case runs several rounds.
const ALICE = trustedContext("alice", "human");
const WRITERS = 6;

type Open = () => Promise<{ one: Store; two: Store; cleanup: () => Promise<void> }>;

const backends: [string, number, Open][] = [
  [
    "memory",
    10,
    async () => {
      const shared = `alloc-${crypto.randomUUID()}`;
      return {
        one: createMemoryStore({ region: "eu", shared }),
        two: createMemoryStore({ region: "eu", shared }),
        cleanup: async () => {},
      };
    },
  ],
  [
    "file",
    10,
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "agentic-tasks-alloc-"));
      const file = join(dir, "tasks.json");
      return {
        one: createFileStore(file),
        two: createFileStore(file),
        cleanup: () => rm(dir, { recursive: true, force: true }),
      };
    },
  ],
  [
    "D1",
    3,
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "agentic-tasks-alloc-d1-"));
      const first = await openLocalD1(dir);
      const second = await openLocalD1(dir);
      return {
        one: first.store,
        two: second.store,
        cleanup: async () => {
          await Promise.all([first.dispose(), second.dispose()]);
          await rm(dir, { recursive: true, force: true });
        },
      };
    },
  ],
];

// Local D1 can answer a busy error that did not apply the write. A client sends it again.
async function settled<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= 20 || !/SQLITE_BUSY|database is locked|kept conflicting|session commit token/.test(String(error))) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

// Holds each writer, after its read of the sequence, until both writers have
// read. A broken allocation that reads the highest row (a query on tasks) or the
// counter then always sees the same value in both writers, so the race is certain
// and not left to timing. The wait ends by itself so the test never hangs.
function gated(store: Store, gate: { arrived: number; release: () => void; open: Promise<void> }): Store {
  return {
    ...store,
    transaction: (fn) =>
      store.transaction(async (tx) => {
        let seen = false;
        const hold = async () => {
          if (seen) return;
          seen = true;
          gate.arrived += 1;
          if (gate.arrived >= 2) gate.release();
          await gate.open;
        };
        return fn({
          ...tx,
          get: (async (collection: string, id: string) => {
            const row = await tx.get(collection, id);
            if (collection === "counters") await hold();
            return row;
          }) as StoreOps["get"],
          query: (async (collection: string, q?: Query) => {
            const rows = await tx.query(collection, q);
            if (collection === "tasks") await hold();
            return rows;
          }) as StoreOps["query"],
        });
      }),
  } as Store;
}

const distinct = (numbers: number[]) => new Set(numbers).size === numbers.length;

describe.each(backends)("allocation on the %s store", (_name, rounds, open) => {
  async function setup() {
    const stores = await open();
    const tasksOne = createTasks({ store: stores.one });
    const tasksTwo = createTasks({ store: stores.two });
    const board = await tasksOne.createBoard({ title: "Sprint" }, ALICE);
    const todo = (await tasksOne.addColumn(board.id, "Todo", ALICE)).columns[0]!.id;
    const done = (await tasksOne.addColumn(board.id, "Done", ALICE)).columns[1]!.id;
    const pick = (i: number) => (i % 2 === 0 ? tasksOne : tasksTwo);
    return { ...stores, tasksOne, board: board.id, todo, done, pick };
  }

  it("gives each simultaneous createTask its own position", async () => {
    const s = await setup();
    try {
      for (let round = 0; round < rounds; round += 1) {
        const made = await Promise.all(
          Array.from({ length: WRITERS }, (_, i) =>
            settled(() => s.pick(i).createTask({ boardId: s.board, columnId: s.todo, title: `t${round}-${i}` }, ALICE)),
          ),
        );
        expect(distinct(made.map((task) => task.position as number))).toBe(true);
      }
      const all = await s.tasksOne.listTasks({ boardId: s.board, columnId: s.todo }, ALICE);
      expect(distinct(all.map((task) => task.position as number))).toBe(true);
    } finally {
      await s.cleanup();
    }
  }, 120_000);

  it("gives each simultaneous moveTask its own position", async () => {
    const s = await setup();
    try {
      for (let round = 0; round < rounds; round += 1) {
        const tasks = await Promise.all(
          Array.from({ length: WRITERS }, (_, i) =>
            settled(() => s.pick(i).createTask({ boardId: s.board, columnId: s.todo, title: `m${round}-${i}` }, ALICE)),
          ),
        );
        await Promise.all(tasks.map((task, i) => settled(() => s.pick(i).moveTask(task.id, { columnId: s.done }, ALICE))));
      }
      const all = await s.tasksOne.listTasks({ boardId: s.board, columnId: s.done }, ALICE);
      expect(all).toHaveLength(rounds * WRITERS);
      expect(distinct(all.map((task) => task.position as number))).toBe(true);
    } finally {
      await s.cleanup();
    }
  }, 120_000);

  it("gives each simultaneous progress note its own seq", async () => {
    const s = await setup();
    try {
      const task = await s.tasksOne.createTask({ boardId: s.board, title: "Write spec" }, ALICE);
      for (let round = 0; round < rounds; round += 1) {
        await Promise.all(
          Array.from({ length: WRITERS }, (_, i) => settled(() => s.pick(i).progress(task.id, `n${round}-${i}`, ALICE))),
        );
      }
      const notes = await s.tasksOne.listProgress(task.id, ALICE);
      expect(notes).toHaveLength(rounds * WRITERS);
      expect(distinct(notes.map((note) => note.seq))).toBe(true);
    } finally {
      await s.cleanup();
    }
  }, 120_000);

  it("keeps going above existing rows when the counter is missing, as in an older store", async () => {
    const s = await setup();
    try {
      await s.tasksOne.createTask({ boardId: s.board, columnId: s.todo, title: "a" }, ALICE);
      await s.tasksOne.createTask({ boardId: s.board, columnId: s.todo, title: "b" }, ALICE);
      await s.one.delete("counters", `position:${s.board}:${s.todo}`);
      const next = await s.tasksOne.createTask({ boardId: s.board, columnId: s.todo, title: "c" }, ALICE);
      expect(next.position).toBe(2);
    } finally {
      await s.cleanup();
    }
  }, 120_000);
});

// The file store has no case here. It runs the calls on one path one at a time,
// so the gate could only time out and the test would prove nothing.
describe("allocation with both writers held between read and write", () => {
  it.each(["memory"] as const)("gives two createTask calls on the %s store different positions", async (kind) => {
    const [, , open] = backends.find(([name]) => name === kind)!;
    const stores = await open();
    try {
      const base = createTasks({ store: stores.one });
      const board = await base.createBoard({ title: "Sprint" }, ALICE);
      const col = (await base.addColumn(board.id, "Todo", ALICE)).columns[0]!.id;
      for (let round = 0; round < 3; round += 1) {
        let release!: () => void;
        const open = new Promise<void>((resolve) => {
          release = resolve;
          setTimeout(resolve, 1_000);
        });
        const gate = { arrived: 0, release, open };
        const one = createTasks({ store: gated(stores.one, gate) });
        const two = createTasks({ store: gated(stores.two, gate) });
        const made = await Promise.all([
          settled(() => one.createTask({ boardId: board.id, columnId: col, title: `a${round}` }, ALICE)),
          settled(() => two.createTask({ boardId: board.id, columnId: col, title: `b${round}` }, ALICE)),
        ]);
        expect(distinct(made.map((task) => task.position as number))).toBe(true);
      }
    } finally {
      await stores.cleanup();
    }
  }, 60_000);
});

describe("allocation on bad data", () => {
  it.each([["text", "abc"], ["NaN", Number.NaN], ["fraction", 1.5], ["negative", -3]])(
    "ignores a counter holding %s and stays above existing rows",
    async (_label, bad) => {
      const store = createMemoryStore({ region: "eu" });
      const tasks = createTasks({ store });
      const board = await tasks.createBoard({ title: "Sprint" }, ALICE);
      const col = (await tasks.addColumn(board.id, "Todo", ALICE)).columns[0]!.id;
      await tasks.createTask({ boardId: board.id, columnId: col, title: "a" }, ALICE);
      await tasks.createTask({ boardId: board.id, columnId: col, title: "b" }, ALICE);
      await store.put("counters", `position:${board.id}:${col}`, { id: "x", next: bad as never });
      const next = await tasks.createTask({ boardId: board.id, columnId: col, title: "c" }, ALICE);
      expect(next.position).toBe(2);
    },
  );

  it("refuses a position that is not a safe integer", async () => {
    const tasks = createTasks({ store: createMemoryStore({ region: "eu" }) });
    const board = await tasks.createBoard({ title: "Sprint" }, ALICE);
    const col = (await tasks.addColumn(board.id, "Todo", ALICE)).columns[0]!.id;
    const task = await tasks.createTask({ boardId: board.id, columnId: col, title: "a" }, ALICE);
    await expect(tasks.moveTask(task.id, { columnId: col, position: 2 ** 53 }, ALICE)).rejects.toThrow(/safe integer|integer/);
  });
});
