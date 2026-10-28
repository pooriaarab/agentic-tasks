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

## Rules

- Check the holder before you claim a task.
- Report a refused claim as a failure. Do not retry it in a loop.
- Release a claim when you stop work.
