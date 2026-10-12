import { invoke } from "@tauri-apps/api/core";
import type * as Monaco from "monaco-editor";
import { useEffect, useState } from "react";
import { MonacoBinding } from "y-monaco";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { useLatest } from "../hooks";
import type { messages } from "../i18n";
import { errorMessage } from "../platform";
import { createStore } from "../store";
import { deriveRoom, formatJoinCode, generateJoinCode, normalizeJoinCode, normalizeRelayAddress, normalizeRelayAddresses, PEER_COLORS, peerName, pickPeerColor, roomFile, type RoomFile } from "./protocol";
import { firstReachable, RelayProvider, type EndReason, type Link } from "./provider";

/**
 * A shared room, as this copy of the editor is in it: one file, edited by everyone in the
 * room at once. Nobody's copy is the original. Each member has the file as a file of their
 * own workspace, saved by their own save; the room only keeps the copies alike while it is
 * open, and when it ends everyone simply has the file. Whoever opens a room is the baseline
 * for that room — it starts from their text — and that is all "opening" means.
 *
 * ── Who holds the text ──
 * Everywhere else in the editor the open tab is the one copy of its code and Monaco is a
 * controlled component: React state goes in as `value`, a keystroke comes back through
 * `onChange`. With several people typing that cannot stand, because `value` is always a
 * render behind — a teammate's edit that lands between a render and its effect would be
 * "corrected" back to the text React still holds, and that correction would then be sent
 * to everyone as an edit of this user's.
 *
 * So for the one tab that is in a room, the order is turned round, and nothing flows
 * against it:
 *
 *   Monaco model  ⇄  Y.Text            y-monaco, both ways, edit by edit
 *                    Y.Text  →  tab    an observer here hands the whole text to `sharedText`
 *
 * The `Y.Text` is the truth. The tab only follows it, so saving, auto save, running and
 * submitting go on reading the tab as they always have, and a teammate's edit marks the
 * tab modified like one typed here — it is not on this disk until this user's save has
 * run. The editor is given no `value` for that tab (App.tsx), which is what stops React
 * writing into the model, and its `onChange` is not listened to there, which is what stops
 * an edit being counted twice.
 *
 * The tab follows the document, not the model: the room's file need not be the tab in
 * front. A member may work in another tab while teammates type in the shared one; the
 * binding stays on that tab's model, which Monaco keeps while its tab is open, and the
 * tab keeps up either way.
 *
 * Which tab is the room's is read by App through `useCollab`, which follows the store with
 * an ordinary state update. That matters at the two edges: joining sets the tab and adds
 * it, leaving hands over the final text and clears it, each in one tick — so no render
 * ever shows an uncontrolled editor without a document, or a controlled one with the text
 * of a moment ago.
 *
 * ── The room and the tab ──
 * A room is tied to a tab, not to a name. Renaming the file renames this member's copy and
 * nobody else's; closing or deleting it, or opening another workspace, is this member
 * leaving, and the others carry on. Its language cannot change while the room is open,
 * since the document is the code of one language.
 *
 * ── Undo ──
 * Monaco's own undo stack replays ranges, and a teammate's edit in between makes them
 * wrong. While the room's file is in the editor, Ctrl+Z and Ctrl+Y go to a `Y.UndoManager`
 * that tracks only what this editor typed, so undo takes back this user's last change and
 * leaves everyone else's standing.
 */

type Message = keyof typeof messages.en;

export type Member = { id: number; name: string; color: string; self: boolean };

/**
 * Which of the room's dialogs is up: starting one, the room itself, the question a joiner
 * is asked when it already has a file by the room's name, or the one asked before a room
 * running on this computer is closed with its tab.
 */
export type CollabDialog = "open" | "join" | "room" | "taken" | "close" | null;

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
  /** The tab whose text is the room's document, while the room is live. */
  tabId: string | null;
  /** The file's name as the room knows it, without its folder. */
  filename: string;
  link: Link;
  /** The relay the room is on, as the socket opens it. */
  address: string;
  /** What a teammate on the same network types instead, when the relay is this computer's. */
  lanAddresses: string[];
  /** And what one outside it types, once the router forwards a port here. */
  publicAddress: string;
  reach: Reach;
  code: string;
  members: Member[];
  /** The file a joiner already has under the room's name, and the name a copy would get instead. */
  taken: { filename: string; copyName: string } | null;
  /** Why opening or joining did not work, for the dialog: a message, and the backend's own words when it had any. */
  error: { message: Message; detail?: string } | null;
};

