import { createFileStore as createIdentityFileStore } from "agentic-identity/file";
import type { AdapterOptions, Store } from "agentic-identity";

// The file adapter lives in agentic-identity. This keeps the call shape
// `createFileStore(path, options)` that earlier releases of this package had.
export function createFileStore(path: string, options: AdapterOptions = {}): Store {
  return createIdentityFileStore({ ...options, path });
}
