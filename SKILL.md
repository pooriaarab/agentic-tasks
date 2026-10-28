---
name: agentic-tasks
description: Task boards where people and agents claim and finish work. Keywords: tasks,kanban,todo,project-management,agents,mcp,cli,collaboration.
---

# agentic-tasks

Task boards where people and agents claim and finish work.

## Use the SDK

```js
import { summarizeText, dispatchText } from "agentic-tasks";

summarizeText("some text");
await dispatchText("some text", { dryRun: true });
```

## Use the CLI

```sh
agentic-tasks summary --text "some text"
agentic-tasks dispatch --text "some text" --dry-run
```

## Use the MCP server

Start the server with `agentic-tasks mcp`. Call `summarize_text`
for stats, `dispatch_text` for routes, `get_cost_report` for costs.

## Rules

- Preview each route with dry run first.
- Report guard denials and adapter errors as failures.
- Read the cost report at the end.
