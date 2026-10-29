# Changelog

All notable changes to this package are in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

- The Worker reads bearer credentials from the D1 store with the `agentic-identity`
  `Auth`. `TASKS_UNSAFE_TRUST_HEADERS` is gone. `TASKS_UNSAFE_LOCAL_TEST_AUTH=1`
  trusts principal headers for local tests, and refuses any request outside loopback.

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
