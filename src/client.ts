// A typed client for the Worker HTTP API. It uses only fetch, URL, and
// AbortSignal, so it runs in browsers, Workers, and Node 22. It never retries:
// a retry of a claim, a note, or a create could apply twice.
import type { Role, Subject } from "agentic-identity";
import type { Board, ProgressEntry, Task, TaskErrorCode, TaskStatus } from "./model.js";
import type { ClaimOptions, MoveTarget, NewTask, TaskPatch } from "./tasks.js";

export type { Board, ProgressEntry, Task, TaskStatus } from "./model.js";
export type { ClaimOptions, MoveTarget, NewTask, TaskPatch } from "./tasks.js";

export type MemberKind = Subject["kind"];
export type BoardRole = Role;

// Codes the task rules return, plus the ones the Worker and its auth return.
export type ApiErrorCode =
  | TaskErrorCode
  | "UNAUTHENTICATED"
  | "STORE_BUSY"
  | "STORE_NOT_CONFIGURED"
  | "REGION_NOT_CONFIGURED"
  | "LOCAL_TEST_AUTH_NOT_LOOPBACK"
  | "INTERNAL"
  // The reply was not an API error body, for example from a proxy.
  | "UNKNOWN";

// Every ApiErrorCode must be a key here, so a new code fails the type check.
const CODES: Record<ApiErrorCode, true> = {
  NOT_FOUND: true,
  FORBIDDEN: true,
  INVALID_INPUT: true,
  CLAIM_HELD: true,
  NOT_HOLDER: true,
  TASK_CLOSED: true,
  UNAUTHENTICATED: true,
  STORE_BUSY: true,
  STORE_NOT_CONFIGURED: true,
  REGION_NOT_CONFIGURED: true,
  LOCAL_TEST_AUTH_NOT_LOOPBACK: true,
  INTERNAL: true,
  UNKNOWN: true,
};
const isKnownCode = (v: unknown): v is ApiErrorCode => typeof v === "string" && Object.hasOwn(CODES, v);

// Thrown for every reply that is not a success. `code` is the API error code and
// `status` is the HTTP status.
export class TasksApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, status: number, message: string) {
    super(message);
    this.name = "TasksApiError";
    this.code = code;
    this.status = status;
  }
}

export interface ClientOptions {
  // The Worker origin, for example https://tasks.example.com. The client adds /api/v1/tasks.
  baseUrl: string;
  // A bearer credential that the Worker's auth accepts.
  token: string;
  fetch?: typeof fetch;
}

// Every method takes an optional signal. An aborted call rejects with the
// signal reason (an AbortError, or a TimeoutError for AbortSignal.timeout),
// not a TasksApiError. A write that was aborted after it was sent may still
// have applied: read the task before you try again.
export interface CallOptions {
  signal?: AbortSignal;
}

export interface ListTasksFilter {
  boardId: string;
  columnId?: string;
  status?: TaskStatus;
}

export interface TasksClient {
  createBoard(input: { title: string }, options?: CallOptions): Promise<Board>;
  getBoard(boardId: string, options?: CallOptions): Promise<Board>;
  addColumn(boardId: string, name: string, options?: CallOptions): Promise<Board>;
  shareBoard(boardId: string, subject: { kind: MemberKind; id: string }, role: BoardRole, options?: CallOptions): Promise<void>;
  unshareBoard(boardId: string, subject: { kind: MemberKind; id: string }, options?: CallOptions): Promise<void>;
  eraseBoard(boardId: string, options?: CallOptions): Promise<void>;
  createTask(input: NewTask, options?: CallOptions): Promise<Task>;
  listTasks(filter: ListTasksFilter, options?: CallOptions): Promise<Task[]>;
  getTask(taskId: string, options?: CallOptions): Promise<Task>;
  updateTask(taskId: string, patch: TaskPatch, options?: CallOptions): Promise<Task>;
  moveTask(taskId: string, target: MoveTarget, options?: CallOptions): Promise<Task>;
  claim(taskId: string, claim?: ClaimOptions, options?: CallOptions): Promise<Task>;
  release(taskId: string, options?: CallOptions): Promise<Task>;
  closeTask(taskId: string, options?: CallOptions): Promise<Task>;
  progress(taskId: string, note: string, options?: CallOptions): Promise<ProgressEntry>;
  listProgress(taskId: string, options?: CallOptions): Promise<ProgressEntry[]>;
}

