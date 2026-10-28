import {
  PRINCIPAL_KINDS,
  TaskError,
  type Board,
  type Claim,
  type Principal,
  type PrincipalKind,
  type ProgressEntry,
  type Task,
  type TaskStatus,
} from "./model.js";
import type { Store, Tx } from "./store.js";

const DEFAULT_CLAIM_TTL_MS = 30 * 60 * 1000;

export interface TasksOptions {
  store: Store;
  now?: () => Date;
}

export interface NewBoard {
  title: string;
}

export interface NewTask {
  boardId: string;
  title: string;
  description?: string;
  columnId?: string;
  labels?: string[];
  dueDate?: string | null;
  assignees?: Principal[];
}

export interface TaskPatch {
  title?: string;
  description?: string;
  labels?: string[];
  dueDate?: string | null;
  assignees?: Principal[];
}

export interface MoveTarget {
  columnId: string;
  position?: number;
}

export interface ClaimOptions {
  ttlMs?: number;
}

export interface TaskFilter {
  boardId?: string;
  columnId?: string;
  status?: TaskStatus;
}

export interface Tasks {
  createBoard(input: NewBoard, actor: Principal): Promise<Board>;
  getBoard(id: string): Promise<Board>;
  addColumn(boardId: string, name: string, actor: Principal): Promise<Board>;
  createTask(input: NewTask, actor: Principal): Promise<Task>;
  getTask(id: string): Promise<Task>;
  listTasks(filter?: TaskFilter): Promise<Task[]>;
  moveTask(id: string, target: MoveTarget, actor: Principal): Promise<Task>;
  updateTask(id: string, patch: TaskPatch, actor: Principal): Promise<Task>;
  closeTask(id: string, actor: Principal): Promise<Task>;
  claim(id: string, principal: Principal, options?: ClaimOptions): Promise<Task>;
  release(id: string, principal: Principal): Promise<Task>;
  progress(id: string, note: string, actor: Principal): Promise<ProgressEntry>;
  listProgress(id: string): Promise<ProgressEntry[]>;
}

function invalid(message: string): TaskError {
  return new TaskError("INVALID_INPUT", message);
}

function assertPrincipal(value: unknown): asserts value is Principal {
  const candidate = value as Partial<Principal> | undefined;
  const knownKind = PRINCIPAL_KINDS.includes(candidate?.kind as PrincipalKind);
  if (typeof candidate?.id !== "string" || candidate.id.trim() === "" || !knownKind) {
    throw invalid("principal needs a non-empty id and a known kind");
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeLabels(labels: unknown): string[] {
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string")) {
    throw invalid("labels must be a list of strings");
  }
  const cleaned = labels.map((label: string) => label.trim()).filter((label) => label !== "");
  return [...new Set(cleaned)];
}

function normalizeAssignees(assignees: unknown): Principal[] {
  if (!Array.isArray(assignees)) throw invalid("assignees must be a list");
  assignees.forEach(assertPrincipal);
  return assignees.map((p: Principal) => ({ id: p.id, kind: p.kind }));
}

function normalizeDueDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalid("dueDate must be YYYY-MM-DD or null");
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw invalid("dueDate is not a real calendar date");
  }
  return value;
}

function requireBoard(tx: Tx, id: string) {
  const board = tx.get<Board>("boards", id);
  if (!board) throw new TaskError("NOT_FOUND", `board ${id} does not exist`);
  return board;
}

function requireTask(tx: Tx, id: string): Task {
  const task = tx.get<Task>("tasks", id);
  if (!task) throw new TaskError("NOT_FOUND", `task ${id} does not exist`);
  return task;
}

function requireOpen(task: Task): void {
  if (task.status === "closed") {
    throw new TaskError("TASK_CLOSED", `task ${task.id} is closed`);
  }
}

function requireColumn(board: Board, columnId: string): void {
  if (!board.columns.some((column) => column.id === columnId)) {
    throw invalid(`board ${board.id} has no column ${columnId}`);
  }
}

