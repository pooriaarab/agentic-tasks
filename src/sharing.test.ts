import { createMemoryStore } from "agentic-identity";
import { describe, expect, it } from "vitest";
import { TaskError } from "./model.js";
import { trustedContext } from "./principal.js";
import { createTasks } from "./tasks.js";

const ALICE = trustedContext("alice", "human");
const BOB = trustedContext("bob", "human");
const NOW = Date.parse("2026-10-28T10:00:00Z");

async function setup() {
  const tasks = createTasks({ store: createMemoryStore(), now: () => new Date(NOW) });
  const board = await tasks.createBoard({ title: "Sprint" }, ALICE);
  const other = await tasks.createBoard({ title: "Other" }, ALICE);
  return { tasks, board, other };
}

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TaskError);
  return (error as TaskError).code;
}

describe("board sharing: access, invites, links", () => {
  it("lists the grants, the invites, and the links to an owner", async () => {
    const { tasks, board } = await setup();
    await tasks.shareBoard(board.id, { kind: "agent", id: "bot" }, "editor", ALICE);
    const invite = await tasks.inviteToBoard(board.id, { role: "viewer", email: "Ada@Example.com" }, ALICE);
    const handle = await tasks.inviteToBoard(board.id, { role: "commenter", handle: "helper", expiresInMs: 1000 }, ALICE);
    const link = await tasks.createBoardLink(board.id, { role: "viewer", expiresInMs: 60_000 }, ALICE);

    const access = await tasks.listAccess(board.id, ALICE);
    expect(access.grants.map((g) => g.subjectId).sort()).toEqual(["alice", "bot"]);
    expect(access.invites.map((i) => i.id).sort()).toEqual([invite.id, handle.id].sort());
    expect(access.links).toEqual([{ id: link.id, role: "viewer", signedInOnly: false, expiresAt: NOW + 60_000 }]);
    // No address and no token leave the store.
    const text = JSON.stringify(access);
    expect(text).not.toContain("example.com");
    expect(text).not.toContain(link.token);
    expect(text).not.toContain("tokenHash");
  });

  it("refuses every sharing call to a principal that is not an owner", async () => {
    const { tasks, board } = await setup();
    await tasks.shareBoard(board.id, { kind: "human", id: "bob" }, "editor", ALICE);
    const link = await tasks.createBoardLink(board.id, { role: "viewer" }, ALICE);
    expect(await code(tasks.listAccess(board.id, BOB))).toBe("FORBIDDEN");
    expect(await code(tasks.inviteToBoard(board.id, { role: "viewer", handle: "x" }, BOB))).toBe("FORBIDDEN");
    expect(await code(tasks.createBoardLink(board.id, { role: "viewer" }, BOB))).toBe("FORBIDDEN");
    expect(await code(tasks.revokeBoardLink(board.id, link.id, BOB))).toBe("FORBIDDEN");
  });

  it("refuses bad input with INVALID_INPUT", async () => {
    const { tasks, board } = await setup();
    const bad: Promise<unknown>[] = [
      tasks.inviteToBoard(board.id, { role: "owner" as never, handle: "x" }, ALICE),
      tasks.inviteToBoard(board.id, { role: "viewer" }, ALICE),
      tasks.inviteToBoard(board.id, { role: "viewer", email: "a@b.co", handle: "x" }, ALICE),
      tasks.inviteToBoard(board.id, { role: "viewer", email: "not-an-email" }, ALICE),
      tasks.inviteToBoard(board.id, { role: "viewer", handle: "x", expiresInMs: -1 }, ALICE),
      tasks.inviteToBoard(board.id, { role: "viewer", handle: "x", expiresInMs: "1" as never }, ALICE),
      tasks.createBoardLink(board.id, { role: "owner" as never }, ALICE),
      tasks.createBoardLink(board.id, { role: "viewer", signedInOnly: "yes" as never }, ALICE),
      tasks.createBoardLink(board.id, { role: "viewer", expiresInMs: Number.NaN }, ALICE),
    ];
    for (const call of bad) expect(await code(call)).toBe("INVALID_INPUT");
  });

  it("revokes a link, and not a link of another board", async () => {
    const { tasks, board, other } = await setup();
    const link = await tasks.createBoardLink(other.id, { role: "viewer" }, ALICE);
    // Alice owns both boards, but the link belongs to the other one.
    expect(await code(tasks.revokeBoardLink(board.id, link.id, ALICE))).toBe("NOT_FOUND");
    expect(await code(tasks.revokeBoardLink(board.id, "missing", ALICE))).toBe("NOT_FOUND");
    expect((await tasks.listAccess(other.id, ALICE)).links[0]?.revokedAt).toBeUndefined();
    await tasks.revokeBoardLink(other.id, link.id, ALICE);
    expect((await tasks.listAccess(other.id, ALICE)).links[0]?.revokedAt).toBe(NOW);
  });

  it("refuses an agent that holds no role", async () => {
    const { tasks, board } = await setup();
    expect(await code(tasks.createBoardLink(board.id, { role: "viewer" }, trustedContext("bot", "agent_of_human")))).toBe("FORBIDDEN");
  });
});
