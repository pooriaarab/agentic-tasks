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
import {
  assertId,
  createSharing,
  type Action,
  type Doc,
  type PrincipalContext,
  type Query,
  type Role,
  type Store,
  type StoreOps,
} from "agentic-identity";

const DEFAULT_CLAIM_TTL_MS = 30 * 60 * 1000;
// A claim that lasts for years cannot be undone by a holder who has lost access.
const MAX_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

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
  boardId: string;
  columnId?: string;
  status?: TaskStatus;
}

// Every call names the caller as a principal context from agentic-identity: who
// acts, the chain it acts for, and its scopes. The call then needs a role on the
// board: viewer reads, commenter adds progress notes, editor changes tasks, and
// owner shares the board.
export interface Tasks {
  createBoard(input: NewBoard, ctx: PrincipalContext): Promise<Board>;
  getBoard(id: string, ctx: PrincipalContext): Promise<Board>;
  addColumn(boardId: string, name: string, ctx: PrincipalContext): Promise<Board>;
  createTask(input: NewTask, ctx: PrincipalContext): Promise<Task>;
  getTask(id: string, ctx: PrincipalContext): Promise<Task>;
  listTasks(filter: TaskFilter, ctx: PrincipalContext): Promise<Task[]>;
  moveTask(id: string, target: MoveTarget, ctx: PrincipalContext): Promise<Task>;
  updateTask(id: string, patch: TaskPatch, ctx: PrincipalContext): Promise<Task>;
  closeTask(id: string, ctx: PrincipalContext): Promise<Task>;
  claim(id: string, ctx: PrincipalContext, options?: ClaimOptions): Promise<Task>;
  release(id: string, ctx: PrincipalContext): Promise<Task>;
  progress(id: string, note: string, ctx: PrincipalContext): Promise<ProgressEntry>;
  listProgress(id: string, ctx: PrincipalContext): Promise<ProgressEntry[]>;
  shareBoard(boardId: string, subjectId: string, role: Role, ctx: PrincipalContext): Promise<void>;
  unshareBoard(boardId: string, subjectId: string, ctx: PrincipalContext): Promise<void>;
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

// A context from the caller. A missing or unknown kind is an error, never a default.
function assertContext(value: unknown): asserts value is PrincipalContext {
  const c = value as Partial<PrincipalContext> | undefined;
  const ok =
    typeof c?.principalId === "string" &&
    c.principalId.trim() !== "" &&
    PRINCIPAL_KINDS.includes(c.kind as PrincipalKind) &&
    Array.isArray(c.chain) &&
    c.chain.length > 0 &&
    Array.isArray(c.scopes);
  if (!ok) throw invalid("principal context needs an id, a known kind, a chain, and scopes");
}

function actorOf(ctx: PrincipalContext): Principal {
  return { id: ctx.principalId, kind: ctx.kind };
}

// The sharing calls throw plain errors. Give each one a task error code.
async function shared<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof Error) || error instanceof TaskError) throw error;
    if (error.message === "forbidden") throw new TaskError("FORBIDDEN", "not allowed");
    if (/^(invalid|the last owner)/.test(error.message)) throw invalid(error.message);
    throw error;
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

const NEEDS_OWNER = Symbol("needs owner");

