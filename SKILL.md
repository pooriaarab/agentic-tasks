---
name: agentic-tasks
description: Task boards where people and agents claim and finish work. Keywords: tasks,kanban,todo,project-management,agents,mcp,cli,collaboration.
---

# agentic-tasks

Task boards where people and agents claim and finish work.

## Use the SDK

```js
import { createTasks, createFileStore } from "agentic-tasks";

const tasks = createTasks({ store: createFileStore("./tasks.json") });
const me = { id: "agent-1", kind: "agent_of_human" };
const board = await tasks.createBoard({ title: "Sprint" }, me);
```

## Use the CLI

```sh
agentic-tasks board Sprint --columns Todo,Doing --as alice --kind human
agentic-tasks new <boardId> "Write spec" --as alice --kind human
agentic-tasks claim <taskId> --as bot-1 --kind agent_of_human
agentic-tasks list --status open
```

Every command prints JSON. A refused call prints `{"error":{"code",...}}` and exits 1.
A write needs `--as` and `--kind`. The CLI never defaults the kind. A missing flag exits 2.

## Use the MCP server

Run `agentic-tasks mcp`. Each tool takes a `principal` with `id` and `kind`.

## Rules

- Check the holder before you claim a task.
- Report a refused claim as a failure. Do not retry it in a loop.
- Release a claim when you stop work.
