import type { PrincipalContext } from "agentic-identity";
import type { PrincipalKind } from "./model.js";

// The stopgap until the identity Worker API (agentic-identity 0.2.0) can resolve a
// credential to a chain. It builds a context from a name that nobody has checked,
// with the full board scope. The board role of that principal still limits it.
// Use it only where the caller is already trusted: the local CLI, the local MCP
// server, and the Worker behind TASKS_UNSAFE_TRUST_HEADERS.
export function trustedContext(id: string, kind: string): PrincipalContext {
  return {
    principalId: id,
    kind: kind as PrincipalKind,
    chain: [{ id, kind: kind as PrincipalKind }],
    scopes: ["board:admin"],
  };
}
