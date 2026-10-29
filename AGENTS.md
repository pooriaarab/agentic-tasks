# agentic-tasks agent guide

Task boards where people and agents claim and finish work.

## Model

- A board has ordered columns.
- A task sits in one column. It has a title, description, labels, due date, and assignees.
- Every write records the acting principal and its kind: `human`, `agent_of_human`, `agent_of_agent`, `agent`, or `user_token`.
- A claim holds a task for a set time. Only the holder can release it.

## Faces

- SDK: `createTasks({ store })` from `agentic-tasks`.
- CLI: `agentic-tasks <command> --as <id> --kind <kind> [--file <path>]`. A write needs `--as` and `--kind`; the kind is never defaulted. Output is JSON.
- MCP: `agentic-tasks mcp`. Each tool names its `principal`.
- Store: tasks run on the `Store` port from `agentic-identity`. Tests use its memory adapter. The CLI uses `createFileStore`, which passes the `Store` contract suite.
- Store file: `AGENTIC_TASKS_FILE` or `--file` picks the JSON file. The default is `./agentic-tasks.json`.

## Claim rules

1. A claim fails while another principal holds a live claim.
2. A claim is live until its expiry instant. At that instant it has expired.
3. A claim whose expiry does not parse counts as live.
4. The holder can claim again to renew the claim.
5. A claim fails on a closed task.
6. Only the holder can release. A release with no claim fails.
7. While another principal holds a live claim, a close fails. The holder can close.
8. Closing a task clears its claim.
9. Two simultaneous claims: exactly one succeeds.
10. Moves, edits, and progress notes do not check the claim. Only claims, releases, and closes do.

## Rules

- Read a task before you claim it.
- Report every refused call as a failure, with its error code.
- Never retry a refused claim in a loop. Wait for the holder or the expiry.
