import { useEffect, useState } from "react";
import { useCollab } from "../collab/collabStore";
import { fileKey } from "../fileNaming";
import type { Translate } from "../i18n";
import { errorMessage } from "../platform";
import { useWorkspacePath } from "../workspaceStore";
import { BoardPanel, type BoardConnection, type TabletLink } from "./BoardPanel";
import { holdBoard } from "./boardStore";
import { pairBoard, pairings, reachFromOutside, unpairBoard } from "./pads";

/** The tablet as the editor window offers it, for the board at `path`. */
export const useTabletLink = (path: string): TabletLink => {
  const view = pairings.use((state) => state[fileKey(path)] ?? null);
  const [error, setError] = useState("");
  useEffect(() => setError(""), [path]);
  return {
    view,
    error,
    start: () => { setError(""); pairBoard(path).catch((reason) => setError(errorMessage(reason))); },
    away: () => void reachFromOutside(path),
    stop: () => unpairBoard(path),
  };
};

const connectHere = (path: string): BoardConnection => {
  const handle = holdBoard(path);
  return { source: handle.source, release: handle.release };
};

/** A board over the editor, held by this window. */
export function BoardView({ t, path, themeKey, korean, boards, onOpen, onNew, onClose, onPopOut }: {
  t: Translate; path: string; themeKey: string; korean: boolean; boards: string[];
  onOpen: (path: string) => void; onNew: () => void; onClose: () => void;
  /** Moves the board into a window of its own; absent where there are no windows (a plain browser). */
  onPopOut?: () => void;
}) {
  const shared = useCollab((state) => state.boards.has(fileKey(path)));
  const workspacePath = useWorkspacePath();
  const tablet = useTabletLink(path);
  return <BoardPanel t={t} path={path} themeKey={themeKey} korean={korean} boards={boards} workspacePath={workspacePath}
    connect={connectHere} shared={shared} tablet={tablet} closeLabel={t("boardClose")}
    placement={onPopOut ? { label: t("boardPopOut"), icon: "upload", onToggle: onPopOut } : null}
    onOpen={onOpen} onNew={onNew} onClose={onClose} />;
}
