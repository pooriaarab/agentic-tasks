# agentic-tasks

[![npm version](https://img.shields.io/npm/v/agentic-tasks)](https://www.npmjs.com/package/agentic-tasks)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-tasks) · [Source](https://github.com/pooriaarab/agentic-tasks) · [Support](https://github.com/pooriaarab/agentic-tasks/issues)

Task boards where people and agents claim and finish work.

> Status: early. The library holds boards, tasks, and claim rules. The CLI, MCP
> server, and HTTP API are not built yet. The package is not on npm yet.

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
- **HTTP API**: a Cloudflare Worker you deploy to your own account.
- **Web UI**: a small app served by the same Worker.

## Develop

```sh
npm ci
npm run build && npm run typecheck && npm test
```

## License

MIT.
