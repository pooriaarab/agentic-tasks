import { createFileStore as createIdentityFileStore } from "agentic-identity/file";
import { StoreConflictError, type AdapterOptions, type Store } from "agentic-identity";

const MAX_CONFLICT_RUNS = 50;

// The shared adapter throws StoreConflictError when another process changed the
// file after it was read. It does not run the call again. A call that fails this
// way wrote nothing, so it runs again on fresh data, as a transaction may.
async function again<T>(work: () => Promise<T>): Promise<T> {
  for (let run = 1; ; run += 1) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof StoreConflictError) || run >= MAX_CONFLICT_RUNS) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * Math.min(run, 10)));
    }
  }
}

// The file adapter lives in agentic-identity. This keeps the call shape
// `createFileStore(path, options)` that earlier releases of this package had.
export function createFileStore(path: string, options: AdapterOptions = {}): Store {
  const store = createIdentityFileStore({ ...options, path });
  return {
    region: store.region,
    get: (collection, id) => again(() => store.get(collection, id)),
    query: (collection, query) => again(() => store.query(collection, query)),
    put: (collection, id, doc) => again(() => store.put(collection, id, doc)),
    delete: (collection, id) => again(() => store.delete(collection, id)),
    transaction: (fn) => again(() => store.transaction(fn)),
  };
}
