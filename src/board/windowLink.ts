import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { collab } from "../collab/collabStore";
import { fileKey } from "../fileNaming";
import { errorMessage, IS_TAURI } from "../platform";
import { createStore } from "../store";
import { workspace } from "../workspaceStore";
import { holdBoard, type BoardHandle } from "./boardStore";
import { applyChange, changes, fullState, heard, newSent, readFromPad, type Sent, type ToPad } from "./padProtocol";
import { pairBoard, pairings, reachFromOutside, unpairBoard } from "./pads";
import { BOARD_WINDOW, FROM_WINDOW_EVENT, INFO_EVENT, PAD_EVENT, type FromWindow, type PadToWindow, type WindowInfo } from "./windowProtocol";

/**
 * The app window's end of the board window (BoardWindow.tsx, src-tauri/src/boards.rs). The
 * board a board window shows is held here, as one in the editor's panel is — its file, its
 * room and its tablets stay with this window — and the board window draws on a copy kept up
 * to date the way a tablet's is (padProtocol.ts), over Tauri events instead of a socket.
 *
 * The board window is told, besides the board itself, what it shows around it: the list of
 * boards, whether the board is in a room, and its tablet pairing. What it asks of this
 * window (another board, a new one, back over the editor, a tablet) comes as `FromWindow`.
 */

/** The board the board window shows, or null while it is hidden (or was never opened). */
export const boardWindow = createStore<{ path: string | null }>({ path: null });

/** What the app window does for the board window: open a board, make one, take the board back over the editor. */
type Actions = { open: (path: string) => void; create: () => void; dock: () => void };
let actions: Actions = { open: () => undefined, create: () => undefined, dock: () => undefined };
export const setBoardWindowActions = (next: Actions) => { actions = next; };

type Served = { path: string; handle: BoardHandle; sent: Sent; unsubscribe: () => void; timer: number | null };
let served: Served | null = null;
let pairError = "";

const info = (): WindowInfo => {
  const path = boardWindow.get().path;
  return {
    path,
    boards: workspace.get().workspaceBoards,
    workspacePath: workspace.get().workspacePath,
    shared: path !== null && collab.get().boards.has(fileKey(path)),
    pairing: path !== null ? pairings.get()[fileKey(path)] ?? null : null,
    pairError,
  };
};

let telling = false;
/** Tells the board window what it shows around its board, once for any number of changes in a row. */
const tellInfo = () => {
  if (telling || !inAppWindow) return;
  telling = true;
  queueMicrotask(() => {
    telling = false;
    void emitTo(BOARD_WINDOW, INFO_EVENT, info()).catch(() => undefined);
  });
};

const sendPad = (path: string, message: ToPad) =>
  void emitTo(BOARD_WINDOW, PAD_EVENT, { path, text: JSON.stringify(message) } satisfies PadToWindow).catch(() => undefined);

const stopServing = () => {
  if (!served) return;
  served.unsubscribe();
  if (served.timer !== null) window.clearTimeout(served.timer);
  served.handle.release();
  served = null;
};

/** Holds the board at `path` for the board window, with nothing told of it yet. */
const serve = (path: string) => {
  if (served && fileKey(served.path) === fileKey(path)) {
    served.sent = newSent();
    return served;
  }
  stopServing();
  const handle = holdBoard(path);
  const now: Served = { path, handle, sent: newSent(), unsubscribe: () => undefined, timer: null };
  // The board window is brought up to the board a moment after it changed: a line being drawn changes it every frame.
  now.unsubscribe = handle.source.subscribe(() => {
    if (now.timer !== null) return;
    now.timer = window.setTimeout(() => {
      now.timer = null;
      if (served === now) changes(now.sent, handle.source.elements(), handle.source.assets()).forEach((message) => sendPad(now.path, message));
    }, 16);
  });
  served = now;
  return now;
};

/** Shows the board window with the board at `path`, making the window the first time. */
export const showBoardWindow = async (path: string, focus = true) => {
  pairError = "";
  boardWindow.set({ path });
  tellInfo();
  await invoke("board_window_open", { focus });
};

/** Hides the board window; the board it showed is let go. */
export const hideBoardWindow = () => {
  if (!inAppWindow) return;
  forget();
  void invoke("board_window_hide").catch(() => undefined);
};

/** The board window shows nothing any more. */
const forget = () => {
  boardWindow.set({ path: null });
  stopServing();
  tellInfo();
};

const same = (a: string | null, b: string) => a !== null && fileKey(a) === fileKey(b);

const heardFromWindow = (message: FromWindow) => {
  switch (message.kind) {
    case "ready": tellInfo(); break;
    case "hello": {
      if (!same(boardWindow.get().path, message.path)) break;
      const now = serve(message.path);
      const { source } = now.handle;
      sendPad(now.path, fullState(now.sent, message.path.split("/").pop() ?? message.path, source.elements()));
      changes(now.sent, source.elements(), source.assets()).forEach((change) => sendPad(now.path, change));
      break;
    }
    case "pad": {
      if (!served || !same(served.path, message.path)) break;
      const change = readFromPad(message.text);
      if (!change || change.t === "hello") break;
      const { source } = served.handle;
      // What the board window did it already has: counted as told before the change is heard back.
      heard(served.sent, change);
      if (change.t === "asset") source.putAsset(change.id, change.data);
      else if (change.t === "pts") source.extend(change.id, change.pts);
      else source.commit(applyChange(source.elements(), change));
      break;
    }
    case "bye": if (served && same(served.path, message.path)) stopServing(); break;
    case "open": actions.open(message.path); break;
    case "new": actions.create(); break;
    case "dock": actions.dock(); break;
    case "pair":
      pairError = "";
      tellInfo();
      pairBoard(message.path).catch((error) => { pairError = errorMessage(error); tellInfo(); });
      break;
    case "away": void reachFromOutside(message.path); break;
    case "unpair": unpairBoard(message.path); break;
  }
};

/** Only the app window serves the board window; every window loads this module (main.tsx imports the app). */
const inAppWindow = (() => {
  try { return IS_TAURI && getCurrentWebviewWindow().label === "main"; } catch { return false; }
})();

if (inAppWindow) {
  // Heard only when sent to this window: a plain `listen` hears what is sent to any window.
  const here = getCurrentWebviewWindow();
  void here.listen<FromWindow>(FROM_WINDOW_EVENT, ({ payload }) => { if (payload && typeof payload === "object") heardFromWindow(payload); });
  // Hidden by its own button, the system's close, or Ctrl+W there.
  void here.listen("board-window-hidden", () => { if (boardWindow.get().path !== null) forget(); });
  // Everything the board window shows around its board follows this window's.
  let known = { boards: workspace.get().workspaceBoards, folder: workspace.get().workspacePath };
  workspace.subscribe(() => {
    const { workspaceBoards: boards, workspacePath: folder } = workspace.get();
    if (boards === known.boards && folder === known.folder) return;
    known = { boards, folder };
    const path = boardWindow.get().path;
    // A board that is gone — deleted here or by a teammate, or with its folder — is not shown any more.
    if (path !== null && !workspace.get().workspaceBoards.some((board) => fileKey(board) === fileKey(path))) hideBoardWindow();
    else tellInfo();
  });
  collab.subscribe(tellInfo);
  pairings.subscribe(tellInfo);
}
