// Failure cases for the account contract, written before the code.
//  1. A subject with no id or no kind is refused. A context that names someone else is refused:
//     it would export or erase another person's data.
//     A context with more than one step in its chain acts for someone else, and is refused too.
//     A one-step chain whose root is someone else is refused: roles belong to the root.
//  2. Export holds only what the subject touched: tasks they made, changed, hold, or are assigned,
//     and their own notes. Another person's board, tasks, and notes are never in it.
//  3. Export is plain JSON: it survives a JSON round trip, and keeps the principal kind.
//  4. Boards the subject only holds a role on are exported (with the role) and never erased.
//  5. Erase removes a board the subject made and owns, with its tasks and notes, and counts them.
//  6. A board that was shared to the subject with the owner role, but made by another, stays.
//  7. A second erase counts zero. Erase leaves a second person's boards alone.
//  8. A person and an agent with the same id are two subjects.
//  9. A board with a corrupt creator is left alone. An erase that stops names the board it stopped at.
// 10. The collection names stay stable, so a rename fails here before it breaks a host.
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "agentic-identity";
import { createTasks, tasksAccount, trustedContext, type Principal } from "./index.js";

const ANA: Principal = { id: "ana", kind: "human" };
const BOB: Principal = { id: "bob", kind: "human" };
const ANA_BOT: Principal = { id: "ana", kind: "agent_of_human" };
const ctxOf = (p: Principal) => trustedContext(p.id, p.kind);

function setup() {
  const tasks = createTasks({ store: createMemoryStore() });
  const deps = (p: Principal) => ({ tasks, ctx: ctxOf(p) });
  return { tasks, deps };
}

async function board(tasks: ReturnType<typeof setup>["tasks"], owner: Principal, tag: string) {
  const made = await tasks.createBoard({ title: `${tag}-board` }, ctxOf(owner));
  const b = await tasks.addColumn(made.id, "todo", ctxOf(owner));
  const t = await tasks.createTask({ boardId: b.id, title: `${tag}-task` }, ctxOf(owner));
  await tasks.progress(t.id, `${tag}-note`, ctxOf(owner));
  return { b, t };
}

describe("subject", () => {
  it("refuses a bad subject and a context for someone else", async () => {
    const { deps } = setup();
    for (const bad of [{ id: "", kind: "human" }, { id: "ana" }, { id: "ana", kind: "wizard" }, null]) {
      await expect(tasksAccount.exportAccount(bad as never, deps(ANA))).rejects.toThrow(/subject/);
      await expect(tasksAccount.eraseAccount(bad as never, deps(ANA))).rejects.toThrow(/subject/);
    }
    await expect(tasksAccount.exportAccount(ANA, deps(BOB))).rejects.toThrow(/does not match/);
    await expect(tasksAccount.eraseAccount(ANA, deps(ANA_BOT))).rejects.toThrow(/does not match/);
    const acting = { tasks: deps(ANA).tasks, ctx: { ...ctxOf(ANA_BOT), chain: [{ id: "bob", kind: "human" as const }, { id: "ana", kind: "agent" as const }] } };
    await expect(tasksAccount.exportAccount(ANA_BOT, acting as never)).rejects.toThrow(/does not match/);
    await expect(tasksAccount.eraseAccount(ANA_BOT, acting as never)).rejects.toThrow(/does not match/);
    const otherRoot = { tasks: deps(ANA).tasks, ctx: { ...ctxOf(ANA), chain: [{ id: "bob", kind: "human" as const }] } };
    await expect(tasksAccount.exportAccount(ANA, otherRoot as never)).rejects.toThrow(/does not match/);
    await expect(tasksAccount.eraseAccount(ANA, otherRoot as never)).rejects.toThrow(/does not match/);
    await expect(tasksAccount.exportAccount(ANA, {} as never)).rejects.toThrow("needs deps.tasks");
    await expect(tasksAccount.eraseAccount(ANA, undefined as never)).rejects.toThrow("needs deps.tasks");
  });
});