export function createTasks(options: TasksOptions): Tasks {
  const { store } = options;
  const clock = options.now ?? (() => new Date());
  const sharing = createSharing(store, { now: () => clock().getTime() });

  // Needs the role that the action asks for on the board. The check writes an
  // audit entry that keeps the chain and the machine label.
  async function authorize(ctx: PrincipalContext, action: Action, boardId: string): Promise<Board> {
    assertContext(ctx);
    const board = await requireBoard(store, boardId);
    if (!(await sharing.can(ctx, action, board.id)).allowed) {
      throw new TaskError("FORBIDDEN", `not allowed to ${action} board ${board.id}`);
    }
    return board;
  }

  // An owner can break a claim that another principal holds. A holder who lost
  // access cannot release it, and the owner must not be locked out by that.
  // The check writes an audit entry, so ask it only when the answer decides the
  // call. A holder or a task with no claim never needs it, and a refused
  // non-owner leaves a real denial, not a false one.
  async function isOwner(ctx: PrincipalContext, boardId: string): Promise<boolean> {
    return (await sharing.can(ctx, "admin", boardId)).allowed;
  }

  // Runs `body` with a lazy owner answer. When `body` needs it first, it throws
  // NEEDS_OWNER. The answer is then read once, and the transaction runs again.
  async function withOwner<T>(
    ctx: PrincipalContext,
    boardId: string,
    body: (owner: () => boolean) => Promise<T>,
  ): Promise<T> {
    let answer: boolean | undefined;
    const owner = () => {
      if (answer === undefined) throw NEEDS_OWNER;
      return answer;
    };
    for (;;) {
      try {
        return await body(owner);
      } catch (error) {
        if (error !== NEEDS_OWNER) throw error;
        answer = await isOwner(ctx, boardId);
      }
    }
  }

  async function authorizeTask(ctx: PrincipalContext, action: Action, taskId: string): Promise<Task> {
    assertContext(ctx);
    const task = await requireTask(store, taskId);
    await authorize(ctx, action, task.boardId);
    return task;
  }

  return {
    async createBoard(input, ctx) {
      assertContext(ctx);
      const title = requireText(input.title, "title");
      const at = clock().toISOString();
      const actor = actorOf(ctx);
      const board: Board = {
        id: crypto.randomUUID(),
        title,
        columns: [],
        createdBy: actor,
        createdAt: at,
        updatedAt: at,
      };
      // The creator becomes the owner. This needs the board:write scope.
      await shared(() => sharing.createResource(ctx, { id: board.id, type: "board" }));
      // createResource writes no audit entry. This check records who made the board.
      await sharing.can(ctx, "write", board.id);
      await putRow(store, "boards", board);
      return board;
    },

    async getBoard(id, ctx) {
      return authorize(ctx, "read", id);
    },

    async addColumn(boardId, name, ctx) {
      await authorize(ctx, "write", boardId);
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

    async createTask(input, ctx) {
      assertContext(ctx);
      const title = requireText(input.title, "title");
      const labels = normalizeLabels(input.labels ?? []);
      const dueDate = normalizeDueDate(input.dueDate ?? null);
      const assignees = normalizeAssignees(input.assignees ?? []);
      const description = input.description ?? "";
      if (typeof description !== "string") throw invalid("description must be a string");
      await authorize(ctx, "write", input.boardId);
      const actor = actorOf(ctx);
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
          createdBy: actor,
          createdAt: at,
          updatedBy: actor,
          updatedAt: at,
        };
        await putRow(tx, "tasks", task);
        return task;
      });
    },

    async getTask(id, ctx) {
      return authorizeTask(ctx, "read", id);
    },

    // Sorted here, not by the store: the store leaves out a doc whose position is
    // missing, and a corrupt row must still show up in the list.
    async listTasks(filter, ctx) {
      if (typeof filter?.boardId !== "string") throw invalid("boardId is required");
      await authorize(ctx, "read", filter.boardId);
      const rows = await listRows<Task>(store, "tasks", {
        boardId: filter.boardId,
        columnId: filter.columnId,
        status: filter.status,
      });
      return rows.sort(byPosition);
    },

    async moveTask(id, target, ctx) {
      if (target.position !== undefined && !Number.isInteger(target.position)) {
        throw invalid("position must be an integer");
      }
      await authorizeTask(ctx, "write", id);
      const actor = actorOf(ctx);
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

    async updateTask(id, patch, ctx) {
      await authorizeTask(ctx, "write", id);
      const actor = actorOf(ctx);
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

    async closeTask(id, ctx) {
      const checked = await authorizeTask(ctx, "write", id);
      const actor = actorOf(ctx);
      return withOwner(ctx, checked.boardId, (owner) => store.transaction(async (tx) => {
        const task = await requireTask(tx, id);
        requireOpen(task);
        const now = clock();
        const at = now.toISOString();
        if (heldByOther(task.claim, actor, now.getTime()) && !owner()) {
          throw new TaskError("CLAIM_HELD", `task ${id} is held by another principal`);
        }
        task.status = "closed";
        task.closedAt = at;
        delete task.claim;
        touch(task, actor, at);
        await putRow(tx, "tasks", task);
        return task;
      }));
    },

    // The read and the write sit in one transaction. The store checks that the
    // task did not change in between, and runs the body again when it did. So two
    // Worker instances on one database cannot both take the claim.
    async claim(id, ctx, options = {}) {
      await authorizeTask(ctx, "write", id);
      const principal = actorOf(ctx);
      const ttlMs = options.ttlMs ?? DEFAULT_CLAIM_TTL_MS;
      if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_CLAIM_TTL_MS) {
        throw invalid(`ttlMs must be a whole number from 1 to ${MAX_CLAIM_TTL_MS}`);
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
          holder: principal,
          claimedAt: live && typeof current.claimedAt === "string" ? current.claimedAt : nowIso,
          expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        };
        touch(task, principal, nowIso);
        await putRow(tx, "tasks", task);
        return task;
      });
    },

    async release(id, ctx) {
      const checked = await authorizeTask(ctx, "write", id);
      const principal = actorOf(ctx);
      return withOwner(ctx, checked.boardId, (owner) => store.transaction(async (tx) => {
        const task = await requireTask(tx, id);
        if (task.claim === undefined) {
          throw new TaskError("NOT_HOLDER", `only the holder or an owner can release task ${id}`);
        }
        const holds = isWellFormed(task.claim) && samePrincipal(task.claim.holder, principal);
        if (!holds && !owner()) {
          throw new TaskError("NOT_HOLDER", `only the holder or an owner can release task ${id}`);
        }
        delete task.claim;
        touch(task, principal, clock().toISOString());
        await putRow(tx, "tasks", task);
        return task;
      }));
    },

    async progress(id, note, ctx) {
      const text = requireText(note, "note");
      await authorizeTask(ctx, "comment", id);
      const actor = actorOf(ctx);
      return store.transaction(async (tx) => {
        const task = await requireTask(tx, id);
        requireOpen(task);
        const earlier = await listRows<ProgressEntry>(tx, "progress", { taskId: task.id });
        const entry: ProgressEntry = {
          id: crypto.randomUUID(),
          taskId: task.id,
          seq: Math.max(0, ...earlier.map((other) => other.seq).filter(Number.isSafeInteger)) + 1,
          note: text,
          by: actor,
          at: clock().toISOString(),
        };
        await putRow(tx, "progress", entry);
        return entry;
      });
    },

    // Sorted here for the same reason as listTasks: a row with no seq must show.
    async listProgress(id, ctx) {
      await authorizeTask(ctx, "read", id);
      const rows = await listRows<ProgressEntry>(store, "progress", { taskId: id });
      const rank = (entry: ProgressEntry) =>
        Number.isSafeInteger(entry.seq) ? entry.seq : Number.MAX_SAFE_INTEGER;
      return rows.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },

    async shareBoard(boardId, subjectId, role, ctx) {
      await authorize(ctx, "admin", boardId);
      // A grant replaces the old one without the last-owner check. An owner who
      // lowers their own role could leave the board with no owner. Use unshare.
      if (role !== "owner" && subjectId === ctx.chain[0]?.id) {
        throw invalid("an owner cannot lower their own role. Make another owner first, then unshare");
      }
      await shared(() => sharing.grant(ctx, boardId, subjectId, role));
    },

    async unshareBoard(boardId, subjectId, ctx) {
      await authorize(ctx, "admin", boardId);
      await shared(() => sharing.revokeGrant(ctx, boardId, subjectId));
    },
  };
}
