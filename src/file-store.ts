import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { emptyState, storeFrom, type Backend, type State, type Store } from "./store.js";

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

// The lock file is created with the O_EXCL flag ("wx"). That makes the
// create atomic across processes. The file names its owner, so a lock left
// by a dead process is taken over.
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

// A JSON file on disk. Writes go to a temp file, then rename over the old
// file. A lock file serializes writers across processes.
export function createFileStore(path: string): Store {
  const backend: Backend = {
    load: async (): Promise<State> => {
      try {
        return JSON.parse(await readFile(path, "utf8")) as State;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
        throw error;
      }
    },
    save: async (next) => {
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`);
        await rename(temp, path);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    },
  };
  return storeFrom(backend, async (work) => {
    await mkdir(dirname(path), { recursive: true });
    return fileLock(`${path}.lock`, work);
  });
}
