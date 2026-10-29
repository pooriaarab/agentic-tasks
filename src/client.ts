// A typed client for the Worker HTTP API. It uses only fetch, URL, and
// AbortSignal, so it runs in browsers, Workers, and Node 22. It never retries:
// a retry of a claim, a note, or a create could apply twice.
import type { Board, ProgressEntry, Task, TaskErrorCode, TaskStatus } from "./model.js";
import type { ClaimOptions, MoveTarget, NewTask, TaskPatch } from "./tasks.js";

export type { Board, ProgressEntry, Task, TaskStatus } from "./model.js";
export type { ClaimOptions, MoveTarget, NewTask, TaskPatch } from "./tasks.js";

export type MemberKind = "human" | "agent";
export type BoardRole = "viewer" | "commenter" | "editor" | "owner";

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
// fetch AbortError, not a TasksApiError.
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

export function createClient(options: ClientOptions): TasksClient {
  if (typeof options.baseUrl !== "string" || options.baseUrl === "") {
    throw new TypeError("createClient needs a baseUrl");
  }
  if (typeof options.token !== "string" || options.token === "") {
    throw new TypeError("createClient needs a token");
  }
  const root = `${options.baseUrl.replace(/\/+$/, "")}/api/v1/tasks`;
  const token = options.token;
  // Read at call time so a test can swap the global.
  const send = (input: string, init: RequestInit) => (options.fetch ?? globalThis.fetch)(input, init);
  const seg = encodeURIComponent;

  async function call<T>(
    method: string,
    path: string,
    body: unknown,
    call: CallOptions | undefined,
  ): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await send(`${root}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: call?.signal,
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
      const code = typeof error?.code === "string" ? (error.code as ApiErrorCode) : "UNKNOWN";
      const message = typeof error?.message === "string" ? error.message : `HTTP ${response.status}`;
      throw new TasksApiError(code, response.status, message);
    }
    if (parsed === undefined) {
      throw new TasksApiError("UNKNOWN", response.status, "the reply was not JSON");
    }
    return parsed as T;
  }

  const member = (boardId: string, subject: { kind: MemberKind; id: string }) =>
    `/boards/${seg(boardId)}/members/${seg(subject.kind)}/${seg(subject.id)}`;

  return {
    createBoard: (input, o) => call("POST", "/boards", input, o),
    getBoard: (id, o) => call("GET", `/boards/${seg(id)}`, undefined, o),
    addColumn: (id, name, o) => call("POST", `/boards/${seg(id)}/columns`, { name }, o),
    shareBoard: async (id, subject, role, o) => {
      await call("PUT", member(id, subject), { role }, o);
    },
    unshareBoard: async (id, subject, o) => {
      await call("DELETE", member(id, subject), undefined, o);
    },
    eraseBoard: async (id, o) => {
      await call("DELETE", `/boards/${seg(id)}`, undefined, o);
    },
    createTask: (input, o) => call("POST", "/tasks", input, o),
    listTasks: (filter, o) => {
      const query = new URLSearchParams({ boardId: filter.boardId });
      if (filter.columnId !== undefined) query.set("columnId", filter.columnId);
      if (filter.status !== undefined) query.set("status", filter.status);
      return call("GET", `/tasks?${query}`, undefined, o);
    },
    getTask: (id, o) => call("GET", `/tasks/${seg(id)}`, undefined, o),
    updateTask: (id, patch, o) => call("PATCH", `/tasks/${seg(id)}`, patch, o),
    moveTask: (id, target, o) => call("POST", `/tasks/${seg(id)}/move`, target, o),
    claim: (id, claim, o) => call("POST", `/tasks/${seg(id)}/claim`, claim ?? {}, o),
    release: (id, o) => call("POST", `/tasks/${seg(id)}/release`, undefined, o),
    closeTask: (id, o) => call("POST", `/tasks/${seg(id)}/close`, undefined, o),
    progress: (id, note, o) => call("POST", `/tasks/${seg(id)}/progress`, { note }, o),
    listProgress: (id, o) => call("GET", `/tasks/${seg(id)}/progress`, undefined, o),
  };
}