// A success reply must have the expected shape, or the call fails. A proxy or a
// wrong baseUrl can answer 200 with any body.
type Shape = "board" | "task" | "tasks" | "note" | "notes" | "shared" | "unshared" | "erased";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const hasId = (v: unknown) => isObject(v) && typeof v.id === "string";
const SHAPES: Record<Shape, (v: unknown) => boolean> = {
  board: (v) => hasId(v) && Array.isArray((v as Board).columns),
  task: (v) =>
    hasId(v) &&
    typeof (v as Task).boardId === "string" &&
    ((v as Task).status === "open" || (v as Task).status === "closed") &&
    ((v as Task).claim === undefined || isObject((v as Task).claim?.holder)),
  tasks: (v) => Array.isArray(v) && v.every(SHAPES.task),
  note: (v) => hasId(v) && typeof (v as ProgressEntry).note === "string",
  notes: (v) => Array.isArray(v) && v.every(SHAPES.note),
  shared: (v) => isObject(v) && v.shared === true,
  unshared: (v) => isObject(v) && v.unshared === true,
  erased: (v) => isObject(v) && v.erased === true,
};

export function createClient(options: ClientOptions): TasksClient {
  if (typeof options.baseUrl !== "string" || options.baseUrl === "") {
    throw new TypeError("createClient needs a baseUrl");
  }
  if (typeof options.token !== "string" || options.token === "") {
    throw new TypeError("createClient needs a token");
  }
  let origin: URL;
  try {
    origin = new URL(options.baseUrl);
  } catch {
    throw new TypeError("baseUrl must be an absolute URL");
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") {
    throw new TypeError("baseUrl must be an http or https URL");
  }
  if (origin.search !== "" || origin.hash !== "" || origin.username !== "" || origin.password !== "") {
    throw new TypeError("baseUrl must have no query, hash, or credentials");
  }
  const root = `${origin.origin}${origin.pathname.replace(/\/+$/, "")}/api/v1/tasks`;
  const token = options.token;
  // Read at call time so a test can swap the global.
  // A custom fetch is called as a plain function, so a bound method works too.
  const send = (input: string, init: RequestInit) =>
    options.fetch === undefined ? globalThis.fetch(input, init) : options.fetch(input, init);
  const seg = encodeURIComponent;

  async function call<T>(
    method: string,
    path: string,
    body: unknown,
    callOptions: CallOptions | undefined,
    shape: Shape,
  ): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await send(`${root}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: callOptions?.signal,
      // Never follow a redirect: it would send a write to another host. Workers
      // reject "error", so a 3xx (or an opaque redirect) fails as UNKNOWN below.
      redirect: "manual",
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
      const code = isKnownCode(error?.code) ? error.code : "UNKNOWN";
      const message = typeof error?.message === "string" ? error.message : `HTTP ${response.status}`;
      throw new TasksApiError(code, response.status, message);
    }
    if (!SHAPES[shape](parsed)) {
      throw new TasksApiError("UNKNOWN", response.status, `the reply is not a ${shape}`);
    }
    return parsed as T;
  }

  const member = (boardId: string, subject: { kind: MemberKind; id: string }) =>
    `/boards/${seg(boardId)}/members/${seg(subject.kind)}/${seg(subject.id)}`;

  return {
    createBoard: (input, o) => call("POST", "/boards", input, o, "board"),
    getBoard: (id, o) => call("GET", `/boards/${seg(id)}`, undefined, o, "board"),
    addColumn: (id, name, o) => call("POST", `/boards/${seg(id)}/columns`, { name }, o, "board"),
    shareBoard: async (id, subject, role, o) => {
      await call("PUT", member(id, subject), { role }, o, "shared");
    },
    unshareBoard: async (id, subject, o) => {
      await call("DELETE", member(id, subject), undefined, o, "unshared");
    },
    eraseBoard: async (id, o) => {
      await call("DELETE", `/boards/${seg(id)}`, undefined, o, "erased");
    },
    createTask: (input, o) => call("POST", "/tasks", input, o, "task"),
    listTasks: (filter, o) => {
      const query = new URLSearchParams({ boardId: filter.boardId });
      if (filter.columnId !== undefined) query.set("columnId", filter.columnId);
      if (filter.status !== undefined) query.set("status", filter.status);
      return call("GET", `/tasks?${query}`, undefined, o, "tasks");
    },
    getTask: (id, o) => call("GET", `/tasks/${seg(id)}`, undefined, o, "task"),
    updateTask: (id, patch, o) => call("PATCH", `/tasks/${seg(id)}`, patch, o, "task"),
    moveTask: (id, target, o) => call("POST", `/tasks/${seg(id)}/move`, target, o, "task"),
    claim: (id, claim, o) => call("POST", `/tasks/${seg(id)}/claim`, claim ?? {}, o, "task"),
    release: (id, o) => call("POST", `/tasks/${seg(id)}/release`, undefined, o, "task"),
    closeTask: (id, o) => call("POST", `/tasks/${seg(id)}/close`, undefined, o, "task"),
    progress: (id, note, o) => call("POST", `/tasks/${seg(id)}/progress`, { note }, o, "note"),
    listProgress: (id, o) => call("GET", `/tasks/${seg(id)}/progress`, undefined, o, "notes"),
  };
}
