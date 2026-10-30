// Failure cases: sole vs shared ownership; all authored data without a current grant;
// delegated machine labels; damaged principals, grants, and parent paths; failed commit and retry;
// published subpath and registry compatibility. Establish these before changing account behavior.
import { createMemoryStore, createSharing, type Store } from "agentic-identity";
import { createAccountRegistry } from "agentic-identity/account";
import { describe, expect, it } from "vitest";
import { tasksAccount } from "./account.js";
import { createTasks, trustedContext } from "./index.js";
const ana = { id: "ana", kind: "human" } as const;
const ctx = trustedContext;
async function setup() {
  const store = createMemoryStore();
  const tasks = createTasks({ store });
  const board = async (owner: string) => {
    const b = await tasks.createBoard({ title: owner }, ctx(owner, "human"));
    await tasks.addColumn(b.id, "todo", ctx(owner, "human"));
    const t = await tasks.createTask({ boardId: b.id, title: owner }, ctx(owner, "human"));
    await tasks.progress(t.id, "note", ctx(owner, "human"));
    return { b, t };
  };
  return { store, tasks, board };
}

describe("account contributor", () => {
  it("exports full owned content through the registry and deletes sole-owned boards", async () => {
    const { store, tasks, board } = await setup();
    const { b } = await board("ana");
    const other = await board("bob");
    await tasks.shareBoard(b.id, { id: "reader", kind: "human" }, "viewer", ctx("ana", "human"));
    const sharing = createSharing(store);
    await sharing.createInvite(ctx("ana", "human"), b.id, { email: "reader@example.test", role: "viewer" });
    await sharing.createLink(ctx("ana", "human"), b.id, { role: "viewer" });
    const registry = createAccountRegistry().register(tasksAccount, { store });
    const out = await tasksAccount.exportAccount(ana, { store });
    expect(out.boards).toMatchObject([{ id: b.id }]);
    expect(out.tasks).toHaveLength(1);
    expect(out.notes).toHaveLength(1);
    expect(out.grants).toHaveLength(2);
    expect(out.invites).toHaveLength(1);
    expect(out.links).toHaveLength(1);
    expect(JSON.stringify(out.links)).not.toContain("tokenHash");
    expect((await registry.export(ana)).manifest.apps[0].files).toHaveLength(7);
    expect((await registry.erase(ana, store, { actor: null })).ok).toBe(true);
    expect(await store.get("boards", b.id)).toBeNull();
    expect(await store.get("resources", b.id)).toBeNull();
    expect(await store.get("boards", other.b.id)).not.toBeNull();
    expect(Object.values(await tasksAccount.eraseAccount(ana, { store })).every(n => n === 0)).toBe(true);
  });

  it("keeps co-owned boards, drops the subject, and finds authorship after access is lost", async () => {
    const { store, tasks, board } = await setup();
    const { b, t } = await board("ana");
    await tasks.shareBoard(b.id, { id: "bob", kind: "human" }, "owner", ctx("ana", "human"));
    const other = await board("bob");
    await tasks.shareBoard(other.b.id, ana, "editor", ctx("bob", "human"));
    await tasks.progress(other.t.id, "authored elsewhere", ctx("ana", "human"));
    await tasks.unshareBoard(other.b.id, ana, ctx("bob", "human"));
    expect((await tasksAccount.exportAccount(ana, { store })).notes).toHaveLength(2);
    await tasksAccount.eraseAccount(ana, { store });
    expect(await store.get("boards", b.id)).toMatchObject({ createdBy: { id: "(erased)", kind: "human" } });
    expect(await store.get("tasks", t.id)).toMatchObject({ createdBy: { id: "(erased)" } });
    expect(await store.get("grants", `${b.id}:human:bob`)).not.toBeNull();
    expect(await store.get("grants", `${b.id}:human:ana`)).toBeNull();
    expect((await store.query("progress")).items).toHaveLength(1);
    expect(Object.values(await tasksAccount.eraseAccount(ana, { store })).every(n => n === 0)).toBe(true);
  });

  it("erases agent authors and preserves their machine kind", async () => {
    const { store, tasks, board } = await setup();
    const { b, t } = await board("bob");
    await tasks.shareBoard(b.id, { id: "bot", kind: "agent" }, "editor", ctx("bob", "human"));
    await tasks.updateTask(t.id, { description: "machine edit" }, ctx("bot", "agent_of_human"));
    const bot = { id: "bot", kind: "agent_of_human" } as const;
    expect((await tasksAccount.exportAccount(bot, { store })).tasks).toHaveLength(1);
    await tasksAccount.eraseAccount(bot, { store });
    expect(await store.get("tasks", t.id)).toMatchObject({ updatedBy: { id: "(erased)", kind: "agent_of_human" } });
    expect(Object.values(await tasksAccount.eraseAccount(bot, { store })).every(n => n === 0)).toBe(true);
  });

  it("fails closed before mutation on damaged records", async () => {
    const { store, board } = await setup();
    const { b, t } = await board("ana");
    for (const [c, id, patch] of [["tasks", t.id, { createdBy: null }], ["resources", b.id, { parentId: "missing" }], ["grants", `${b.id}:human:ana`, { role: "unknown" }]] as const) {
      const original = (await store.get(c, id))!;
      await store.put(c, id, { ...original, ...patch });
      for (const run of [tasksAccount.exportAccount, tasksAccount.eraseAccount]) await expect(run(ana, { store })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(await store.get("boards", b.id)).not.toBeNull();
      await store.put(c, id, original);
    }
  });

  it("keeps a board whose parent folder has another owner", async () => {
    const { store, board } = await setup();
    const { b } = await board("ana");
    await store.put("resources", "team", { id: "team", type: "folder" });
    await store.put("grants", "team:human:bob", { resourceId: "team", subjectId: "bob", subjectKind: "human", role: "owner" });
    const resource = (await store.get("resources", b.id))!;
    await store.put("resources", b.id, { ...resource, parentId: "team" });
    expect((await tasksAccount.eraseAccount(ana, { store })).boards).toBe(1);
    expect(await store.get("boards", b.id)).not.toBeNull();
    expect(await store.get("grants", "team:human:bob")).not.toBeNull();
  });

  it("retries after a failed transaction without losing discovery records", async () => {
    const { store, board } = await setup();
    const { b } = await board("ana");
    const down: Store = { ...store, transaction: fn => store.transaction(async tx => {
      let deletes = 0;
      return fn({ ...tx, delete: async (collection, id) => {
        if (++deletes === 2) throw new Error("offline");
        await tx.delete(collection, id);
      } });
    }) };
    await expect(tasksAccount.eraseAccount(ana, { store: down })).rejects.toThrow("offline");
    expect(await store.get("boards", b.id)).not.toBeNull();
    expect((await tasksAccount.eraseAccount(ana, { store })).boards).toBe(1);
    expect(Object.values(await tasksAccount.eraseAccount(ana, { store })).every(n => n === 0)).toBe(true);
  });
});
