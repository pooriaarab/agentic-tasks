import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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

type State = Record<Collection, Record<string, { id: string }>>;

function emptyState(): State {
  return { boards: {}, tasks: {}, progress: {} };
}

interface Backend {
  load(): Promise<State>;
  save(next: State): Promise<void>;
}

type Lock = <T>(work: () => Promise<T>) => Promise<T>;

function inProcessLock(): Lock {
  let queue: Promise<unknown> = Promise.resolve();
  return (work) => {
    const run = queue.then(work);
    queue = run.catch(() => undefined);
    return run;
  };
}

const LOCK_ATTEMPTS = 500;
const LOCK_WAIT_MS = 10;

async function fileLock<T>(lockPath: string, work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await (await open(lockPath, "wx")).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt >= LOCK_ATTEMPTS) {
        throw new Error(
          `store is locked. If no other process runs, delete ${lockPath}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
  try {
    return await work();
  } finally {
    await rm(lockPath, { force: true });
  }
}

function transactional(backend: Backend, lock: Lock): Store {
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

export function createMemoryStore(): Store {
  let state = emptyState();
  return transactional(
    {
      load: async () => structuredClone(state),
      save: async (next) => {
        state = next;
      },
    },
    inProcessLock(),
  );
}

// A JSON file on disk. Writes go to a temp file, then rename over the old
// file. A lock file serializes writers across processes.
export function createFileStore(path: string): Store {
  return transactional(
    {
      load: async () => {
        try {
          return JSON.parse(await readFile(path, "utf8")) as State;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return emptyState();
          }
          throw error;
        }
      },
      save: async (next) => {
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`);
        await rename(temp, path);
      },
    },
    (work) => fileLock(`${path}.lock`, work),
  );
}
