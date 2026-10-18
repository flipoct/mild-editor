import { invoke } from "@tauri-apps/api/core";
import * as Y from "yjs";
import { collab, sharedBoard } from "../collab/collabStore";
import { fileKey } from "../fileNaming";
import { workspace } from "../workspaceStore";
import { BoardDoc } from "./boardDoc";
import type { BoardSource } from "./canvas";
import { parseBoard, serializeBoard, type Stroke } from "./model";

/**
 * The boards that are open — in the editor, or on a tablet — by workspace path. Whoever
 * draws on a board holds it (`holdBoard`) and lets go when done; a board nobody holds is put
 * away, its last strokes written first.
 *
 * A board in a shared room is drawn on in the room's document, and the room writes its file
 * (collabStore.ts). Any other board has a document of its own, read from its file and written
 * back a moment after each change. A board that enters or leaves a room while it is open
 * moves over to the other kind: the holders keep their handle and are told to draw again.
 */

const SAVE_DELAY = 600;

export type BoardHandle = {
  path: string;
  /** What a canvas draws and draws on. Always the board's current document. */
  source: BoardSource;
  /** Whether the board is in a room now. */
  shared: () => boolean;
  release: () => void;
};

type Open = {
  path: string;
  folder: string;
  holders: number;
  doc: BoardDoc;
  /** The board's own document, when it is not in a room. */
  own: Y.Doc | null;
  saving: number | null;
  listeners: Set<() => void>;
  unobserve: () => void;
};

const open = new Map<string, Open>();

const save = (board: Open) => {
  if (board.saving !== null) window.clearTimeout(board.saving);
  board.saving = null;
  if (!board.own) return;
  void invoke("write_workspace_board", { request: { folderPath: board.folder, filename: board.path, text: serializeBoard(board.doc.strokes()) } }).catch(() => undefined);
};

/** Points `board` at the document it is drawn on now: the room's, or one of its own read from the file. */
const attach = async (board: Open) => {
  const room = sharedBoard(board.path);
  // Out of a room, the board goes on from what the room had: its file may not be written yet.
  const carried = board.own ? null : board.doc.strokes();
  board.unobserve();
  if (board.saving !== null) save(board);
  board.doc.destroy();
  board.own?.destroy();
  board.own = null;
  if (room) {
    board.doc = new BoardDoc(room);
  } else {
    const own = new Y.Doc();
    board.own = own;
    board.doc = new BoardDoc(own.getMap("board"));
    if (carried) board.doc.replace(carried, "file");
    else {
      const text = await invoke<string>("read_workspace_board", { request: { folderPath: board.folder, filename: board.path } }).catch(() => "");
      // Something else may have happened to the board while its file was being read.
      if (board.own !== own) return;
      board.doc.replace(parseBoard(text), "file");
    }
  }
  const doc = board.doc;
  board.unobserve = doc.observe((origin) => {
    if (board.own && origin !== "file" && board.saving === null) board.saving = window.setTimeout(() => save(board), SAVE_DELAY);
    board.listeners.forEach((listener) => listener());
  });
  board.listeners.forEach((listener) => listener());
};

// A board entering or leaving a room is drawn on in the other document from then on.
let roomBoards = collab.get().boards;
collab.subscribe(() => {
  const next = collab.get().boards;
  if (next === roomBoards) return;
  const before = roomBoards;
  roomBoards = next;
  for (const board of open.values()) {
    const key = fileKey(board.path);
    if (before.has(key) !== next.has(key)) void attach(board);
  }
});

/** Holds the board at `path`, opening it if nobody has it open. */
export const holdBoard = (path: string): BoardHandle => {
  const folder = workspace.get().workspacePath ?? "";
  const key = `${folder}\n${fileKey(path)}`;
  let board = open.get(key);
  if (!board) {
    const placeholder = new Y.Doc();
    board = { path, folder, holders: 0, doc: new BoardDoc(placeholder.getMap("board")), own: placeholder, saving: null, listeners: new Set(), unobserve: () => undefined };
    open.set(key, board);
    void attach(board);
  }
  board.holders += 1;
  const held = board;
  let released = false;
  const source: BoardSource = {
    strokes: () => held.doc.strokes(),
    subscribe: (listener) => { held.listeners.add(listener); return () => { held.listeners.delete(listener); }; },
    begin: (stroke: Stroke) => held.doc.add(stroke),
    extend: (id, points) => held.doc.extend(id, points),
    end: () => undefined,
    erase: (ids) => held.doc.remove(ids),
  };
  return {
    path,
    source,
    shared: () => sharedBoard(held.path) !== null,
    release: () => {
      if (released) return;
      released = true;
      held.holders -= 1;
      if (held.holders > 0) return;
      open.delete(key);
      if (held.saving !== null) save(held);
      held.unobserve();
      held.doc.destroy();
      held.own?.destroy();
    },
  };
};

/** Clears a board, for everyone drawing on it. */
export const clearBoard = (handle: BoardHandle) => {
  const board = [...open.values()].find((item) => fileKey(item.path) === fileKey(handle.path));
  board?.doc.clear();
};
