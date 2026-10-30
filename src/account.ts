import { PRINCIPAL_KINDS, ROLES, SUBJECT_KINDS, type Doc, type Json, type Store, type StoreOps } from "agentic-identity";
import type { AccountPackage, AccountSubject } from "agentic-identity/account";
import { z } from "zod";
import { TaskError } from "./model.js";

export interface TasksAccountDeps { store: Store }
export type TasksCollection = "boards" | "tasks" | "notes" | "grants" | "invites" | "links" | "audit";
export interface TasksAccount extends AccountPackage<TasksAccountDeps> {
  id: "tasks";
  exportAccount(subject: AccountSubject, deps: TasksAccountDeps): Promise<Record<TasksCollection, Json[]>>;
  eraseAccount(subject: AccountSubject, deps: TasksAccountDeps): Promise<Record<TasksCollection, number>>;
}
const stamp = z.object({ id: z.string().min(1), kind: z.enum(PRINCIPAL_KINDS) });
const time = z.iso.datetime();
const schemas = {
  boards: z.object({ id: z.string(), title: z.string(), columns: z.array(z.object({ id: z.string(), name: z.string() })), createdBy: stamp, createdAt: time, updatedAt: time }),
  tasks: z.object({ id: z.string(), boardId: z.string(), title: z.string(), description: z.string(), columnId: z.string(), position: z.number().finite(), labels: z.array(z.string()), dueDate: z.iso.date().nullable(), assignees: z.array(stamp), status: z.enum(["open", "closed"]), createdBy: stamp, updatedBy: stamp, createdAt: time, updatedAt: time, closedAt: time.optional(), claim: z.object({ holder: stamp, claimedAt: time, expiresAt: time }).optional() }),
  progress: z.object({ id: z.string(), taskId: z.string(), seq: z.number().int().positive(), note: z.string(), by: stamp, at: time }),
};
const ERASED = "(erased)";
const collections = ["boards", "tasks", "progress", "grants", "invites", "links", "audit", "resources", "counters"] as const;
type Collection = typeof collections[number];
type Row = { id: string; data: Doc };
function fail(): never { throw new TaskError("INVALID_INPUT", "account data is damaged"); }
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const principal = (v: unknown): v is { id: string; kind: string } => {
  const p = v as { id?: unknown; kind?: unknown } | null;
  return !!p && text(p.id) && (PRINCIPAL_KINDS as readonly unknown[]).includes(p.kind);
};
const matches = (v: unknown, s: AccountSubject) => principal(v) && v.id === s.id && v.kind === s.kind;
const rootKind = (s: AccountSubject) => s.kind === "human" || s.kind === "user_token" ? "human" : "agent";
const bucket = (c: Collection): TasksCollection => c === "progress" ? "notes" : c as TasksCollection;
const empty = <T>(make: () => T): Record<TasksCollection, T> => Object.fromEntries(["boards", "tasks", "notes", "grants", "invites", "links", "audit"].map(c => [c, make()])) as Record<TasksCollection, T>;

async function rows(store: StoreOps, collection: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let cursor: string | undefined; ;) {
    const page = await store.query(collection, { limit: 100, ...(cursor ? { cursor } : {}) });
    out.push(...page.items);
    if ((cursor = page.nextCursor) === undefined) return out;
  }
}