const IDLE: Omit<CollabState, "dialog" | "error"> = { phase: "idle", local: false, tabId: null, filename: "", link: "offline", address: "", lanAddresses: [], publicAddress: "", reach: "none", code: "", members: [], taken: null };

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

/** The app's side of a room: the tabs are App's state, so what happens to them is asked for here. */
export type CollabBridge = {
  /** An open tab's code and what the room tells the others about the file; null when the tab is gone. */
  tab: (tabId: string) => { text: string; file: RoomFile } | null;
  /** The document changed, here or at a teammate's: the tab takes its text and is modified. */
  sharedText: (tabId: string, text: string) => void;
  /** Whether this user already has a file called `filename`, and the next free name beside it. */
  place: (filename: string) => { taken: boolean; copyName: string };
  /**
   * The room's file becomes a tab of this user's (and so, on the next save, a file of their
   * workspace). `replace` puts the text into the file they already have by that name.
   * Returns the tab's id.
   */
  openRoomTab: (file: RoomFile, text: string, replace: boolean) => string;
  closeTab: (tabId: string) => void;
  /** Something for the status line. */
  report: (message: Message) => void;
};

let bridge: CollabBridge | null = null;

/** Registers the app as the one whose tabs a room works on. Called by App on every render; the room always reaches the latest. */
export const useCollabBridge = (app: CollabBridge) => {
  const latest = useLatest(app);
  useEffect(() => {
    const proxy: CollabBridge = {
      tab: (tabId) => latest.current.tab(tabId),
      sharedText: (tabId, text) => latest.current.sharedText(tabId, text),
      place: (filename) => latest.current.place(filename),
      openRoomTab: (file, text, replace) => latest.current.openRoomTab(file, text, replace),
      closeTab: (tabId) => latest.current.closeTab(tabId),
      report: (message) => latest.current.report(message),
    };
    bridge = proxy;
    return () => { if (bridge === proxy) bridge = null; };
  }, [latest]);
};

// ── The room ──

type Session = {
  /** This member opened the room: it began with the document instead of waiting for it. */
  opener: boolean;
  /** Null until a joiner has the document and its tab. */
  tabId: string | null;
  /** The tab has been seen among the app's tabs, so its absence now means it was closed. */
  tabSeen: boolean;
  doc: Y.Doc;
  text: Y.Text;
  /** `file`: what a joiner needs to know about the file to have it as its own (a `RoomFile`, as JSON). */
  meta: Y.Map<string>;
  awareness: Awareness;
  undo: Y.UndoManager;
  provider: RelayProvider | null;
  binding: MonacoBinding | null;
  bound: { editor: Monaco.editor.IStandaloneCodeEditor; model: Monaco.editor.ITextModel } | null;
  /** The relay is the one inside this app, and goes when this member leaves. */
  local: boolean;
};

let session: Session | null = null;

const newSession = (opener: boolean, name: string, color: string): Session => {
  const doc = new Y.Doc();
  const text = doc.getText("code");
  const awareness = new Awareness(doc);
  awareness.setLocalState({ user: { name, color } });
  // Nothing is undoable until a binding says its edits are: the document's first text and
  // everything a teammate sends stay out of this user's history.
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set() });
  return { opener, tabId: null, tabSeen: false, doc, text, meta: doc.getMap<string>("meta"), awareness, undo, provider: null, binding: null, bound: null, local: false };
};

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

// ── The editor ──

let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
let liveKey: Monaco.editor.IContextKey<boolean> | null = null;

/** App names a tab's model `file:///<tab id>/main.<ext>`; this is that tab id. */
const modelTab = (model: Monaco.editor.ITextModel) => model.uri.path.split("/")[1] ?? "";

type Decorated = { _decorations?: Map<unknown, string[]>; _rerenderDecorations?: () => void };

const unbind = (room: Session) => {
  if (room.binding && room.bound && !room.bound.model.isDisposed()) {
    // The binding leaves the cursors it drew behind; they are its to take away.
    const drawn = (room.binding as unknown as Decorated)._decorations?.get(room.bound.editor);
    if (drawn?.length) room.bound.editor.deltaDecorations(drawn, []);
  }
  room.binding?.destroy();
  room.binding = null;
  room.bound = null;
};

/**
 * Ties the room's document to the editor once the room's tab is the one it shows. The
 * binding then stays with that model for the life of the room, in front or not: making a
 * new one each time the tab came back would also add y-monaco's cursor listener again,
 * which it never takes off, and every cursor move would be announced once per visit.
 */
