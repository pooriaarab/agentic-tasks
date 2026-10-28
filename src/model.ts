// Domain types. Every write records the acting principal and its kind,
// so a reader can tell a person's edit from an agent's edit.

export const PRINCIPAL_KINDS = [
  "human",
  "agent_of_human",
  "agent_of_agent",
  "agent",
  "user_token",
] as const;

export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export interface Principal {
  id: string;
  kind: PrincipalKind;
}

export interface Column {
  id: string;
  name: string;
}

export interface Board {
  id: string;
  title: string;
  columns: Column[];
  createdBy: Principal;
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus = "open" | "closed";

export interface Claim {
  holder: Principal;
  claimedAt: string;
  expiresAt: string;
}

export interface Task {
  id: string;
  boardId: string;
  title: string;
  description: string;
  columnId: string;
  position: number;
  labels: string[];
  dueDate: string | null;
  assignees: Principal[];
  status: TaskStatus;
  claim?: Claim;
  createdBy: Principal;
  createdAt: string;
  updatedBy: Principal;
  updatedAt: string;
  closedAt?: string;
}

export interface ProgressEntry {
  id: string;
  taskId: string;
  note: string;
  by: Principal;
  at: string;
}

export type TaskErrorCode =
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "CLAIM_HELD"
  | "NOT_HOLDER"
  | "TASK_CLOSED";

// Thrown for every refused operation. Callers report the code.
export class TaskError extends Error {
  readonly code: TaskErrorCode;

  constructor(code: TaskErrorCode, message: string) {
    super(message);
    this.name = "TaskError";
    this.code = code;
  }
}
