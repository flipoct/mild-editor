import { invoke } from "@tauri-apps/api/core";
import type * as Monaco from "monaco-editor";
import { useEffect, useState } from "react";
import { MonacoBinding } from "y-monaco";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { explorerBasename, fileKey, mexFilename, normalizedExplorerPath } from "../fileNaming";
import { useLatest } from "../hooks";
import type { messages } from "../i18n";
import { errorMessage, IS_TAURI, isMac } from "../platform";
import { createStore } from "../store";
import type { ProblemTab } from "../types";
import { folderHooks, workspace } from "../workspaceStore";
import { deriveRoom, fileJudge, fileMeta, fileTests, formatJoinCode, generateJoinCode, mergeJudge, normalizeRelayAddress, normalizeRelayAddresses, parseInvite, PEER_COLORS, peerName, pickPeerColor, safeFolderName, safePath, type FileJudge, type FileMeta, type FileTest } from "./protocol";
import { BoardDoc } from "../board/boardDoc";
import { EMPTY_BOARD, parseBoard, serializeBoard } from "../board/model";
import { heardClaim, KEYBOARD_IDLE_MS, keyboardAt, nextRun, writeClaim, type Keyboard, type Writer } from "./keyboard";
import { firstReachable, RelayProvider, type EndReason, type Link } from "./provider";

/**
 * A shared room, as this copy of the editor is in it: one folder, with every source file
 * and folder under it, kept alike for everyone in the room. Nobody's copy is the original.
 * Each member has the folder as a folder of their own workspace — whoever opens the room
 * shares one they have, whoever joins picks where a copy of it goes, much like a clone —
 * and from then on a file added, renamed, moved, edited or deleted by anyone is so for all.
 * When the room ends everyone simply has the folder.
 *
 * ── The document ──
 * One Y.Doc holds the folder: a map of files by random id, each with its `path` (relative
 * to the shared folder), its `text` and what else belongs to a file (protocol.ts); and a
 * map of the folders, so that an empty one exists too. A file is known by its id, not its
 * path, which is what makes a rename a rename for everyone and not a delete and an add.
 *
 * ── Two directions ──
 * The workspace is React's and the disk's; the document is the room's. `syncWorkspace` is
 * told the workspace after every render and carries what changed there into the document;
 * `pull` hears the document change and asks the app (the bridge) to carry that into the
 * workspace. Each value that can change on both sides is a `Register`: it remembers what
 * each side last showed, so a change is only ever carried across once, and a value on its
 * way into the workspace — the app applies them through state updates and the disk, which
 * take a moment — is not mistaken for the user changing it back.
 *
 * ── Who holds the text ──
 * Everywhere else in the editor the open tab is the one copy of its code and Monaco is a
 * controlled component. With several people typing that cannot stand: React's `value` is
 * always a render behind, and a teammate's edit landing in that gap would be "corrected"
 * back. So for a file in the room the order is turned round:
 *
 *   Monaco model  ⇄  Y.Text            y-monaco, both ways, edit by edit
 *                    Y.Text  →  file   `pull` hands the whole text to the tab or saved file
 *
 * The `Y.Text` is the truth, for a file that is open and for one that is not. The editor is
 * given no `value` for a shared tab (App.tsx) and its `onChange` is not listened to there.
 * Text therefore only enters the document through the editor, or `replaceSharedText`.
 *
 * ── Undo ──
 * Monaco's own undo stack replays ranges, and a teammate's edit in between makes them
 * wrong. While a shared file is in the editor, Ctrl+Z and Ctrl+Y go to a `Y.UndoManager`
 * of that file which tracks only what this editor typed.
 *
 * ── Boards ──
 * A drawing board in the shared folder (a `.board` file, src/board) is in the document too,
 * under `boards`: a map by random id with its `path` and its strokes (boardDoc.ts). Everyone
 * draws on that map directly, and each member writes it to their own file a moment after it
 * changes, so the folder holds the drawing when the room is over. Drawing is not writing
 * code: the ICPC rule leaves boards alone.
 *
 * ── One keyboard ──
 * A room opened under the ICPC rule lets one member write code at a time (keyboard.ts says
 * how the members agree on whom without anybody deciding it). Everything this user writes
 * into a shared file is noted as theirs; while the keyboard is somebody else's the editor
 * is read-only for shared files (App.tsx), and undo, templates and language switches wait.
 */

type Message = keyof typeof messages.en;

export type Member = { id: number; name: string; color: string; self: boolean };

/** Which of the room's dialogs is up: starting one, or the room itself. */
export type CollabDialog = "open" | "join" | "room" | null;

/**
 * Whether teammates outside this network can reach a room that runs on this computer:
 * not asked (the room is on a relay, or is somebody else's), being asked of the router,
 * `open` — the router forwards a port here — or the reason it does not.
 */
export type Reach = "none" | "checking" | "open" | "no-gateway" | "nat" | "refused";

type CollabState = {
  dialog: CollabDialog;
  phase: "idle" | "starting" | "live";
  /** The relay is inside this app: leaving stops it, which ends the room for everyone. */
  local: boolean;
  /** The ids of this user's files that are in the room. A new set whenever that changes. */
  shared: ReadonlySet<string>;
  /** The boards of this workspace that are in the room, by file key of their workspace path. */
  boards: ReadonlySet<string>;
  /** Where the shared folder is in this user's workspace; "" is the workspace itself. */
  root: string;
  /** What the room calls the folder. */
  name: string;
  link: Link;
  /** The relay the room is on, as the socket opens it. */
  address: string;
  /** What a teammate on the same network connects to instead, when the relay is this computer's. */
  lanAddresses: string[];
  /** And one outside it, once the router forwards a port here. */
  publicAddress: string;
  reach: Reach;
  code: string;
  members: Member[];
  /** The room keeps the ICPC rule: one member writes code at a time. */
  icpc: boolean;
  /** This member's client id, the one `members` and `keyboard` know them by. */
  self: number;
  /** Who has the keyboard, under the ICPC rule. */
  keyboard: Keyboard;
  /** Why opening or joining did not work, for the dialog: a message, and the backend's own words when it had any. */
  error: { message: Message; detail?: string } | null;
};

const NOBODY: ReadonlySet<string> = new Set();
const IDLE: Omit<CollabState, "dialog" | "error"> = { phase: "idle", local: false, shared: NOBODY, boards: NOBODY, root: "", name: "", link: "offline", address: "", lanAddresses: [], publicAddress: "", reach: "none", code: "", members: [], icpc: false, self: 0, keyboard: { holder: null, until: 0 } };

export const collab = createStore<CollabState>({ ...IDLE, dialog: null, error: null });

/**
 * One part of the room's state, re-rendering when it changes — through an ordinary state
 * update rather than `collab.use`, for the reason `useWorkspace` gives: a change here comes
 * together with a change to the tabs, and the two must reach the same render.
 */
