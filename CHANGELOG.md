# Changelog

All notable changes to this package are in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `agentic-tasks/client`: `createClient({ baseUrl, token, fetch? })`, a typed client for
  the Worker HTTP API. It has one method for each route, throws `TasksApiError` with the
  API error `code` and HTTP `status`, takes an `AbortSignal`, and never retries.

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
