import type { PairingView } from "./pads";

/**
 * What the app window and the board window say to each other (windowLink.ts is the app
 * window's end, BoardWindow.tsx the board window's). Nothing here runs: both pages import it.
 */

export const BOARD_WINDOW = "board";
export const INFO_EVENT = "board-window-info";
export const PAD_EVENT = "board-window-pad";
export const FROM_WINDOW_EVENT = "board-window-from";

/** What the board window shows around its board. */
export type WindowInfo = {
  path: string | null;
  boards: string[];
  workspacePath: string | null;
  shared: boolean;
  pairing: PairingView | null;
  pairError: string;
};

export type FromWindow =
  | { kind: "ready" }
  /** The board window shows `path` and wants all of it. */
  | { kind: "hello"; path: string }
  | { kind: "pad"; path: string; text: string }
  /** It stopped showing `path`. */
  | { kind: "bye"; path: string }
  | { kind: "open"; path: string }
  | { kind: "new" }
  | { kind: "dock" }
  | { kind: "pair"; path: string }
  | { kind: "away"; path: string }
  | { kind: "unpair"; path: string };

export type PadToWindow = { path: string; text: string };
