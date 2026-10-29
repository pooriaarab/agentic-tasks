// The package's side of the account contract: a host calls `exportAccount` and `eraseAccount`
// and never reads the storage layout. The shape is provisional: it is the contract that a later
// `agentic-identity` release adds to `agentic-identity/account` as `AccountPackage`. The `AccountApp` of earlier releases is a different contract, and this does not fit it.
import type { PrincipalContext } from "agentic-identity";
import type { Principal, Task } from "./model.js";
import { PRINCIPAL_KINDS, TaskError } from "./model.js";
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
  /** Erases the boards the subject created and still owns, with their tasks and notes. Counts by `boards`, `tasks`, and `notes`. The tasks and notes of other people on those boards go too, and are counted. A failure names the board id. A repeat finds the board again and counts what is left, so a count is the sum of the runs. A subject that is an agent needs a one-step context rooted in itself (as `trustedContext` makes): a delegated chain is refused. */
  eraseAccount(subject: Principal, deps: TasksAccountDeps): Promise<Record<"boards" | "tasks" | "notes", number>>;
}

// Through JSON, so the records are what a file would hold: a key with no value is dropped, not left as `undefined`.
const plain = (value: unknown): JsonRecord[] => JSON.parse(JSON.stringify(value)) as JsonRecord[];

function check(subject: Principal, deps: TasksAccountDeps): void {
  const { tasks, ctx } = deps ?? ({} as Partial<TasksAccountDeps>);
  if ((["exportData", "listTasks", "listProgress", "deleteTask", "eraseBoard"] as const).some((name) => typeof tasks?.[name] !== "function")) throw new TaskError("INVALID_INPUT", "tasksAccount needs deps.tasks and deps.ctx");
  const known = (PRINCIPAL_KINDS as readonly unknown[]).includes(subject?.kind);
  if (typeof subject?.id !== "string" || subject.id.trim() === "" || !known) throw new TaskError("INVALID_INPUT", "subject needs an id and a known kind");
  // One step in the chain, and it is the subject: a role belongs to the root of the chain, so a context with
  // another root would export or erase that person's boards. The root kind is the role kind of the subject
  // (a person or a user token is `human`, every agent kind is `agent`), as in `trustedContext`.
  const root = ctx?.chain?.length === 1 ? ctx.chain[0] : undefined;
  const rootKind = subject.kind === "human" || subject.kind === "user_token" ? "human" : subject.kind.startsWith("agent") ? "agent" : subject.kind;
  if (ctx?.principalId !== subject.id || ctx.kind !== subject.kind || root?.id !== subject.id || root.kind !== rootKind) throw new TaskError("FORBIDDEN", "context does not match the subject");
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
        // Each task goes first, with its notes, and the board last. `eraseBoard` deletes the board row before its tasks, so a stop
    // inside it would hide the board from the next run. Here a stop leaves the board row in place, and the next run finds it and goes on.
    for (const { board, role } of (await tasks.exportData(ctx)).boards) {
      const by = board.createdBy as Partial<Principal> | null | undefined;
      if (role !== "owner") continue;
      // An owned board whose creator is not a valid principal cannot be matched to the subject. Erasing it by guess would be wrong,
      // and skipping it would read as done, so the run stops and names the board.
      const valid = typeof by?.id === "string" && by.id !== "" && (PRINCIPAL_KINDS as readonly unknown[]).includes(by.kind);
      if (!valid) throw new TaskError("INVALID_INPUT", `erase stopped at board ${board.id}: its creator is not a valid principal. ${counts.boards} boards, ${counts.tasks} tasks, and ${counts.notes} notes were erased before it`);
      if (by.id !== subject.id || by.kind !== subject.kind) continue;
      try {
        const rows: Task[] = await tasks.listTasks({ boardId: board.id }, ctx);
        // A task row with no id cannot be deleted by id. Stop before anything goes, so a retry stops the same way and never reads as done.
        if (rows.some((t) => typeof t.id !== "string" || t.id === "")) throw new Error("a task row has no id");
        for (const task of rows) {
          const notes = (await tasks.listProgress(task.id, ctx)).length;
          await tasks.deleteTask(task.id, ctx);
          counts.tasks += 1;
          counts.notes += notes;
        }
        await tasks.eraseBoard(board.id, ctx);
        counts.boards += 1;
      } catch (cause) {
        // The board id is not personal data. A run that is repeated finds the board again and counts only what is left.
        const code = cause instanceof TaskError ? cause.code : "INVALID_INPUT";
        throw new TaskError(code, `erase stopped at board ${board.id}: ${counts.boards} boards, ${counts.tasks} tasks, and ${counts.notes} notes were erased before it`);
      }
    }
    return counts;
  },
};
