import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Button, CloseIcon, IconButton, Input, PresenceChip, Select, Textarea } from "agentic-design/react";
import { PRINCIPAL_KINDS, type Principal, type PrincipalKind } from "../src/model.js";
import type { Board, Task, TaskPatch, TasksClient } from "../src/client.js";
import { nameOf, personOf } from "./people.js";
import { AgentMark, claimIsLive } from "./BoardView.js";
import { describe, type Session } from "./session.js";

export function TaskPanel({ client, session, board, task, narrow, onClose, onChanged }: {
  client: TasksClient;
  session: Session;
  board: Board;
  task: Task;
  /** The panel covers the page, so the Tab key stays inside it. */
  narrow: boolean;
  onClose: () => void;
  onChanged: (task: Task) => void;
}) {
  // A field shows the task as the server has it until the person edits it. The board can change the
  // task while the panel is open, so a save sends only the fields that were edited.
  type Edits = { title?: string; description?: string; labels?: string; dueDate?: string; columnId?: string; assignees?: Principal[] };
  const [saved, setSaved] = useState(false);
  const [edits, setEdits] = useState<Edits>({});
  const edit = (patch: Edits) => {
    setSaved(false);
    setEdits((e) => ({ ...e, ...patch }));
  };
  const title = edits.title ?? task.title;
  const description = edits.description ?? task.description;
  const labels = edits.labels ?? task.labels.join(", ");
  const dueDate = edits.dueDate ?? task.dueDate ?? "";
  const columnId = edits.columnId ?? task.columnId;
  const assignees = edits.assignees ?? task.assignees;
  const setAssignees = (list: Principal[]) => edit({ assignees: list });
  const [assigneeId, setAssigneeId] = useState("");
  const [assigneeKind, setAssigneeKind] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const closed = task.status === "closed";

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const addAssignee = (id: string, kind: string) => {
    if (id.trim() === "" || !PRINCIPAL_KINDS.includes(kind as PrincipalKind)) {
      return setError("Enter an assignee id and choose its kind.");
    }
    setError(undefined);
    if (!assignees.some((a) => a.id === id.trim() && a.kind === kind)) {
      setAssignees([...assignees, { id: id.trim(), kind: kind as PrincipalKind }]);
    }
    setAssigneeId("");
  };

  const save = (e?: FormEvent) => {
    e?.preventDefault();
    if (title.trim() === "") return setError("Enter a title.");
    return run(async () => {
      const patch: TaskPatch = {};
      if (edits.title !== undefined) patch.title = edits.title.trim();
      if (edits.description !== undefined) patch.description = edits.description;
      if (edits.labels !== undefined) patch.labels = edits.labels.split(",").map((l) => l.trim()).filter(Boolean);
      if (edits.dueDate !== undefined) patch.dueDate = edits.dueDate === "" ? null : edits.dueDate;
      if (edits.assignees !== undefined) patch.assignees = edits.assignees;
      let next = task;
      if (Object.keys(patch).length > 0) {
        next = await client.updateTask(task.id, patch);
        onChanged(next);
      }
      if (edits.columnId !== undefined && edits.columnId !== next.columnId) {
        next = await client.moveTask(task.id, { columnId: edits.columnId });
        onChanged(next);
      }
      setEdits({});
      setSaved(true);
    });
  };
  // Read the task before each call, and again after a refusal, so the panel shows the real claim.
  const act = (call: (id: string) => Promise<Task>) =>
    run(async () => {
      try {
        await client.getTask(task.id);
        onChanged(await call(task.id));
      } catch (err) {
        onChanged(await client.getTask(task.id).catch(() => task));
        throw err;
      }
    });

  const live = claimIsLive(task);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      // Escape never throws away an edit. The hide button does.
      if (Object.keys(edits).length > 0) setError("You have unsaved changes. Press Save, or Hide details to discard them.");
      else onClose();
    }
    if (e.key === "Tab" && narrow) {
      const items = [...e.currentTarget.querySelectorAll<HTMLElement>("button, input, select, textarea, [href]")]
        .filter((el) => !el.matches(":disabled") && el.offsetParent !== null);
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  };
  return (
    <aside className="panel" aria-label="Task details" onKeyDown={onKeyDown}>
      <header className="panel-head">
        <h2 className="panel-title">Task</h2>
        <IconButton label="Hide details" icon={<CloseIcon aria-hidden="true" />} variant="ghost" onClick={onClose} />
      </header>
      <form id="task-form" className="panel-form" onSubmit={save} onChange={() => setSaved(false)} noValidate>
        {error && <p className="banner" role="alert">{error}</p>}
        <input className="bare-input title-input" aria-label="Title" autoFocus value={title} onChange={(e) => edit({ title: e.target.value })} />
        <p className="meta">
          <AgentMark task={task} />{" "}
          Created by <PresenceChip entry={personOf(task.createdBy)} />, last changed by{" "}
          <PresenceChip entry={personOf(task.updatedBy)} />.
        </p>
        <Textarea label="Description" value={description} onChange={(e) => edit({ description: e.target.value })} />
        <Input label="Labels" hint="Separate labels with commas." value={labels} onChange={(e) => edit({ labels: e.target.value })} />
        <Input label="Due date" type="date" value={dueDate} onChange={(e) => edit({ dueDate: e.target.value })} />
        <Select label="Column" value={columnId} onChange={(e) => edit({ columnId: e.target.value })}>
          {board.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <fieldset className="stack">
          <legend>Assignees</legend>
          {assignees.length === 0 && <p className="meta">No one is assigned.</p>}
          <ul className="list-links" aria-label="Assigned">
            {assignees.map((a) => (
              <li key={`${a.kind}:${a.id}`} className="row">
                <PresenceChip entry={personOf(a)} />
                <Button size="sm" variant="ghost" aria-label={`Remove ${nameOf(a.id)}`}
                  onClick={() => setAssignees(assignees.filter((x) => x !== a))}>Remove</Button>
              </li>
            ))}
          </ul>
          <Input label="Assignee id" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} />
          <Select label="Assignee kind" value={assigneeKind} onChange={(e) => setAssigneeKind(e.target.value)}>
            <option value="">Choose a kind</option>
            {PRINCIPAL_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </Select>
          <div className="row">
            <Button variant="secondary" onClick={() => addAssignee(assigneeId, assigneeKind)}>Add assignee</Button>
            <Button variant="secondary" onClick={() => addAssignee(session.id, session.kind)}>Assign to me</Button>
          </div>
        </fieldset>
        <fieldset className="stack">
          <legend>Claim</legend>
          <p className="meta" role="status">
            {closed ? "This task is closed." : live && task.claim
              ? `Claimed by ${nameOf(task.claim.holder.id)} until ${
                Number.isNaN(Date.parse(task.claim.expiresAt)) ? "an unknown time" : new Date(task.claim.expiresAt).toLocaleString()
              }.`
              : "No live claim."}
          </p>
          <div className="row">
            <Button variant="secondary" disabled={closed} onClick={() => void act((id) => client.claim(id))}>Claim</Button>
            <Button variant="secondary" disabled={closed || task.claim === undefined} onClick={() => void act((id) => client.release(id))}>Release</Button>
            <Button variant="danger" disabled={closed} onClick={() => void act((id) => client.closeTask(id))}>Close task</Button>
          </div>
        </fieldset>
      </form>
      <footer className="panel-foot">
        <p className="meta" role="status">{saved ? "Saved." : ""}</p>
        <Button type="submit" form="task-form" loading={busy}>Save task</Button>
      </footer>
    </aside>
  );
}
