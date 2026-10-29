---
name: agentic-tasks
description: Task boards where people and agents claim and finish work. Keywords: tasks,kanban,todo,project-management,agents,mcp,cli,collaboration.
---

# agentic-tasks

Task boards where people and agents claim and finish work.

## Use the SDK

```js
import { createTasks, createFileStore, trustedContext } from "agentic-tasks";

const tasks = createTasks({ store: createFileStore("./tasks.json") });
// A principal context from agentic-identity. trustedContext is for local use.
const me = trustedContext("alice", "human");
const board = await tasks.createBoard({ title: "Sprint" }, me);
await tasks.shareBoard(board.id, { kind: "agent", id: "agent-1" }, "editor", me);
```

## Use the remote client

```js
import { createClient } from "agentic-tasks/client";

const tasks = createClient({ baseUrl: "https://tasks.example.com", token });
await tasks.getTask(taskId); // read a task before you claim it
try {
  await tasks.claim(taskId);
} catch (error) {
  // CLAIM_HELD: wait for the holder or the expiry. Do not retry in a loop.
}
```

## Use the CLI

```sh
agentic-tasks board Sprint --columns Todo,Doing --as alice --kind human
agentic-tasks share <boardId> bot-1 editor --subject-kind agent --as alice --kind human
agentic-tasks new <boardId> "Write spec" --as alice --kind human
agentic-tasks claim <taskId> --as bot-1 --kind agent_of_human
agentic-tasks list --board <boardId> --status open --as bot-1 --kind agent_of_human
```

Every command prints JSON. A refused call prints `{"error":{"code",...}}` and exits 1.
Every command needs `--as` and `--kind`, and a role on the board. The CLI never defaults the kind. A missing flag exits 2.

## Use the MCP server

Run `agentic-tasks mcp`. Each tool takes a `principal` with `id` and `kind`.

## Rules

- Check the holder before you claim a task.
- Report a refused claim as a failure. Do not retry it in a loop.
- Release a claim when you stop work.