// Account operations are administrative. The host authenticates the subject and stops writes first.
// Read and validate the complete plan before any mutation; never guess who owns a damaged row.
async function plan(subject: AccountSubject, deps: TasksAccountDeps) {
  if (!text(subject?.id) || subject.id === ERASED || !(PRINCIPAL_KINDS as readonly unknown[]).includes(subject.kind)) throw new TaskError("INVALID_INPUT", "subject needs an id and a known kind");
  if (!deps?.store || ["query", "get", "put", "delete", "transaction"].some(key => typeof deps.store[key as keyof Store] !== "function")) throw new TaskError("INVALID_INPUT", "tasksAccount needs deps.store");
  const all = Object.fromEntries(await Promise.all(collections.map(async c => [c, await rows(deps.store, c)]))) as Record<Collection, Row[]>;
  const boards = new Set(all.boards.map(r => r.id));
  for (const r of all.resources) if (r.data.type === "board") boards.add(r.id);
  const tasks = new Map(all.tasks.map(r => [r.id, r.data]));
  const resource = new Map(all.resources.map(r => [r.id, r.data]));
  const mine = (d: Doc) => d.subjectId === subject.id && d.subjectKind === rootKind(subject);
  for (const r of all.grants) if (r.data.subjectId === subject.id && (!text(r.data.resourceId) || !(SUBJECT_KINDS as readonly unknown[]).includes(r.data.subjectKind))) fail();
  const owned = new Set<string>();
  const sole = new Set<string>();
  for (const id of boards) {
    let next: string | undefined = id;
    const seen = new Set<string>();
    const owners: Doc[] = [];
    while (next !== undefined) {
      if (seen.has(next) || seen.size >= 16) fail();
      seen.add(next);
      const res = resource.get(next);
      if (!res || (next === id ? res.type !== "board" : res.type !== "folder")) fail();
      for (const r of all.grants.filter(r => r.data.resourceId === next)) {
        const d = r.data;
        if (!text(d.subjectId) || !(SUBJECT_KINDS as readonly unknown[]).includes(d.subjectKind) || !(ROLES as readonly unknown[]).includes(d.role) || r.id !== `${next}:${String(d.subjectKind)}:${d.subjectId}`) fail();
        if (d.role === "owner") owners.push(d);
      }
      if (res.parentId != null && !text(res.parentId)) fail();
      next = res.parentId == null ? undefined : res.parentId as string;
    }
    if (owners.length === 0) fail();
    if (owners.some(mine)) owned.add(id);
    if (owners.every(mine)) {
      if (all.resources.some(r => r.data.parentId === id)) fail();
      sole.add(id);
    }
  }
  for (const c of ["boards", "tasks", "progress"] as const) for (const r of all[c]) {
    const d = r.data;
    if (d.id !== r.id || !schemas[c].safeParse(d).success) fail();
    if (c === "tasks" && !boards.has(String(d.boardId))) fail();
    if (c === "progress" && !tasks.has(String(d.taskId))) fail();
  }
  const boardOf = (c: Collection, r: Row): string | undefined => c === "boards" || c === "resources" ? r.id : c === "tasks" ? String(r.data.boardId) : c === "progress" ? String(tasks.get(String(r.data.taskId))?.boardId) : text(r.data.resourceId) ? r.data.resourceId : undefined;
  const authored = (c: Collection, d: Doc): boolean => {
    if (c === "boards") return matches(d.createdBy, subject);
    if (c === "tasks") return matches(d.createdBy, subject) || matches(d.updatedBy, subject) || (d.assignees as Json[]).some(p => matches(p, subject)) || matches((d.claim as Doc | undefined)?.holder, subject);
    if (c === "progress") return matches(d.by, subject);
    if (c === "invites") return d.createdBy === subject.id;
    if (c === "audit") {
      if (!Array.isArray(d.chain)) fail();
      if (d.principalId === subject.id && !(PRINCIPAL_KINDS as readonly unknown[]).includes(d.principalKind)) fail();
      if (d.chain.some(p => !principal(p))) fail();
      return (d.principalId === subject.id && d.principalKind === subject.kind) || d.chain.some(p => principal(p) && p.id === subject.id && p.kind === rootKind(subject)) || (d.targetId === subject.id && d.targetKind === rootKind(subject));
    }
    return false;
  };
  for (const c of ["audit", "invites", "links"] as const) for (const r of all[c]) {
    const id = boardOf(c, r);
    if (!id) {
      if (c === "audit" && r.data.resourceId === undefined) continue;
      fail();
    }
    if (!boards.has(id)) continue;
    const d = r.data;
    if (d.id !== r.id) fail();
    if (c === "audit") {
      if (!text(d.principalId) || ![...PRINCIPAL_KINDS, "anonymous"].includes(d.principalKind as never) || typeof d.machineMade !== "boolean" || typeof d.at !== "number" || !Number.isFinite(d.at)) fail();
      authored(c, d);
      if (d.rootId !== undefined && (!Array.isArray(d.chain) || (d.chain[0] as Doc | undefined)?.id !== d.rootId)) fail();
    } else {
      if (!(ROLES as readonly unknown[]).includes(d.role)) fail();
      for (const key of ["expiresAt", "revokedAt"]) if (d[key] !== undefined && (typeof d[key] !== "number" || !Number.isFinite(d[key]))) fail();
      if (c === "invites" ? !text(d.createdBy) : !text(d.tokenHash) || typeof d.signedInOnly !== "boolean") fail();
    }
  }
  return { all, boards, owned, sole, mine, boardOf, authored };
}

