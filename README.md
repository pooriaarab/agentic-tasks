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

## SDK

`agentic-tasks/client` is a typed client for the Worker HTTP API. It uses only
`fetch`, so it runs in Workers and Node 22, and in a browser on the same origin as the Worker.

```js
import { createClient, TasksApiError } from "agentic-tasks/client";

const tasks = createClient({ baseUrl: "https://tasks.example.com", token });
const board = await tasks.createBoard({ title: "Sprint" });
try {
  await tasks.getTask(taskId); // read a task before you claim it
  await tasks.claim(taskId, { ttlMs: 600_000 }, { signal: AbortSignal.timeout(5000) });
} catch (error) {
  if (error instanceof TasksApiError) console.error(error.code, error.status);
  else throw error;
}
```

- `baseUrl` is the Worker URL, `http` or `https`, with no query, hash, or credentials. The client adds
  `/api/v1/tasks` after any path prefix.
- `token` is a bearer credential that the Worker accepts. `fetch` is optional.
- One method for each route: `createBoard`, `getBoard`, `addColumn`, `shareBoard`,
  `unshareBoard`, `eraseBoard`, `createTask`, `listTasks`, `getTask`, `updateTask`,
  `moveTask`, `claim`, `release`, `closeTask`, `progress`, and `listProgress`.
- A refused call throws `TasksApiError` with the API error `code` and the HTTP `status`.
  A reply that is not an API error, or a success reply with the wrong shape, has the code `UNKNOWN`.
- Each method takes `{ signal }` last. An aborted call rejects with the signal reason: `AbortError`, or `TimeoutError` for `AbortSignal.timeout`.
  A write that was aborted after it was sent may still have applied. Read the task before you try again.
- The client does not follow redirects: a 3xx reply fails as `UNKNOWN`.
- The Worker sends no CORS headers. A browser page can call it only from the same origin.
- The client never retries. A refused claim stays refused: wait for the holder or the expiry.

## Planned features

- Boards and lists with columns you name.
- People and agents claim a task and post progress on it.
- Due dates, labels, and assignees.
- Agent tools: list, claim, update, and close tasks.
- Real-time updates.
- Share by invite or link. Roles work now. Invites and links are not wired in yet.

## Surfaces

One package gives you each way in:

- **Library and SDK**: `import { ... } from "agentic-tasks"`. The remote client is `agentic-tasks/client`.
- **CLI**: `npx agentic-tasks --help`.
- **MCP server**: `npx agentic-tasks mcp`, for Claude Code and other MCP clients.
- **HTTP API**: a Cloudflare Worker at `/api/v1/tasks`. Read the caution above first.
- **Web UI**: a small app served by the same Worker.

## UI

The Worker serves a small web app on `/`. It uses the `agentic-design` package
from npm for tokens, controls, and overlays, and the typed client from
`agentic-tasks/client` to call the API.

Run it on your machine:

```sh
npm ci
export WRANGLER_SEND_METRICS=false
npm run build
npx wrangler d1 migrations apply DB --local
npx wrangler dev --var TASKS_UNSAFE_LOCAL_TEST_AUTH:1 --var TASKS_REGION:unknown --var TASKS_UNSAFE_LOCAL_REGION:1
```

Open `http://127.0.0.1:8787`. Give a principal id and a kind. The UI never
defaults the kind. Leave the token empty: the local Worker trusts that name
on loopback requests only. A deployed Worker needs a bearer token in the
token field.

What it does:

- Create a list. The UI adds the columns To do, Doing, and Done.
- Create, edit, assign, claim, release, and close a task.
- Show tasks as a board or a list. Filter by text, status, and column, or show
  only tasks that an agent made.
- Mark each task that an agent created or changed. The mark is words and an icon.
- Show loading, empty, and error states. A refused call shows its error code.

It works with a keyboard, shows a focus ring, and follows the system light or
dark theme or your pick. An axe check for WCAG 2.2 AA runs on each view in both
themes. Screenshots are in `docs/screenshots`.

Run the browser tests. They start `wrangler dev` on port 18743:

```sh
npx playwright install chromium
npm run test:e2e
SCREENSHOTS=1 npm run test:e2e   # writes docs/screenshots
```

The UI limits:

- The API has no call that lists lists. The UI remembers the lists that this
  browser opened. Open another list by its id.
- The session (id, kind, token) stays in `sessionStorage` until the tab closes.
- The UI does not show progress notes or manage sharing.

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
- A move with a position that you name can share it with another task. Ids break
  the tie. Positions and note numbers that the package picks are always different.
- Tasks use any `Store` that passes the `agentic-identity` contract suite. Pass a
  `Store` to `createTasks`. `createFileStore` is the file adapter. Use
  `createMemoryStore` from `agentic-identity` in tests.
- A live claim blocks other claims and closes, except from a board owner. A claim lasts at most one day. Moves, edits, and progress notes
  do not check the claim.

## License

MIT.
