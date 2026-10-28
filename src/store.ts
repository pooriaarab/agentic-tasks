import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
// A lock older than this is stale even when its process still runs.
const LOCK_STALE_MS = 30_000;

interface LockOwner {
  pid: number;
  createdAt: number;
}

function parseOwner(text: string): LockOwner | undefined {
  try {
    const owner = JSON.parse(text) as Partial<LockOwner>;
    if (typeof owner.pid === "number" && typeof owner.createdAt === "number") {
      return { pid: owner.pid, createdAt: owner.createdAt };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Returns the lock text when the lock is stale. A lock with no readable
// owner is judged by its age. Returns undefined when the lock is live or gone.
async function staleLockText(lockPath: string): Promise<string | undefined> {
  let text: string;
  let ageMs: number;
  try {
    text = await readFile(lockPath, "utf8");
    ageMs = Date.now() - (await stat(lockPath)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const owner = parseOwner(text);
  if (owner === undefined) return ageMs > LOCK_STALE_MS ? text : undefined;
  const expired = Date.now() - owner.createdAt > LOCK_STALE_MS;
  return expired || !processIsAlive(owner.pid) ? text : undefined;
}

// Removes the lock only while it still holds the expected text, so a process
// never deletes a lock that another process has just taken.
async function removeLockIfText(lockPath: string, expected: string): Promise<void> {
  try {
    if ((await readFile(lockPath, "utf8")) === expected) {
      await rm(lockPath, { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function fileLock<T>(lockPath: string, work: () => Promise<T>): Promise<T> {
  const text = JSON.stringify({
    pid: process.pid,
    createdAt: Date.now(),
    token: randomUUID(),
  });
  for (let attempt = 1; ; attempt += 1) {
    try {
      await writeFile(lockPath, text, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stale = await staleLockText(lockPath);
      if (stale !== undefined) {
        await removeLockIfText(lockPath, stale);
        continue;
      }
      if (attempt >= LOCK_ATTEMPTS) {
        throw new Error(`store is locked by a live process. Lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
  try {
    return await work();
  } finally {
    await removeLockIfText(lockPath, text);
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
