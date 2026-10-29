#!/usr/bin/env node
import type { PrincipalContext, Role, Subject } from "agentic-identity";
import { trustedContext } from "./principal.js";
import { TaskError, type Principal, type PrincipalKind } from "./model.js";
import { createFileStore } from "./file-store.js";
import { createTasks, type Tasks } from "./tasks.js";
import { serveMcp } from "./mcp.js";

const USAGE =
  "usage: agentic-tasks <board|column|new|get|update|move|claim|progress|release|close|list|share|unshare|erase|delete|boards|export|mcp> " +
  "[args] --as <id> --kind <kind> [--file <path>]";

class UsageError extends Error {}

interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string[]>;
}

// Flags may sit anywhere after the command. A repeated flag keeps every value.
function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`flag ${token} needs a value`);
    }
    flags.set(token.slice(2), [...(flags.get(token.slice(2)) ?? []), value]);
    index += 1;
  }
  return { command: positionals[0], positionals: positionals.slice(1), flags };
}

function one(flags: Map<string, string[]>, name: string): string | undefined {
  return flags.get(name)?.at(-1);
}

function many(flags: Map<string, string[]>, name: string): string[] {
  return flags.get(name) ?? [];
}

// Every command names its principal and kind. The kind is never defaulted, so
// an agent's write cannot be recorded as a person's. The CLI trusts these flags,
// as git trusts user.name: anyone who can open the file can name any principal.
// The board role of that principal still decides what the command may do.
function actorFrom(flags: Map<string, string[]>): PrincipalContext {
  const id = one(flags, "as");
  if (id === undefined) throw new UsageError("this command needs --as <id>");
  const kind = one(flags, "kind");
  if (kind === undefined) throw new UsageError("this command needs --kind <kind>");
  return trustedContext(id, kind);
}

function assignees(flags: Map<string, string[]>): Principal[] | undefined {
  const values = many(flags, "assignee");
  if (values.length === 0) return undefined;
  return values.map((value) => {
    const [id, kind] = value.split(":");
    return { id: id ?? "", kind: (kind ?? "") as PrincipalKind };
  });
}

function subjectFrom(flags: Map<string, string[]>, positionals: string[]): Subject {
  const kind = one(flags, "subject-kind");
  if (kind === undefined) throw new UsageError("missing --subject-kind human|agent");
  return { kind: kind as Subject["kind"], id: requirePositional(positionals, 1, "subject id") };
}

function requirePositional(positionals: string[], index: number, label: string): string {
  const value = positionals[index];
  if (value === undefined) throw new UsageError(`missing ${label}`);
  return value;
}

async function runCommand(
  tasks: Tasks,
  args: ParsedArgs,
): Promise<unknown> {
  const { flags, positionals } = args;
  switch (args.command) {
    case "board": {
      const board = await tasks.createBoard(
        { title: requirePositional(positionals, 0, "title") },
        actorFrom(flags),
      );
      let current = board;
      for (const name of (one(flags, "columns") ?? "").split(",").filter(Boolean)) {
        current = await tasks.addColumn(board.id, name, actorFrom(flags));
      }
      return current;
    }
    case "column":
      return tasks.addColumn(
        requirePositional(positionals, 0, "board id"),
        requirePositional(positionals, 1, "column name"),
        actorFrom(flags),
      );
    case "new":
      return tasks.createTask(
        {
          boardId: requirePositional(positionals, 0, "board id"),
          title: requirePositional(positionals, 1, "title"),
          columnId: one(flags, "column"),
          description: one(flags, "description"),
          labels: many(flags, "label"),
          dueDate: one(flags, "due"),
          assignees: assignees(flags),
        },
        actorFrom(flags),
      );
    case "get":
      return tasks.getTask(requirePositional(positionals, 0, "task id"), actorFrom(flags));
    case "update":
      return tasks.updateTask(
        requirePositional(positionals, 0, "task id"),
        {
          title: one(flags, "title"),
          description: one(flags, "description"),
          labels: flags.has("label") ? many(flags, "label") : undefined,
          dueDate: one(flags, "due"),
          assignees: assignees(flags),
        },
        actorFrom(flags),
      );
    case "move": {
      const columnId = one(flags, "column");
      if (columnId === undefined) throw new UsageError("move needs --column <id>");
      const position = one(flags, "position");
      return tasks.moveTask(
        requirePositional(positionals, 0, "task id"),
        { columnId, position: position === undefined ? undefined : Number(position) },
        actorFrom(flags),
      );
    }
    case "claim": {
      const ttl = one(flags, "ttl-ms");
      return tasks.claim(requirePositional(positionals, 0, "task id"), actorFrom(flags), {
        ttlMs: ttl === undefined ? undefined : Number(ttl),
      });
    }
    case "release":
      return tasks.release(requirePositional(positionals, 0, "task id"), actorFrom(flags));
    case "close":
      return tasks.closeTask(requirePositional(positionals, 0, "task id"), actorFrom(flags));
    case "progress": {
      const taskId = requirePositional(positionals, 0, "task id");
      const note = positionals[1];
      if (note === undefined) return tasks.listProgress(taskId, actorFrom(flags));
      return tasks.progress(taskId, note, actorFrom(flags));
    }
    case "list": {
      const boardId = one(flags, "board");
      if (boardId === undefined) throw new UsageError("list needs --board <id>");
      return tasks.listTasks(
        {
          boardId,
          columnId: one(flags, "column"),
          status: one(flags, "status") as "open" | "closed" | undefined,
        },
        actorFrom(flags),
      );
    }
    case "share":
      await tasks.shareBoard(
        requirePositional(positionals, 0, "board id"),
        subjectFrom(flags, positionals),
        requirePositional(positionals, 2, "role") as Role,
        actorFrom(flags),
      );
      return { shared: true };
    case "unshare":
      await tasks.unshareBoard(
        requirePositional(positionals, 0, "board id"),
        subjectFrom(flags, positionals),
        actorFrom(flags),
      );
      return { unshared: true };
    case "delete":
      await tasks.deleteTask(requirePositional(positionals, 0, "task id"), actorFrom(flags));
      return { deleted: true };
    case "boards":
      return tasks.listBoards(actorFrom(flags));
    case "export":
      return tasks.exportData(actorFrom(flags));
    case "erase":
      await tasks.eraseBoard(requirePositional(positionals, 0, "board id"), actorFrom(flags));
      return { erased: true };
    default:
      throw new UsageError(`unknown command ${args.command ?? ""}`.trim());
  }
}

async function main(argv: string[]): Promise<number> {
  try {
    if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const args = parseArgs(argv);
    if (args.command === undefined) throw new UsageError("no command given");
    const path =
      one(args.flags, "file") ?? process.env.AGENTIC_TASKS_FILE ?? "./agentic-tasks.json";
    const tasks = createTasks({ store: createFileStore(path) });
    if (args.command === "mcp") {
      await serveMcp(tasks);
      return 0;
    }
    const result = await runCommand(tasks, args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${USAGE}\n${error.message}\n`);
      return 2;
    }
    const code = error instanceof TaskError ? error.code : "INTERNAL";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
