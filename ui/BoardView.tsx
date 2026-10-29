import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { BotIcon, Button, Checkbox, EmptyState, IconButton, Input, Menu, MoreIcon, PlusIcon, Select, Tabs } from "agentic-design/react";
import type { Board, Task } from "../src/client.js";
import type { TasksClient } from "../src/client.js";
import { nameOf as personName } from "./people.js";
import { TaskPanel } from "./TaskPanel.js";
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
  // The API keeps only the last writer. A later change by a person hides an earlier agent
  // change, so the text says "last changed by an agent", never "changed".
  const text = created
    ? changed && task.updatedAt !== task.createdAt ? "Agent created, last changed by an agent" : "Agent created"
    : "Last changed by an agent";
  return (
    <span className="agent-mark">
      <BotIcon aria-hidden="true" focusable="false" />
      {text}
    </span>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

// Due date and assignees show as quiet chips. A date before today on an open task reads as late.
function Chips({ task }: { task: Task }) {
  const late = task.dueDate != null && task.status !== "closed" && task.dueDate < today();
  const held = claimIsLive(task) && task.claim;
  if (!task.dueDate && task.assignees.length === 0 && !held && task.status !== "closed" && task.labels.length === 0) return null;
  return (
    <span className="chips">
      {task.status === "closed" && <span className="chip">Closed</span>}
      {task.dueDate && <span className={late ? "chip chip-late" : "chip"}>{late ? "Late, due " : "Due "}{task.dueDate}</span>}
      {held && task.claim && <span className="chip">Claimed by {personName(task.claim.holder.id)}</span>}
      {task.assignees.map((a) => (
        <span key={`${a.kind}:${a.id}`} className="chip" title={a.kind}>
          {isAgent(a) && <BotIcon aria-hidden="true" focusable="false" />}
          Assigned to {personName(a.id)}
        </span>
      ))}
      {task.labels.map((l) => <span key={l} className="chip chip-label">{l}</span>)}
    </span>
  );
}

function Card({ task, columns, columnName, renaming, onOpen, onMove, onRename, onRenameDone, onDragStart }: {
  task: Task;
  columns: Board["columns"];
  columnName?: string;
  renaming: boolean;
  onOpen: () => void;
  onMove: (columnId: string) => void;
  onRename: () => void;
  onRenameDone: (title: string | null) => void;
  onDragStart: () => void;
}) {
  const [draft, setDraft] = useState(task.title);
  const settled = useRef(false);
  // Enter, Escape, and blur each end the edit. Only the first counts.
  const finish = (title: string | null) => {
    if (settled.current) return;
    settled.current = true;
    onRenameDone(title);
  };
  // Keyboard alternative to dragging: Alt+Arrow moves the card to the next or previous column.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "F2") return onRename();
    const step = e.altKey ? (e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0) : 0;
    if (step === 0) return;
    e.preventDefault();
    const to = columns[columns.findIndex((c) => c.id === task.columnId) + step];
    if (to) onMove(to.id);
  };
  const others = columns.filter((c) => c.id !== task.columnId);
  return (
    <li className="card" draggable={!renaming} onDragStart={(e: DragEvent) => { e.dataTransfer.setData("text/plain", task.id); onDragStart(); }}>
      {renaming ? (
        <form className="card-edit" onSubmit={(e) => { e.preventDefault(); finish(draft); }}>
          <input className="bare-input" aria-label={`Title of ${task.title}`} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); finish(null); } }}
            onBlur={() => finish(draft)} />
        </form>
      ) : (
        <>
          <button type="button" className="card-main" data-task-id={task.id} onClick={onOpen} onKeyDown={onKeyDown}
            onDoubleClick={onRename} title="Press F2 to rename. Press Alt and an arrow key to move.">
            <span className="card-title">{task.title}</span>
            <AgentMark task={task} />
            {columnName && <span className="meta">{columnName}</span>}
            <Chips task={task} />
          </button>
          <Menu
            align="end"
            trigger={<IconButton label={`Actions for ${task.title}`} icon={<MoreIcon aria-hidden="true" />} size="sm" variant="ghost" />}
            items={[
              { label: "Rename", onSelect: onRename, shortcut: "F2" },
              ...(others.length > 0 ? ["separator" as const] : []),
              ...others.map((c) => ({ label: `Move to ${c.name}`, onSelect: () => onMove(c.id) })),
            ]}
          />
        </>
      )}
    </li>
  );
}