export const useCollab = <Part>(part: (state: CollabState) => Part): Part => {
  const [value, setValue] = useState(() => part(collab.get()));
  useEffect(() => {
    const follow = () => setValue(() => part(collab.get()));
    follow();
    return collab.subscribe(follow);
  }, []);
  return value;
};

export const showCollabDialog = (dialog: CollabDialog) => collab.set({ dialog, error: null });

// ── What the app does for a room ──

export type SharedFile = { meta: FileMeta; tests: FileTest[]; judge: FileJudge };

/** The app's side of a room: the workspace is its state and its disk, so what happens to them is asked for here. */
export type CollabBridge = {
  /** The file's code is now `text`, whoever typed it. */
  setText: (id: string, text: string) => void;
  patch: (id: string, patch: Partial<SharedFile>) => void;
  /** A teammate's file becomes a file of this workspace. Returns its id. */
  create: (file: SharedFile & { filename: string; text: string }) => string;
  rename: (id: string, filename: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  createDirectory: (path: string) => Promise<void>;
  /** Removes the folder if nothing is left in it. */
  removeDirectory: (path: string) => Promise<void>;
  /** A board's file: read, written (made when it is not there), deleted. */
  readBoard: (path: string) => Promise<string>;
  writeBoard: (path: string, text: string) => Promise<void>;
  removeBoard: (path: string) => Promise<void>;
  /** Something for the status line. */
  report: (message: Message) => void;
};

let bridge: CollabBridge | null = null;

/** Registers the app as the one whose workspace a room works on. Called by App on every render; the room always reaches the latest. */
export const useCollabBridge = (app: CollabBridge) => {
  const latest = useLatest(app);
  useEffect(() => {
    const proxy: CollabBridge = {
      setText: (id, text) => latest.current.setText(id, text),
      patch: (id, patch) => latest.current.patch(id, patch),
      create: (file) => latest.current.create(file),
      rename: (id, filename) => latest.current.rename(id, filename),
      remove: (id) => latest.current.remove(id),
      createDirectory: (path) => latest.current.createDirectory(path),
      removeDirectory: (path) => latest.current.removeDirectory(path),
      readBoard: (path) => latest.current.readBoard(path),
      writeBoard: (path, text) => latest.current.writeBoard(path, text),
      removeBoard: (path) => latest.current.removeBoard(path),
      report: (message) => latest.current.report(message),
    };
    bridge = proxy;
    return () => { if (bridge === proxy) bridge = null; };
  }, [latest]);
};

// ── The room ──

/** A value both the workspace and the document hold: what each was last seen to show. */
type Register = { local: string; doc: string };

type Entry = {
  /** The file's id in the document. */
  id: string;
  /** The same file in this workspace: the id of its tab or saved file. */
  localId: string;
  /** It has been seen among the workspace's files, so its absence now means it was deleted here. */
  seen: boolean;
  /** The workspace's object for it when it was last looked at; unchanged, there is nothing new to carry. */
  ref: ProblemTab | null;
  map: Y.Map<unknown>;
  text: Y.Text;
  path: Register;
  meta: Register;
  tests: Register;
  judge: Register;
  /**
   * Added from this workspace while the editor was showing it: what the editor holds is the
   * newer text. Never for a file whose tab is opened later — that model starts out empty,
   * and is filled from the document.
   */
  fresh: boolean;
  /** A move asked of the app and not yet answered, and how often it has been asked in vain. */
  renaming: boolean;
  tries: number;
  binding: MonacoBinding | null;
  bound: { editor: Monaco.editor.IStandaloneCodeEditor; model: Monaco.editor.ITextModel } | null;
  undo: Y.UndoManager | null;
};

/** A board in the room, and in this workspace. */
type BoardEntry = {
  id: string;
  /** Relative to the shared folder. */
  path: string;
  map: Y.Map<unknown>;
  doc: BoardDoc;
  /** It has been seen among the workspace's boards, so its absence now means it was deleted here. */
  seen: boolean;
  /** A write of the file waiting for the drawing to settle. */
  saving: number | null;
};

type Session = {
  /** This member opened the room: it began with the folder instead of waiting for it. */
  opener: boolean;
  /** The relay is the one inside this app, and goes when this member leaves. */
  local: boolean;
  /** The folder is in place here, so the two directions run. */
  ready: boolean;
  root: string;
  /** The workspace the folder is in; another one being opened is this member leaving. */
  workspace: string | null;
  doc: Y.Doc;
  files: Y.Map<Y.Map<unknown>>;
  dirs: Y.Map<boolean>;
  info: Y.Map<string>;
  awareness: Awareness;
  provider: RelayProvider | null;
  entries: Map<string, Entry>;
  byLocal: Map<string, Entry>;
  /** The folders under the root this workspace was last seen to have (file key → path). */
  dirsSeen: Map<string, string>;
  dirsBusy: Set<string>;
  /** Files of the document that changed and have not been looked at yet. */
  dirty: Set<string>;
  scheduled: boolean;
  boards: Y.Map<Y.Map<unknown>>;
  boardEntries: Map<string, BoardEntry>;
  /** Boards by file key of their workspace path. */
  boardsByPath: Map<string, BoardEntry>;
  /** Boards of this workspace being read to be brought into the room, by file key. */
  boardsSharing: Set<string>;
  /** Under the ICPC rule (see `keyboard`). */
  icpc: boolean;
  /** This member's writing, and everyone else's as heard, for the keyboard. */
  writing: Writer;
  writers: Map<number, Writer>;
  /** When the keyboard is next looked at again: its holder's idle time running out. */
  keyTimer: number | null;
  /** Telling the others about this member's writing, at most every `CLAIM_EVERY`. */
  claimTimer: number | null;
  claimedAt: number;
};

let session: Session | null = null;

/** What the app last showed of the workspace. */
export type WorkspaceView = { path: string | null; files: ProblemTab[]; directories: string[]; boards: string[] };
let view: WorkspaceView = { path: null, files: [], directories: [], boards: [] };

const newSession = (opener: boolean, name: string, color: string): Session => {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  // Writing is announced from the start, so that a teammate's first keystroke is a change of it.
  awareness.setLocalState({ user: { name, color }, write: { run: 0, n: 0 } });
  return {
    opener, local: false, ready: false, root: "", workspace: null, doc, awareness, provider: null,
    files: doc.getMap<Y.Map<unknown>>("files"), dirs: doc.getMap<boolean>("dirs"), info: doc.getMap<string>("room"),
    boards: doc.getMap<Y.Map<unknown>>("boards"), boardEntries: new Map(), boardsByPath: new Map(), boardsSharing: new Set(),
    entries: new Map(), byLocal: new Map(), dirsSeen: new Map(), dirsBusy: new Set(), dirty: new Set(), scheduled: false,
    icpc: false, writing: { id: doc.clientID, run: 0, n: 0, at: Number.NEGATIVE_INFINITY }, writers: new Map(), keyTimer: null, claimTimer: null, claimedAt: 0,
  };
};

const newEntry = (id: string, localId: string, map: Y.Map<unknown>, code: Y.Text, path: string, said: { meta: string; tests: string; judge: string }, mine: ProblemTab | null): Entry => ({
  id, localId, seen: mine !== null, ref: mine, map, text: code, fresh: false, renaming: false, tries: 0, binding: null, bound: null, undo: null,
  path: { local: path, doc: path }, meta: { local: said.meta, doc: said.meta }, tests: { local: said.tests, doc: said.tests }, judge: { local: said.judge, doc: said.judge },
});

const COLOR = /^#[0-9a-f]{6}$/i;

/** Everyone in the room, this user first. Names and colours come from the others and are taken for what they are. */
const membersOf = (room: Session): Member[] => [...room.awareness.getStates()].map(([id, state]): Member => {
  const user = (state as { user?: { name?: unknown; color?: unknown } }).user;
  return {
    id,
    name: peerName(typeof user?.name === "string" ? user.name : "", "?"),
    color: typeof user?.color === "string" && COLOR.test(user.color) ? user.color : PEER_COLORS[0],
    self: id === room.doc.clientID,
  };
}).sort((left, right) => Number(right.self) - Number(left.self) || left.id - right.id);

/**
 * y-monaco draws a teammate's selection and cursor as decorations classed by client id;
 * whose they are — the colour, and the name over the cursor — is said here, in one style
 * sheet rewritten as people come and go. A name is somebody else's text: it goes in as a
 * quoted CSS string and nowhere near markup.
 */
const cursorStyles = (members: Member[]) => {
  const id = "collab-cursors";
  let sheet = document.getElementById(id);
  const others = members.filter((member) => !member.self);
  if (!others.length) { sheet?.remove(); return; }
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.id = id;
    document.head.append(sheet);
  }
  sheet.textContent = others.map((member) =>
    `.yRemoteSelection-${member.id}{background:${member.color}45}`
    + `.yRemoteSelectionHead-${member.id}{border-color:${member.color}}`
    + `.yRemoteSelectionHead-${member.id}::after{content:${JSON.stringify(member.name)};background:${member.color}}`).join("\n");
};

