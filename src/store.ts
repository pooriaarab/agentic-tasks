// Storage port. Every operation runs inside one transaction. The body is
// synchronous and sees a consistent snapshot. Writes commit only when the
// body returns. A throw discards every write from that transaction.
// Queries use equality filters only, so a Firestore adapter can match them.

export type Collection = "boards" | "tasks" | "progress";

export interface Tx {
  get<T extends { id: string }>(collection: Collection, id: string): T | undefined;
  list<T extends { id: string }>(
    collection: Collection,
    equals?: Record<string, string | undefined>,
  ): T[];
  put(collection: Collection, row: { id: string }): void;
}

export interface Store {
  transaction<T>(run: (tx: Tx) => T): Promise<T>;
}

export type State = Record<Collection, Record<string, { id: string }>>;

export function emptyState(): State {
  return { boards: {}, tasks: {}, progress: {} };
}

// Reads the whole state, and writes it back when a transaction changes it.
export interface Backend {
  load(): Promise<State>;
  save(next: State): Promise<void>;
}

export type Lock = <T>(work: () => Promise<T>) => Promise<T>;

// Runs one transaction at a time inside this process.
export function serialLock(): Lock {
  let queue: Promise<unknown> = Promise.resolve();
  return (work) => {
    const run = queue.then(work);
    queue = run.catch(() => undefined);
    return run;
  };
}

export function storeFrom(backend: Backend, lock: Lock): Store {
  return {
    transaction<T>(run: (tx: Tx) => T): Promise<T> {
      return lock(async () => {
        const draft = await backend.load();
        let dirty = false;
        const tx: Tx = {
          get<R extends { id: string }>(collection: Collection, id: string) {
            const row = draft[collection][id];
            return row === undefined ? undefined : (structuredClone(row) as R);
          },
          list<R extends { id: string }>(
            collection: Collection,
            equals: Record<string, string | undefined> = {},
          ) {
            return Object.values(draft[collection])
              .filter((row) =>
                Object.entries(equals).every(
                  ([field, value]) =>
                    value === undefined ||
                    (row as Record<string, unknown>)[field] === value,
                ),
              )
              .map((row) => structuredClone(row) as R);
          },
          put(collection: Collection, row: { id: string }) {
            draft[collection][row.id] = structuredClone(row);
            dirty = true;
          },
        };
        const result = run(tx);
        if (dirty) await backend.save(draft);
        return result;
      });
    },
  };
}

// State lives in this process only. A Worker instance keeps its own copy.
export function createMemoryStore(): Store {
  let state = emptyState();
  return storeFrom(
    {
      load: async () => structuredClone(state),
      save: async (next) => {
        state = next;
      },
    },
    serialLock(),
  );
}
