# agentic-tasks

[![npm version](https://img.shields.io/npm/v/agentic-tasks)](https://www.npmjs.com/package/agentic-tasks)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-tasks) · [Source](https://github.com/pooriaarab/agentic-tasks) · [Support](https://github.com/pooriaarab/agentic-tasks/issues)

Task boards where people and agents claim and finish work.

> Status: early. The library, CLI, and MCP server use the shared `Store` port
> from `agentic-identity`. The CLI keeps data in a local JSON file.
> The HTTP API runs as a Worker, but it has no authentication yet. The package
> is not on npm yet.

> [!CAUTION]
> Do not expose the HTTP API to the public internet. The Worker trusts the
> `X-Principal-Id` and `X-Principal-Kind` headers. Any caller can act as any
> person or agent. The Worker answers 503 until you set
> `TASKS_UNSAFE_TRUST_HEADERS=1`. Set it only behind a gateway that checks
> identity and sets those headers itself.

## Planned features

- Boards and lists with columns you name.
- People and agents claim a task and post progress on it.
- Due dates, labels, and assignees.
- Agent tools: list, claim, update, and close tasks.
- Real-time updates.
- Share by invite or link, with roles.

## Surfaces

One package gives you each way in:

- **Library and SDK**: `import { ... } from "agentic-tasks"`.
- **CLI**: `npx agentic-tasks --help`.
- **MCP server**: `npx agentic-tasks mcp`, for Claude Code and other MCP clients.
- **HTTP API**: a Cloudflare Worker at `/api/v1/tasks`. Read the caution above first.
- **Web UI**: a small app served by the same Worker.

## Develop

```sh
npm ci
npm run build && npm run typecheck && npm test
```

Run the HTTP API on your machine only:

```sh
npx wrangler dev --var TASKS_UNSAFE_TRUST_HEADERS:1
```

## Limits

- The HTTP API has no authentication. It trusts the principal headers.
- The Worker keeps state in memory. Each instance has its own tasks and claims,
  so the claim rules do not hold across instances.
- The JSON file store works on one machine. Do not put the file on a network share.
- Tasks use any `Store` that passes the `agentic-identity` contract suite. Pass a
  `Store` to `createTasks`. `createFileStore` is the file adapter. Use
  `createMemoryStore` from `agentic-identity` in tests.
- A live claim blocks other claims and closes. Moves, edits, and progress notes
  do not check the claim.

## License

MIT.
