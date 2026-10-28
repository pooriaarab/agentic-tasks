import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TaskError, type Principal } from "./model.js";
import type { Tasks } from "./tasks.js";
import { VERSION } from "./version.js";

// Every call names its actor. Kinds are checked by the service, so a bad
// kind comes back as an INVALID_INPUT error result.
const actor = z.object({ id: z.string(), kind: z.string() });
const assignee = z.object({ id: z.string(), kind: z.string() });

async function respond(work: () => Promise<unknown>) {
  try {
    const value = await work();
    return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
  } catch (error) {
    const code = error instanceof TaskError ? error.code : "INTERNAL";
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `${code}: ${message}` }],
    };
  }
}

export function createMcpServer(tasks: Tasks): McpServer {
  const server = new McpServer({ name: "agentic-tasks", version: VERSION });

  server.tool(
    "create_board",
    "Create a board. Add columns with add_column.",
    { title: z.string(), principal: actor },
    async ({ title, principal }) =>
      respond(() => tasks.createBoard({ title }, principal as Principal)),
  );

  server.tool(
    "add_column",
    "Append a named column to a board.",
    { boardId: z.string(), name: z.string(), principal: actor },
    async ({ boardId, name, principal }) =>
      respond(() => tasks.addColumn(boardId, name, principal as Principal)),
  );

  server.tool(
    "create_task",
    "Create a task. It lands in the first column unless columnId is given.",
    {
      boardId: z.string(),
      title: z.string(),
      description: z.string().optional(),
      columnId: z.string().optional(),
      labels: z.array(z.string()).optional(),
      dueDate: z.string().nullable().optional(),
      assignees: z.array(assignee).optional(),
      principal: actor,
    },
    async ({ principal, assignees, ...input }) =>
      respond(() =>
        tasks.createTask(
          { ...input, assignees: assignees as Principal[] | undefined },
          principal as Principal,
        ),
      ),
  );

  server.tool(
    "get_task",
    "Read one task.",
    { taskId: z.string() },
    async ({ taskId }) => respond(() => tasks.getTask(taskId)),
  );

  server.tool(
    "list_tasks",
    "List tasks, optionally filtered by board, column, or status.",
    {
      boardId: z.string().optional(),
      columnId: z.string().optional(),
      status: z.enum(["open", "closed"]).optional(),
    },
    async (filter) => respond(() => tasks.listTasks(filter)),
  );

  server.tool(
    "move_task",
    "Move a task to a column. Without a position it goes to the end.",
    {
      taskId: z.string(),
      columnId: z.string(),
      position: z.number().optional(),
      principal: actor,
    },
    async ({ taskId, columnId, position, principal }) =>
      respond(() =>
        tasks.moveTask(taskId, { columnId, position }, principal as Principal),
      ),
  );

  server.tool(
    "update_task",
    "Change a task's title, description, labels, due date, or assignees.",
    {
      taskId: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      labels: z.array(z.string()).optional(),
      dueDate: z.string().nullable().optional(),
      assignees: z.array(assignee).optional(),
      principal: actor,
    },
    async ({ taskId, principal, assignees, ...patch }) =>
      respond(() =>
        tasks.updateTask(
          taskId,
          { ...patch, assignees: assignees as Principal[] | undefined },
          principal as Principal,
        ),
      ),
  );

  server.tool(
    "close_task",
    "Close a task. Closing clears its claim.",
    { taskId: z.string(), principal: actor },
    async ({ taskId, principal }) =>
      respond(() => tasks.closeTask(taskId, principal as Principal)),
  );

  server.tool(
    "claim_task",
    "Claim a task for a time. Fails while another principal holds a live claim.",
    {
      taskId: z.string(),
      ttlMs: z.number().optional(),
      principal: actor,
    },
    async ({ taskId, ttlMs, principal }) =>
      respond(() =>
        tasks.claim(taskId, principal as Principal, { ttlMs }),
      ),
  );

  server.tool(
    "release_task",
    "Release a claim. Only the holder can release it.",
    { taskId: z.string(), principal: actor },
    async ({ taskId, principal }) =>
      respond(() => tasks.release(taskId, principal as Principal)),
  );

  server.tool(
    "add_progress",
    "Append a progress note to a task.",
    { taskId: z.string(), note: z.string(), principal: actor },
    async ({ taskId, note, principal }) =>
      respond(() => tasks.progress(taskId, note, principal as Principal)),
  );

  server.tool(
    "list_progress",
    "Read the progress notes on a task, oldest first.",
    { taskId: z.string() },
    async ({ taskId }) => respond(() => tasks.listProgress(taskId)),
  );

  return server;
}

export async function serveMcp(tasks: Tasks): Promise<void> {
  await createMcpServer(tasks).connect(new StdioServerTransport());
}
