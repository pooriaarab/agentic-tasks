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
import { assertId, type Doc, type Query, type Store, type StoreOps } from "agentic-identity";

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

type Collection = "boards" | "tasks" | "progress";

// An id that the store would refuse cannot name a row, so it names nothing.
async function getRow<T>(ops: StoreOps, collection: Collection, id: string): Promise<T | undefined> {
  try {
    assertId(id);
  } catch {
    return undefined;
  }
  return ((await ops.get(collection, id)) as T | null) ?? undefined;
}

function putRow(ops: StoreOps, collection: Collection, row: { id: string }): Promise<void> {
  return ops.put(collection, row.id, row as unknown as Doc);
}

// Reads every page of a query. Equality filters only, so a Firestore adapter fits.
async function listRows<T>(
  ops: StoreOps,
  collection: Collection,
  where: Record<string, string | undefined>,
  orderBy?: Query["orderBy"],
): Promise<T[]> {
  const filter = Object.fromEntries(
    Object.entries(where).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const rows: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await ops.query(collection, { where: filter, orderBy, cursor });
    rows.push(...page.items.map((item) => item.data as unknown as T));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return rows;
}

async function requireBoard(ops: StoreOps, id: string): Promise<Board> {
  const board = await getRow<Board>(ops, "boards", id);
  if (!board) throw new TaskError("NOT_FOUND", `board ${id} does not exist`);
  return board;
}

async function requireTask(ops: StoreOps, id: string): Promise<Task> {
  const task = await getRow<Task>(ops, "tasks", id);
  if (!task) throw new TaskError("NOT_FOUND", `task ${id} does not exist`);
  return task;
}

function requireOpen(task: Task): void {
  if (task.status !== "open") {
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

// Only the exact form that toISOString writes is a time. Date.parse also reads
// text such as "1" as a past date, which would free a claim that is corrupt.
const STORED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function parseStoredTime(text: string): number {
  if (!STORED_TIME.test(text)) return Number.NaN;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && new Date(ms).toISOString() === text ? ms : Number.NaN;
}

// A claim read from storage may hold any value. Anything but a holder with
// an id and kind, and an expiry text, is corrupt.
function isWellFormed(claim: unknown): claim is Claim {
  const candidate = claim as Partial<Claim> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.holder?.id === "string" &&
    typeof candidate.holder.kind === "string" &&
    typeof candidate.expiresAt === "string"
  );
}

// A claim is live until its expiry instant. At the instant itself it has expired.
// An expiry that does not parse counts as live, so a corrupt claim blocks others.
function isLive(claim: Claim, nowMs: number): boolean {
  const expiresMs = parseStoredTime(claim.expiresAt);
  return !Number.isFinite(expiresMs) || expiresMs > nowMs;
}

// True when another principal holds the task. A corrupt claim counts as held.
function heldByOther(claim: unknown, who: Principal, nowMs: number): boolean {
  if (claim === undefined) return false;
  if (!isWellFormed(claim)) return true;
  return isLive(claim, nowMs) && !samePrincipal(claim.holder, who);
}

// A stored position that is not a whole number is skipped, so one bad row
// cannot give every new task in the column a position that JSON turns to null.
function nextPosition(siblings: Task[]): number {
  const positions = siblings.map((task) => task.position).filter(Number.isSafeInteger);
  return positions.length === 0 ? 0 : Math.max(...positions) + 1;
}

function byPosition(a: Task, b: Task): number {
  const rank = (task: Task) => (Number.isSafeInteger(task.position) ? task.position : Number.MAX_SAFE_INTEGER);
  return rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
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
      await putRow(store, "boards", board);
      return board;
    },

    async getBoard(id) {
      return requireBoard(store, id);
    },

    async addColumn(boardId, name, actor) {
      assertPrincipal(actor);
      const columnName = requireText(name, "column name");
      return store.transaction(async (tx) => {
        const board = await requireBoard(tx, boardId);
        if (board.columns.some((column) => column.name === columnName)) {
          throw invalid(`board ${boardId} already has a column named ${columnName}`);
        }
        board.columns.push({ id: crypto.randomUUID(), name: columnName });
        board.updatedAt = clock().toISOString();
        await putRow(tx, "boards", board);
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
      return store.transaction(async (tx) => {
        const board = await requireBoard(tx, input.boardId);
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
          position: nextPosition(
            await listRows<Task>(tx, "tasks", { boardId: board.id, columnId }),
          ),
          labels,
          dueDate,
          assignees,
          status: "open",
          createdBy: { id: actor.id, kind: actor.kind },
          createdAt: at,
          updatedBy: { id: actor.id, kind: actor.kind },
          updatedAt: at,
        };
        await putRow(tx, "tasks", task);
        return task;
      });
    },

    async getTask(id) {
      return requireTask(store, id);
    },

    // Sorted here, not by the store: the store leaves out a doc whose position is
    // missing, and a corrupt row must still show up in the list.
    async listTasks(filter = {}) {
      const rows = await listRows<Task>(store, "tasks", {
        boardId: filter.boardId,
        columnId: filter.columnId,
        status: filter.status,
      });
      return rows.sort(byPosition);
    },

    async moveTask(id, target, actor) {
      assertPrincipal(actor);
      if (target.position !== undefined && !Number.isInteger(target.position)) {
        throw invalid("position must be an integer");
      }
      return store.transaction(async (tx) => {
        const task = await requireTask(tx, id);
        requireOpen(task);
        requireColumn(await requireBoard(tx, task.boardId), target.columnId);
        const siblings = (
          await listRows<Task>(tx, "tasks", { boardId: task.boardId, columnId: target.columnId })
        ).filter((other) => other.id !== task.id);
        task.columnId = target.columnId;
        task.position = target.position ?? nextPosition(siblings);
        touch(task, actor, clock().toISOString());
        await putRow(tx, "tasks", task);
        return task;
      });
    },

    async updateTask(id, patch, actor) {
      assertPrincipal(actor);
      return store.transaction(async (tx) => {
        const task = await requireTask(tx, id);
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
        await putRow(tx, "tasks", task);
        return task;
      });
    },

    async closeTask(id, actor) {
      assertPrincipal(actor);
      return store.transaction(async (tx) => {
        const task = await requireTask(tx, id);
        requireOpen(task);
        const now = clock();
        const at = now.toISOString();
        if (heldByOther(task.claim, actor, now.getTime())) {
          throw new TaskError("CLAIM_HELD", `task ${id} is held by another principal`);
        }
        task.status = "closed";
        task.closedAt = at;
        delete task.claim;
        touch(task, actor, at);
        await putRow(tx, "tasks", task);
        return task;
      });
    },

    // The read and the write sit in one transaction. The store checks that the
    // task did not change in between, and runs the body again when it did. So two
    // Worker instances on one database cannot both take the claim.
    async claim(id, principal, options = {}) {
      assertPrincipal(principal);
      const ttlMs = options.ttlMs ?? DEFAULT_CLAIM_TTL_MS;
      if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
        throw invalid("ttlMs must be a positive integer");
      }
      return store.transaction(async (tx) => {
        const task = await requireTask(tx, id);
        requireOpen(task);
        const now = clock();
        const nowIso = now.toISOString();
        if (heldByOther(task.claim, principal, now.getTime())) {
          throw new TaskError("CLAIM_HELD", `task ${id} is held by another principal`);
        }
        const current = task.claim;
        const live = current !== undefined && isLive(current, now.getTime());
        task.claim = {
          holder: { id: principal.id, kind: principal.kind },
          claimedAt: live && typeof current.claimedAt === "string" ? current.claimedAt : nowIso,
          expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        };
        touch(task, principal, nowIso);
        await putRow(tx, "tasks", task);
        return task;
      });
    },

    async release(id, principal) {
      assertPrincipal(principal);
      return store.transaction(async (tx) => {
        const task = await requireTask(tx, id);
        if (!isWellFormed(task.claim) || !samePrincipal(task.claim.holder, principal)) {
          throw new TaskError("NOT_HOLDER", `only the holder can release task ${id}`);
        }
        delete task.claim;
        touch(task, principal, clock().toISOString());
        await putRow(tx, "tasks", task);
        return task;
      });
    },

    async progress(id, note, actor) {
      assertPrincipal(actor);
      const text = requireText(note, "note");
      return store.transaction(async (tx) => {
        const task = await requireTask(tx, id);
        requireOpen(task);
        const earlier = await listRows<ProgressEntry>(tx, "progress", { taskId: task.id });
        const entry: ProgressEntry = {
          id: crypto.randomUUID(),
          taskId: task.id,
          seq: Math.max(0, ...earlier.map((other) => other.seq).filter(Number.isSafeInteger)) + 1,
          note: text,
          by: { id: actor.id, kind: actor.kind },
          at: clock().toISOString(),
        };
        await putRow(tx, "progress", entry);
        return entry;
      });
    },

    async listProgress(id) {
      await requireTask(store, id);
      return listRows<ProgressEntry>(store, "progress", { taskId: id }, { field: "seq" });
    },
  };
}
