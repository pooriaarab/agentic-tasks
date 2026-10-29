# agentic-tasks

[![npm version](https://img.shields.io/npm/v/agentic-tasks)](https://www.npmjs.com/package/agentic-tasks)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-tasks) · [Source](https://github.com/pooriaarab/agentic-tasks) · [Support](https://github.com/pooriaarab/agentic-tasks/issues)

Task boards where people and agents claim and finish work.

> Status: early. The library, CLI, and MCP server use the shared `Store` port
> from `agentic-identity`. The CLI keeps data in a local JSON file.
> The HTTP API runs as a Worker on a D1 database. Board roles come from
> `agentic-identity`. The Worker reads a bearer credential from the same D1
> store. The package is not on npm yet.

> [!CAUTION]
> The Worker does not issue credentials. Run the `agentic-identity` Worker on the
> same D1 database to sign people in and to make keys. `TASKS_UNSAFE_LOCAL_TEST_AUTH=1`
> swaps the credential for the `X-Principal-Id` and `X-Principal-Kind` headers.
> Nothing checks them. It serves only a request that names a loopback host and a
> loopback client address, and answers 403 to any other. Both are headers, not
> the socket. Keep `wrangler dev` on its default loopback address, or a caller on
> your network can forge them. Use it for local dev and tests only. `TASKS_UNSAFE_LOCAL_REGION=1` skips the
> region check of the database. Use it for local dev only.

## Access

Every call has a principal from `agentic-identity`: who acts, the chain it acts
for, and its scopes. A board is a resource with roles. A call needs a role:

| Role | Can |
|---|---|
| viewer | read the board, its tasks, and progress notes |
| commenter | also add progress notes |
| editor | also add columns, make, move, edit, claim, release, and close tasks |
| owner | also share the board and take access away |

The person who makes a board owns it. An agent that acts for a person gets that
person's role, cut down by the scopes that its chain leaves. Every check writes
an audit entry that keeps the chain and labels an agent action as machine-made.
Share with the SDK (`shareBoard`, `unshareBoard`), the CLI (`share`, `unshare`),
the MCP tools (`share_board`, `unshare_board`), or `PUT` and `DELETE` on
`/boards/:id/members/:kind/:subjectId`. A role belongs to a kind (`human` or `agent`)
and an id, so a person and an agent with one id are two subjects. The CLI needs
`--subject-kind`. Erase a board, with its tasks, notes, and grants, with `eraseBoard`,
`erase`, `erase_board`, or `DELETE /boards/:id`. Only an owner can. Listing tasks needs a `boardId`.

## Planned features

- Boards and lists with columns you name.
- People and agents claim a task and post progress on it.
- Due dates, labels, and assignees.
- Agent tools: list, claim, update, and close tasks.
- Real-time updates.
- Share by invite or link. Roles work now. Invites and links are not wired in yet.

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

Run the HTTP API on your machine only. Wrangler keeps a local D1 database:

```sh
export WRANGLER_SEND_METRICS=false
npx wrangler d1 migrations apply DB --local
npx wrangler dev --var TASKS_UNSAFE_LOCAL_TEST_AUTH:1 --var TASKS_REGION:unknown --var TASKS_UNSAFE_LOCAL_REGION:1
```

Local D1 reports no served region, so the store cannot check a region claim
there. `TASKS_UNSAFE_LOCAL_REGION=1` lets the Worker run with region `unknown`.
Use it for local dev only. Never set it in production.

Deploy to a database in the EU. The location cannot change later:

```sh
npx wrangler d1 create agentic-tasks --location weur
# Put the database id in wrangler.jsonc, then:
npx wrangler d1 migrations apply DB --remote
```

`TASKS_REGION` in `wrangler.jsonc` is your claim about where the database
lives (`eu` or `us`). The Worker answers 503 until it holds a valid region.
The store also refuses a query that D1 reports as served outside that region.
Production D1 reports the region for each query. Local D1 does not.
Every Worker instance reads the same database, so a claim taken in one instance
is refused in all of them.

## Limits

- The Worker reads credentials but does not issue them. Use the `agentic-identity` Worker for that.
- The CLI and the MCP server trust the principal that you name, as `git` trusts
  `user.name`. Anyone who can open the store file can name any principal.
- A role check and the action that follows are two steps. A role that is taken
  away at that moment can still finish the call that began before.
- The JSON file store works on one machine. Do not put the file on a network share.
- The CLI file format changed. It does not read files from earlier releases.
- Two tasks made at the same moment in one column can share a position. Two notes
  made at the same moment can share a `seq`. Ids break the tie.
- Tasks use any `Store` that passes the `agentic-identity` contract suite. Pass a
  `Store` to `createTasks`. `createFileStore` is the file adapter. Use
  `createMemoryStore` from `agentic-identity` in tests.
- A live claim blocks other claims and closes, except from a board owner. A claim lasts at most one day. Moves, edits, and progress notes
  do not check the claim.

## License

MIT.