function samePrincipal(a: Principal, b: Principal): boolean {
  return a.id === b.id && a.kind === b.kind;
}

// A claim is live until its expiry instant. At the instant itself it has expired.
// An expiry that does not parse counts as live, so a corrupt claim blocks others.
function isLive(claim: Claim, nowMs: number): boolean {
  const expiresMs = Date.parse(claim.expiresAt);
  return !Number.isFinite(expiresMs) || expiresMs > nowMs;
}

function nextPosition(siblings: Task[]): number {
  if (siblings.length === 0) return 0;
  return Math.max(...siblings.map((task) => task.position)) + 1;
}

function touch(task: Task, actor: Principal, at: string): void {
  task.updatedBy = { id: actor.id, kind: actor.kind };
  task.updatedAt = at;
}

export function createTasks(options: TasksOptions): Tasks {
  const { store } = options;
  const clock = options.now ?? (() => new Date());

  return {
    async createBoard(input, actor) {
      assertPrincipal(actor);
      const title = requireText(input.title, "title");
      const at = clock().toISOString();
      const board: Board = {
        id: crypto.randomUUID(),
        title,
        columns: [],
        createdBy: { id: actor.id, kind: actor.kind },
        createdAt: at,
        updatedAt: at,
      };
      return store.transaction((tx) => {
        tx.put("boards", board);
        return board;
      });
    },

    async getBoard(id) {
      return store.transaction((tx) => requireBoard(tx, id));
    },

    async addColumn(boardId, name, actor) {
      assertPrincipal(actor);
      const columnName = requireText(name, "column name");
      return store.transaction((tx) => {
        const board = requireBoard(tx, boardId);
        if (board.columns.some((column) => column.name === columnName)) {
          throw invalid(`board ${boardId} already has a column named ${columnName}`);
        }
        board.columns.push({ id: crypto.randomUUID(), name: columnName });
        board.updatedAt = clock().toISOString();
        tx.put("boards", board);
        return board;
      });
    },

    async createTask(input, actor) {
      assertPrincipal(actor);
      const title = requireText(input.title, "title");
      const labels = normalizeLabels(input.labels ?? []);
      const dueDate = normalizeDueDate(input.dueDate ?? null);
      const assignees = normalizeAssignees(input.assignees ?? []);
      const description = input.description ?? "";
      if (typeof description !== "string") throw invalid("description must be a string");
      return store.transaction((tx) => {
        const board = requireBoard(tx, input.boardId);
        if (board.columns.length === 0) {
          throw invalid(`board ${board.id} has no columns`);
        }
        const columnId = input.columnId ?? board.columns[0]!.id;
        requireColumn(board, columnId);
        const at = clock().toISOString();
        const task: Task = {
          id: crypto.randomUUID(),
          boardId: board.id,
          title,
          description,
          columnId,
          position: nextPosition(tx.list<Task>("tasks", { boardId: board.id, columnId })),
          labels,
          dueDate,
          assignees,
          status: "open",
          createdBy: { id: actor.id, kind: actor.kind },
          createdAt: at,
          updatedBy: { id: actor.id, kind: actor.kind },
          updatedAt: at,
        };
        tx.put("tasks", task);
        return task;
      });
    },

    async getTask(id) {
      return store.transaction((tx) => requireTask(tx, id));
    },

    async listTasks(filter = {}) {
      return store.transaction((tx) =>
        tx
          .list<Task>("tasks", {
            boardId: filter.boardId,
            columnId: filter.columnId,
            status: filter.status,
          })
          .sort((a, b) => a.position - b.position),
      );
    },

    async moveTask(id, target, actor) {
      assertPrincipal(actor);
      if (target.position !== undefined && !Number.isInteger(target.position)) {
        throw invalid("position must be an integer");
      }
      return store.transaction((tx) => {
        const task = requireTask(tx, id);
        requireOpen(task);
        requireColumn(requireBoard(tx, task.boardId), target.columnId);
        const siblings = tx
          .list<Task>("tasks", { boardId: task.boardId, columnId: target.columnId })
          .filter((other) => other.id !== task.id);
        task.columnId = target.columnId;
        task.position = target.position ?? nextPosition(siblings);
        touch(task, actor, clock().toISOString());
        tx.put("tasks", task);
        return task;
      });
    },

    async updateTask(id, patch, actor) {
      assertPrincipal(actor);
      return store.transaction((tx) => {
        const task = requireTask(tx, id);
        requireOpen(task);
        if (patch.title !== undefined) task.title = requireText(patch.title, "title");
        if (patch.description !== undefined) {
          if (typeof patch.description !== "string") {
            throw invalid("description must be a string");
          }
          task.description = patch.description;
        }
        if (patch.labels !== undefined) task.labels = normalizeLabels(patch.labels);
        if (patch.dueDate !== undefined) task.dueDate = normalizeDueDate(patch.dueDate);
        if (patch.assignees !== undefined) {
          task.assignees = normalizeAssignees(patch.assignees);
        }
        touch(task, actor, clock().toISOString());
        tx.put("tasks", task);
        return task;
      });
    },

    async closeTask(id, actor) {
      assertPrincipal(actor);
      return store.transaction((tx) => {
        const task = requireTask(tx, id);
        requireOpen(task);
        const now = clock();
        const at = now.toISOString();
        const claim = task.claim;
        if (
          claim !== undefined &&
          isLive(claim, now.getTime()) &&
          !samePrincipal(claim.holder, actor)
        ) {
          throw new TaskError(
            "CLAIM_HELD",
            `task ${id} is held by another principal until ${claim.expiresAt}`,
          );
        }
        task.status = "closed";
        task.closedAt = at;
        delete task.claim;
        touch(task, actor, at);
        tx.put("tasks", task);
        return task;
      });
    },

    async claim(id, principal, options = {}) {
      assertPrincipal(principal);
      const ttlMs = options.ttlMs ?? DEFAULT_CLAIM_TTL_MS;
      if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
        throw invalid("ttlMs must be a positive integer");
      }
      return store.transaction((tx) => {
        const task = requireTask(tx, id);
        requireOpen(task);
        const now = clock();
        const nowIso = now.toISOString();
        const current = task.claim;
        const live = current !== undefined && isLive(current, now.getTime());
        if (live && !samePrincipal(current.holder, principal)) {
          throw new TaskError(
            "CLAIM_HELD",
            `task ${id} is held by another principal until ${current.expiresAt}`,
          );
        }
        task.claim = {
          holder: { id: principal.id, kind: principal.kind },
          claimedAt: live ? current.claimedAt : nowIso,
          expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        };
        touch(task, principal, nowIso);
        tx.put("tasks", task);
        return task;
      });
    },

    async release(id, principal) {
      assertPrincipal(principal);
      return store.transaction((tx) => {
        const task = requireTask(tx, id);
        if (task.claim === undefined || !samePrincipal(task.claim.holder, principal)) {
          throw new TaskError("NOT_HOLDER", `only the holder can release task ${id}`);
        }
        delete task.claim;
        touch(task, principal, clock().toISOString());
        tx.put("tasks", task);
        return task;
      });
    },

    async progress(id, note, actor) {
      assertPrincipal(actor);
      const text = requireText(note, "note");
      return store.transaction((tx) => {
        const task = requireTask(tx, id);
        requireOpen(task);
        const entry: ProgressEntry = {
          id: crypto.randomUUID(),
          taskId: task.id,
          note: text,
          by: { id: actor.id, kind: actor.kind },
          at: clock().toISOString(),
        };
        tx.put("progress", entry);
        return entry;
      });
    },

    async listProgress(id) {
      return store.transaction((tx) => {
        requireTask(tx, id);
        return tx
          .list<ProgressEntry>("progress", { taskId: id })
          .sort((a, b) => a.at.localeCompare(b.at));
      });
    },
  };
}