const bind = () => {
  const room = session;
  const model = editor?.getModel() ?? null;
  const shows = Boolean(room?.tabId && model && modelTab(model) === room.tabId);
  liveKey?.set(shows);
  if (!room || !editor || !model || !shows) return;
  if (room.bound?.editor === editor && room.bound.model === model) return;
  unbind(room);
  // The binding puts the document's text into the model when the two differ — a joiner's
  // new tab, or a model made again — and the view would jump to the top with it.
  const view = model.getValue() === room.text.toString() ? null : editor.saveViewState();
  const binding = new MonacoBinding(room.text, model, new Set([editor]), room.awareness);
  room.undo.addTrackedOrigin(binding);
  room.binding = binding;
  room.bound = { editor, model };
  if (view) editor.restoreViewState(view);
  // Teammates who were already there are only drawn on their next move otherwise.
  (binding as unknown as Decorated)._rerenderDecorations?.();
};

const step = (back: boolean) => {
  if (!session) return;
  if (back) session.undo.undo(); else session.undo.redo();
};

/** Called by App when Monaco has made its editor: from then on the room follows which model it shows. */
export const attachCollabEditor = (instance: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => {
  editor = instance;
  // Only while the room's file is in the editor; every other tab keeps Monaco's own undo.
  liveKey = instance.createContextKey("mildCollabLive", false);
  instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, () => step(true), "mildCollabLive");
  instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ, () => step(false), "mildCollabLive");
  instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, () => step(false), "mildCollabLive");
  // Not inside the model change itself. Binding a joiner's new tab fills its model, and the
  // editor's `onChange` listener is at that moment still the one of the tab that was in
  // front before — it would take the room's text for an edit of that other file.
  instance.onDidChangeModel(() => queueMicrotask(bind));
  instance.onDidDispose(() => {
    if (editor !== instance) return;
    if (session) unbind(session);
    editor = null;
    liveKey = null;
  });
  bind();
};

/**
 * Replaces the whole text of the room's file, for the commands that write a tab's code
 * outright (applying a template): in a room that is an edit like any other, made through
 * the document so that everyone gets it and this user can undo it. False when `tabId` is
 * not the room's, and the caller writes the tab as usual.
 */
export const replaceSharedText = (tabId: string, text: string) => {
  const room = session;
  if (!room || room.tabId !== tabId) return false;
  room.doc.transact(() => {
    room.text.delete(0, room.text.length);
    room.text.insert(0, text);
  }, room.binding);
  return true;
};

// ── Opening, joining, leaving ──

const basename = (filename: string) => filename.replace(/\\/g, "/").split("/").at(-1) || filename;

const END_MESSAGE: Record<EndReason, Message> = {
  unreachable: "collabErrUnreachable", "no-room": "collabErrNoRoom", "room-full": "collabErrFull", refused: "collabErrRefused", closed: "collabRoomOver", lost: "collabLost",
};

/** How long a joiner waits for somebody in the room to answer with the document. */
const ANSWER_TIMEOUT = 12_000;

/** The joiner's answer to "you already have this file", while it is being waited for. */
let answer: ((choice: "replace" | "copy" | null) => void) | null = null;