describe("exportAccount", () => {
  it("holds only the subject's data, as plain JSON, under stable names", async () => {
    const { tasks, deps } = setup();
    await board(tasks, ANA, "ana");
    await board(tasks, BOB, "bob");
    const out = await tasksAccount.exportAccount(ANA, deps(ANA));
    expect(Object.keys(out)).toEqual(["boards", "tasks", "notes"]);
    expect(out.boards).toMatchObject([{ title: "ana-board", role: "owner", createdBy: { id: "ana", kind: "human" } }]);
    expect(out.tasks).toMatchObject([{ title: "ana-task" }]);
    expect(out.notes).toMatchObject([{ by: { id: "ana", kind: "human" } }]);
    expect(JSON.stringify(out)).not.toContain("bob");
    expect(JSON.parse(JSON.stringify(out))).toStrictEqual(out);
  });

  it("exports a shared board with the role, and the subject's notes on it", async () => {
    const { tasks, deps } = setup();
    const { b, t } = await board(tasks, BOB, "bob");
    await tasks.shareBoard(b.id, { kind: "human", id: "ana" }, "commenter", ctxOf(BOB));
    await tasks.progress(t.id, "from ana", ctxOf(ANA));
    const out = await tasksAccount.exportAccount(ANA, deps(ANA));
    expect(out.boards).toMatchObject([{ id: b.id, role: "commenter" }]);
    expect(out.notes).toMatchObject([{ note: "from ana" }]);
    expect(out.tasks).toEqual([]);
  });

  it("keeps a person and an agent with one id apart", async () => {
    const { tasks, deps } = setup();
    await board(tasks, ANA, "person");
    const out = await tasksAccount.exportAccount(ANA_BOT, deps(ANA_BOT));
    expect(out.boards).toEqual([]);
  });
});

describe("eraseAccount", () => {
  it("skips a board with a corrupt creator, and names the board when an erase stops", async () => {
    const store = createMemoryStore();
    const tasks = createTasks({ store });
    const deps = (p: Principal) => ({ tasks, ctx: ctxOf(p) });
    const good = await board(tasks, ANA, "good");
    const bad = await board(tasks, ANA, "bad");
    const row = (await store.get("boards", bad.b.id))!;
    await store.put("boards", bad.b.id, { ...row, createdBy: null });
    expect(await tasksAccount.eraseAccount(ANA, deps(ANA))).toEqual({ boards: 1, tasks: 1, notes: 1 });
    expect((await store.get("boards", bad.b.id))).not.toBeNull();
    const failing = { ...tasks, eraseBoard: async () => { throw new Error("db down"); } };
    const second = await board(tasks, ANA, "second");
    const err = await tasksAccount.eraseAccount(ANA, { tasks: failing, ctx: ctxOf(ANA) }).catch((e) => e);
    expect(err.message).toContain(second.b.id);
    expect(err.message).not.toContain(good.b.id);
  });

  it("erases the boards the subject made and owns, counts them, and is safe to run twice", async () => {
    const { tasks, deps } = setup();
    const { b } = await board(tasks, ANA, "ana");
    await tasks.createTask({ boardId: b.id, title: "second" }, ctxOf(ANA));
    await board(tasks, BOB, "bob");
    expect(await tasksAccount.eraseAccount(ANA, deps(ANA))).toEqual({ boards: 1, tasks: 2, notes: 1 });
    expect(await tasksAccount.exportAccount(ANA, deps(ANA))).toEqual({ boards: [], tasks: [], notes: [] });
    expect(await tasksAccount.eraseAccount(ANA, deps(ANA))).toEqual({ boards: 0, tasks: 0, notes: 0 });
    expect((await tasksAccount.exportAccount(BOB, deps(BOB))).boards).toHaveLength(1);
  });

  it("leaves a board that someone else made, even when the subject owns it", async () => {
    const { tasks, deps } = setup();
    const { b } = await board(tasks, BOB, "bob");
    await tasks.shareBoard(b.id, { kind: "human", id: "ana" }, "owner", ctxOf(BOB));
    expect(await tasksAccount.eraseAccount(ANA, deps(ANA))).toEqual({ boards: 0, tasks: 0, notes: 0 });
    expect((await tasksAccount.exportAccount(BOB, deps(BOB))).boards).toHaveLength(1);
  });

  it("erases for one of two subjects with the same id", async () => {
    const { tasks, deps } = setup();
    await board(tasks, ANA, "person");
    await board(tasks, ANA_BOT, "agent");
    expect(await tasksAccount.eraseAccount(ANA_BOT, deps(ANA_BOT))).toMatchObject({ boards: 1 });
    expect((await tasksAccount.exportAccount(ANA, deps(ANA))).boards).toHaveLength(1);
  });
});
