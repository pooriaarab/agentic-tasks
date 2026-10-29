import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Role } from "agentic-identity";
import { TaskError, type Principal } from "./model.js";
import { trustedContext } from "./principal.js";
import type { Tasks } from "./tasks.js";
import { VERSION } from "./version.js";

// Every call names its principal. Kinds are checked by the service, so a bad
// kind comes back as an INVALID_INPUT error result. The server trusts the name,
// as the CLI does. The board role of that principal still decides the result.
const actor = z.object({ id: z.string(), kind: z.string() });
const ctx = (p: { id: string; kind: string }) => trustedContext(p.id, p.kind);
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
      respond(() => tasks.createBoard({ title }, ctx(principal))),
  );

  server.tool(
    "add_column",
    "Append a named column to a board.",
    { boardId: z.string(), name: z.string(), principal: actor },
    async ({ boardId, name, principal }) =>
      respond(() => tasks.addColumn(boardId, name, ctx(principal))),
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
          ctx(principal),
        ),
      ),
  );

  server.tool(
    "get_task",
    "Read one task.",
    { taskId: z.string(), principal: actor },
    async ({ taskId, principal }) => respond(() => tasks.getTask(taskId, ctx(principal))),
  );

  server.tool(
    "list_tasks",
    "List the tasks of a board, optionally filtered by column or status.",
    {
      boardId: z.string(),
      columnId: z.string().optional(),
      status: z.enum(["open", "closed"]).optional(),
      principal: actor,
    },
    async ({ principal, ...filter }) => respond(() => tasks.listTasks(filter, ctx(principal))),
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
        tasks.moveTask(taskId, { columnId, position }, ctx(principal)),
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
          ctx(principal),
        ),
      ),
  );

  server.tool(
    "close_task",
    "Close a task. Closing clears its claim.",
    { taskId: z.string(), principal: actor },
    async ({ taskId, principal }) =>
      respond(() => tasks.closeTask(taskId, ctx(principal))),
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
        tasks.claim(taskId, ctx(principal), { ttlMs }),
      ),
  );

  server.tool(
    "release_task",
    "Release a claim. Only the holder can release it.",
    { taskId: z.string(), principal: actor },
    async ({ taskId, principal }) =>
      respond(() => tasks.release(taskId, ctx(principal))),
  );

  server.tool(
    "add_progress",
    "Append a progress note to a task.",
    { taskId: z.string(), note: z.string(), principal: actor },
    async ({ taskId, note, principal }) =>
      respond(() => tasks.progress(taskId, note, ctx(principal))),
  );

  server.tool(
    "list_progress",
    "Read the progress notes on a task, oldest first.",
    { taskId: z.string(), principal: actor },
    async ({ taskId, principal }) => respond(() => tasks.listProgress(taskId, ctx(principal))),
  );

  server.tool(
    "share_board",
    "Give a principal a role on a board: viewer, commenter, editor, or owner. Needs the owner role.",
    {
      boardId: z.string(),
      subjectId: z.string(),
      role: z.enum(["viewer", "commenter", "editor", "owner"]),
      principal: actor,
    },
    async ({ boardId, subjectId, role, principal }) =>
      respond(async () => {
        await tasks.shareBoard(boardId, subjectId, role as Role, ctx(principal));
        return { shared: true };
      }),
  );

  server.tool(
    "unshare_board",
    "Remove a principal's role on a board. Needs the owner role. The last owner stays.",
    { boardId: z.string(), subjectId: z.string(), principal: actor },
    async ({ boardId, subjectId, principal }) =>
      respond(async () => {
        await tasks.unshareBoard(boardId, subjectId, ctx(principal));
        return { unshared: true };
      }),
  );

  return server;
}

export async function serveMcp(tasks: Tasks): Promise<void> {
  await createMcpServer(tasks).connect(new StdioServerTransport());
}
