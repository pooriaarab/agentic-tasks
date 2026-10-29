import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryStore, type Store } from "agentic-identity";
import { createFileStore } from "./file-store.js";
import { openLocalD1 } from "./worker-harness.js";
import { trustedContext } from "./principal.js";
import { createTasks, type Tasks } from "./tasks.js";

// Failure list, written before the test. Two owners each remove the other at the
// same moment, through two Tasks on two stores that share the data. A gate holds
// both transactions until both have started, so the two reads come before the
// two writes on every store. Without the gate the calls run one after the other.
//  1. Each demotes the other to editor: both reads see two owners, and both
//     writes could go through. The board must keep one owner.
//  2. Each unshares the other: the same.
//  3. One demotes and the other unshares: the same.
// One lucky round is not proof, so each case runs many rounds.
const ALICE = trustedContext("alice", "human");
const BOB = trustedContext("bob", "human");
// A D1 round is slow, so it runs fewer rounds. Without the guard, every D1 round fails.
const ROUNDS: Record<string, number> = { memory: 25, file: 25, D1: 5 };

type Open = () => Promise<{ one: Store; two: Store; cleanup: () => Promise<void> }>;

const backends: [string, Open][] = [
  [
    "memory",
    async () => {
      const shared = `owners-${crypto.randomUUID()}`;
      return {
        one: createMemoryStore({ region: "eu", shared }),
        two: createMemoryStore({ region: "eu", shared }),
        cleanup: async () => {},
      };
    },
  ],
  [
    "file",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "agentic-tasks-owners-"));
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
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "agentic-tasks-owners-d1-"));
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

// Local D1 can answer a busy error for a write that did not apply. A client sends
// it again, and a call that is sent again after the other one won is refused.
async function retried<T>(work: () => Promise<T>): Promise<T> {
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

// Holds each transaction of a store until `n` of them are waiting, so the two
// removals read the grants before either one writes. Without it, the checks that
// run before the transaction can make one call end first, and nothing overlaps.
function gated(store: Store, gate: { wait: (() => Promise<void>) | undefined }): Store {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "transaction") {
        return async (body: Parameters<Store["transaction"]>[0]) => {
          await gate.wait?.();
          return target.transaction(body);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  return () => {
    arrived += 1;
    if (arrived >= n) release();
    return open;
  };
}

const DEMOTE = (t: Tasks, board: string, who: string, by: typeof ALICE) => t.shareBoard(board, { kind: "human", id: who }, "editor", by);
const UNSHARE = (t: Tasks, board: string, who: string, by: typeof ALICE) => t.unshareBoard(board, { kind: "human", id: who }, by);
type Move = typeof DEMOTE;

describe.each(backends)("owner removal on the %s store", (name, open) => {
  it.each([
    ["demote and demote", DEMOTE, DEMOTE],
    ["unshare and unshare", UNSHARE, UNSHARE],
    ["demote and unshare", DEMOTE, UNSHARE],
  ] as [string, Move, Move][])("keeps an owner when two owners %s each other", async (_label, first, second) => {
    const { one, two, cleanup } = await open();
    try {
      const gate: { wait: (() => Promise<void>) | undefined } = { wait: undefined };
      const tasksOne = createTasks({ store: gated(one, gate) });
      const tasksTwo = createTasks({ store: gated(two, gate) });
      for (let round = 0; round < (ROUNDS[name] ?? 25); round += 1) {
        const board = await tasksOne.createBoard({ title: "Sprint" }, ALICE);
        await tasksOne.shareBoard(board.id, { kind: "human", id: "bob" }, "owner", ALICE);
        gate.wait = barrier(2);
        const results = await Promise.allSettled([
          retried(() => first(tasksOne, board.id, "bob", ALICE)),
          retried(() => second(tasksTwo, board.id, "alice", BOB)),
        ]);
        gate.wait = undefined;
        // Exactly one removal works. The other is refused, as it would take the
        // last owner or comes from an owner who has just lost the role. A guard
        // that refuses both, or a store error on both, fails here.
        const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(["INVALID_INPUT", "FORBIDDEN"]).toContain((refused[0]!.reason as { code?: string }).code);
        const owners = await one.query("grants", { where: { resourceId: board.id, role: "owner" }, limit: 10 });
        // The caller that won removed the other, so it is the one owner left.
        expect(owners.items.map((item) => item.data.subjectId)).toEqual([results[0].status === "fulfilled" ? "alice" : "bob"]);
      }
    } finally {
      await cleanup();
    }
  }, 60_000);
});
