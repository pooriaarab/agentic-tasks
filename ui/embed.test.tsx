// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type MountedTasks, type TasksUiOptions } from "./embed.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no matchMedia, and the theme provider asks for it.
window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never;

const who = { id: "ada", kind: "human" as const };
const board = {
  id: "b1",
  title: "Sprint",
  columns: [{ id: "c1", name: "To do" }],
  createdBy: who,
  updatedBy: who,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fakeFetch() {
  const calls: { url: string; auth: string | null }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/boards/b1")) return json(board);
    if (url.includes("/tasks?")) return json([]);
    return json({ error: { code: "NOT_FOUND", message: "no" } }, 404);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

let host: HTMLElement;
let mounted: MountedTasks | undefined;
const options = (over: Partial<TasksUiOptions> = {}): TasksUiOptions => ({
  baseUrl: "https://tasks.example.com",
  getToken: () => "tok",
  principal: who,
  fetch: fakeFetch().impl,
  ...over,
});
beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(async () => {
  if (mounted) await act(async () => mounted!.unmount());
  mounted = undefined;
  host.remove();
});

describe("mount", () => {
  it.each([
    ["no kind", { id: "ada" }],
    ["an unknown kind", { id: "ada", kind: "robot" }],
    ["no id", { kind: "human" }],
    ["a blank id", { id: " ", kind: "human" }],
    ["no principal", undefined],
  ])("throws for %s and renders nothing", (_label, principal) => {
    expect(() => mount(host, options({ principal: principal as never }))).toThrow(TypeError);
    expect(host.innerHTML).toBe("");
  });

  it.each(["", "not a url", "ftp://tasks.example.com"])("throws for the base URL %j", (baseUrl) => {
    expect(() => mount(host, options({ baseUrl }))).toThrow(TypeError);
    expect(host.innerHTML).toBe("");
  });

  it.each(["", 5])("throws for the board id %j", (boardId) => {
    expect(() => mount(host, options({ boardId: boardId as never }))).toThrow(TypeError);
    expect(host.innerHTML).toBe("");
  });

  it("leaves the theme attribute of the host page alone", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    await act(async () => void (mounted = mount(host, options())));
    await act(async () => mounted!.unmount());
    mounted = undefined;
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    document.documentElement.removeAttribute("data-theme");
  });

  it("throws when getToken is missing", () => {
    expect(() => mount(host, options({ getToken: undefined as never }))).toThrow(TypeError);
  });

  it("shows the lists when no board is given", async () => {
    await act(async () => void (mounted = mount(host, options())));
    expect(host.querySelector("h1")?.textContent).toBe("Lists");
  });

  it("loads a board with the token from getToken on every call", async () => {
    const { impl, calls } = fakeFetch();
    let n = 0;
    await act(async () => void (mounted = mount(host, options({ boardId: "b1", fetch: impl, getToken: async () => `tok${++n}` }))));
    await settle();
    expect(host.querySelector("h1")?.textContent).toBe("Sprint");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.map((c) => c.auth)).toEqual(calls.map((_, i) => `Bearer tok${i + 1}`));
  });

  it("fails the call and shows the error when getToken returns nothing", async () => {
    const { impl, calls } = fakeFetch();
    await act(async () => void (mounted = mount(host, options({ boardId: "b1", fetch: impl, getToken: () => "" }))));
    await settle();
    expect(calls).toEqual([]);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not load this list");
  });

  it("update shows another board, and a bad update keeps the UI", async () => {
    await act(async () => void (mounted = mount(host, options({ boardId: "b1" }))));
    await settle();
    expect(() => mounted!.update(options({ principal: { id: "x", kind: "bad" as never } }))).toThrow(TypeError);
    expect(host.querySelector("h1")?.textContent).toBe("Sprint");
    expect(() => mounted!.update(options({ baseUrl: "" }))).toThrow(TypeError);
    expect(host.querySelector("h1")?.textContent).toBe("Sprint");
    await act(async () => mounted!.update(options()));
    expect(host.querySelector("h1")?.textContent).toBe("Lists");
  });

  it("unmount empties the element", async () => {
    await act(async () => void (mounted = mount(host, options())));
    await act(async () => mounted!.unmount());
    mounted = undefined;
    expect(host.innerHTML).toBe("");
  });
});
