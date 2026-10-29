import { useState, type FormEvent } from "react";
import { Button, Dialog, DialogClose, Input, PresenceChip, Select, Textarea } from "agentic-design/react";
import { PRINCIPAL_KINDS, type Principal, type PrincipalKind } from "../src/model.js";
import type { Board, Task, TasksClient } from "../src/client.js";
import { personOf } from "./people.js";
import { AgentMark, claimIsLive } from "./BoardView.js";
import { describe, type Session } from "./session.js";

export function TaskDialog({ client, session, board, task, onClose, onSaved, onChanged }: {
  client: TasksClient;
  session: Session;
  board: Board;
  task?: Task;
  onClose: () => void;
  onSaved: () => void;
  onChanged: (task: Task) => void;
}) {
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [labels, setLabels] = useState(task?.labels.join(", ") ?? "");
  const [dueDate, setDueDate] = useState(task?.dueDate ?? "");
  const [columnId, setColumnId] = useState(task?.columnId ?? board.columns[0]?.id ?? "");
  const [assignees, setAssignees] = useState<Principal[]>(task?.assignees ?? []);
  const [assigneeId, setAssigneeId] = useState("");
  const [assigneeKind, setAssigneeKind] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const closed = task?.status === "closed";

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
      if (task === undefined) {
        await client.createTask({
          boardId: board.id, title: title.trim(), description, columnId, labels: labelList,
          dueDate: dueDate === "" ? null : dueDate, assignees,
        });
      } else {
        await client.updateTask(task.id, {
          title: title.trim(), description, labels: labelList,
          dueDate: dueDate === "" ? null : dueDate, assignees,
        });
        if (columnId !== task.columnId) await client.moveTask(task.id, { columnId });
      }
      onSaved();
    });
  };
  const act = (call: (id: string) => Promise<Task>) => task && run(async () => onChanged(await call(task.id)));

  const live = task !== undefined && claimIsLive(task);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={task === undefined ? "New task" : "Edit task"}
      description={task === undefined ? `Add a task to ${board.title}.` : undefined}
      footer={
        <>
          <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
          <Button type="submit" form="task-form" loading={busy}>{task === undefined ? "Create task" : "Save task"}</Button>
        </>
      }
    >
      <form id="task-form" className="dialog-form" onSubmit={save} noValidate>
        {error && <p className="banner" role="alert">{error}</p>}
        {task && (
          <p className="meta">
            <AgentMark task={task} />{" "}
            Created by <PresenceChip entry={personOf(task.createdBy)} />, last changed by{" "}
            <PresenceChip entry={personOf(task.updatedBy)} />.
          </p>
        )}
        <Input label="Title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
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
                <Button size="sm" variant="ghost" aria-label={`Remove ${a.id}`}
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
        {task && (
          <fieldset className="stack">
            <legend>Claim</legend>
            <p className="meta" role="status">
              {closed ? "This task is closed." : live && task.claim
                ? `Claimed by ${task.claim.holder.id} until ${new Date(task.claim.expiresAt).toLocaleString()}.`
                : "No live claim."}
            </p>
            <div className="row">
              <Button variant="secondary" disabled={closed} onClick={() => void act((id) => client.claim(id))}>Claim</Button>
              <Button variant="secondary" disabled={closed || task.claim === undefined} onClick={() => void act((id) => client.release(id))}>Release</Button>
              <Button variant="danger" disabled={closed} onClick={() => void act((id) => client.closeTask(id))}>Close task</Button>
            </div>
          </fieldset>
        )}
      </form>
    </Dialog>
  );
}
