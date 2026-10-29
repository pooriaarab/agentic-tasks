#!/usr/bin/env node
import type { PrincipalContext, Role, Subject } from "agentic-identity";
import { trustedContext } from "./principal.js";
import { TaskError, type Principal, type PrincipalKind } from "./model.js";
import { createFileStore } from "./file-store.js";
import { createTasks, type Tasks } from "./tasks.js";
import { serveMcp } from "./mcp.js";
import { VERSION } from "./version.js";

interface CommandSpec {
  // Positional arguments in order. A name in brackets is optional.
  args: string;
  summary: string;
  // Flags beyond --as, --kind, and --file. A command with no principal takes only --file.
  flags: string[];
  principal?: false;
}

const COMMANDS: Record<string, CommandSpec> = {
  board: {
    args: "<title>",
    summary: "Create a board. The title is the argument or --title. --columns adds columns.",
    flags: ["title", "columns"],
  },
  column: { args: "<board id> <name>", summary: "Add a column to a board.", flags: ["name"] },
  new: {
    args: "<board id> <title>",
    summary: "Create a task. It lands in the first column unless --column is given.",
    flags: ["title", "column", "description", "label", "due", "assignee"],
  },
  get: { args: "<task id>", summary: "Read one task.", flags: [] },
  update: {
    args: "<task id>",
    summary: "Change a task. --label and --assignee (<id>:<kind>) repeat.",
    flags: ["title", "description", "label", "due", "assignee"],
  },
  move: {
    args: "<task id>",
    summary: "Move a task to the column given by --column.",
    flags: ["column", "position"],
  },
  claim: { args: "<task id>", summary: "Claim a task for --ttl-ms (up to one day).", flags: ["ttl-ms"] },
  progress: {
    args: "<task id> [note]",
    summary: "Add a progress note. With no note, list the notes of the task.",
    flags: [],
  },
  release: { args: "<task id>", summary: "Release a claim. The holder or a board owner can.", flags: [] },
  close: { args: "<task id>", summary: "Close a task. This clears its claim.", flags: [] },
  list: {
    args: "<board id>",
    summary: "List the tasks of a board. The board is the argument or --board.",
    flags: ["board", "column", "status"],
  },
  share: {
    args: "<board id> <subject id> <role>",
    summary: "Give a role (viewer, commenter, editor, owner). --subject-kind is human or agent.",
    flags: ["subject-kind"],
  },
  unshare: {
    args: "<board id> <subject id>",
    summary: "Take a role away. --subject-kind is human or agent.",
    flags: ["subject-kind"],
  },
  erase: { args: "<board id>", summary: "Erase a board with its tasks, notes, and grants.", flags: [] },
  delete: { args: "<task id>", summary: "Delete a task and its notes.", flags: [] },
  boards: { args: "", summary: "List the boards you hold a role on.", flags: [] },
  export: { args: "", summary: "Print your own data as JSON.", flags: [] },
  mcp: { args: "", summary: "Serve the MCP tools over stdio.", flags: [], principal: false },
};

// An argument that has a flag form. Any command with the argument takes the flag.
const SLOT_FLAGS: Record<string, string> = {
  "board id": "board",
  "task id": "task",
  title: "title",
  name: "name",
};

function slotsOf(spec: CommandSpec): string[] {
  return (spec.args.match(/[<[][^>\]]*[>\]]/g) ?? []).map((slot) => slot.slice(1, -1));
}

for (const spec of Object.values(COMMANDS)) {
  for (const slot of slotsOf(spec)) {
    const flag = SLOT_FLAGS[slot];
    if (flag !== undefined && !spec.flags.includes(flag)) spec.flags.push(flag);
  }
}

const COMMAND_WIDTH =
  Math.max(...Object.entries(COMMANDS).map(([name, spec]) => `${name} ${spec.args}`.trim().length)) + 2;

// A flag that stands for an argument is the same value, never a second one.
const USAGE_NOTE = "An <id> or <title> or <name> argument can be given as --board, --task, --title, or --name instead.";