const watchMembers = (room: Session) => room.awareness.on("change", () => {
  if (session !== room) return;
  hearWriters(room);
  const members = membersOf(room);
  // Two people with one colour: the one with the lower id keeps it. Both sides compute
  // that alike, so exactly one of them moves.
  const self = members.find((member) => member.self);
  if (self && members.some((other) => !other.self && other.color === self.color && other.id < self.id)) {
    room.awareness.setLocalStateField("user", { name: self.name, color: pickPeerColor(members.filter((member) => !member.self).map((member) => member.color), self.id) });
    return;
  }
  cursorStyles(members);
  collab.set({ members });
});

// ── One keyboard ──

/** The origin of a write into the document that is neither typing nor undo: a language switch, a template. */
const WRITE = Symbol("write");

/** How often this member's writing is announced at most; the last edit is always announced, at most this late. */
const CLAIM_EVERY = 250;

/** Somebody else has the keyboard, under the ICPC rule: this member may read, not write, shared code. */
const blockedBy = (state: CollabState) => state.icpc && state.keyboard.holder !== null && state.keyboard.holder !== state.self ? state.keyboard.holder : null;

/** Who has the keyboard right now, when it is not this member: the name to show, or null when this member may write. */
export const keyboardTakenBy = () => {
  const state = collab.get();
  const holder = blockedBy(state);
  return holder === null ? null : state.members.find((member) => member.id === holder)?.name ?? "?";
};

/** The keyboard as it now stands; looked at again when its holder's idle time runs out. */
const judgeKeyboard = (room: Session) => {
  if (room.keyTimer !== null) window.clearTimeout(room.keyTimer);
  room.keyTimer = null;
  if (session !== room || !room.icpc) return;
  const now = Date.now();
  const keyboard = keyboardAt([...room.writers.values(), room.writing], now);
  const shown = collab.get().keyboard;
  if (shown.holder !== keyboard.holder || shown.until !== keyboard.until) collab.set({ keyboard });
  if (keyboard.holder !== null) room.keyTimer = window.setTimeout(() => judgeKeyboard(room), Math.max(0, keyboard.until - now) + 10);
};

/** What the others' awareness says of their writing, heard now. Who has left writes no more. */
const hearWriters = (room: Session) => {
  const now = Date.now();
  const states = room.awareness.getStates();
  for (const id of [...room.writers.keys()]) if (!states.has(id)) room.writers.delete(id);
  states.forEach((state, id) => {
    if (id === room.doc.clientID) return;
    const claim = writeClaim(state);
    if (claim) room.writers.set(id, heardClaim(room.writers.get(id), id, claim, now));
  });
  judgeKeyboard(room);
};

const announceWriting = (room: Session, immediately: boolean) => {
  const send = () => {
    room.claimTimer = null;
    room.claimedAt = Date.now();
    if (session === room) room.awareness.setLocalStateField("write", { run: room.writing.run, n: room.writing.n });
  };
  const since = Date.now() - room.claimedAt;
  if (immediately || since >= CLAIM_EVERY) {
    if (room.claimTimer !== null) window.clearTimeout(room.claimTimer);
    send();
  } else room.claimTimer ??= window.setTimeout(send, CLAIM_EVERY - since);
};

/**
 * This member wrote into a shared file. Taking a free keyboard is a new turn, and is said at
 * once — two members starting together should find out as soon as they can.
 */
const noteWriting = (room: Session) => {
  const now = Date.now();
  const fresh = !(now - room.writing.at < KEYBOARD_IDLE_MS);
  room.writing = { ...room.writing, run: fresh ? nextRun([...room.writers.values(), room.writing]) : room.writing.run, n: room.writing.n + 1, at: now };
  announceWriting(room, fresh);
  judgeKeyboard(room);
};

const watchWriting = (room: Session) => room.doc.on("afterTransaction", (transaction: Y.Transaction) => {
  const origin = transaction.origin;
  if (!transaction.local || !(origin instanceof MonacoBinding || origin instanceof Y.UndoManager || origin === WRITE)) return;
  if ([...transaction.changed.keys()].some((type) => type instanceof Y.Text)) noteWriting(room);
});

const stopKeyboard = (room: Session) => {
  if (room.keyTimer !== null) window.clearTimeout(room.keyTimer);
  if (room.claimTimer !== null) window.clearTimeout(room.claimTimer);
  room.keyTimer = room.claimTimer = null;
};

// ── Paths and values ──

/** `path` relative to the shared folder, or null when it is not in it. */
const within = (root: string, path: string): string | null => {
  const clean = normalizedExplorerPath(path);
  if (!root) return clean;
  return fileKey(clean).startsWith(`${fileKey(root)}/`) ? clean.slice(root.length + 1) : null;
};