// A quick add field at the foot of a column: type a title, press Enter.
function QuickAdd({ column, onAdd }: { column: { id: string; name: string }; onAdd: (title: string) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (title.trim() === "") return;
    const text = title.trim();
    setTitle("");
    await onAdd(text);
  };
  return (
    <form className="quick-add" onSubmit={submit} noValidate>
      <input className="bare-input" aria-label={`Add a task to ${column.name}`} placeholder="+ Add a task" data-quick-add value={title}
        onChange={(e) => setTitle(e.target.value)} />
    </form>
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
  const [editing, setEditing] = useState<Task | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>();
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

  const attempt = async (action: () => Promise<unknown>) => {
    setNotice(undefined);
    try {
      await action();
    } catch (err) {
      setNotice(describe(err));
    }
    await load();
  };
  const quickAdd = (columnId: string) => (title: string) =>
    attempt(() => client.createTask({ boardId: board.id, title, columnId }));
  const move = (task: Task, to: string) => {
    if (task.columnId !== to) void attempt(() => client.moveTask(task.id, { columnId: to }));
  };
  const rename = (task: Task, title: string | null) => {
    setRenaming(null);
    const next = title?.trim();
    if (next && next !== task.title) void attempt(() => client.updateTask(task.id, { title: next }));
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-task-id="${task.id}"]`)?.focus());
  };
  const close = () => {
    const id = editing?.id;
    setEditing(null);
    if (id) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-task-id="${id}"]`)?.focus());
  };
  const drop = (e: DragEvent, columnId: string) => {
    e.preventDefault();
    setOver(null);
    const task = tasks.find((t) => t.id === dragging);
    setDragging(null);
    if (task) move(task, columnId);
  };
  const card = (t: Task, columnName?: string) => (
    <Card key={t.id} task={t} columns={board.columns} columnName={columnName} renaming={renaming === t.id}
      onOpen={() => setEditing(t)} onMove={(to) => move(t, to)} onRename={() => setRenaming(t.id)}
      onRenameDone={(title) => rename(t, title)} onDragStart={() => setDragging(t.id)} />
  );
  const newTask = () => document.querySelector<HTMLInputElement>("[data-quick-add]")?.focus();

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
              <section key={c.id} className="column" aria-labelledby={`col-${c.id}`} data-over={over === c.id || undefined}
                onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver(c.id); } }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null); }}
                onDrop={(e) => drop(e, c.id)}>
                <h2 id={`col-${c.id}`}>{c.name} <span className="count">{here.length}</span></h2>
                <ul className="cards" aria-labelledby={`col-${c.id}`}>
                  {here.map((t) => card(t))}
                </ul>
                {here.length === 0 && !filtered && <p className="meta column-empty">Nothing here yet.</p>}
                <QuickAdd column={c} onAdd={quickAdd(c.id)} />
              </section>
            );
          })}
      </div>
    );
  const listView = (
    <ul className="cards" aria-label="Tasks">
      {shown.map((t) => card(t, nameOf(t.columnId)))}
    </ul>
  );

  return (
    <div className={editing ? "board-layout has-panel" : "board-layout"}>
      <div className="board-main">
      <div className="page-head">
        <h1>{board.title}</h1>
        <Button onClick={newTask} disabled={board.columns.length === 0}>
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
        <Checkbox label="Created or last changed by an agent" checked={agentOnly} onChange={(e) => setAgentOnly(e.target.checked)} />
        {filtered && <Button variant="ghost" onClick={clear}>Clear filters</Button>}
      </div>
      {notice && <p className="banner" role="alert">{notice}</p>}
      {tasks.length === 0 && board.columns.length > 0 && (
        <EmptyState title="No tasks yet" description="Type a title in a column below and press Enter." />
      )}
      {tasks.length > 0 && shown.length === 0 ? (
        <EmptyState title="No task matches the filters" action={<Button onClick={clear}>Clear filters</Button>} />
      ) : (
        <Tabs label="View" value={view} onValueChange={setView}
          tabs={[
            { value: "board", label: "Board", content: boardView },
            { value: "list", label: "List", content: listView },
          ]} />
      )}
      <form className="row" onSubmit={addColumn} noValidate style={{ marginTop: "var(--agd-space-6)" }}>
        <Input label="New column" value={columnName} onChange={(e) => setColumnName(e.target.value)}
          error={columnError} />
        <Button type="submit" variant="secondary">Add column</Button>
      </form>
      </div>
      {editing !== null && (
        <TaskPanel key={editing.id} client={client} session={session} board={board} task={editing}
          onClose={close} onChanged={(t) => { setEditing(t); void load(); }} />
      )}
    </div>
  );
}