const USAGE = [
  `usage: agentic-tasks <command> [args] --as <id> --kind <kind> [--file <path>]`,
  "",
  "Every command but mcp needs --as and --kind. The kind is never defaulted.",
  "The store file is --file, or AGENTIC_TASKS_FILE, or ./agentic-tasks.json.",
  "Output is JSON.",
  USAGE_NOTE,
  "",
  "commands:",
  ...Object.entries(COMMANDS).map(
    ([name, spec]) => `  ${`${name} ${spec.args}`.trim().padEnd(COMMAND_WIDTH)}${spec.summary}`,
  ),
  "",
  "agentic-tasks <command> --help prints one command. agentic-tasks --version prints the version.",
].join("\n");

function commandUsage(name: string, spec: CommandSpec): string {
  const principal = spec.principal === false ? "" : " --as <id> --kind <kind>";
  const flags = spec.flags.map((flag) => ` [--${flag} <value>]`).join("");
  return [
    `usage: agentic-tasks ${`${name} ${spec.args}`.trim()}${principal}${flags} [--file <path>]`,
    "",
    spec.summary,
    ...(slotsOf(spec).some((slot) => slot in SLOT_FLAGS) ? ["", USAGE_NOTE] : []),
  ].join("\n");
}

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

// Refuses a flag the command does not take, and a positional beyond its arguments.
// A wrong word fails here, so `board new --title Sprint` cannot make a board named "new".
function checkArgs(args: ParsedArgs, spec: CommandSpec): void {
  const known = new Set(["file", ...(spec.principal === false ? [] : ["as", "kind"]), ...spec.flags]);
  for (const name of args.flags.keys()) {
    if (!known.has(name)) throw new UsageError(`unknown flag --${name}`);
  }
  const slots = slotsOf(spec).length;
  if (args.positionals.length > slots) {
    throw new UsageError(`unexpected argument ${args.positionals[slots]}`);
  }
}