const join = (root: string, path: string) => root ? `${root}/${path}` : path;

/** What of a workspace file the room shares besides its text, as the strings the document keeps. */
const describe = (file: ProblemTab) => ({
  meta: JSON.stringify({ title: file.title, source: file.source, sourceUrl: file.sourceUrl, limits: file.limits } satisfies FileMeta),
  tests: JSON.stringify(file.tests.map(({ name, input, expected }) => ({ name, input, expected }))),
  judge: JSON.stringify({ status: file.judgeStatus, url: file.submissionUrl, submissions: file.submissions } satisfies FileJudge),
});

const string = (value: unknown) => typeof value === "string" ? value : "";

/** What two members know of a problem's standing, as the one string both arrive at (see `mergeJudge`). */
const merged = (left: string, right: string) => JSON.stringify(mergeJudge(fileJudge(left), fileJudge(right)));

// ── The editor ──

let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
let liveKey: Monaco.editor.IContextKey<boolean> | null = null;

/** App names a tab's model `file:///<tab id>/main.<ext>`; this is that tab id. */
const modelTab = (model: Monaco.editor.ITextModel) => model.uri.path.split("/")[1] ?? "";

type Decorated = { _decorations?: Map<unknown, string[]>; _rerenderDecorations?: () => void };

const unbind = (entry: Entry) => {
  if (entry.binding && entry.bound && !entry.bound.model.isDisposed()) {
    // The binding leaves the cursors it drew behind; they are its to take away.
    const drawn = (entry.binding as unknown as Decorated)._decorations?.get(entry.bound.editor);
    if (drawn?.length) entry.bound.editor.deltaDecorations(drawn, []);
  }
  entry.binding?.destroy();
  entry.binding = null;
  entry.bound = null;
};

/** The whole text of a file, set through the document so that everyone gets it. */
const rewrite = (entry: Entry, next: string, origin: unknown) => {
  if (entry.text.toString() === next) return;
  entry.text.doc?.transact(() => {
    entry.text.delete(0, entry.text.length);
    entry.text.insert(0, next);
  }, origin);
};

/**
 * Ties a shared file's text to the editor once its tab is the one shown. The binding then
 * stays with that model while the room lasts, in front or not — y-monaco only announces
 * the cursor of the model the editor is showing — and is made again only for a new model.
 */
const bind = () => {
  const room = session;
  const model = editor?.getModel() ?? null;
  const entry = room && model ? room.byLocal.get(modelTab(model)) : undefined;
  liveKey?.set(Boolean(entry));
  if (!room || !editor || !model || !entry) return;
  if (entry.bound?.editor === editor && entry.bound.model === model) return;
  unbind(entry);
  // A file this user just brought into the room may have been typed into since its text
  // was read: the editor is ahead, and the document takes what it holds.
  if (entry.fresh && model.getValue()) rewrite(entry, model.getValue(), null);
  entry.fresh = false;
  // The binding puts the document's text into the model when the two differ — a file a
  // teammate made, or a model made again — and the view would jump to the top with it.
  const state = model.getValue() === entry.text.toString() ? null : editor.saveViewState();
  const binding = new MonacoBinding(entry.text, model, new Set([editor]), room.awareness);
  // Nothing is undoable but what this editor typed: a teammate's edits stay out of this user's history.
  entry.undo ??= new Y.UndoManager(entry.text, { trackedOrigins: new Set() });
  entry.undo.addTrackedOrigin(binding);
  entry.binding = binding;
  entry.bound = { editor, model };
  if (state) editor.restoreViewState(state);
  // Teammates who were already there are only drawn on their next move otherwise.
  (binding as unknown as Decorated)._rerenderDecorations?.();
};

const step = (back: boolean) => {
  const model = editor?.getModel();
  const undo = model && session?.byLocal.get(modelTab(model))?.undo;
  if (!undo || blockedBy(collab.get()) !== null) return;
  if (back) undo.undo(); else undo.redo();
};

/** Called by App when Monaco has made its editor: from then on the room follows which model it shows. */
export const attachCollabEditor = (instance: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => {
  editor = instance;
  // Only while a shared file is in the editor; every other tab keeps Monaco's own undo.
  liveKey = instance.createContextKey("mildCollabLive", false);
  instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, () => step(true), "mildCollabLive");
  instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ, () => step(false), "mildCollabLive");
  instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, () => step(false), "mildCollabLive");
  // Not inside the model change itself. Binding a tab fills its model, and the editor's
  // `onChange` listener is at that moment still the one of the tab that was in front
  // before — it would take the room's text for an edit of that other file.
  instance.onDidChangeModel(() => queueMicrotask(bind));
  instance.onDidDispose(() => {
    if (editor !== instance) return;
    session?.entries.forEach(unbind);
    editor = null;
    liveKey = null;
  });
  bind();
};

/**
 * Replaces the whole text of a shared file, for the commands that write a tab's code
 * outright (applying a template of its language): in a room that is an edit like any other, made through
 * the document so that everyone gets it and this user can undo it. False when the file is
 * not in the room, and the caller writes the tab as usual.
 */
export const replaceSharedText = (localId: string, next: string) => {
  const entry = session?.byLocal.get(localId);
  if (!entry) return false;
  if (blockedBy(collab.get()) === null) rewrite(entry, next, entry.binding ?? WRITE);
  return true;
};

/**
 * A shared file changes its language: it moves to `filename` and its text becomes `next`,
 * the code this user has for it in that language. One step in the document, so that nobody
 * is handed the new text for the old language or the other way round. False when the file
 * is not in the room.
 */
export const moveSharedFile = (localId: string, filename: string, next: string) => {
  const room = session;
  const entry = room?.byLocal.get(localId);
  const path = room && entry ? within(room.root, filename) : null;
  if (!room || !entry || path === null || !safePath(path, true)) return false;
  room.doc.transact(() => {
    entry.path.doc = path;
    entry.map.set("path", path);
    entry.text.delete(0, entry.text.length);
    entry.text.insert(0, next);
  }, WRITE);
  return true;
};

const languageOf = (path: string) => /\.py$/i.test(path) ? "python" : "cpp";

/**
 * The room has moved the file to another language and this workspace has not followed yet:
 * the text in the document is already that language's, and the copy here still the old
 * one's — which this user keeps, for when the file is switched back.
 */
const switching = (entry: Entry) => languageOf(entry.path.local) !== languageOf(entry.path.doc);

/** Which of this user's files are in the room changed: the app is told, and the editor may now be showing one. */
const publishShared = (room: Session) => {
  if (session === room) collab.set({ shared: new Set(room.byLocal.keys()) });
  bind();
};

// ── Document → workspace ──

