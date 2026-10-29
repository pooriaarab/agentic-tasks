import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AppShell,
  Button,
  EmptyState,
  Input,
  PresenceChip,
  Select,
  SidebarNav,
  useTheme,
  type ThemePreference,
} from "agentic-design/react";
import { PRINCIPAL_KINDS, type PrincipalKind } from "../src/model.js";
import { personOf } from "./people.js";
import { BoardView } from "./BoardView.js";
import {
  describe,
  forgetList,
  loadLists,
  loadSession,
  makeClient,
  rememberList,
  saveSession,
  type SavedList,
  type Session,
} from "./session.js";

const DEFAULT_COLUMNS = ["To do", "Doing", "Done"];

// Hash routes: #/ lists the boards, #/b/<id> opens one.
function useBoardId(): string | null {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const match = /^#\/b\/(.+)$/.exec(hash);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1] as string);
  } catch {
    return null;
  }
}

function ConnectForm({ onConnect }: { onConnect: (s: Session) => void }) {
  const [id, setId] = useState("");
  const [kind, setKind] = useState("");
  const [token, setToken] = useState("");
  const [tried, setTried] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (id.trim() === "" || !PRINCIPAL_KINDS.includes(kind as PrincipalKind)) return;
    onConnect({ id: id.trim(), kind: kind as PrincipalKind, token: token.trim() });
  };
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <h1>Connect</h1>
      <p className="meta">
        Say who acts. Every change records this name and kind. Leave the token empty only on a local Worker
        that trusts loopback requests.
      </p>
      <Input label="Principal id" value={id} onChange={(e) => setId(e.target.value)} autoComplete="off"
        error={tried && id.trim() === "" ? "Enter an id." : undefined} />
      <Select label="Principal kind" value={kind} onChange={(e) => setKind(e.target.value)}
        error={tried && kind === "" ? "Choose a kind." : undefined}>
        <option value="">Choose a kind</option>
        {PRINCIPAL_KINDS.map((k) => (
          <option key={k} value={k}>{k}</option>
        ))}
      </Select>
      <Input label="Token (optional)" type="password" value={token} onChange={(e) => setToken(e.target.value)}
        autoComplete="off" hint="A bearer credential for the Worker." />
      <Button type="submit">Connect</Button>
    </form>
  );
}

function Lists({ session, lists, setLists, onOpen }: {
  session: Session;
  lists: SavedList[];
  setLists: (lists: SavedList[]) => void;
  onOpen: (id: string) => void;
}) {
  const client = useMemo(() => makeClient(session), [session]);
  const [title, setTitle] = useState("");
  const [openId, setOpenId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (title.trim() === "") return setError("Enter a name for the list.");
    setBusy(true);
    setError(undefined);
    try {
      const board = await client.createBoard({ title: title.trim() });
      // Save the list first: if a column call fails, the list is still in the sidebar.
      setLists(rememberList({ id: board.id, title: board.title }));
      for (const name of DEFAULT_COLUMNS) await client.addColumn(board.id, name);
      setTitle("");
      onOpen(board.id);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };
  const open = (e: FormEvent) => {
    e.preventDefault();
    if (openId.trim() === "") return setError("Enter a list id.");
    onOpen(openId.trim());
  };

  return (
    <>
      <h1>Lists</h1>
      {error && <p className="banner" role="alert">{error}</p>}
      <form className="row" onSubmit={create} noValidate>
        <Input label="New list name" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Button type="submit" loading={busy}>Create list</Button>
      </form>
      <form className="row" onSubmit={open} noValidate style={{ marginTop: "var(--ad-space-3)" }}>
        <Input label="Open a list by id" value={openId} onChange={(e) => setOpenId(e.target.value)} />
        <Button type="submit" variant="secondary">Open list</Button>
      </form>
      {lists.length === 0 ? (
        <EmptyState title="No lists on this device" description="Create a list, or open one by its id." />
      ) : (
        <ul className="list-links" aria-label="Lists on this device">
          {lists.map((l) => (
            <li key={l.id} className="row">
              <a className="link" href={`#/b/${encodeURIComponent(l.id)}`}>{l.title}</a>
              <Button size="sm" variant="ghost" aria-label={`Forget ${l.title} on this device`}
                onClick={() => setLists(forgetList(l.id))}>Forget</Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [lists, setLists] = useState<SavedList[]>(loadLists);
  const boardId = useBoardId();
  const { preference, setPreference } = useTheme();
  const client = useMemo(() => (session ? makeClient(session) : null), [session]);

  const connect = (s: Session) => {
    saveSession(s);
    setSession(s);
  };
  const disconnect = () => {
    saveSession(null);
    setSession(null);
  };
  const open = (id: string) => {
    location.hash = `#/b/${encodeURIComponent(id)}`;
  };

  const items = [
    { href: "#/", label: "Lists", current: boardId === null },
    ...lists.map((l) => ({ href: `#/b/${encodeURIComponent(l.id)}`, label: l.title, current: l.id === boardId })),
  ];

  return (
    <AppShell
      brand="Agentic Tasks"
      sidebar={<SidebarNav label="Lists" items={items} />}
      topbar={
        <>
          <Select label="Theme" hideLabel value={preference}
            onChange={(e) => setPreference(e.target.value as ThemePreference)}>
            <option value="system">Theme: system</option>
            <option value="light">Theme: light</option>
            <option value="dark">Theme: dark</option>
          </Select>
          {session && (
            <>
              <PresenceChip entry={personOf(session)} />
              <Button size="sm" variant="secondary" onClick={disconnect}>Disconnect</Button>
            </>
          )}
        </>
      }
    >
      {session === null || client === null ? (
        <ConnectForm onConnect={connect} />
      ) : boardId === null ? (
        <Lists session={session} lists={lists} setLists={setLists} onOpen={open} />
      ) : (
        <BoardView key={boardId} client={client} session={session} boardId={boardId}
          onLoaded={(b) => setLists(rememberList({ id: b.id, title: b.title }))} />
      )}
    </AppShell>
  );
}