/** Puts `room` away. The relay inside the app goes with a room that was on it. */
const dispose = (room: Session) => {
  unbind(room);
  room.provider?.destroy();
  room.undo.destroy();
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
 * The room is over for this user, whoever or whatever ended it. The tab takes the
 * document's last text in the same tick the room's hold on it is given up, and from then on
 * is the ordinary tab of an ordinary file again.
 */
const finish = (room: Session, message?: Message) => {
  if (session !== room) return;
  if (room.tabId) bridge?.sharedText(room.tabId, room.text.toString());
  session = null;
  liveKey?.set(false);
  cursorStyles([]);
  const dialog = collab.get().dialog;
  collab.set({ ...IDLE, dialog: dialog === "open" || dialog === "join" ? dialog : null });
  answer?.(null);
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

/** The room has its tab: the tab follows the document from here on, and the editor is bound to it when it shows that tab. */
const goLive = (room: Session, tabId: string, shown: Partial<CollabState>) => {
  room.tabId = tabId;
  room.text.observe(() => { if (session === room) bridge?.sharedText(tabId, room.text.toString()); });
  collab.set({ phase: "live", local: room.local, tabId, link: "online", members: membersOf(room), taken: null, ...shown });
  bind();
};

/**
 * Opens a room on the file in tab `tabId`, starting from its text. `relay` is the address
 * of a relay to open it on; null opens it on this computer, on `port`, which only the app
 * can do — and then the room lasts only as long as this member stays in it.
 */
export const openRoom = async (request: { tabId: string; name: string; relay: string | null; port: number }) => {
  if (session || collab.get().phase !== "idle") return;
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
    // Only now, with the room open, does the document take the file's text: whatever was
    // typed while the code was being derived is in it, and the binding made below finds
    // the model and the document already alike.
    const tab = bridge?.tab(request.tabId);
    if (!tab || session !== room) throw new Error("the file was closed");
    const model = editor?.getModel();
    const text = model && modelTab(model) === request.tabId ? model.getValue() : tab.text;
    const live = room;
    live.doc.transact(() => {
      live.text.insert(0, text);
      live.meta.set("file", JSON.stringify(tab.file));
    });
    goLive(live, request.tabId, { filename: basename(tab.file.filename), address, lanAddresses, code: formatJoinCode(code), dialog: "room", reach: live.local ? "checking" : "none" });
    if (live.local) void reachOutside(live);
  } catch (error) {
    failed(room, error);
  }
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
 * Joins the room at `address` with `code`. The address may be several, as an invitation
 * gives them; the first that answers is the one the room is joined at. Once somebody there has sent the document, its
 * file becomes a file of this user's: under the name it has in the room, or — when they
 * already have one by that name — whichever way they answer the question that is asked.
 */
export const joinRoom = async (request: { address: string; code: string; name: string }) => {
  if (session || collab.get().phase !== "idle") return;
  const addresses = normalizeRelayAddresses(request.address);
  const code = normalizeJoinCode(request.code);
  if (!addresses || !code) { collab.set({ error: { message: addresses ? "collabErrCode" : "collabErrAddress" } }); return; }
  collab.set({ phase: "starting", error: null });
  let room: Session | null = null;
  try {
    const keys = await deriveRoom(code);
    const address = addresses.length > 1 ? await firstReachable(addresses, keys.roomId) : addresses[0];
    if (!address) throw "unreachable";
    if (session || collab.get().phase !== "starting") return;
    // A first guess at a colour; `watchMembers` settles it once the others' are known.
    room = session = newSession(false, request.name, PEER_COLORS[1]);
    watchMembers(room);
    await connect(room, address, keys);
    if (session !== room || !bridge) return;
    const live = room;
    // What the file is called and where it belongs is somebody else's word for it.
    const file = roomFile(live.meta.get("file"));
    const place = bridge.place(file.filename);
    let replace = false;
    if (place.taken) {
      // Never silently: the file here may hold work of this user's. The room stays
      // connected meanwhile, so the text that lands is the text of that moment.
      collab.set({ dialog: "taken", taken: { filename: file.filename, copyName: place.copyName } });
      const choice = await new Promise<"replace" | "copy" | null>((resolve) => { answer = resolve; });
      answer = null;
      if (session !== live) return;
      if (choice === null) { void leaveRoom(); return; }
      replace = choice === "replace";
    }
    // The name was free a moment ago, or was asked about; a copy takes the next free one as of now.
    const landed = replace || !place.taken ? file : { ...file, filename: bridge.place(file.filename).copyName };
    const tabId = bridge.openRoomTab(landed, live.text.toString(), replace);
    goLive(live, tabId, { filename: basename(file.filename), address, lanAddresses: [], code: formatJoinCode(code), dialog: null });
  } catch (error) {
    failed(room, error);
  }
};

/** The joiner's answer about the file it already has; null backs out of the room. */
export const answerTaken = (choice: "replace" | "copy" | null) => answer?.(choice);

/**
 * Leaves the room. The others carry on without this member — unless the relay is this
 * app's, which stops with it, and then they are told the room is over. The text stays in
 * the tab either way.
 */
export const leaveRoom = async () => {
  const room = session;
  if (!room) return;
  finish(room);
  unbind(room);
  // The goodbye has to get out before the connection — and the relay under it — goes.
  await room.provider?.leave();
  dispose(room);
};

/** Closing the tab of a room that runs on this computer, once that has been agreed to: the room first, then the tab like any other. */
export const closeRoomWithTab = async () => {
  const tabId = session?.tabId;
  await leaveRoom();
  if (tabId) bridge?.closeTab(tabId);
};

/** Told the app's tabs whenever they change: a room whose tab was closed is left. */
export const reconcileSharedTab = (tabs: ReadonlyArray<{ id: string }>) => {
  const room = session;
  if (!room?.tabId) return;
  if (tabs.some((item) => item.id === room.tabId)) { room.tabSeen = true; return; }
  // A joiner's tab is added in the tick the room goes live; a render from before that has not got it yet.
  if (room.tabSeen) void leaveRoom();
};