const forget = (room: Session, entry: Entry) => {
  unbind(entry);
  entry.undo?.destroy();
  room.entries.delete(entry.id);
  if (room.byLocal.get(entry.localId) === entry) room.byLocal.delete(entry.localId);
};

/**
 * Two files at one path — two members added the same name at the same moment. The one with
 * the higher id takes the next free name. Every member works that out alike, so they all
 * write the same answer. True when something was renamed, and `pull` runs again for it.
 */
const dedupe = (room: Session) => {
  const holders = new Map<string, string[]>();
  const paths: string[] = [];
  room.files.forEach((map, id) => {
    const path = safePath(map.get("path"), true);
    if (!path) return;
    paths.push(path);
    holders.set(fileKey(path), [...holders.get(fileKey(path)) ?? [], id]);
  });
  const moves: Array<[string, string]> = [];
  for (const ids of holders.values()) {
    if (ids.length < 2) continue;
    for (const id of ids.sort().slice(1)) {
      const next = mexFilename(string(room.files.get(id)?.get("path")), paths);
      paths.push(next);
      moves.push([id, next]);
    }
  }
  if (moves.length) room.doc.transact(() => moves.forEach(([id, path]) => room.files.get(id)?.set("path", path)));
  return moves.length > 0;
};

/** A file's path in the room is not its path here: the app is asked to move it, one request at a time. */
const rename = (room: Session, entry: Entry) => {
  if (entry.renaming || entry.tries >= 3 || !bridge) return;
  entry.renaming = true;
  entry.tries += 1;
  void bridge.rename(entry.localId, join(room.root, entry.path.doc)).catch(() => undefined).then(() => { entry.renaming = false; });
};

const pullDirectories = (room: Session) => {
  if (!bridge) return;
  const here = new Set(view.directories.map((directory) => within(room.root, directory)).filter((path): path is string => Boolean(path)).map(fileKey));
  const there = new Map<string, string>();
  room.dirs.forEach((_, path) => { if (safePath(path, false)) there.set(fileKey(path), path); });
  const settle = (key: string, work: Promise<void>) => {
    room.dirsBusy.add(key);
    void work.catch(() => undefined).then(() => room.dirsBusy.delete(key));
  };
  for (const [key, path] of there) {
    if (!here.has(key) && !room.dirsSeen.has(key) && !room.dirsBusy.has(key)) settle(key, bridge.createDirectory(join(room.root, path)));
  }
  // A folder this workspace had and the room no longer does: a teammate removed it. The
  // deepest first; one that still holds something stays, and is tried again later.
  for (const [key, path] of [...room.dirsSeen].sort((a, b) => b[0].length - a[0].length)) {
    if (!there.has(key) && here.has(key) && !room.dirsBusy.has(key)) settle(key, bridge.removeDirectory(join(room.root, path)));
  }
};

/** Carries what changed in the document into the workspace. */
const pull = (room: Session) => {
  room.scheduled = false;
  if (session !== room || !room.ready || !bridge) return;
  if (dedupe(room)) return;
  const ids = [...room.dirty];
  room.dirty.clear();
  let membership = false;
  for (const id of ids) {
    const map = room.files.get(id);
    const entry = room.entries.get(id);
    if (!map) {
      // A teammate deleted it.
      if (!entry) continue;
      forget(room, entry);
      membership = true;
      void bridge.remove(entry.localId).catch(() => undefined);
      continue;
    }
    const path = safePath(map.get("path"), true);
    const code = map.get("text");
    if (!path || !(code instanceof Y.Text)) continue;
    const said = { meta: string(map.get("meta")), tests: string(map.get("tests")), judge: string(map.get("judge")) };
    if (!entry) {
      // A teammate's new file. What the workspace then shows of it is what the room said.
      const localId = bridge.create({ filename: join(room.root, path), text: code.toString(), meta: fileMeta(said.meta), tests: fileTests(said.tests), judge: fileJudge(said.judge) });
      const made = newEntry(id, localId, map, code, path, said, null);
      room.entries.set(id, made);
      room.byLocal.set(localId, made);
      membership = true;
      continue;
    }
    if (path !== entry.path.doc) {
      entry.path.doc = path;
      entry.tries = 0;
      if (path !== entry.path.local) rename(room, entry);
    }
    if (said.meta !== entry.meta.doc) {
      entry.meta.doc = said.meta;
      if (said.meta !== entry.meta.local) bridge.patch(entry.localId, { meta: fileMeta(said.meta) });
    }
    if (said.tests !== entry.tests.doc) {
      entry.tests.doc = said.tests;
      if (said.tests !== entry.tests.local) bridge.patch(entry.localId, { tests: fileTests(said.tests) });
    }
    if (said.judge !== entry.judge.doc) {
      // Two members may have written at once and only one of the two is kept: what this
      // one knows goes back in with it.
      const both = merged(said.judge, entry.judge.local);
      entry.judge.doc = said.judge;
      if (both !== merged(said.judge, said.judge)) { entry.judge.doc = both; map.set("judge", both); }
      if (both !== merged(entry.judge.local, entry.judge.local)) bridge.patch(entry.localId, { judge: fileJudge(both) });
    }
    if (!switching(entry)) bridge.setText(entry.localId, code.toString());
  }
  pullDirectories(room);
  if (membership) publishShared(room);
};

const schedule = (room: Session) => {
  if (room.scheduled) return;
  room.scheduled = true;
  queueMicrotask(() => pull(room));
};

const watchDocument = (room: Session) => {
  room.files.observeDeep((events) => {
    for (const event of events) {
      if (event.target === room.files) event.keys.forEach((_, id) => room.dirty.add(id));
      else if (typeof event.path[0] === "string") room.dirty.add(event.path[0]);
    }
    schedule(room);
  });
  room.dirs.observe(() => schedule(room));
};

// ── Workspace → document ──

/** Brings a file of this workspace into the room. */
const share = (room: Session, file: ProblemTab, path: string) => {
  const id = crypto.randomUUID();
  const map = new Y.Map<unknown>();
  const code = new Y.Text();
  const said = describe(file);
  code.insert(0, file.codes[file.language]);
  map.set("path", path);
  map.set("text", code);
  map.set("meta", said.meta);
  map.set("tests", said.tests);
  map.set("judge", said.judge);
  room.files.set(id, map);
  const entry = newEntry(id, file.id, map, code, path, said, file);
  const shown = editor?.getModel();
  entry.fresh = Boolean(shown && modelTab(shown) === file.id);
  room.entries.set(id, entry);
  room.byLocal.set(file.id, entry);
};

/** What the workspace shows of a value: carried into the document when it is this user's change. */
const observed = (register: Register, now: string, push: (value: string) => void) => {
  // Unchanged here; if the document differs, that change is on its way in.
  if (now === register.local) return;
  register.local = now;
  if (now === register.doc) return;
  register.doc = now;
  push(now);
};

