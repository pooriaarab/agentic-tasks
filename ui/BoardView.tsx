import { useCallback, useEffect, useState, type FormEvent } from "react";
import { BotIcon, Button, Checkbox, EmptyState, Input, PlusIcon, Select, Tabs } from "agentic-design/react";
import type { Board, Task } from "../src/client.js";
import type { TasksClient } from "../src/client.js";
import { nameOf as personName } from "./people.js";
import { TaskDialog } from "./TaskDialog.js";
import { describe, type Session } from "./session.js";

// A claim is live until its expiry. An expiry that does not parse counts as live.
export function claimIsLive(task: Task, now = Date.now()): boolean {
  if (task.claim === undefined || task.status === "closed") return false;
  const expires = Date.parse(task.claim.expiresAt);
  return Number.isNaN(expires) || expires > now;
}

const isAgent = (p: { kind: string }) => p.kind !== "human";

export function AgentMark({ task }: { task: Task }) {
  const created = isAgent(task.createdBy);
  const changed = isAgent(task.updatedBy);
  if (!created && !changed) return null;
  const text = created ? (changed && task.updatedAt !== task.createdAt ? "Agent created and changed" : "Agent created") : "Agent changed";
  return (
    <span className="agent-mark">
      <BotIcon aria-hidden="true" focusable="false" />
      {text}
    </span>
  );
}

function Card({ task, columnName, onOpen }: { task: Task; columnName?: string; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className="card" onClick={onOpen}>
        <span className="card-title">{task.title}</span>
        <AgentMark task={task} />
        <span className="meta">
          {task.status === "closed" ? "Closed" : "Open"}
          {columnName ? ` · ${columnName}` : ""}
          {task.dueDate ? ` · due ${task.dueDate}` : ""}
          {claimIsLive(task) && task.claim ? ` · claimed by ${personName(task.claim.holder.id)}` : ""}
          {task.assignees.length > 0 ? ` · assigned to ${task.assignees.map((a) => personName(a.id)).join(", ")}` : ""}
        </span>
        {task.labels.length > 0 && <span className="meta">Labels: {task.labels.join(", ")}</span>}
      </button>
    </li>
  );
}

type Load = { board: Board; tasks: Task[] } | { error: string } | null;

export function BoardView({ client, session, boardId, onLoaded }: {
  client: TasksClient;
  session: Session;
  boardId: string;
  onLoaded: (board: Board) => void;
}) {
  const [state, setState] = useState<Load>(null);
  const [view, setView] = useState("board");
  const [status, setStatus] = useState("");
  const [columnId, setColumnId] = useState("");
  const [text, setText] = useState("");
  const [agentOnly, setAgentOnly] = useState(false);
  const [editing, setEditing] = useState<Task | "new" | null>(null);
  const [columnName, setColumnName] = useState("");
  const [columnError, setColumnError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [board, tasks] = await Promise.all([client.getBoard(boardId), client.listTasks({ boardId })]);
      setState({ board, tasks });
      onLoaded(board);
    } catch (err) {
      setState({ error: describe(err) });
    }
  }, [client, boardId, onLoaded]);
  useEffect(() => void load(), [client, boardId]);

  if (state === null) return <p role="status">Loading tasks…</p>;
  if ("error" in state) {
    return (
      <>
        <h1>List</h1>
        <p className="banner" role="alert">Could not load this list. {state.error}</p>
        <Button onClick={() => { setState(null); void load(); }}>Try again</Button>
      </>
    );
  }
  const { board, tasks } = state;
  const needle = text.trim().toLowerCase();
  const shown = tasks.filter(
    (t) =>
      (status === "" || t.status === status) &&
      (columnId === "" || t.columnId === columnId) &&
      (!agentOnly || isAgent(t.createdBy) || isAgent(t.updatedBy)) &&
      (needle === "" || t.title.toLowerCase().includes(needle) || t.labels.some((l) => l.toLowerCase().includes(needle))),
  );
  const nameOf = (id: string) => board.columns.find((c) => c.id === id)?.name ?? "";
  const filtered = status !== "" || columnId !== "" || needle !== "" || agentOnly;
  const clear = () => { setStatus(""); setColumnId(""); setText(""); setAgentOnly(false); };

  const addColumn = async (e: FormEvent) => {
    e.preventDefault();
    if (columnName.trim() === "") return setColumnError("Enter a column name.");
    try {
      const next = await client.addColumn(board.id, columnName.trim());
      setState({ board: next, tasks });
      setColumnName("");
      setColumnError(undefined);
    } catch (err) {
      setColumnError(describe(err));
    }
  };

  const boardView =
    board.columns.length === 0 ? (
      <EmptyState title="This list has no columns" description="Add a column to start." />
    ) : (
      <div className="columns">
        {board.columns
          .filter((c) => columnId === "" || c.id === columnId)
          .map((c) => {
            const here = shown.filter((t) => t.columnId === c.id);
            return (
              <section key={c.id} className="column" aria-labelledby={`col-${c.id}`}>
                <h3 id={`col-${c.id}`}>{c.name} ({here.length})</h3>
                <ul className="cards" aria-labelledby={`col-${c.id}`}>
                  {here.map((t) => <Card key={t.id} task={t} onOpen={() => setEditing(t)} />)}
                </ul>
              </section>
            );
          })}
      </div>
    );
  const listView = (
    <ul className="cards" aria-label="Tasks">
      {shown.map((t) => <Card key={t.id} task={t} columnName={nameOf(t.columnId)} onOpen={() => setEditing(t)} />)}
    </ul>
  );

  return (
    <>
      <div className="page-head">
        <h1>{board.title}</h1>
        <Button onClick={() => setEditing("new")} disabled={board.columns.length === 0}>
          <PlusIcon aria-hidden="true" /> New task
        </Button>
      </div>
      <p className="meta">List id: <code>{board.id}</code></p>
      <div className="filters" role="group" aria-label="Filters">
        <Input label="Search" value={text} onChange={(e) => setText(e.target.value)} />
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
        </Select>
        <Select label="Column" value={columnId} onChange={(e) => setColumnId(e.target.value)}>
          <option value="">All columns</option>
          {board.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Checkbox label="Agent-made only" checked={agentOnly} onChange={(e) => setAgentOnly(e.target.checked)} />
        {filtered && <Button variant="ghost" onClick={clear}>Clear filters</Button>}
      </div>
      {tasks.length === 0 ? (
        <EmptyState title="No tasks yet" description="Add the first task to this list."
          action={board.columns.length > 0 ? <Button onClick={() => setEditing("new")}>New task</Button> : undefined} />
      ) : shown.length === 0 ? (
        <EmptyState title="No task matches the filters" action={<Button onClick={clear}>Clear filters</Button>} />
      ) : (
        <Tabs label="View" value={view} onValueChange={setView}
          tabs={[
            { value: "board", label: "Board", content: boardView },
            { value: "list", label: "List", content: listView },
          ]} />
      )}
      <form className="row" onSubmit={addColumn} noValidate style={{ marginTop: "var(--ad-space-6)" }}>
        <Input label="New column" value={columnName} onChange={(e) => setColumnName(e.target.value)}
          error={columnError} />
        <Button type="submit" variant="secondary">Add column</Button>
      </form>
      {editing !== null && (
        <TaskDialog
          client={client}
          session={session}
          board={board}
          task={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
          onChanged={(t) => { setEditing(t); void load(); }}
        />
      )}
    </>
  );
}
