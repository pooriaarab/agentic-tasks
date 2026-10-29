import type { PrincipalContext } from "agentic-identity";
import type { PrincipalKind } from "./model.js";

// A context from a name that nobody has checked, with the full board scope. The
// board role of that principal still limits it. Use it only where the caller is
// already trusted: the local CLI, the local MCP server, and the Worker's
// loopback-only test auth (TASKS_UNSAFE_LOCAL_TEST_AUTH).
//
// A role is held by the root of a chain, which is a person or an agent. A trusted
// context has one step, so it is its own root: a person or a user token holds a
// role as a person, and every agent kind holds it as the agent with that id. Any
// other kind keeps its own name as root and holds no role.
export function trustedContext(id: string, kind: string): PrincipalContext {
  const root = kind === "human" || kind === "user_token" ? "human" : kind.startsWith("agent") ? "agent" : kind;
  return {
    principalId: id,
    kind: kind as PrincipalKind,
    chain: [{ id, kind: root as PrincipalKind }],
    scopes: ["board:admin"],
  };
}
