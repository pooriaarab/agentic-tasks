import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Button, CloseIcon, IconButton, Input, PresenceChip, Select, Textarea } from "agentic-design/react";
import { PRINCIPAL_KINDS, type Principal, type PrincipalKind } from "../src/model.js";
import type { Board, Task, TasksClient } from "../src/client.js";
import { nameOf, personOf } from "./people.js";
import { AgentMark, claimIsLive } from "./BoardView.js";
import { describe, type Session } from "./session.js";

export function TaskPanel({ client, session, board, task, onClose, onChanged }: {
  client: TasksClient;
  session: Session;
  board: Board;
  task: Task;
  onClose: () => void;
  onChanged: (task: Task) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [labels, setLabels] = useState(task.labels.join(", "));
  const [dueDate, setDueDate] = useState(task.dueDate ?? "");
  const [columnId, setColumnId] = useState(task.columnId);
  const [assignees, setAssignees] = useState<Principal[]>(task.assignees);
  const [assigneeId, setAssigneeId] = useState("");
  const [assigneeKind, setAssigneeKind] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
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
    const labelList = labels.split(",").map((l) => l.trim()).filter(Boolean);
    return run(async () => {
      let next = await client.updateTask(task.id, {
        title: title.trim(), description, labels: labelList,
        dueDate: dueDate === "" ? null : dueDate, assignees,
      });
      onChanged(next);
      if (columnId !== task.columnId) next = await client.moveTask(task.id, { columnId });
      onChanged(next);
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
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !e.defaultPrevented) onClose();
  };
  return (
    <aside className="panel" aria-label="Task details" onKeyDown={onKeyDown}>
      <header className="panel-head">
        <h2 className="panel-title">Task</h2>
        <IconButton label="Hide details" icon={<CloseIcon aria-hidden="true" />} variant="ghost" onClick={onClose} />
      </header>
      <form id="task-form" className="panel-form" onSubmit={save} onChange={() => setSaved(false)} noValidate>
        {error && <p className="banner" role="alert">{error}</p>}
        <input className="bare-input title-input" aria-label="Title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        <p className="meta">
          <AgentMark task={task} />{" "}
          Created by <PresenceChip entry={personOf(task.createdBy)} />, last changed by{" "}
          <PresenceChip entry={personOf(task.updatedBy)} />.
        </p>
        <Textarea label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
        <Input label="Labels" hint="Separate labels with commas." value={labels} onChange={(e) => setLabels(e.target.value)} />
        <Input label="Due date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        <Select label="Column" value={columnId} onChange={(e) => setColumnId(e.target.value)}>
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
