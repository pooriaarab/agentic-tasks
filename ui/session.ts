import { createClient, type TasksClient, TasksApiError } from "../src/client.js";
import { PRINCIPAL_KINDS, type PrincipalKind } from "../src/model.js";

export interface Session {
  id: string;
  kind: PrincipalKind;
  // Empty in local dev, where the Worker trusts the principal headers on loopback.
  token: string;
}
export interface SavedList {
  id: string;
  title: string;
}

const SESSION_KEY = "agentic-tasks.session";
const LISTS_KEY = "agentic-tasks.lists";

const isKind = (v: unknown): v is PrincipalKind => PRINCIPAL_KINDS.includes(v as PrincipalKind);
const read = (storage: Storage, key: string): unknown => {
  try {
    return JSON.parse(storage.getItem(key) ?? "null");
  } catch {
    return null;
  }
};

// The session lives in sessionStorage: it ends with the tab.
export function loadSession(): Session | null {
  const v = read(sessionStorage, SESSION_KEY) as Partial<Session> | null;
  if (v && typeof v.id === "string" && v.id !== "" && isKind(v.kind) && typeof v.token === "string") {
    return { id: v.id, kind: v.kind, token: v.token };
  }
  return null;
}
export const saveSession = (s: Session | null) =>
  s === null ? sessionStorage.removeItem(SESSION_KEY) : sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));

// The API has no call that lists boards, so this device remembers the ones it opened.
export function loadLists(): SavedList[] {
  const v = read(localStorage, LISTS_KEY);
  if (!Array.isArray(v)) return [];
  return v.filter((l): l is SavedList => typeof l?.id === "string" && typeof l?.title === "string");
}
export function rememberList(list: SavedList): SavedList[] {
  const next = [list, ...loadLists().filter((l) => l.id !== list.id)];
  localStorage.setItem(LISTS_KEY, JSON.stringify(next));
  return next;
}
export function forgetList(id: string): SavedList[] {
  const next = loadLists().filter((l) => l.id !== id);
  localStorage.setItem(LISTS_KEY, JSON.stringify(next));
  return next;
}

export function makeClient(s: Session): TasksClient {
  return createClient({
    baseUrl: location.origin,
    token: s.token === "" ? "local-dev" : s.token,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      if (s.token === "") {
        headers.set("x-principal-id", s.id);
        headers.set("x-principal-kind", s.kind);
      }
      return fetch(input, { ...init, headers });
    },
  });
}

// Every refused call shows its error code.
export function describe(error: unknown): string {
  if (error instanceof TasksApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "Something went wrong.";
}
