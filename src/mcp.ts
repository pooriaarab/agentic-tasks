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
      subjectKind: z.enum(["human", "agent"]),
      subjectId: z.string(),
      role: z.enum(["viewer", "commenter", "editor", "owner"]),
      principal: actor,
    },
    async ({ boardId, subjectKind, subjectId, role, principal }) =>
      respond(async () => {
        await tasks.shareBoard(boardId, { kind: subjectKind, id: subjectId }, role as Role, ctx(principal));
        return { shared: true };
      }),
  );

  server.tool(
    "unshare_board",
    "Remove a principal's role on a board. Needs the owner role. The last owner stays.",
    { boardId: z.string(), subjectKind: z.enum(["human", "agent"]), subjectId: z.string(), principal: actor },
    async ({ boardId, subjectKind, subjectId, principal }) =>
      respond(async () => {
        await tasks.unshareBoard(boardId, { kind: subjectKind, id: subjectId }, ctx(principal));
        return { unshared: true };
      }),
  );

  server.tool(
    "list_access",
    "List the grants, the invites, and the share links of a board. Needs the owner role. An invite shows no email and a link shows no token.",
    { boardId: z.string(), principal: actor },
    async ({ boardId, principal }) => respond(() => tasks.listAccess(boardId, ctx(principal))),
  );

  server.tool(
    "create_invite",
    "Invite a person by email or an agent by handle to a board. Give email or handle, not both. The role is not owner. Needs the owner role.",
    {
      boardId: z.string(),
      role: z.enum(["viewer", "commenter", "editor"]),
      email: z.string().optional(),
      handle: z.string().optional(),
      expiresInMs: z.number().optional(),
      principal: actor,
    },
    async ({ boardId, principal, ...input }) =>
      respond(() => tasks.inviteToBoard(boardId, input, ctx(principal))),
  );

  server.tool(
    "create_link",
    "Make a share link for a board. The reply holds the token once: it cannot be read again. The role is not owner. Needs the owner role.",
    {
      boardId: z.string(),
      role: z.enum(["viewer", "commenter", "editor"]),
      signedInOnly: z.boolean().optional(),
      expiresInMs: z.number().optional(),
      principal: actor,
    },
    async ({ boardId, principal, ...input }) =>
      respond(() => tasks.createBoardLink(boardId, input, ctx(principal))),
  );

  server.tool(
    "revoke_link",
    "Revoke a share link of a board. Needs the owner role.",
    { boardId: z.string(), linkId: z.string(), principal: actor },
    async ({ boardId, linkId, principal }) =>
      respond(async () => {
        await tasks.revokeBoardLink(boardId, linkId, ctx(principal));
        return { revoked: true };
      }),
  );

  server.tool(
    "erase_board",
    "Erase a board with its tasks, notes, and grants. Needs the owner role. It cannot be undone.",
    { boardId: z.string(), principal: actor },
    async ({ boardId, principal }) =>
      respond(async () => {
        await tasks.eraseBoard(boardId, ctx(principal));
        return { erased: true };
      }),
  );

  server.tool(
    "delete_task",
    "Delete a task and its notes. Needs the editor role. It cannot be undone.",
    { taskId: z.string(), principal: actor },
    async ({ taskId, principal }) =>
      respond(async () => {
        await tasks.deleteTask(taskId, ctx(principal));
        return { deleted: true };
      }),
  );

  server.tool(
    "list_boards",
    "List the boards the principal holds a role on.",
    { principal: actor },
    async ({ principal }) => respond(() => tasks.listBoards(ctx(principal))),
  );

  server.tool(
    "export_data",
    "Export the principal's data as JSON: its boards, the tasks it made, last changed, holds, or is assigned to, and its own notes.",
    { principal: actor },
    async ({ principal }) => respond(() => tasks.exportData(ctx(principal))),
  );

  return server;
}

export async function serveMcp(tasks: Tasks): Promise<void> {
  await createMcpServer(tasks).connect(new StdioServerTransport());
}