/**
 * Told the workspace after every render: what changed in the shared folder since the last
 * time goes into the document. Deleting is only ever read off a file that was seen here
 * and is now gone — never off a folder that has not arrived yet.
 */
export const syncWorkspace = (next: WorkspaceView) => {
  view = next;
  const room = session;
  if (!room?.ready || !bridge) return;
  const app = bridge;
  const here = new Map<string, ProblemTab>();
  const paths = new Map<string, ProblemTab>();
  for (const file of next.files) {
    const path = within(room.root, file.filename);
    // An open tab comes first in the list and stands for its saved file.
    if (path === null || !safePath(path, true) || paths.has(fileKey(path))) continue;
    here.set(file.id, file);
    paths.set(fileKey(path), file);
  }
  let membership = false;
  room.doc.transact(() => {
    for (const entry of [...room.entries.values()]) {
      let file = here.get(entry.localId);
      if (!file) {
        // The same file under another id: the workspace was read again from the disk.
        const again = paths.get(fileKey(entry.path.local));
        if (again && !room.byLocal.has(again.id)) {
          unbind(entry);
          room.byLocal.delete(entry.localId);
          entry.localId = again.id;
          room.byLocal.set(again.id, entry);
          file = again;
          membership = true;
        }
      }
      if (!file) {
        if (!entry.seen) continue;
        // Deleted here, or moved out of the folder: gone from the room.
        room.files.delete(entry.id);
        forget(room, entry);
        membership = true;
        continue;
      }
      entry.seen = true;
      if (entry.ref === file) {
        // Nothing new here; a move the room asked for that did not happen is asked again.
        if (entry.path.local !== entry.path.doc) rename(room, entry);
        continue;
      }
      entry.ref = file;
      const said = describe(file);
      observed(entry.path, within(room.root, file.filename) ?? entry.path.local, (value) => entry.map.set("path", value));
      observed(entry.meta, said.meta, (value) => entry.map.set("meta", value));
      observed(entry.tests, said.tests, (value) => entry.map.set("tests", value));
      if (said.judge !== entry.judge.local) {
        // A verdict of this member's own: the room keeps the better of what it had and this.
        entry.judge.local = said.judge;
        const both = merged(entry.judge.doc, said.judge);
        if (both !== merged(entry.judge.doc, entry.judge.doc)) { entry.judge.doc = both; entry.map.set("judge", both); }
        if (both !== merged(said.judge, said.judge)) app.patch(entry.localId, { judge: fileJudge(both) });
      }
      // The document is the text. A copy here that differs is an older one — the disk read
      // again before a teammate's edit was written to it.
      const code = entry.text.toString();
      if (!switching(entry) && file.codes[file.language] !== code) app.setText(file.id, code);
    }
    for (const file of paths.values()) {
      if (room.byLocal.has(file.id)) continue;
      const path = within(room.root, file.filename);
      if (path === null) continue;
      share(room, file, path);
      membership = true;
    }
    // Folders: one new here is told, one gone from here is taken back.
    const folders = new Map<string, string>();
    for (const directory of next.directories) {
      const path = within(room.root, directory);
      if (path && safePath(path, false)) folders.set(fileKey(path), path);
    }
    const known = () => [...room.dirs.keys()];
    for (const [key, path] of folders) {
      if (room.dirsSeen.has(key)) continue;
      room.dirsSeen.set(key, path);
      if (!known().some((other) => fileKey(other) === key)) room.dirs.set(path, true);
    }
    for (const key of [...room.dirsSeen.keys()]) {
      if (folders.has(key)) continue;
      room.dirsSeen.delete(key);
      known().filter((other) => fileKey(other) === key).forEach((other) => room.dirs.delete(other));
    }
  });
  pullDirectories(room);
  syncBoards(room, next.boards);
  if (membership) publishShared(room);
};

// ── Boards ──

/** A board's path in the room: a path the workspace can take, ending in `.board`. */
const boardPath = (path: unknown): string | null => {
  const safe = safePath(path, false);
  return safe && /\.board$/i.test(safe) ? safe : null;
};

/** How long a board is left to settle before its file is written. */
const BOARD_SAVE_DELAY = 700;

const publishBoards = (room: Session) => {
  if (session === room) collab.set({ boards: new Set(room.boardsByPath.keys()) });
};

const writeBoard = (room: Session, entry: BoardEntry) => {
  if (entry.saving !== null) window.clearTimeout(entry.saving);
  entry.saving = null;
  void bridge?.writeBoard(join(room.root, entry.path), serializeBoard(entry.doc.strokes())).catch(() => undefined);
};

const saveBoardSoon = (room: Session, entry: BoardEntry) => {
  if (entry.saving !== null) return;
  entry.saving = window.setTimeout(() => writeBoard(room, entry), BOARD_SAVE_DELAY);
};

const addBoardEntry = (room: Session, id: string, path: string, map: Y.Map<unknown>, seen: boolean): BoardEntry => {
  const entry: BoardEntry = { id, path, map, doc: new BoardDoc(map), seen, saving: null };
  room.boardEntries.set(id, entry);
  room.boardsByPath.set(fileKey(join(room.root, path)), entry);
  // Everyone's file follows the drawing, whoever drew.
  entry.doc.observe(() => { if (session === room && room.ready) saveBoardSoon(room, entry); });
  return entry;
};

const forgetBoard = (room: Session, entry: BoardEntry) => {
  if (entry.saving !== null) window.clearTimeout(entry.saving);
  entry.doc.destroy();
  room.boardEntries.delete(entry.id);
  const key = fileKey(join(room.root, entry.path));
  if (room.boardsByPath.get(key) === entry) room.boardsByPath.delete(key);
};

/** Carries the room's boards into the workspace: a teammate's new board becomes a file here, a deleted one goes. */
const pullBoards = (room: Session) => {
  if (session !== room || !room.ready || !bridge) return;
  const app = bridge;
  let changed = false;
  room.boards.forEach((map, id) => {
    if (room.boardEntries.has(id) || !(map instanceof Y.Map)) return;
    const path = boardPath(map.get("path"));
    // Two members brought a board of one name at once: the second is not taken here.
    if (!path || room.boardsByPath.has(fileKey(join(room.root, path)))) return;
    const entry = addBoardEntry(room, id, path, map, false);
    writeBoard(room, entry);
    changed = true;
  });
  for (const entry of [...room.boardEntries.values()]) {
    if (room.boards.has(entry.id)) continue;
    forgetBoard(room, entry);
    void app.removeBoard(join(room.root, entry.path)).catch(() => undefined);
    changed = true;
  }
  if (changed) publishBoards(room);
};

const watchBoards = (room: Session) => room.boards.observe(() => pullBoards(room));

