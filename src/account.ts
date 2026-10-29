// The package's side of the account contract: a host calls `exportAccount` and `eraseAccount`
// and never reads the storage layout. The shape is provisional: it is the contract that the next
// `agentic-identity` release adds to `agentic-identity/account` as `AccountPackage`. The released 0.6.x has no such type.
import type { PrincipalContext } from "agentic-identity";
import type { Principal } from "./model.js";
import { PRINCIPAL_KINDS } from "./model.js";
import type { Tasks } from "./tasks.js";

export interface TasksAccountDeps {
  tasks: Tasks;
  /** The subject's own context. The package checks that it names the subject. */
  ctx: PrincipalContext;
}

type JsonRecord = Record<string, unknown>;

export interface TasksAccount {
  id: "tasks";
  /** Collections: `boards` (each with the subject's `role`), `tasks` (the ones the subject made, changed, holds, or is assigned to), and `notes` (the subject's own). */
  exportAccount(subject: Principal, deps: TasksAccountDeps): Promise<Record<string, JsonRecord[]>>;
  /** Erases the boards the subject created and still owns, with their tasks and notes. Counts by `boards`, `tasks`, and `notes`. */
  eraseAccount(subject: Principal, deps: TasksAccountDeps): Promise<Record<string, number>>;
}

// Through JSON, so the records are what a file would hold: a key with no value is dropped, not left as `undefined`.
const plain = (value: unknown): JsonRecord[] => JSON.parse(JSON.stringify(value)) as JsonRecord[];

function check(subject: Principal, deps: TasksAccountDeps): void {
  const { tasks, ctx } = deps ?? ({} as Partial<TasksAccountDeps>);
  if (typeof tasks?.exportData !== "function" || typeof tasks.eraseBoard !== "function") throw new Error("tasksAccount needs deps.tasks and deps.ctx");
  const known = (PRINCIPAL_KINDS as readonly unknown[]).includes(subject?.kind);
  if (typeof subject?.id !== "string" || subject.id.trim() === "" || !known) throw new Error("subject needs an id and a known kind");
  // One step in the chain: a context that acts for someone else would export or erase that person's roles.
  if (ctx?.principalId !== subject.id || ctx.kind !== subject.kind || ctx.chain?.length !== 1) throw new Error("context does not match the subject");
}

export const tasksAccount: TasksAccount = {
  id: "tasks",
  async exportAccount(subject, deps) {
    check(subject, deps);
    const { tasks, ctx } = deps;
    const out = await tasks.exportData(ctx);
    return {
      boards: plain(out.boards.map(({ board, role }) => ({ ...board, role }))),
      tasks: plain(out.boards.flatMap((b) => b.tasks)),
      notes: plain(out.boards.flatMap((b) => b.notes)),
    };
  },
  async eraseAccount(subject, deps) {
    check(subject, deps);
    const { tasks, ctx } = deps;
    const counts = { boards: 0, tasks: 0, notes: 0 };
    // The export names the role of each board. Only a board the subject made and still owns goes: a board shared with them stays.
    for (const { board, role } of (await tasks.exportData(ctx)).boards) {
      if (role !== "owner" || board.createdBy.id !== subject.id || board.createdBy.kind !== subject.kind) continue;
      const rows = await tasks.listTasks({ boardId: board.id }, ctx);
      let notes = 0;
      for (const task of rows) notes += (await tasks.listProgress(task.id, ctx)).length;
      await tasks.eraseBoard(board.id, ctx);
      counts.boards += 1;
      counts.tasks += rows.length;
      counts.notes += notes;
    }
    return counts;
  },
};