// Fills the arguments of a command in order. An argument with a flag form comes
// from the flag when given, else from the next positional. It is never both: a
// positional that repeats a flag's value, or is left over after a flag filled its
// slot, is a second value for that argument.
function bindArgs(args: ParsedArgs, spec: CommandSpec): Map<string, string> {
  const bound = new Map<string, string>();
  const flagged = new Map<string, string>();
  let next = 0;
  for (const slot of slotsOf(spec)) {
    const flag = SLOT_FLAGS[slot];
    const named = flag === undefined ? undefined : args.flags.get(flag);
    if (named !== undefined) {
      if (named.length > 1) throw new UsageError(`give --${flag} once`);
      bound.set(slot, named[0] as string);
      flagged.set(slot, named[0] as string);
    } else if (args.positionals[next] !== undefined) {
      bound.set(slot, args.positionals[next] as string);
      next += 1;
    }
  }
  const twice = (slot: string): UsageError =>
    new UsageError(`give the ${slot} once: as an argument or as --${SLOT_FLAGS[slot]}`);
  for (const [slot, value] of flagged) {
    if (args.positionals.includes(value)) throw twice(slot);
  }
  if (next < args.positionals.length) {
    const slot = flagged.keys().next().value;
    throw slot === undefined ? new UsageError(`unexpected argument ${args.positionals[next]}`) : twice(slot);
  }
  return bound;
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

function subjectFrom(flags: Map<string, string[]>, id: string): Subject {
  const kind = one(flags, "subject-kind");
  if (kind === undefined) throw new UsageError("missing --subject-kind human|agent");
  return { kind: kind as Subject["kind"], id };
}

async function runCommand(
  tasks: Tasks,
  args: ParsedArgs,
): Promise<unknown> {
  const { flags } = args;
  const bound = bindArgs(args, COMMANDS[args.command as string] as CommandSpec);
  const need = (slot: string): string => {
    const value = bound.get(slot);
    if (value === undefined) throw new UsageError(`missing ${slot}`);
    return value;
  };
  switch (args.command) {
    case "board": {
      const board = await tasks.createBoard(
        { title: need("title") },
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
        need("board id"),
        need("name"),
        actorFrom(flags),
      );
    case "new":
      return tasks.createTask(
        {
          boardId: need("board id"),
          title: need("title"),
          columnId: one(flags, "column"),
          description: one(flags, "description"),
          labels: many(flags, "label"),
          dueDate: one(flags, "due"),
          assignees: assignees(flags),
        },
        actorFrom(flags),
      );
    case "get":
      return tasks.getTask(need("task id"), actorFrom(flags));
    case "update":
      return tasks.updateTask(
        need("task id"),
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
        need("task id"),
        { columnId, position: position === undefined ? undefined : Number(position) },
        actorFrom(flags),
      );
    }
    case "claim": {
      const ttl = one(flags, "ttl-ms");
      return tasks.claim(need("task id"), actorFrom(flags), {
        ttlMs: ttl === undefined ? undefined : Number(ttl),
      });
    }
    case "release":
      return tasks.release(need("task id"), actorFrom(flags));
    case "close":
      return tasks.closeTask(need("task id"), actorFrom(flags));
    case "progress": {
      const taskId = need("task id");
      const note = bound.get("note");
      if (note === undefined) return tasks.listProgress(taskId, actorFrom(flags));
      return tasks.progress(taskId, note, actorFrom(flags));
    }
    case "list": {
      return tasks.listTasks(
        {
          boardId: need("board id"),
          columnId: one(flags, "column"),
          status: one(flags, "status") as "open" | "closed" | undefined,
        },
        actorFrom(flags),
      );
    }
    case "share":
      await tasks.shareBoard(
        need("board id"),
        subjectFrom(flags, need("subject id")),
        need("role") as Role,
        actorFrom(flags),
      );
      return { shared: true };
    case "unshare":
      await tasks.unshareBoard(
        need("board id"),
        subjectFrom(flags, need("subject id")),
        actorFrom(flags),
      );
      return { unshared: true };
    case "delete":
      await tasks.deleteTask(need("task id"), actorFrom(flags));
      return { deleted: true };
    case "boards":
      return tasks.listBoards(actorFrom(flags));
    case "export":
      return tasks.exportData(actorFrom(flags));
    case "erase":
      await tasks.eraseBoard(need("board id"), actorFrom(flags));
      return { erased: true };
    default:
      throw new UsageError(`unknown command ${args.command ?? ""}`.trim());
  }
}

// Finds the command and a help request. A value that follows a flag is not read
// as either, so a flag value of "-h" stays a value. A word of "-h" or "--help" in
// an argument position is help.
function scanForHelp(argv: string[]): { help: boolean; words: string[] } {
  const words: string[] = [];
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === "--help" || token === "-h") help = true;
    else if (token.startsWith("--")) index += 1;
    else words.push(token);
  }
  return { help, words };
}

async function main(argv: string[]): Promise<number> {
  try {
    if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    // Help comes before every other check, so it works with no --as and no store.
    const { help, words } = scanForHelp(argv);
    if (help || words[0] === "help") {
      const named = words[0] === "help" ? words[1] : words[0];
      if (named === undefined) {
        process.stdout.write(`${USAGE}\n`);
        return 0;
      }
      if (!Object.hasOwn(COMMANDS, named)) throw new UsageError(`unknown command ${named}`);
      process.stdout.write(`${commandUsage(named, COMMANDS[named] as CommandSpec)}\n`);
      return 0;
    }
    const args = parseArgs(argv);
    if (args.command === undefined) throw new UsageError("no command given");
    if (!Object.hasOwn(COMMANDS, args.command)) throw new UsageError(`unknown command ${args.command}`);
    checkArgs(args, COMMANDS[args.command] as CommandSpec);
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
      process.stderr.write(`${USAGE.split("\n")[0]}\n${error.message}\nRun agentic-tasks --help for the commands.\n`);
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
