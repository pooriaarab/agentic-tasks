import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_LIMIT,
  assertCollection,
  assertField,
  assertId,
  parseRegion,
  type AdapterOptions,
  type Doc,
  type Json,
  type Page,
  type Query,
  type Store,
  type StoreOps,
} from "agentic-identity";

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

interface Row {
  doc: Doc;
  version: number;
}

interface Data {
  // Every write takes the next number, so a doc that is deleted and made again
  // never repeats a version.
  clock: number;
  tables: Map<string, Map<string, Row>>;
}

interface Write {
  collection: string;
  id: string;
  doc: Doc | null;
}

interface Tx {
  // The version each doc had when the transaction first read it. 0 means missing.
  seen: Map<string, number>;
  writes: Map<string, Write>;
}

const MAX_TRANSACTION_RUNS = 50;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const keyOf = (collection: string, id: string) => `${collection}/${id}`;

const compare = (a: Json, b: Json): number =>
  typeof a !== typeof b
    ? typeof a < typeof b ? -1 : 1
    : (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;

// A file that is not a store file fails loudly. It is never read as an empty store.
async function load(path: string): Promise<Data> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { clock: 0, tables: new Map() };
    throw error;
  }
  const refuse = () => new Error(`${path} is not an agentic-tasks store file`);
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw refuse();
  }
  if (
    !isObject(raw) ||
    typeof raw.clock !== "number" ||
    !Number.isSafeInteger(raw.clock) ||
    raw.clock < 0 ||
    !isObject(raw.tables)
  ) {
    throw refuse();
  }
  const clock = raw.clock;
  // Every row needs a version above 0 that the clock has already passed. A
  // version that repeats would let a stale transaction pass its check.
  const tables = new Map<string, Map<string, Row>>();
  for (const [name, rows] of Object.entries(raw.tables)) {
    if (!isObject(rows)) throw refuse();
    const table = new Map<string, Row>();
    for (const [id, row] of Object.entries(rows)) {
      const ok =
        isObject(row) &&
        isObject(row.doc) &&
        typeof row.version === "number" &&
        Number.isSafeInteger(row.version) &&
        row.version > 0 &&
        row.version <= clock;
      if (!ok) throw refuse();
      table.set(id, row as unknown as Row);
    }
    tables.set(name, table);
  }
  return { clock, tables };
}

// Writes to a temp file, then renames it over the old file.
async function save(path: string, data: Data): Promise<void> {
  const tables = Object.fromEntries(
    [...data.tables].map(([name, rows]) => [name, Object.fromEntries(rows)]),
  );
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ clock: data.clock, tables }, null, 2)}\n`);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function unchanged(data: Data, seen: Map<string, number>): boolean {
  return [...seen].every(([key, version]) => {
    const slash = key.indexOf("/");
    return (
      (data.tables.get(key.slice(0, slash))?.get(key.slice(slash + 1))?.version ?? 0) === version
    );
  });
}

function queryRows(data: Data, collection: string, query: Query) {
  const limit = query.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("limit must be an integer of 1 or more");
  }
  for (const name of Object.keys(query.where ?? {})) assertField(name);
  const field = query.orderBy?.field;
  if (field !== undefined) assertField(field);
  const sign = query.orderBy?.direction === "desc" ? -1 : 1;
  const order = (x: { v: Json; id: string }, y: { v: Json; id: string }) =>
    sign * (compare(x.v, y.v) || compare(x.id, y.id));
  let rows = [...(data.tables.get(collection) ?? [])]
    .filter(([, row]) =>
      Object.entries(query.where ?? {}).every(([k, v]) => k in row.doc && row.doc[k] === v),
    )
    .map(([id, row]) => ({ id, row, v: (field === undefined ? id : row.doc[field]) as Json }))
    .filter((entry) => entry.v !== undefined && entry.v !== null)
    .sort(order);
  if (query.cursor !== undefined) {
    let after: { v: Json; id: string };
    try {
      const [v, id] = JSON.parse(Buffer.from(query.cursor, "base64url").toString()) as [Json, string];
      if (typeof id !== "string") throw new Error();
      after = { v, id };
    } catch {
      throw new Error("invalid cursor");
    }
    rows = rows.filter((entry) => order(entry, after) > 0);
  }
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? Buffer.from(JSON.stringify([last.v, last.id])).toString("base64url")
      : undefined;
  return { page, nextCursor };
}

// A JSON file on disk that follows the shared Store port. Reads never take the
// lock. A write takes the lock file, checks the versions it read, and then
// renames a temp file over the old one. Two stores on one file stay correct.
export function createFileStore(path: string, options: AdapterOptions = {}): Store {
  const region = options.region === undefined ? "unknown" : parseRegion(options.region);

  // Applies writes under the lock. Returns false when a doc in `seen` changed.
  const commit = (seen: Map<string, number>, writes: Iterable<Write>) =>
    (async () => {
      await mkdir(dirname(path), { recursive: true });
      return fileLock(`${path}.lock`, async () => {
        const data = await load(path);
        if (!unchanged(data, seen)) return false;
        let dirty = false;
        for (const { collection, id, doc } of writes) {
          dirty = true;
          if (doc === null) {
            data.tables.get(collection)?.delete(id);
            continue;
          }
          if (!data.tables.has(collection)) data.tables.set(collection, new Map());
          data.tables.get(collection)!.set(id, { doc, version: ++data.clock });
        }
        if (dirty) await save(path, data);
        return true;
      });
    })();

  function ops(tx?: Tx): StoreOps {
    const noReadAfterWrite = () => {
      if (tx && tx.writes.size > 0) throw new Error("a transaction must read before it writes");
    };
    const see = (collection: string, id: string, version: number) => {
      const key = keyOf(collection, id);
      if (tx && !tx.seen.has(key)) tx.seen.set(key, version);
    };
    const write = async (collection: string, id: string, doc: Doc | null) => {
      assertCollection(collection);
      assertId(id);
      if (tx) tx.writes.set(keyOf(collection, id), { collection, id, doc });
      else await commit(new Map(), [{ collection, id, doc }]);
    };
    return {
      async get<T extends Doc>(collection: string, id: string) {
        assertCollection(collection);
        assertId(id);
        noReadAfterWrite();
        const found = (await load(path)).tables.get(collection)?.get(id);
        see(collection, id, found?.version ?? 0);
        return found ? copy(found.doc as T) : null;
      },
      async put(collection, id, doc) {
        await write(collection, id, copy(doc));
      },
      async delete(collection, id) {
        await write(collection, id, null);
      },
      async query<T extends Doc>(collection: string, query: Query = {}): Promise<Page<T>> {
        assertCollection(collection);
        noReadAfterWrite();
        const { page, nextCursor } = queryRows(await load(path), collection, query);
        for (const entry of page) see(collection, entry.id, entry.row.version);
        return {
          items: page.map((entry) => ({ id: entry.id, data: copy(entry.row.doc as T) })),
          ...(nextCursor === undefined ? {} : { nextCursor }),
        };
      },
    };
  }

  return {
    region,
    ...ops(),
    async transaction(fn) {
      for (let run = 0; run < MAX_TRANSACTION_RUNS; run += 1) {
        const tx: Tx = { seen: new Map(), writes: new Map() };
        const result = await fn(ops(tx));
        // A read-only transaction still checks, so it never returns a stale read.
        const ok =
          tx.writes.size === 0
            ? unchanged(await load(path), tx.seen)
            : await commit(tx.seen, tx.writes.values());
        if (ok) return result;
      }
      throw new Error("transaction kept conflicting");
    },
  };
}
