import type { PrincipalContext } from "agentic-identity";
import type { PrincipalKind } from "./model.js";

// A context from a name that nobody has checked, with the full board scope. The
// board role of that principal still limits it. Use it only where the caller is
// already trusted: the local CLI, the local MCP server, and the Worker's
// loopback-only test auth (TASKS_UNSAFE_LOCAL_TEST_AUTH).
export function trustedContext(id: string, kind: string): PrincipalContext {
  return {
    principalId: id,
    kind: kind as PrincipalKind,
    chain: [{ id, kind: kind as PrincipalKind }],
    scopes: ["board:admin"],
  };
}