/** Carries the workspace's boards into the room: a new one here is brought in, one deleted here is taken out. */
const syncBoards = (room: Session, boards: string[]) => {
  if (!bridge) return;
  const app = bridge;
  const here = new Map<string, string>();
  for (const board of boards) {
    const path = within(room.root, board);
    if (path !== null && boardPath(path)) here.set(fileKey(board), path);
  }
  let changed = false;
  for (const entry of [...room.boardEntries.values()]) {
    const key = fileKey(join(room.root, entry.path));
    if (here.has(key)) { entry.seen = true; continue; }
    if (!entry.seen) continue;
    // Deleted here: gone from the room.
    room.boards.delete(entry.id);
    forgetBoard(room, entry);
    changed = true;
  }
  for (const [key, path] of here) {
    if (room.boardsByPath.has(key) || room.boardsSharing.has(key)) continue;
    room.boardsSharing.add(key);
    void app.readBoard(join(room.root, path)).catch(() => EMPTY_BOARD).then((text) => {
      room.boardsSharing.delete(key);
      if (session !== room || !room.ready || room.boardsByPath.has(key)) return;
      const id = crypto.randomUUID();
      const map = new Y.Map<unknown>();
      room.doc.transact(() => {
        room.boards.set(id, map);
        map.set("path", path);
        // Made with the board: two members drawing a first stroke at once would each make their own list, and one would be lost.
        map.set("strokes", new Y.Array());
        const doc = new BoardDoc(map);
        doc.replace(parseBoard(text));
        doc.destroy();
      });
      addBoardEntry(room, id, path, map, true);
      publishBoards(room);
    });
  }
  if (changed) publishBoards(room);
};

/**
 * The room's map of the board at `path` (a workspace path), for drawing on it; null when the
 * board is not in a room, and is drawn on as a file of its own.
 */
export const sharedBoard = (path: string): Y.Map<unknown> | null => session?.ready ? session.boardsByPath.get(fileKey(path))?.map ?? null : null;

/** Adds a new, empty board to the shared folder, named `name` or the next free name; resolves to its workspace path. */
export const addSharedBoard = async (name = "share.board") => {
  const room = session;
  if (!room?.ready || !bridge) return null;
  const taken = view.boards.map((board) => within(room.root, board)).filter((path): path is string => path !== null);
  const path = join(room.root, mexFilename(name, taken));
  await bridge.writeBoard(path, EMPTY_BOARD);
  return path;
};

// ── Opening, joining, leaving ──

const END_MESSAGE: Record<EndReason, Message> = {
  unreachable: "collabErrUnreachable", "no-room": "collabErrNoRoom", "room-full": "collabErrFull", refused: "collabErrRefused", closed: "collabRoomOver", lost: "collabLost",
};

/** How long a joiner waits for somebody in the room to answer with the document. */
const ANSWER_TIMEOUT = 12_000;

/** Puts `room` away. The relay inside the app goes with a room that was on it. */
const dispose = (room: Session) => {
  stopKeyboard(room);
  room.boardEntries.forEach((entry) => forgetBoard(room, entry));
  room.entries.forEach((entry) => { unbind(entry); entry.undo?.destroy(); });
  room.provider?.destroy();
  room.awareness.destroy();
  room.doc.destroy();
  if (room.local) void invoke("collab_close_relay").catch(() => undefined);
  if (session === room) {
    session = null;
    liveKey?.set(false);
    cursorStyles([]);
  }
};

/**
 * The room is over for this user, whoever or whatever ended it. Every file takes the
 * document's last text in the same tick the room's hold on it is given up, and from then on
 * the folder is an ordinary folder of ordinary files again. `quiet` when the folder itself
 * is going, and there is nothing left to hand the text to.
 */
const finish = (room: Session, message?: Message, quiet = false) => {
  if (session !== room) return;
  if (room.ready && !quiet) room.entries.forEach((entry) => bridge?.setText(entry.localId, entry.text.toString()));
  // A drawing that has not been written yet is, now: after this the file is the board.
  if (room.ready && !quiet) room.boardEntries.forEach((entry) => { if (entry.saving !== null) writeBoard(room, entry); });
  room.boardEntries.forEach((entry) => forgetBoard(room, entry));
  room.ready = false;
  stopKeyboard(room);
  room.entries.forEach(unbind);
  session = null;
  liveKey?.set(false);
  cursorStyles([]);
  const dialog = collab.get().dialog;
  collab.set({ ...IDLE, dialog: dialog === "open" || dialog === "join" ? dialog : null });
  if (message) bridge?.report(message);
};

/** Connects `room`; resolves once it is usable — the opener's room is open, a joiner has the document. */
const connect = (room: Session, address: string, keys: Awaited<ReturnType<typeof deriveRoom>>) => new Promise<void>((resolve, reject: (reason: EndReason | "no-answer") => void) => {
  let ready = false;
  const settle = () => { ready = true; window.clearTimeout(waiting); resolve(); };
  const waiting = window.setTimeout(() => { if (!ready) reject("no-answer"); }, ANSWER_TIMEOUT);
  room.provider = new RelayProvider({
    address, room: keys, doc: room.doc, awareness: room.awareness, opener: room.opener, ownsRelay: room.local,
    onLink: (link) => {
      if (session === room) collab.set({ link });
      if (room.opener && link === "online" && !ready) settle();
    },
    onSynced: () => { if (!ready) settle(); },
    onEnd: (reason) => {
      window.clearTimeout(waiting);
      if (!ready) { reject(reason); return; }
      finish(room, END_MESSAGE[reason]);
      dispose(room);
    },
  });
});

const failed = (room: Session | null, error: unknown) => {
  if (room) dispose(room);
  const reason = typeof error === "string" ? error : "";
  const message: Message = reason === "no-answer" ? "collabErrNoAnswer" : reason in END_MESSAGE ? END_MESSAGE[reason as EndReason] : "collabErrFailed";
  collab.set({ ...IDLE, error: { message, detail: message === "collabErrFailed" ? errorMessage(error) : undefined } });
};

type RelayStatus = { open: boolean; port: number | null; addresses: string[] };

/** The folder is in place: the two directions start, and what is already on either side is carried across. */
const goLive = (room: Session, shown: Partial<CollabState>) => {
  room.ready = true;
  // The rule is the room's, set by whoever opened it, and the same for everyone in it.
  room.icpc = room.info.get("icpc") === "1";
  watchDocument(room);
  watchWriting(room);
  watchBoards(room);
  room.files.forEach((_, id) => room.dirty.add(id));
  collab.set({ phase: "live", local: room.local, root: room.root, link: "online", members: membersOf(room), icpc: room.icpc, self: room.doc.clientID, ...shown });
  hearWriters(room);
  pull(room);
  pullBoards(room);
  syncWorkspace(view);
};

const REACH = new Set<Reach>(["no-gateway", "nat", "refused"]);

/**
 * Asks the router to let teammates outside the network into a room on this computer. The
 * room is open and usable meanwhile; the invitation gains an address when this works, and
 * the room says why not when it does not.
 */
