// The package's side of the account contract: a host calls `exportAccount` and `eraseAccount`
// and never reads the storage layout. The shape is provisional: it is the contract that the next
// `agentic-identity` release adds to `agentic-identity/account` as `AccountPackage`. The released 0.6.x has no such type.
import type { PrincipalContext } from "agentic-identity";
import type { Principal, Task } from "./model.js";
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
  exportAccount(subject: Principal, deps: TasksAccountDeps): Promise<Record<"boards" | "tasks" | "notes", JsonRecord[]>>;
  /** Erases the boards the subject created and still owns, with their tasks and notes. Counts by `boards`, `tasks`, and `notes`. The tasks and notes of other people on those boards go too, and are counted. A failure names the board id, so it can be erased by id. A subject that is an agent needs a one-step context rooted in itself (as `trustedContext` makes): a delegated chain is refused. */
  eraseAccount(subject: Principal, deps: TasksAccountDeps): Promise<Record<string, number>>;
}

// Through JSON, so the records are what a file would hold: a key with no value is dropped, not left as `undefined`.
const plain = (value: unknown): JsonRecord[] => JSON.parse(JSON.stringify(value)) as JsonRecord[];

function check(subject: Principal, deps: TasksAccountDeps): void {
  const { tasks, ctx } = deps ?? ({} as Partial<TasksAccountDeps>);
  if (typeof tasks?.exportData !== "function" || typeof tasks.eraseBoard !== "function") throw new Error("tasksAccount needs deps.tasks and deps.ctx");
  const known = (PRINCIPAL_KINDS as readonly unknown[]).includes(subject?.kind);
  if (typeof subject?.id !== "string" || subject.id.trim() === "" || !known) throw new Error("subject needs an id and a known kind");
  // One step in the chain, and it is the subject: a role belongs to the root of the chain, so a context with
  // another root would export or erase that person's boards. The root kind is the role kind of the subject
  // (a person or a user token is `human`, every agent kind is `agent`), as in `trustedContext`.
  const root = ctx?.chain?.length === 1 ? ctx.chain[0] : undefined;
  const rootKind = subject.kind === "human" || subject.kind === "user_token" ? "human" : subject.kind.startsWith("agent") ? "agent" : subject.kind;
  if (ctx?.principalId !== subject.id || ctx.kind !== subject.kind || root?.id !== subject.id || root.kind !== rootKind) throw new Error("context does not match the subject");
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
    // A board row with no valid `createdBy` is skipped, so a corrupt row is never erased by guess.
    // The counts are read just before each erase, so a task added in between goes uncounted.
    for (const { board, role } of (await tasks.exportData(ctx)).boards) {
      const by = board.createdBy as Partial<Principal> | null | undefined;
      if (role !== "owner" || by?.id !== subject.id || by?.kind !== subject.kind) continue;
      let rows: Task[] = [];
      let notes = 0;
      try {
        // A task row with no id cannot own a note query, and `exportData` skips it too: it is erased with the board but not counted.
        rows = (await tasks.listTasks({ boardId: board.id }, ctx)).filter((t) => typeof t.id === "string" && t.id !== "");
        for (const task of rows) notes += (await tasks.listProgress(task.id, ctx)).length;
        await tasks.eraseBoard(board.id, ctx);
      } catch (cause) {
        // The board row may already be gone, and then the next run cannot find the board. The id is not personal data.
        throw new Error(`erase stopped at board ${board.id}: ${counts.boards} boards, ${counts.tasks} tasks, and ${counts.notes} notes were erased before it`, { cause });
      }
      counts.boards += 1;
      counts.tasks += rows.length;
      counts.notes += notes;
    }
    return counts;
  },
};
