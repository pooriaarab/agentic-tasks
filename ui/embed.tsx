// The task UI for an app that embeds it: `agentic-tasks/ui`. The app gives a base URL, a function that returns the
// bearer token, and the principal who uses the UI. The web UI that the Worker serves uses the same components.
// React and react-dom are peer dependencies.
import { StrictMode, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, TooltipProvider } from "agentic-design/react";
import "agentic-design/styles.css";
import "./ui.css";
import { createClient, type TasksClient } from "../src/client.js";
import { PRINCIPAL_KINDS, type PrincipalKind } from "../src/model.js";
import { Lists } from "./App.js";
import { BoardView } from "./BoardView.js";
import { loadLists, rememberList, type SavedList } from "./session.js";

export type { TasksClient };

/** Who uses the UI. The server still checks every write against the token that `getToken` returns. */
export interface EmbedPrincipal {
  id: string;
  kind: PrincipalKind;
}

export interface TasksUiOptions {
  /** The Worker origin, for example `https://tasks.example.com`. */
  baseUrl: string;
  /** Called before every request. It returns the bearer token, or a promise of it. An empty token fails the call. */
  getToken: () => string | Promise<string>;
  principal: EmbedPrincipal;
  /** Open this board first. Without it, the UI starts at the lists. */
  boardId?: string;
  /** A fetch to use in place of the global one. */
  fetch?: typeof fetch;
}

/** A principal must have a known kind and an id. A missing kind is an error, never a default. */
function checkOptions(options: TasksUiOptions): void {
  const { principal } = options;
  if (!principal || !PRINCIPAL_KINDS.includes(principal.kind) || typeof principal.id !== "string" || principal.id.trim() === "") {
    throw new TypeError(`the task UI needs a principal with a kind (${PRINCIPAL_KINDS.join(", ")}) and an id`);
  }
  if (typeof options.getToken !== "function") throw new TypeError("the task UI needs a getToken function");
  // createClient checks the base URL. Do it here, so a bad value throws from mount or update.
  createClient({ baseUrl: options.baseUrl, token: "check" });
}

/** The task UI. `mount` adds the theme and tooltip providers above it. */
function TasksUi(options: TasksUiOptions) {
  checkOptions(options);
  const { baseUrl, getToken, principal, fetch: fetchImpl } = options;
  const client = useMemo(
    () =>
      createClient({
        baseUrl,
        // The real token comes from getToken on every call, so it can refresh.
        token: "supplied-per-call",
        fetch: async (input, init) => {
          const token = await getToken();
          if (typeof token !== "string" || token === "") throw new TypeError("getToken returned no token");
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${token}`);
          return (fetchImpl ?? globalThis.fetch)(input, { ...init, headers });
        },
      }),
    [baseUrl, getToken, fetchImpl],
  );
  const session = useMemo(() => ({ id: principal.id, kind: principal.kind, token: "" }), [principal.id, principal.kind]);
  const [boardId, setBoardId] = useState<string | undefined>(options.boardId);
  const [lists, setLists] = useState<SavedList[]>(loadLists);
  const onLoaded = useCallback((b: { id: string; title: string }) => setLists(rememberList({ id: b.id, title: b.title })), []);
  return (
    <div className="agentic-tasks-ui">
      {boardId === undefined ? (
        <Lists client={client} lists={lists} setLists={setLists} onOpen={setBoardId} />
      ) : (
        <>
          <button type="button" className="link" onClick={() => setBoardId(undefined)}>Back to lists</button>
          <BoardView key={boardId} client={client} session={session} boardId={boardId} onLoaded={onLoaded} />
        </>
      )}
    </div>
  );
}

export interface MountedTasks {
  /** Show another board or principal in the same place. A bad principal throws and keeps the UI as it is. */
  update(options: TasksUiOptions): void;
  /** Remove the UI and its React tree. */
  unmount(): void;
}

/** Render the task UI into an element, for an app that does not use React itself. */
export function mount(element: HTMLElement, options: TasksUiOptions): MountedTasks {
  checkOptions(options);
  const root = createRoot(element);
  const render = (next: TasksUiOptions) =>
    root.render(
      <StrictMode>
        <ThemeProvider>
          <TooltipProvider>
            <TasksUi key={`${next.principal.kind}:${next.principal.id}:${next.boardId ?? ""}`} {...next} />
          </TooltipProvider>
        </ThemeProvider>
      </StrictMode>,
    );
  render(options);
  return {
    update: (next) => {
      checkOptions(next);
      render(next);
    },
    unmount: () => root.unmount(),
  };
}
