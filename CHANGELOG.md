# Changelog

All notable changes to this package are in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.11.0] - 2026-10-29

### Changed

- The web UI has a calmer look. It uses `agentic-design` ^0.5.0 tokens and `agd-` classes only. The style follows Tiny Little Office (https://tinylittleoffice.com, MIT); no code is copied.
- A task opens in a side panel, not a dialog. The panel takes the focus and returns it to the card on Escape. On a narrow screen it fills the page, and the board behind it is inert. A card keeps the focus after a move, and a status line says where it went.
- The "New task" button moves the focus to the quick add field of the first column.

### Added

- Quick add at the foot of each column, inline title edit (F2 or the card menu), and drag and drop between columns.
- A keyboard and single-pointer way to move a card (WCAG 2.2, 2.5.7): Alt and the left or right arrow, or the card menu.
- Due date, assignee, claim, and label chips on each card. A date before today on an open task shows as late.
- `E2E_PORT` sets the port of the browser tests, so parallel runs do not clash.

## [0.10.0] - 2026-10-29

### Added

- Sharing beyond a plain grant, on every surface. The owner of a board can list its grants, invites, and share links, invite a person by email or an agent by handle, and make and revoke share links. SDK: `listAccess`, `inviteToBoard`, `createBoardLink`, `revokeBoardLink` (also on `agentic-tasks/client`). CLI: `access`, `invite`, `link`, `unlink`. MCP tools: `list_access`, `create_invite`, `create_link`, `revoke_link`. HTTP: `GET /boards/:id/access`, `POST /boards/:id/invites`, `POST /boards/:id/links`, `DELETE /boards/:id/links/:linkId`. An invite or a link never gives owner. A list shows no email and no link token.
- `tasksAccount`: `exportAccount` and `eraseAccount` for a host that runs account export and erase across packages. They return plain JSON by collection and counts by collection, so the host does not read the board layout. The erase deletes each task before its board.

### Fixed

- `eraseBoard` puts the board row back when a step after the row delete fails, for example when `deleteResource` is refused for more than 100 owners. Before, the row stayed deleted and the board could not be found again.

## [0.9.0] - 2026-10-29

### Changed

- **BREAKING:** design class prefix is now agd-. The UI reads the `--agd-*` tokens from `agentic-design` ^0.4.0. The old prefix matches EasyList cosmetic rules, so ad blockers hid design-styled controls. Host CSS that sets old-prefix tokens or targets old-prefix classes must use the agd- names instead.

## [0.8.0] - 2026-10-29

### Added

- A `<board id>`, `<task id>`, `<title>`, or `<name>` argument of the CLI also takes a flag: `--board`, `--task`, `--title`, or `--name`. For example, `list --board <board id>` is the same as `list <board id>`. Give each value once, as the argument or as the flag. `tasks <command> --help` lists the flag forms of that command.

### Security

- `zod` is `^4.6.6`, and the `overrides` field gives the same range to `agentic-design`. It was `^3.25.0`. This clears GHSA-mrhx-c7xc-m3w5.

### Fixed

- The repository's publish workflow runs one release at a time for each ref. A second run waits for the first. Before, two runs could overlap. The package code does not change.

## [0.7.0] - 2026-10-29

### Added

- `deleteTask`, `listBoards`, and `exportData` on the SDK and the client. The CLI has `delete`, `boards`, and `export`. MCP has `delete_task`, `list_boards`, and `export_data`. The HTTP API has `DELETE /tasks/:id`, `GET /boards`, and `GET /export`. Delete needs the editor role. While another principal holds a live claim, only the holder or a board owner can delete.
- An install and CLI quick start in the README.

### Changed

- The file store is now the `agentic-identity/file` adapter. The store file format changes, and the CLI refuses a file from an earlier release. Export the data with the earlier release, then import it again. A call that loses a race between two processes runs again on fresh data.
- `agentic-tasks --version` prints the version and exits 0. `--help` prints the full usage and exits 0, at the top level, for each command, and for `mcp`.
- `board` and `new` take the title as an argument or as `--title`. A command refuses an unknown flag or an extra argument with exit code 2, so `board new --title Sprint` no longer makes a board named "new".
- The `agentic-identity` dependency is `^0.6.0`. It was `^0.4.0`. A project that pins `agentic-identity` 0.4.x next to this package gets two copies. Move that pin to 0.6.x.
- The Worker checks every credential with `requirePrincipal` from `agentic-identity/http`. A 401 now sends `www-authenticate: Bearer`. A failed credential check on the store returns 503 `STORE_BUSY` with `retry-after: 1`, so a client can retry. A write authenticated by something other than a bearer token, such as a session cookie, returns 403 `FORBIDDEN` from any origin. A request with no valid credential still gets 401. Any other failure returns 500 `INTERNAL`.

### Fixed

- The embedded board (`agentic-tasks/ui`) passes axe WCAG 2.2 AA on a host page. Column headings are `h2`, so they follow the board's `h1` with no skipped level. The "Back to lists" button has no button face, so its link color keeps its contrast in dark mode, and it is 24px tall.

## [0.6.0] - 2026-10-29

### Added

- `agentic-tasks/ui` exports `mount`, which renders the task UI into an element from a base URL and a token callback. `agentic-tasks/ui.css` holds its styles. React is an optional peer dependency.

### Fixed

- The README describes only what works. It says the package is on npm, and it lists the features that are not built under "Not yet".

## [0.5.0] - 2026-10-29

### Added

- `GET /api/v1/tasks/health` on the Worker returns `{ "ok": true }`. It needs no
  auth and reads no store, so a monitor can check that the Worker runs.

### Changed

- `PRINCIPAL_KINDS` and the `PrincipalKind` type come from `agentic-identity` now,
  not from a local copy. The five values are the same.

## [0.4.0] - 2026-10-29

### Added

- `agentic-tasks/worker`: the Cloudflare Worker (`createApp`, and the default app on D1)
  is now a public subpath export, with a test that imports it from a packed tarball.
- A web UI that the Worker serves on `/`, built on `agentic-design` and the typed client.
  It has lists, a board view and a list view, task create, edit, assign, claim, release,
  and close, filters, empty, loading, and error states, and a mark on tasks that an
  agent created or last changed.
- Playwright tests against `wrangler dev`, an axe WCAG 2.2 AA check on each view in
  light and dark, and a screenshot set in `docs/screenshots`.

### Fixed

- `agentic-tasks --help` (also `-h` and `help`) prints the usage and exits 0. It exited 2.

## [0.3.0] - 2026-10-29

This release adds one public subpath. Nothing else changed since 0.2.0.

### Added

- `agentic-tasks/client`: `createClient({ baseUrl, token, fetch? })`, a typed client for
  the Worker HTTP API. It has one method for each route, throws `TasksApiError` with the
  API error `code` and HTTP `status`, takes an `AbortSignal`, and never retries. It uses
  only `fetch`, so it runs in Workers and Node 22, and in a browser on the same origin as
  the Worker.
- The client checks every success reply for its shape, and fails a wrong one as `UNKNOWN`.
  It refuses an id of `.` or `..`, a `baseUrl` that is not `http` or `https`, and a
  redirect.

## [0.2.0] - 2026-10-29

### Breaking

- Uses `agentic-identity` 0.4.0. A grant is keyed on kind (`human` or `agent`) and id.
  A person and an agent with one id are two subjects.
- `shareBoard` and `unshareBoard` take a subject `{ kind, id }`, not an id.
- The CLI `share` and `unshare` need `--subject-kind human|agent`. The kind is never
  defaulted.
- The MCP tools `share_board` and `unshare_board` take `subjectKind`.
- The member route is `/boards/:id/members/:kind/:subjectId`.
- A grant that 0.1.0 stored is not honored. `migrateGrants` from `agentic-identity`
  can rewrite it only where the store holds a `principals` row for each subject, as
  the identity Worker does. The CLI file store holds none, so a 0.1.0 store file keeps
  working only with 0.1.0. 0.2.0 opens a 0.1.0 file, but refuses every board call on
  it with `FORBIDDEN`. Start a new file for 0.2.0.
- `TASKS_UNSAFE_TRUST_HEADERS` is gone. The Worker reads bearer credentials from the
  D1 store with the `agentic-identity` `Auth`. `TASKS_UNSAFE_LOCAL_TEST_AUTH=1` trusts
  principal headers for local tests, and refuses a request that does not name
  loopback. It reads headers, not the socket: keep `wrangler dev` on loopback.

### Added

- `eraseBoard`, the CLI `erase`, the MCP tool `erase_board`, and `DELETE /boards/:id`.
  They remove the board and its tasks and notes. They call `deleteResource`, which also
  removes the grants, invites, and links of the board, and most of its audit entries:
  an entry written at the moment of the erase can stay. Only an owner can erase. An
  erase that stops after a failed write can run again. An erase is refused when the
  board has more than 100 owners, and the tasks and notes are already gone then.

### Changed

- A trusted local context (CLI, MCP, local test Auth) holds roles as `human` (kinds
  `human` and `user_token`) or as `agent` (every agent kind) with its own id. This is
  local only. In a real chain the root of an agent is the person or agent it acts for.

## [0.1.0] - 2026-10-29

First release.

- Task boards with ordered columns. A task has a title, description, labels, due
  date, and assignees. Every write records the acting principal and its kind.
- Claims with an expiry of up to one day. A claim fails while another principal
  holds a live claim. The holder or a board owner can release or close.
- Board roles (viewer, commenter, editor, owner) on shared `agentic-identity`
  principals. A refused call returns `FORBIDDEN`.
- SDK (`createTasks`), CLI (`agentic-tasks`), and MCP server (`agentic-tasks mcp`).
- Local JSON store for the CLI, which passes the `agentic-identity` `Store`
  contract suite.
- HTTP API as a Cloudflare Worker on D1, with a required region claim
  (`TASKS_REGION`). The sign-in stopgap is for local dev only and needs
  `TASKS_UNSAFE_TRUST_HEADERS=1`.
- Local dev can run with `TASKS_REGION=unknown` and `TASKS_UNSAFE_LOCAL_REGION=1`.
  The region check does not run then. Never set it in production.
- Depends on `agentic-identity` ^0.3.0. Requires Node.js 22 or later.
