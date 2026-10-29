import { usableName } from "agentic-design/react";
import type { PrincipalKind } from "../src/model.js";

// A principal id passes the design package's name check before it is shown to anyone.
export const nameOf = (id: string) => usableName(id) ?? "Unnamed";

// Every kind except "human" counts as machine-made, and so does "user_token", which acts as a
// person through an agent. The mark errs toward showing it.
export const personOf = (s: { id: string; kind: PrincipalKind }) => ({
  id: s.id,
  name: nameOf(s.id),
  kind: s.kind === "human" ? ("person" as const) : ("agent" as const),
});
