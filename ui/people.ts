import { usableName } from "agentic-design/react";
import type { PrincipalKind } from "../src/model.js";

// A principal id passes the design package's name check before it is shown to anyone.
export const personOf = (s: { id: string; kind: PrincipalKind }) => ({
  id: s.id,
  name: usableName(s.id) ?? "Unnamed",
  kind: s.kind === "human" ? ("person" as const) : ("agent" as const),
});