const reachOutside = async (room: Session) => {
  const outcome = await invoke<string>("collab_forward_port").then((address) => ({ address }), (error: unknown) => ({ error: String(error) }));
  if (session !== room) return;
  if ("address" in outcome) collab.set({ reach: "open", publicAddress: outcome.address });
  else collab.set({ reach: REACH.has(outcome.error as Reach) ? outcome.error as Reach : "refused" });
};

/**
 * Opens a room on `folder` of the workspace ("" for all of it). `relay` is the address of a
 * relay to open it on; null opens it on this computer, on `port`, which only the app can
 * do — and then the room lasts only as long as this member stays in it.
 */
export const openRoom = async (request: { folder: string; name: string; relay: string | null; port: number; icpc: boolean; board?: boolean }) => {
  if (session || collab.get().phase !== "idle") return;
  if (!view.path) { collab.set({ error: { message: "collabErrNoWorkspace" } }); return; }
  collab.set({ phase: "starting", error: null });
  let room: Session | null = null;
  try {
    let address = request.relay === null ? "" : normalizeRelayAddress(request.relay);
    if (address === null) { collab.set({ ...IDLE, error: { message: "collabErrAddress" } }); return; }
    const code = generateJoinCode();
    const keys = await deriveRoom(code);
    room = session = newSession(true, request.name, PEER_COLORS[0]);
    let lanAddresses: string[] = [];
    if (request.relay === null) {
      const status = await invoke<RelayStatus>("collab_open_relay", { port: request.port });
      room.local = true;
      address = `ws://127.0.0.1:${status.port}`;
      lanAddresses = status.addresses.map((host) => `${host}:${status.port}`);
    }
    watchMembers(room);
    await connect(room, address, keys);
    if (session !== room) return;
    room.root = normalizedExplorerPath(request.folder);
    room.workspace = view.path;
    // What the room calls the folder: its own name, or the workspace's when all of it is shared.
    const name = safeFolderName(explorerBasename(room.root || view.path || ""));
    room.info.set("name", name);
    if (request.icpc) room.info.set("icpc", "1");
    goLive(room, { name, address, lanAddresses, code: formatJoinCode(code), dialog: "room", reach: room.local ? "checking" : "none" });
    // Asked for with the room: a board to plan on together, which the room then shares like any other.
    // A folder that has a board already shares that one instead.
    if (request.board && !view.boards.some((board) => within(room!.root, board) !== null)) await addSharedBoard().catch(() => null);
    if (room.local) void reachOutside(room);
  } catch (error) {
    failed(room, error);
  }
};

/**
 * The addresses the page itself can open, each with the room address it stands for. On macOS
 * WebKit will not let the page open a plain `ws://` socket to another computer (mixed content
 * from a secure page), so each one goes through a loopback port the app passes on to the room
 * (`collab_tunnel` in collab.rs); elsewhere they are used as they are. An address the tunnel
 * cannot take is left out, as an unreachable one would be.
 */
const openableAddresses = async (addresses: string[]): Promise<Map<string, string>> => {
  if (!isMac || !IS_TAURI) return new Map(addresses.map((address) => [address, address]));
  const pairs = await Promise.all(addresses.map(async (address): Promise<readonly [string, string] | null> => {
    try {
      const port = await invoke<number>("collab_tunnel", { address });
      return [`ws://127.0.0.1:${port}`, address] as const;
    } catch {
      return null;
    }
  }));
  return new Map(pairs.filter((pair): pair is readonly [string, string] => pair !== null));
};

/**
 * Joins the room an invitation leads to. Once somebody there has sent the folder, a copy of
 * it is made under `parent` in this workspace — a new folder, by the room's name for it or
 * the next free one, so nothing this user has is ever written over.
 */
export const joinRoom = async (request: { invite: string; name: string; parent: string }) => {
  if (session || collab.get().phase !== "idle") return;
  const invite = parseInvite(request.invite);
  const addresses = invite.address ? normalizeRelayAddresses(invite.address) : null;
  if (!addresses || !invite.code) { collab.set({ error: { message: "collabErrInvite" } }); return; }
  if (!view.path) { collab.set({ error: { message: "collabErrNoWorkspace" } }); return; }
  collab.set({ phase: "starting", error: null });
  let room: Session | null = null;
  try {
    const keys = await deriveRoom(invite.code);
    const openable = await openableAddresses(addresses);
    const candidates = [...openable.keys()];
    const opened = candidates.length > 1 ? await firstReachable(candidates, keys.roomId) : candidates[0];
    if (!opened) throw "unreachable";
    // What the page connects to, and what the room's address is called on screen.
    const address = openable.get(opened) ?? opened;
    if (session || collab.get().phase !== "starting") return;
    // A first guess at a colour; `watchMembers` settles it once the others' are known.
    room = session = newSession(false, request.name, PEER_COLORS[1]);
    watchMembers(room);
    await connect(room, opened, keys);
    if (session !== room || !bridge) return;
    const name = safeFolderName(room.info.get("name"));
    const parent = normalizedExplorerPath(request.parent);
    // Whatever is already called that — a folder, or a file — is left alone.
    const taken = [...view.directories, ...view.files.map((file) => file.filename)].map((path) => within(parent, path)?.split("/")[0]).filter((part): part is string => Boolean(part));
    const root = join(parent, mexFilename(name, taken));
    await bridge.createDirectory(root);
    if (session !== room) return;
    room.root = root;
    room.workspace = view.path;
    goLive(room, { name, address, lanAddresses: [], code: formatJoinCode(invite.code), dialog: null });
  } catch (error) {
    failed(room, error);
  }
};

/**
 * Leaves the room. The others carry on without this member — unless the relay is this
 * app's, which stops with it, and then they are told the room is over. The folder stays as
 * it is, here and with everyone else.
 */
export const leaveRoom = async (quiet = false) => {
  const room = session;
  if (!room) return;
  finish(room, undefined, quiet);
  // The goodbye has to get out before the connection — and the relay under it — goes.
  await room.provider?.leave();
  dispose(room);
};

// The shared folder going from this workspace is this member leaving, not the folder being
// emptied for everyone: the room is left before the workspace is seen without its files.
workspace.subscribe(() => { if (session?.ready && workspace.get().workspacePath !== session.workspace) void leaveRoom(true); });
folderHooks.deleting.add((directory) => {
  const room = session;
  if (!room?.ready || !room.root) return;
  const [root, gone] = [fileKey(room.root), fileKey(normalizedExplorerPath(directory))];
  if (root === gone || root.startsWith(`${gone}/`)) void leaveRoom(true);
});
folderHooks.moved.add((movePath) => {
  const room = session;
  if (!room?.ready || !room.root) return;
  room.root = normalizedExplorerPath(movePath(room.root));
  collab.set({ root: room.root });
});
