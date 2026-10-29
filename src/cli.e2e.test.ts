import { execFile, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Runs the built binary. `npm run build` runs before this suite in ci:local.
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const ALICE = ["--as", "alice", "--kind", "human"];
const BOT = ["--as", "bot-1", "--kind", "agent_of_human"];

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe("agentic-tasks CLI (built binary)", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentic-tasks-cli-"));
    file = join(dir, "tasks.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function run(args: string[]): Run {
    const result = spawnSync(process.execPath, [CLI, ...args, "--file", file], {
      encoding: "utf8",
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function errorCodeOf(result: Run): string {
    return (JSON.parse(result.stderr) as { error: { code: string } }).error.code;
  }

  function makeBoard(): { boardId: string; columnId: string } {
    const board = JSON.parse(
      run(["board", "Sprint", "--columns", "Todo,Doing", ...ALICE]).stdout,
    ) as { id: string; columns: { id: string }[] };
    run(["share", board.id, "bot-1", "editor", "--subject-kind", "agent", ...ALICE]);
    return { boardId: board.id, columnId: board.columns[0]!.id };
  }

  it("creates a board with ordered columns and prints it as JSON", () => {
    const result = run(["board", "Sprint", "--columns", "Todo,Doing", ...ALICE]);
    expect(result.code).toBe(0);
    const board = JSON.parse(result.stdout) as { columns: { name: string }[] };
    expect(board.columns.map((column) => column.name)).toEqual(["Todo", "Doing"]);
  });

  it("adds a column to an existing board and refuses a duplicate name", () => {
    const { boardId } = makeBoard();
    const added = run(["column", boardId, "Done", ...ALICE]);
    expect(added.code).toBe(0);
    expect((JSON.parse(added.stdout) as { columns: { name: string }[] }).columns.map((c) => c.name))
      .toEqual(["Todo", "Doing", "Done"]);
    const duplicate = run(["column", boardId, "Done", ...ALICE]);
    expect(duplicate.code).toBe(1);
    expect(errorCodeOf(duplicate)).toBe("INVALID_INPUT");
  });

  it("creates a task in the first column and lists it from a new process", () => {
    const { boardId, columnId } = makeBoard();
    const created = run(["new", boardId, "Write spec", ...ALICE]);
    expect(created.code).toBe(0);
    const task = JSON.parse(created.stdout) as { id: string; columnId: string };
    expect(task.columnId).toBe(columnId);
    const listed = JSON.parse(run(["list", "--board", boardId, ...ALICE]).stdout) as { id: string }[];
    expect(listed.map((row) => row.id)).toEqual([task.id]);
  });

  it("claims a task and refuses another principal while the claim is live", () => {
    const { boardId } = makeBoard();
    const { id } = JSON.parse(run(["new", boardId, "Write spec", ...ALICE]).stdout) as {
      id: string;
    };
    expect(run(["claim", id, ...ALICE]).code).toBe(0);
    const refused = run(["claim", id, ...BOT]);
    expect(refused.code).toBe(1);
    expect(errorCodeOf(refused)).toBe("CLAIM_HELD");
  });

  it("refuses a release by a principal that does not hold the claim", () => {
    const { boardId } = makeBoard();
    const { id } = JSON.parse(run(["new", boardId, "Write spec", ...ALICE]).stdout) as {
      id: string;
    };
    run(["claim", id, ...ALICE]);
    const refused = run(["release", id, ...BOT]);
    expect(refused.code).toBe(1);
    expect(errorCodeOf(refused)).toBe("NOT_HOLDER");
  });

  it("refuses a claim on a closed task", () => {
    const { boardId } = makeBoard();
    const { id } = JSON.parse(run(["new", boardId, "Write spec", ...ALICE]).stdout) as {
      id: string;
    };
    expect(run(["close", id, ...ALICE]).code).toBe(0);
    const refused = run(["claim", id, ...BOT]);
    expect(refused.code).toBe(1);
    expect(errorCodeOf(refused)).toBe("TASK_CLOSED");
  });

  it("appends progress with a note and reads the entries back", () => {
    const { boardId } = makeBoard();
    const { id } = JSON.parse(run(["new", boardId, "Write spec", ...BOT]).stdout) as {
      id: string;
    };
    expect(run(["progress", id, "outline done", ...BOT]).code).toBe(0);
    const entries = JSON.parse(run(["progress", id, ...ALICE]).stdout) as {
      note: string;
      by: { kind: string };
    }[];
    expect(entries.map((entry) => entry.note)).toEqual(["outline done"]);
    expect(entries[0]?.by.kind).toBe("agent_of_human");
  });

  it("moves a task to another column of its board", () => {
    const board = JSON.parse(
      run(["board", "Sprint", "--columns", "Todo,Doing", ...ALICE]).stdout,
    ) as { id: string; columns: { id: string }[] };
    const doing = board.columns[1]!.id;
    const { id } = JSON.parse(run(["new", board.id, "Write spec", ...ALICE]).stdout) as {
      id: string;
    };
    const moved = run(["move", id, "--column", doing, ...ALICE]);
    expect(moved.code).toBe(0);
    expect((JSON.parse(moved.stdout) as { columnId: string }).columnId).toBe(doing);
  });

  it("refuses a write without --kind and records no change", () => {
    const { boardId } = makeBoard();
    const refused = run(["new", boardId, "Write spec", "--as", "bot-1"]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/--kind/);
    expect(JSON.parse(run(["list", "--board", boardId, ...ALICE]).stdout)).toEqual([]);
  });

  it("rejects an unknown principal kind with INVALID_INPUT", () => {
    const { boardId } = makeBoard();
    const refused = run(["new", boardId, "Write spec", "--as", "x", "--kind", "root"]);
    expect(refused.code).toBe(1);
    expect(errorCodeOf(refused)).toBe("INVALID_INPUT");
  });

  it("answers NOT_FOUND for an id that names an object prototype member", () => {
    makeBoard();
    for (const id of ["__proto__", "constructor"]) {
      const result = run(["get", id, ...ALICE]);
      expect(result.code).toBe(1);
      expect(errorCodeOf(result)).toBe("NOT_FOUND");
    }
  });

  it("refuses a principal that has no role on the board", () => {
    const board = JSON.parse(run(["board", "Sprint", "--columns", "Todo", ...ALICE]).stdout) as { id: string };
    const refused = run(["new", board.id, "Write spec", ...BOT]);
    expect(refused.code).toBe(1);
    expect(errorCodeOf(refused)).toBe("FORBIDDEN");
  });

  it("shares a board by role and takes the role away on unshare", () => {
    const board = JSON.parse(run(["board", "Sprint", "--columns", "Todo", ...ALICE]).stdout) as { id: string };
    expect(run(["share", board.id, "bot-1", "viewer", "--subject-kind", "agent", ...ALICE]).code).toBe(0);
    expect(run(["list", "--board", board.id, ...BOT]).code).toBe(0);
    expect(errorCodeOf(run(["new", board.id, "Write spec", ...BOT]))).toBe("FORBIDDEN");
    expect(run(["share", board.id, "bot-1", "editor", "--subject-kind", "agent", ...ALICE]).code).toBe(0);
    expect(run(["new", board.id, "Write spec", ...BOT]).code).toBe(0);
    expect(errorCodeOf(run(["share", board.id, "x", "viewer", "--subject-kind", "agent", ...BOT]))).toBe("FORBIDDEN");
    expect(run(["unshare", board.id, "bot-1", "--subject-kind", "agent", ...ALICE]).code).toBe(0);
    expect(errorCodeOf(run(["list", "--board", board.id, ...BOT]))).toBe("FORBIDDEN");
  });

  it("needs --board to list", () => {
    const result = run(["list", ...ALICE]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/--board/);
  });

  it("exits 2 with a usage message on an unknown command", () => {
    const result = run(["teleport"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/usage/i);
  });
});

describe("agentic-tasks lock file (built binary)", () => {
  let dir: string;
  let file: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentic-tasks-lock-"));
    file = join(dir, "tasks.json");
    lockPath = `${file}.lock`;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function run(args: string[]): Run {
    const result = spawnSync(process.execPath, [CLI, ...args, "--file", file], {
      encoding: "utf8",
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function runAsync(args: string[]): Promise<Run> {
    return new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args, "--file", file], (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout, stderr });
      });
    });
  }

  function makeTask(): string {
    const board = JSON.parse(
      run(["board", "Sprint", "--columns", "Todo", ...ALICE]).stdout,
    ) as { id: string; columns: { id: string }[] };
    run(["share", board.id, "bot-1", "editor", "--subject-kind", "agent", ...ALICE]);
    const task = JSON.parse(run(["new", board.id, "Write spec", ...ALICE]).stdout) as {
      id: string;
    };
    return task.id;
  }

  function writeLock(owner: { pid: number; createdAt: number }): string {
    const text = JSON.stringify({ ...owner, token: "test-token" });
    writeFileSync(lockPath, text);
    return text;
  }

  function deadPid(): number {
    return spawnSync(process.execPath, ["-e", ""]).pid as number;
  }

  it("takes over a lock whose process has exited", () => {
    const id = makeTask();
    writeLock({ pid: deadPid(), createdAt: Date.now() });
    const claimed = run(["claim", id, ...ALICE]);
    expect(claimed.code).toBe(0);
  });

  it("takes over a lock older than the timeout even when its process still runs", () => {
    const id = makeTask();
    writeLock({ pid: process.pid, createdAt: Date.now() - 10 * 60_000 });
    expect(run(["claim", id, ...ALICE]).code).toBe(0);
  });

  it("does not take a fresh lock held by a live process", () => {
    const id = makeTask();
    const held = writeLock({ pid: process.pid, createdAt: Date.now() });
    const refused = run(["claim", id, ...ALICE]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/store is locked/);
    expect(readFileSync(lockPath, "utf8")).toBe(held);
  }, 20_000);

  it("lets exactly one of two parallel claims through across processes", async () => {
    const id = makeTask();
    const results = await Promise.all([
      runAsync(["claim", id, ...ALICE]),
      runAsync(["claim", id, ...BOT]),
    ]);
    expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
    const refused = results.find((result) => result.code === 1);
    expect(JSON.parse(refused?.stderr ?? "{}")).toMatchObject({
      error: { code: "CLAIM_HELD" },
    });
  });
});

describe("agentic-tasks MCP server over stdio (built binary)", () => {
  let dir: string;
  let file: string;
  let client: Client;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentic-tasks-mcp-"));
    file = join(dir, "tasks.json");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp", "--file", file],
    });
    client = new Client({ name: "agentic-tasks-e2e", version: "0.0.0" });
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function call(name: string, args: Record<string, unknown>) {
    return client.callTool({ name, arguments: args });
  }

  function textOf(result: Awaited<ReturnType<typeof call>>): string {
    const block = (result.content as { type: string; text: string }[])[0];
    return block?.text ?? "";
  }

  it("lists the task tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of [
      "create_board",
      "add_column",
      "create_task",
      "get_task",
      "list_tasks",
      "move_task",
      "update_task",
      "close_task",
      "claim_task",
      "release_task",
      "add_progress",
      "list_progress",
      "share_board",
      "unshare_board",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("runs the claim rules through tool calls", async () => {
    const board = JSON.parse(
      textOf(await call("create_board", { title: "Sprint", principal: { id: "alice", kind: "human" } })),
    ) as { id: string };
    await call("add_column", {
      boardId: board.id,
      name: "Todo",
      principal: { id: "alice", kind: "human" },
    });
    const task = JSON.parse(
      textOf(
        await call("create_task", {
          boardId: board.id,
          title: "Write spec",
          principal: { id: "alice", kind: "human" },
        }),
      ),
    ) as { id: string };

    const shared = await call("share_board", {
      boardId: board.id,
      subjectKind: "agent",
      subjectId: "bot-1",
      role: "editor",
      principal: { id: "alice", kind: "human" },
    });
    expect(shared.isError).toBeFalsy();

    const first = await call("claim_task", {
      taskId: task.id,
      principal: { id: "bot-1", kind: "agent_of_human" },
    });
    expect(first.isError).toBeFalsy();

    const second = await call("claim_task", {
      taskId: task.id,
      principal: { id: "alice", kind: "human" },
    });
    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain("CLAIM_HELD");
  });

  it("reports a principal with no role as FORBIDDEN", async () => {
    const board = JSON.parse(
      textOf(await call("create_board", { title: "Sprint", principal: { id: "alice", kind: "human" } })),
    ) as { id: string };
    const result = await call("list_tasks", {
      boardId: board.id,
      principal: { id: "bot-1", kind: "agent_of_human" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("FORBIDDEN");
  });

  it("reports an unknown principal kind as an error result", async () => {
    const result = await call("create_board", {
      title: "Sprint",
      principal: { id: "x", kind: "root" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("INVALID_INPUT");
  });
});
