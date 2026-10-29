# agentic-tasks

[![npm version](https://img.shields.io/npm/v/agentic-tasks)](https://www.npmjs.com/package/agentic-tasks)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-tasks) · [Source](https://github.com/pooriaarab/agentic-tasks) · [Support](https://github.com/pooriaarab/agentic-tasks/issues)

Task boards where people and agents claim and finish work.

> Status: early. The library, CLI, and MCP server use the shared `Store` port
> from `agentic-identity`. The CLI keeps data in a local JSON file.
> The HTTP API runs as a Worker on a D1 database. Board roles come from
> `agentic-identity`. The Worker reads a bearer credential from the same D1
> store. The package is on npm as `agentic-tasks`.

> [!CAUTION]
> The Worker does not issue credentials. Run the `agentic-identity` Worker on the
> same D1 database to sign people in and to make keys. `TASKS_UNSAFE_LOCAL_TEST_AUTH=1`
> swaps the credential for the `X-Principal-Id` and `X-Principal-Kind` headers.
> Nothing checks them. It serves only a request that names a loopback host and a
> loopback client address, and answers 403 to any other. Both are headers, not
> the socket. Keep `wrangler dev` on its default loopback address, or a caller on
> your network can forge them. Use it for local dev and tests only. `TASKS_UNSAFE_LOCAL_REGION=1` skips the
> region check of the database. Use it for local dev only.

## Install and quick start

Node 22 or later. Install the package, or run it with `npx`:

```sh
npm install agentic-tasks
```

Make a board, add a task, claim it, and finish it. The data goes to `./agentic-tasks.json`.
Every command needs `--as` and `--kind`. The kind is never defaulted.

```sh
tasks() { npx agentic-tasks "$@"; }
tasks board "Sprint" --columns "Todo,Doing,Done" --as ana --kind human
```

The output is the board as JSON. Copy its `id` and the `id` of the first column:

```sh
tasks new <board id> "Write the spec" --column <column id> --as ana --kind human
tasks claim <task id> --ttl-ms 600000 --as ana --kind human
tasks progress <task id> "Draft is done" --as ana --kind human
tasks close <task id> --as ana --kind human
tasks boards --as ana --kind human
tasks export --as ana --kind human
```

A `<board id>`, `<task id>`, `<title>`, or `<name>` argument also has a flag form: `board --title Sprint`, `new --board <board id>
--title "Write the spec"`, `list --board <board id>` (or `list <board id>`), `column --board
<board id> --name Done`, and `get --task <task id>`. Every `<task id>` takes `--task` and every `<board id>` takes `--board`. The subject, role, and note of `share`, `unshare`, and `progress` are arguments only. Give a value as the argument or as the
flag, not both. A word, flag, or missing value that a command does not accept fails with
exit code 2 and a message that names it. `tasks --help` lists the commands, `tasks <command> --help`
shows one command, and `tasks --version` prints the version. Use `--file <path>` or
`AGENTIC_TASKS_FILE` to pick another store file.

## Access

Every call has a principal from `agentic-identity`: who acts, the chain it acts
for, and its scopes. A board is a resource with roles. A call needs a role:

| Role | Can |
|---|---|
| viewer | read the board, its tasks, and progress notes |
| commenter | also add progress notes |
| editor | also add columns, make, move, edit, claim, release, and close tasks |
| owner | also share the board, invite, make share links, list access, and take access away |

The person who makes a board owns it. An agent that acts for a person gets that
person's role, cut down by the scopes that its chain leaves. Every check writes
an audit entry that keeps the chain and labels an agent action as machine-made.
Share with the SDK (`shareBoard`, `unshareBoard`), the CLI (`share`, `unshare`),
the MCP tools (`share_board`, `unshare_board`), or `PUT` and `DELETE` on
`/boards/:id/members/:kind/:subjectId`. A role belongs to a kind (`human` or `agent`)
and an id, so a person and an agent with one id are two subjects. The CLI needs
`--subject-kind`. Erase a board, with its tasks, notes, and grants, with `eraseBoard`,
`erase`, `erase_board`, or `DELETE /boards/:id`. Only an owner can. Listing tasks needs a `boardId`.

Every sharing call needs the owner role:

| Action | SDK | CLI | MCP tool | HTTP |
|---|---|---|---|---|
| Give a role | `shareBoard` | `share` | `share_board` | `PUT /boards/:id/members/:kind/:subjectId` |
| Take a role | `unshareBoard` | `unshare` | `unshare_board` | `DELETE /boards/:id/members/:kind/:subjectId` |
| List grants, invites, links | `listAccess` | `access` | `list_access` | `GET /boards/:id/access` |
| Invite by email or handle | `inviteToBoard` | `invite` | `create_invite` | `POST /boards/:id/invites` |
| Make a share link | `createBoardLink` | `link` | `create_link` | `POST /boards/:id/links` |
| Revoke a share link | `revokeBoardLink` | `unlink` | `revoke_link` | `DELETE /boards/:id/links/:linkId` |

An invite or a link gives viewer, commenter, or editor, never owner. Only a grant makes an
owner. An invite names an email (a person) or a handle (an agent). A list shows no email.
A link token shows once, in the reply that makes it. A list shows the link id, role,
expiry, and revoke time, and never the token. `expiresInMs` (`--expires-in-ms`) sets how long an invite or
link lives. `signedInOnly` (`--signed-in-only true`) limits a link to signed-in people. A link or
an invite on its own does not change the board: accepting an invite and opening a link are
part of `agentic-identity`.

## Lifecycle

- Delete one task and its notes with `deleteTask`, `delete <task id>`, `delete_task`, or
  `DELETE /tasks/:id`. It needs the editor role. While another principal holds a live
  claim, only the holder or a board owner can delete.
- List the boards you hold a role on with `listBoards`, `boards`, `list_boards`, or `GET /boards`.
- Export your own data with `exportData`, `export`, `export_data`, or `GET /export`. The
  JSON has each board you hold a role on, your role, the tasks you made, last changed, hold, or
  are assigned to, and the notes you wrote. A task is the whole task: it names the other
  people and agents on it and holds text that they wrote. The notes are only yours. Share
  the file with care. An agent exports its own tasks and notes, from the boards it can reach. The role is the grant of the person or agent at the root of its chain.

- A host that runs account export and erase across many packages calls `tasksAccount` (from `agentic-tasks`). It has `exportAccount(subject, { tasks, ctx })` and `eraseAccount(subject, { tasks, ctx })`, so the host does not read the board layout. `ctx` must be the context of the subject, with one step in its chain that is the subject (as `trustedContext` makes): a context for someone else, or a delegated chain, throws, even for an agent subject. The export has plain JSON in `boards` (each with your `role`), `tasks`, and `notes`. The erase removes each board that the subject made and still owns, with its tasks and notes, and returns counts of `boards`, `tasks`, and `notes`. The tasks and notes that other people wrote on that board go too, and the counts include them. A task added while the erase runs may be erased and not counted. A board that was shared to the subject stays, and so do the tasks and notes the subject wrote on another person's board. If an erase stops half way, the error names the board id. Each task goes before its board, so the board stays in place and a repeat of the erase finds it and counts only what is left: the counts of the runs add up. A board that the subject owns but whose stored creator is not a valid principal, and a stored task row with no id, stop the erase and name the board; for the task row, before anything goes on that board, and it stops the same way each time until the row is removed. A board the subject made goes even when others now work in it. The shape is provisional: it is the `AccountPackage` contract that a later `agentic-identity` release adds to `agentic-identity/account`. The `agentic-identity/account` of a release before it has a different contract (`AccountApp`), and `tasksAccount` does not fit that one. The subject is an id and a kind: the host takes the kind from the signed-in principal and does not guess it. Export and erase are two calls, so a task written between them is erased and not exported: stop writes first.

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
  `unshareBoard`, `listAccess`, `inviteToBoard`, `createBoardLink`, `revokeBoardLink`, `eraseBoard`, `listBoards`, `exportData`, `deleteTask`, `createTask`, `listTasks`, `getTask`, `updateTask`,
  `moveTask`, `claim`, `release`, `closeTask`, `progress`, and `listProgress`.
- A refused call throws `TasksApiError` with the API error `code` and the HTTP `status`.
  A reply that is not an API error, or a success reply with the wrong shape, has the code `UNKNOWN`.
- Each method takes `{ signal }` last. An aborted call rejects with the signal reason: `AbortError`, or `TimeoutError` for `AbortSignal.timeout`.
  A write that was aborted after it was sent may still have applied. Read the task before you try again.
- The client does not follow redirects: a 3xx reply fails as `UNKNOWN`.
- The Worker sends no CORS headers. A browser page can call it only from the same origin.
- The client never retries. A refused claim stays refused: wait for the holder or the expiry.

## Live demo

A demo Worker runs at <https://agentic-tasks-demo.hello-fd1.workers.dev>.
`GET /api/v1/tasks/health` answers 200. The web UI loads on `/`.
The demo holds no credentials, so any other API call answers 401. It uses its
own D1 database in the EU. It is a staging demo. Do not store real data in it.

Redeploy it with your own Cloudflare account. Log in with `wrangler login`, or
export `CLOUDFLARE_API_TOKEN` in your shell. Do not put a token in the repo or
in CI.

```sh
npx wrangler d1 create agentic-tasks-demo --location weur
# Put the database id in wrangler.demo.jsonc, then:
export WRANGLER_SEND_METRICS=false
npx wrangler d1 migrations apply DB --remote --config wrangler.demo.jsonc
npm run deploy:demo
```

## Features

- Boards with columns that you name.
- Tasks with a title, a description, labels, a due date, and assignees.
- People and agents claim a task for up to one day. The holder or a board owner can release the claim.
- Progress notes on a task.
- Agent tools over MCP: create, get, list, move, update, claim, release, and close tasks, and add and list progress notes.
- Board roles: viewer, commenter, editor, and owner. Share a board with a role, invite by email or handle, and make share links.

## Not yet

- Real-time updates. A person or an agent sees a change by someone else only when it reads the task or the list again.
- Accepting an invite and opening a share link in this package. Make and list them here. `agentic-identity` takes them.

## Surfaces

One package gives you each way in:

- **Library and SDK**: `import { ... } from "agentic-tasks"`. The remote client is `agentic-tasks/client`.
- **CLI**: `npx agentic-tasks --help`. See the quick start above.
- **MCP server**: `npx agentic-tasks mcp`, for Claude Code and other MCP clients.
- **HTTP API**: a Cloudflare Worker at `/api/v1/tasks`. Read the caution above first.
- **Web UI**: a small app served by the same Worker.

## Exports

The package has these entries. The build writes each one to `dist/`.

| Entry | What it is | Where it is described |
|---|---|---|
| `agentic-tasks` | The library: `createTasks`, `createFileStore`, `tasksAccount`, `trustedContext`, types, `TaskError`, `PRINCIPAL_KINDS`, and `VERSION`. | [Library](#library) |
| `agentic-tasks/client` | A typed client for the Worker HTTP API. | [SDK](#sdk) |
| `agentic-tasks/worker` | The HTTP API as a Hono app for a Cloudflare Worker. | [Worker](#worker) |
| `agentic-tasks/ui` | `mount`, which renders the task UI in your page, with its option types and the `TasksClient` type. | [Mount the UI](#mount-the-ui-in-your-app) |
| `agentic-tasks/ui.css` | The styles for `agentic-tasks/ui`. | [Mount the UI](#mount-the-ui-in-your-app) |
| `agentic-tasks` (bin, `dist/cli.js`) | The CLI. `agentic-tasks mcp` serves the MCP tools. | [CLI and MCP](#cli-and-mcp) |

There is no `agentic-tasks/mcp` entry. Start the MCP server with `npx agentic-tasks mcp`.

### Library

The library reads no environment variables. Give it a store. Every call takes a
principal context from `agentic-identity`. `trustedContext(id, kind)` makes one from a principal id and a kind.
It does not check them. Use it only in local code that you control.

```ts
import { createFileStore, createTasks, trustedContext } from "agentic-tasks";

const tasks = createTasks({ store: createFileStore("./agentic-tasks.json") });
const ana = trustedContext("ana", "human"); // no check: local code only

const board = await tasks.createBoard({ title: "Sprint" }, ana);
await tasks.addColumn(board.id, "Todo", ana);
const task = await tasks.createTask({ boardId: board.id, title: "Write the spec" }, ana); // no columnId: the first column
await tasks.getTask(task.id, ana); // read a task before you claim it
await tasks.claim(task.id, ana, { ttlMs: 600_000 });
```

- `createTasks({ store, now? })` returns the `Tasks` methods. `store` is any `Store` from `agentic-identity` that passes its contract suite.
- `createFileStore(path, options?)` is the JSON file adapter. `options` are the adapter options of `agentic-identity`.
- `tasksAccount` has `exportAccount` and `eraseAccount`, for a host that runs account export and erase. See [Lifecycle](#lifecycle).
- A refused call throws `TaskError`. Its `code` is one of `NOT_FOUND`, `FORBIDDEN`, `INVALID_INPUT`, `CLAIM_HELD`, `NOT_HOLDER`, or `TASK_CLOSED`.
- `PRINCIPAL_KINDS` lists the kinds: `human`, `agent_of_human`, `agent_of_agent`, `agent`, and `user_token`. `VERSION` is the package version.

### Worker

The default export of `agentic-tasks/worker` is the HTTP API at `/api/v1/tasks`.
It is a Hono app with a `fetch` handler. It stores data in the D1 database bound as
`DB`. The package does not serve the web UI. This repo's own Worker serves the UI.

Export the app from your Worker's entry file:

```ts
// src/index.ts
export { default } from "agentic-tasks/worker";
```

Add this to your Wrangler config. It sets the `nodejs_compat` flag. The store adapters use Node built-ins such as `Buffer`:

```jsonc
{
  "name": "my-tasks",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "vars": { "TASKS_REGION": "eu" },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "agentic-tasks",
      "database_id": "<id from wrangler d1 create>",
      "migrations_dir": "migrations"
    }
  ]
}
```

Create the database in the EU with `npx wrangler d1 create agentic-tasks --location weur`. For `us`, use `--location wnam` or `--location enam`, and set `TASKS_REGION` to `us`. The package does not ship the schema. Copy every file in this repo's `migrations/` folder into your `migrations/` folder, then run `npx wrangler d1 migrations apply DB --remote`.

| Binding or variable | Needed | What it does |
|---|---|---|
| `DB` | Yes | The D1 database. Without it every route under `/api/v1/tasks` except `health` answers 503 `STORE_NOT_CONFIGURED`. |
| `TASKS_REGION` | Yes | `eu` or `us`, where the database lives. You set it. The Worker does not detect it. With `DB` bound and no valid value, every route under `/api/v1/tasks` except `health` answers 503 `REGION_NOT_CONFIGURED`. A region mismatch is described below the table. |
| `TASKS_UNSAFE_LOCAL_TEST_AUTH` | No | `1` trusts the `X-Principal-Id` and `X-Principal-Kind` headers, on loopback requests only. Use it only for local dev and tests. A request that is not on loopback gets 403 `LOCAL_TEST_AUTH_NOT_LOOPBACK`. |
| `TASKS_UNSAFE_LOCAL_REGION` | No | `1` lets `TASKS_REGION` be `unknown`, because local D1 reports no region. Local dev only. |

Without test auth, the default export reads a bearer credential from the same D1 database.
Run the `agentic-identity` Worker on that database to issue credentials. A request
with no valid credential answers 401 `UNAUTHENTICATED`. If the store cannot answer the credential check, the request answers 503 `STORE_BUSY` with `retry-after: 1`, and a retry can succeed. A request with a credential gets the same 503 on a region mismatch, but a retry does not help: check `TASKS_REGION` and the database location. A request with no credential gets 401 and never reads the store.

The module also has these named exports:

- `createApp(resolve, auth?)` builds the app. `resolve(env)` returns the `Tasks` to use. `auth` is an `Auth` from `agentic-identity`, or a function of `env` that returns one. When you pass `auth`, `TASKS_UNSAFE_LOCAL_TEST_AUTH` has no effect.
- `tasksOnD1(env)` and `authOnD1(env)` are the default store and credential check on `DB`.
- `localTestAuth` and `isLoopbackRequest` are the loopback test auth.

To use another store or credential check, call `createApp` yourself. It still needs the `DB` binding and a valid `TASKS_REGION`. Without them it answers 503 before it calls your store. With your own `auth` and a D1 store, a region mismatch answers 500 `INTERNAL`. Install `agentic-identity` `^0.6.0` in your app. This package uses that version. The example imports its types:

```ts
import { createApp } from "agentic-tasks/worker";
import { createTasks } from "agentic-tasks";
import type { Auth, Store } from "agentic-identity";

declare const myStore: (env: unknown) => Store;  // your Store
declare const myAuth: Auth;                      // your Auth

export default createApp(
  (env) => createTasks({ store: myStore(env) }),
  myAuth,
);
```

### CLI and MCP

`npx agentic-tasks` runs the CLI, and `npx agentic-tasks mcp` serves the MCP tools over stdio. Both use the store file that `--file` names, then `AGENTIC_TASKS_FILE`, then `./agentic-tasks.json`. An MCP client config:

```json
{
  "mcpServers": {
    "agentic-tasks": {
      "command": "npx",
      "args": ["agentic-tasks", "mcp", "--file", "./agentic-tasks.json"]
    }
  }
}
```

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
  only tasks that an agent created or last changed.
- Mark each task that an agent created, or that an agent changed last. The mark is words and an icon.
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
- The API keeps only the last writer of a task. If a person changes a task after an agent did, the mark for the agent change goes away. An agent that created a task stays marked.
- The UI does not show progress notes or manage sharing.

### Mount the UI in your app

`agentic-tasks/ui` renders the task UI inside your own page. Your app does not need React code. It must
install `react` and `react-dom` (version 19), because `agentic-tasks/ui` imports them. You give it
an element, the Worker origin, a function that returns the bearer token, and the principal who uses the UI.
`mount` returns a handle.

```ts
import { mount } from "agentic-tasks/ui";
import "agentic-tasks/ui.css";   // the design styles and the task styles

const ui = mount(document.getElementById("tasks")!, {
  baseUrl: "https://tasks.example.com",
  getToken: async () => await myAuth.token(),   // called before every request
  principal: { id: "ada", kind: "human" },
  // boardId: "b_123",                          // open this list first
});

ui.update({ baseUrl, getToken, principal, boardId: "other" });  // show another list
ui.unmount();                                                   // remove the UI
```

`ui.css` is global. It holds the design tokens and base rules for `html`, `body`, headings, and links, and it
uses plain class names such as `.card` and `.row`. Load it on a page that can take those styles. The UI does not
change the theme of the page: set `data-theme` on `<html>` yourself. The UI shows one `h1`, the list or board name.

The principal needs an `id` and a `kind`. A missing or unknown `kind` throws a `TypeError`. An empty token
fails the call, and the UI shows the error. The server still checks every write against the token. The UI
remembers the lists it opened in `localStorage`, under one key for the page origin. It does not separate
Workers or principals.

`react` and `react-dom` (version 19) are optional peer dependencies. Install them to use `agentic-tasks/ui`.
The CLI, the MCP server, and `agentic-tasks/client` do not need them. The web UI that the Worker serves
uses the same components.

## Run locally

```sh
git clone https://github.com/pooriaarab/agentic-tasks
cd agentic-tasks
npm install && npm run dev
```

You can also use `bun install && bun run dev`. The `dev` script calls npm, so npm must be installed. The scripts need macOS, Linux, or WSL. The `dev` script builds the package, then starts `wrangler dev` on <http://localhost:8791>. Wrangler keeps a local D1 database. The `dev` script turns off Wrangler telemetry. Set `WRANGLER_SEND_METRICS=false` when you run other wrangler commands.

```sh
curl -i http://localhost:8791/api/v1/tasks/health   # 200
```

The API needs a credential. To call it with test auth, stop `npm run dev` and use the commands in "Develop". They start the server with test auth on port 8787.

`npm run dev:smoke` runs the same check by itself. It starts the dev server. It waits for `/api/v1/tasks/health` to answer 200. It stops the server. CI runs it as the "dev smoke" step. To use another port, change `8791` in the `dev` and `dev:smoke` scripts.

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