export const tasksAccount: TasksAccount = {
  id: "tasks",
  async exportAccount(subject, deps) {
    const p = await plan(subject, deps);
    const out = empty<Json[]>(() => []);
    for (const c of collections) {
      if (c === "resources" || c === "counters") continue;
      for (const r of p.all[c]) {
        const id = p.boardOf(c, r);
        if (!id || !p.boards.has(id)) continue;
        if ((["boards", "tasks", "progress"].includes(c) && p.owned.has(id)) || (c === "grants" && (p.owned.has(id) || p.mine(r.data))) || ((c === "invites" || c === "links" || c === "audit") && p.owned.has(id)) || p.authored(c, r.data)) {
          // Sharing secrets are credentials, not portable account content.
          const { tokenHash: _token, ...data } = r.data;
          out[bucket(c)].push(data);
        }
      }
    }
    return out;
  },
  async eraseAccount(subject, deps) {
    const p = await plan(subject, deps);
    const counts = empty(() => 0);
    // Each board is atomic: a failed commit leaves every discovery record for a retry.
    for (const id of p.boards) {
      const delta = await deps.store.transaction(async tx => {
        const delta = empty(() => 0);
        for (const c of collections) for (const r of p.all[c]) {
          if (c === "counters") continue;
          if (p.boardOf(c, r) !== id) continue;
          const remove = p.sole.has(id) || (c === "grants" && p.mine(r.data)) || (c === "invites" && p.authored(c, r.data)) || (c === "progress" && p.authored(c, r.data));
          if (remove) {
            await tx.delete(c, r.id);
            if (c !== "resources") delta[bucket(c)]++;
          } else if (p.authored(c, r.data)) {
            const d = structuredClone(r.data);
            for (const key of ["createdBy", "updatedBy"]) if (matches(d[key], subject)) d[key] = { id: ERASED, kind: subject.kind };
            if (c === "tasks") {
              d.assignees = (d.assignees as Json[]).filter(v => !matches(v, subject));
              if (matches((d.claim as Doc | undefined)?.holder, subject)) delete d.claim;
            }
            if (c === "audit") {
              for (const key of ["principalId", "rootId", "targetId"]) if (d[key] === subject.id) d[key] = ERASED;
              d.chain = (d.chain as Doc[]).map(v => v.id === subject.id ? { ...v, id: ERASED } : v);
            }
            await tx.put(c, r.id, d);
            delta[bucket(c)]++;
          }
          if (c === "tasks" && remove) await tx.delete("counters", `seq:${r.id}`);
        }
        if (p.sole.has(id)) for (const r of p.all.counters) if (r.id.startsWith(`position:${id}:`)) await tx.delete("counters", r.id);
        return delta;
      });
      for (const c of Object.keys(counts) as TasksCollection[]) counts[c] += delta[c];
    }
    return counts;
  },
};
