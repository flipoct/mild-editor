import { VerdictBadge } from "./VerdictBadge";
import { memo, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { buildExplorerTree, mergeExplorerFiles, sortExplorerFiles, useExplorerFiles } from "./explorerFiles";
import { explorerBasename, explorerParent, fileKey, normalizedExplorerPath } from "./fileNaming";
import { useLatest } from "./hooks";
import type { Translate } from "./i18n";
import { Icon, LanguageIcon } from "./icons";
import { errorMessage, isMac, modLabel } from "./platform";
import { canMoveInto } from "./problems";
import { getSetting, setSetting, useSetting } from "./settingsStore";
import { createStore } from "./store";
import type { ExplorerDropTarget, ExplorerFile, ExplorerMenu, ExplorerRename, ExplorerSelection, ExplorerSort, ExplorerTreeNode, ProblemSource } from "./types";
import { createWorkspaceFolder, deleteWorkspaceFolder, expandDirectories, refreshDirectories, relocateWorkspaceFolder, reorderWorkspaceFiles, rescanWorkspace, revealWorkspaceFile, revealWorkspaceFolder, setExplorerSelection, toggleDirectory, useCollapsedDirectories, useSavedFiles, useWorkspaceDirectories, useWorkspacePath, workspace, type RelocatedFolder } from "./workspaceStore";

type ExplorerEntry = NonNullable<ExplorerSelection>;

/** The four things the file menu offers that are the app's to do: each opens one of its dialogs, or makes a tab. */
export type ExplorerFileCommand = "importTests" | "duplicate" | "setSource" | "delete";

/**
 * What the explorer needs from the app around it. The workspace itself is not here: the
 * panel reads that in the workspace store. These are the open tabs, which only the app has,
 * and what a change in the explorer means for them. Every callback has to keep its identity
 * from one render of the app to the next, or the panel is redrawn with each keystroke.
 */
export type ExplorerProps = {
  t: Translate;
  /** The open tabs as rows, in tab order: an unsaved one is listed, and a row shows its tab's number. */
  openFiles: ExplorerFile[];
  /** The file in the editor, whose row is marked. */
  activeFilename: string;
  /** Opens the file as a tab, or brings its tab to the front. */
  openFile: (filename: string) => void;
  /** Asks for the name of a new file in `parentDirectory`; creating it makes a tab, so the dialog is the app's. */
  newFile: (parentDirectory: string) => void;
  /**
   * Renames or moves a file (`requested` is its new workspace path) and takes its tab and
   * its contest entry along. Resolves to the name it settled on, or null when nothing was renamed.
   */
  renameFile: (filename: string, requested: string) => Promise<string | null>;
  fileCommand: (command: ExplorerFileCommand, filename: string) => void;
  /** A folder was renamed or moved: the tabs of its files and the contest board have to follow. */
  onFolderRelocated: (moved: RelocatedFolder) => void;
  /** A folder was deleted with these files (file keys) in it: their tabs have to close. */
  onFilesDeleted: (removedKeys: Set<string>) => void;
  showStatus: (message: string) => void;
};

/**
 * What the menu bar, the command palette and the keyboard reach the explorer through:
 * none of them has a pointer, so they act on the row that is selected.
 */
export type ExplorerHandle = {
  /** Directory a new entry is created in: the selected folder, or the selected file's own. */
  creationParent: () => string;
  newFolder: () => void;
  renameSelection: () => void;
  revealSelection: () => void;
  deleteSelection: () => void;
  /** Enter in the dialog that asks whether to delete a folder, and in the one that names a new one. */
  confirmDeleteFolder: () => void;
  confirmNewFolder: () => void;
};

type ExplorerDrag = { entry: ExplorerEntry; label: string; x: number; y: number; target: ExplorerDropTarget | null };

/**
 * Which of the explorer's floating pieces is up. They are in a store rather than in the
 * panel's own state for three reasons. They are drawn in the app shell, not in the panel
 * (`position: fixed` must not be caught by a panel, and the dialogs have to work while the
 * panel is hidden: the menu bar and the palette open them too). The rows inside the panel
 * are what raise them. And the app's Escape and Enter handling ranks them among its own
 * dialogs, so it has to see which are open. What only one piece needs stays in that piece:
 * the name being typed, the menu's corrected position, the bookkeeping of a drag.
 */
type ExplorerOverlays = {
  menu: ExplorerMenu | null;
  /** Explorer row whose name is being edited in place. */
  rename: ExplorerRename | null;
  /** The entry the "move to…" dialog is asking about. */
  moveEntry: ExplorerEntry | null;
  deleteDirectory: string | null;
  /** The new-folder dialog; a new object each time it is opened, so it starts with an empty name. */
  newFolder: { parent: string } | null;
  drag: ExplorerDrag | null;
};

const overlays = createStore<ExplorerOverlays>({ menu: null, rename: null, moveEntry: null, deleteDirectory: null, newFolder: null, drag: null });

/** Which overlays are open, for the app's Escape and Enter handlers. */
export const useExplorerOverlays = () => ({
  menu: overlays.use((state) => state.menu !== null),
  rename: overlays.use((state) => state.rename !== null),
  moveEntry: overlays.use((state) => state.moveEntry !== null),
  deleteDirectory: overlays.use((state) => state.deleteDirectory !== null),
  newFolder: overlays.use((state) => state.newFolder !== null),
});

export const dismissExplorerOverlay = (overlay: "menu" | "rename" | "moveEntry" | "deleteDirectory" | "newFolder") =>
  overlays.set({ [overlay]: null });

const closeMenu = () => overlays.set({ menu: null });

// The macOS menu bar has no pointer context, so it acts on the Explorer row that
// was last focused or right-clicked. Both lookups re-resolve against live state so
// a deleted or renamed entry stops being a target on its own.
const selectedEntry = (openFiles: ExplorerFile[]): { file?: string; directory?: string } => {
  const { explorerSelection: selection, workspacePath, savedFiles, workspaceDirectories } = workspace.get();
  if (selection?.kind === "directory") return workspaceDirectories.some((directory) => fileKey(directory) === fileKey(selection.path)) ? { directory: selection.path } : {};
  if (selection?.kind !== "file") return {};
  // Only a row the explorer is showing counts, so the source filter applies here as well.
  const source = getSetting("explorerSource");
  const file = mergeExplorerFiles<ExplorerFile>(Boolean(workspacePath), savedFiles, openFiles)
    .find((item) => fileKey(item.filename) === fileKey(selection.filename) && (source === "all" || (item.source || "other") === source));
  return file ? { file: file.filename } : {};
};

/** Directory a new entry is created in: the selected folder, or the selected file's own. */
const creationParent = (openFiles: ExplorerFile[]) => {
  const selected = selectedEntry(openFiles);
  return selected.directory ?? (selected.file ? explorerParent(selected.file) : "");
};

const beginFolderCreation = (parentDirectory = "") =>
  overlays.set({ menu: null, newFolder: { parent: normalizedExplorerPath(parentDirectory) } });

const beginRename = (target: ExplorerRename) => {
  if (!workspace.get().workspacePath) return;
  overlays.set({ menu: null, rename: target });
};

const renameSelection = (openFiles: ExplorerFile[]) => {
  if (overlays.get().rename) return;
  const selected = selectedEntry(openFiles);
  if (selected.directory) beginRename({ kind: "directory", path: selected.directory });
  else if (selected.file) beginRename({ kind: "file", filename: selected.file });
};

const deleteSelection = ({ openFiles, fileCommand }: ExplorerProps) => {
  if (!workspace.get().workspacePath) return;
  closeMenu();
  const selected = selectedEntry(openFiles);
  if (selected.directory) overlays.set({ deleteDirectory: selected.directory });
  else if (selected.file) fileCommand("delete", selected.file);
};

const revealFile = ({ showStatus }: ExplorerProps, filename: string) =>
  void revealWorkspaceFile(filename).catch((error) => showStatus(errorMessage(error)));

const revealFolder = ({ showStatus }: ExplorerProps, directory: string) =>
  void revealWorkspaceFolder(directory).catch((error) => showStatus(errorMessage(error)));

const revealSelection = (host: ExplorerProps) => {
  if (!workspace.get().workspacePath) return;
  closeMenu();
  const selected = selectedEntry(host.openFiles);
  if (selected.directory) revealFolder(host, selected.directory);
  else if (selected.file) revealFile(host, selected.file);
};

/** Rename and move share this: `request` tells the backend which of the two it is. */
const relocateFolder = async (host: ExplorerProps, directory: string, command: "rename_workspace_folder" | "move_workspace_folder", request: Record<string, string>) => {
  try {
    const moved = await relocateWorkspaceFolder(directory, command, request);
    if (!moved) return;
    host.onFolderRelocated(moved);
    await refreshDirectories(host.showStatus);
    host.showStatus("saved");
  } catch (error) {
    host.showStatus(errorMessage(error));
  }
};

/** Moves a file or a folder into `targetDirectory` ("" is the workspace root). */
const moveEntry = async (host: ExplorerProps, entry: ExplorerEntry, targetDirectory: string): Promise<string | null> => {
  if (!workspace.get().workspacePath) return null;
  const target = normalizedExplorerPath(targetDirectory);
  if (!canMoveInto(entry, target)) return null;
  if (entry.kind === "directory") {
    await relocateFolder(host, entry.path, "move_workspace_folder", { targetDirectory: target });
    return null;
  }
  const basename = explorerBasename(entry.filename);
  const moved = await host.renameFile(entry.filename, target ? `${target}/${basename}` : basename);
  await refreshDirectories(host.showStatus);
  return moved;
};

/**
 * Writes the order of one folder's files, exactly as the explorer is showing them.
 * Dropping between rows while another sort is chosen switches to the hand-arranged one:
 * otherwise the drop would appear to do nothing, the rows snapping back to where the
 * chosen sort wants them.
 */
const reorderFiles = async (host: ExplorerProps, directory: string, filenames: string[]) => {
  try {
    if (!(await reorderWorkspaceFiles(directory, filenames))) return;
    if (getSetting("explorerSort") !== "custom") {
      setSetting("explorerSort", "custom");
      host.showStatus(host.t("customOrderSet"));
    }
  } catch (error) {
    host.showStatus(errorMessage(error));
    void rescanWorkspace(host.showStatus);
  }
};

/**
 * What the pointer is over. A file row is split: its middle two thirds drop the dragged
 * row into the folder that file lives in, and the quarters at its top and bottom are the
 * slots either side of it, which is what arranges files by hand. A folder row and the
 * empty space below the tree only ever mean "into", so a drag that is simply moving a
 * file across the tree never has to aim.
 */
const dropTargetAt = (x: number, y: number, entry: ExplorerEntry): ExplorerDropTarget | null => {
  const host = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-directory]");
  if (!host) return null;
  const directory = host.dataset.dropDirectory ?? "";
  const slot = host.dataset.fileSlot;
  if (slot !== undefined && entry.kind === "file") {
    const box = host.getBoundingClientRect();
    const edge = box.height / 4;
    const after = y > box.bottom - edge;
    if (after || y < box.top + edge) {
      return {
        kind: "between",
        directory,
        index: Number(slot) + (after ? 1 : 0),
        line: { x: box.left, width: box.width, y: after ? box.bottom : box.top },
      };
    }
  }
  return canMoveInto(entry, directory) ? { kind: "into", directory } : null;
};

// Rows focus themselves on click: WebKit leaves buttons unfocused after a mouse
// click, which would otherwise keep every Explorer shortcut from ever applying on
// macOS. The row's own element is swapped for an input, VS Code style. The input sits
// outside `.explorer-file` / `.explorer-directory` on purpose: the key handler
// only treats those as Explorer rows, so Return and Cmd+Backspace stay
// ordinary text editing while the name is being typed.
function RenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  return <input
    className="explorer-rename-input"
    value={value}
    autoFocus
    spellCheck={false}
    aria-label="new name"
    onFocus={(event) => event.currentTarget.select()}
    onChange={(event) => setValue(event.target.value)}
    onKeyDown={(event) => {
      // An IME ends its composition with Enter; committing on that keystroke would
      // rename to the half-typed Hangul or kana. keyCode 229 is the legacy signal.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); onCommit(value); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
    }}
    onBlur={() => onCommit(value)}
  />;
}

/**
 * The inside of the explorer panel: the folder's name and buttons, the sort and filter,
 * and the tree. It follows the workspace store itself and is memoised, so it is drawn again
 * when the files, the folders or the open tabs' names change, and not when code is typed.
 */
export const Explorer = memo(function Explorer(props: ExplorerProps) {
  const { t, openFiles, activeFilename, openFile, newFile, showStatus } = props;
  const hostRef = useLatest(props);
  const workspacePath = useWorkspacePath();
  const savedFiles = useSavedFiles();
  const workspaceDirectories = useWorkspaceDirectories();
  const collapsedDirectories = useCollapsedDirectories();
  const [explorerSort, setExplorerSort] = useSetting("explorerSort");
  const [explorerSource, setExplorerSource] = useSetting("explorerSource");
  const rename = overlays.use((state) => state.rename);
  /** The folder a drag would drop into ("" is the workspace root); undefined while there is none. */
  const dragInto = overlays.use((state) => state.drag?.target?.kind === "into" ? state.drag.target.directory : undefined);

  // A save hands back a new list of new objects; the rows it describes are usually the same.
  const savedRows = useExplorerFiles(savedFiles, explorerSort === "modified");
  const allFiles = useMemo(() => mergeExplorerFiles(Boolean(workspacePath), savedRows, openFiles), [savedRows, openFiles, workspacePath]);
  const explorerFiles = useMemo(
    () => sortExplorerFiles(explorerSource === "all" ? allFiles : allFiles.filter((file) => (file.source || "other") === explorerSource), explorerSort),
    [explorerSort, explorerSource, allFiles]);
  const explorerTree = useMemo(() => buildExplorerTree(explorerFiles, workspaceDirectories), [explorerFiles, workspaceDirectories]);
  /** File key → place in the tab strip, for the number a row shows. */
  const openIndexes = useMemo(() => {
    const indexes = new Map<string, number>();
    openFiles.forEach((file, index) => { const key = fileKey(file.filename); if (!indexes.has(key)) indexes.set(key, index); });
    return indexes;
  }, [openFiles]);

  /**
   * A row dropped between two others: `index` is the slot it takes among the files the
   * target folder shows. One arriving from another folder is moved there first, and the
   * folder's whole order is then written so it keeps the slot it was dropped into.
   */
  const placeFile = async (filename: string, directory: string, index: number) => {
    if (!workspacePath) return;
    // Every file of the folder, not just the ones on screen: a source filter hides some,
    // and leaving them out of the arrangement would throw away the places they had.
    const siblings = sortExplorerFiles(allFiles.filter((file) => fileKey(explorerParent(file.filename)) === fileKey(directory)), explorerSort);
    let placed = filename;
    if (fileKey(explorerParent(filename)) !== fileKey(directory)) {
      // The move reports the name it settled on, which is not the one asked for when the
      // folder already had a file by that name.
      const moved = await moveEntry(props, { kind: "file", filename }, directory);
      if (!moved) return;
      placed = moved;
    }
    const rest = siblings.map((file) => file.filename).filter((name) => fileKey(name) !== fileKey(filename) && fileKey(name) !== fileKey(placed));
    const at = Math.max(0, Math.min(rest.length, index));
    await reorderFiles(props, directory, [...rest.slice(0, at), placed, ...rest.slice(at)]);
  };
  const placeFileRef = useLatest(placeFile);

  // Dragging a row onto a folder moves it there. Pointer events, as for the panels and the
  // tabs: every row names the folder a drop on it goes to in `data-drop-directory`.
  const dragRef = useRef<{ entry: ExplorerEntry; label: string; startX: number; startY: number; active: boolean; target: ExplorerDropTarget | null } | null>(null);
  /** Set for the click that ends a drag, so dropping a row does not also open or fold it. */
  const dragClickRef = useRef(false);
  const beginDrag = (entry: ExplorerEntry, label: string, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !workspacePath) return;
    dragRef.current = { entry, label, startX: event.clientX, startY: event.clientY, active: false, target: null };
  };
  useEffect(() => {
    const track = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
        drag.active = true;
      }
      drag.target = dropTargetAt(event.clientX, event.clientY, drag.entry);
      overlays.set({ drag: { entry: drag.entry, label: drag.label, x: event.clientX, y: event.clientY, target: drag.target } });
    };
    const finish = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag?.active) return;
      overlays.set({ drag: null });
      dragClickRef.current = true;
      window.setTimeout(() => { dragClickRef.current = false; }, 0);
      if (event.type !== "pointerup" || !drag.target) return;
      if (drag.target.kind === "between" && drag.entry.kind === "file") void placeFileRef.current(drag.entry.filename, drag.target.directory, drag.target.index);
      else void moveEntry(hostRef.current, drag.entry, drag.target.directory);
    };
    window.addEventListener("pointermove", track);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("keydown", finish, true);
    return () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("keydown", finish, true);
      // The panel was hidden in the middle of a drag: nothing is left to drop on.
      dragRef.current = null;
      overlays.set({ drag: null });
    };
  }, []);
  // A folded folder opens when a drag rests on it, so the drop can go deeper.
  useEffect(() => {
    if (!dragInto || !collapsedDirectories.has(fileKey(dragInto))) return;
    const timer = window.setTimeout(() => expandDirectories(dragInto), 650);
    return () => window.clearTimeout(timer);
  }, [dragInto]);

  // These belong to the Explorer, so they stay behind a focus check:
  // Return and Cmd+Backspace have to keep their editing meaning inside the editor.
  useEffect(() => {
    const handleRowShortcut = (event: KeyboardEvent) => {
      const explorerRowFocused = document.activeElement instanceof Element && Boolean(document.activeElement.closest(".explorer-file, .explorer-directory"));
      if (!explorerRowFocused || !workspace.get().workspacePath) return;
      const host = hostRef.current;
      const renaming = Boolean(overlays.get().rename);
      // Finder renames with Return; Windows and Linux keep F2.
      const renameRequested = event.key === "F2" || (isMac && event.key === "Enter");
      const selected = selectedEntry(host.openFiles);
      if (renameRequested && !event.ctrlKey && !event.metaKey && !event.altKey && (selected.file || selected.directory) && !renaming) {
        event.preventDefault();
        renameSelection(host.openFiles);
      }
      // Finder deletes with Cmd+Backspace; Windows and Linux use Delete. Both ask first.
      if ((isMac && event.metaKey && !event.altKey && event.key === "Backspace") || (!isMac && !event.ctrlKey && !event.altKey && event.key === "Delete" && !renaming)) {
        event.preventDefault();
        deleteSelection(host);
      }
    };
    window.addEventListener("keydown", handleRowShortcut);
    return () => window.removeEventListener("keydown", handleRowShortcut);
  }, []);

  const commitRename = async (target: ExplorerRename, value: string) => {
    // Only the rename still on show can be committed. One that was committed or cancelled
    // is gone from the store before its input is, so the blur that follows the input
    // unmounting cannot commit it a second time.
    if (overlays.get().rename !== target) return;
    overlays.set({ rename: null });
    const typed = value.trim();
    if (!typed || /[\\/]/.test(typed)) return;
    if (target.kind === "directory") {
      if (typed !== explorerBasename(target.path)) await relocateFolder(props, target.path, "rename_workspace_folder", { newName: typed });
      return;
    }
    const parent = explorerParent(target.filename);
    await props.renameFile(target.filename, parent ? `${parent}/${typed}` : typed);
  };
  const renameInput = (target: ExplorerRename) => <RenameInput
    initial={explorerBasename(target.kind === "file" ? target.filename : target.path)}
    onCommit={(value) => void commitRename(target, value)}
    onCancel={() => dismissExplorerOverlay("rename")}
  />;
  const renamingDirectory = (path: string) => rename?.kind === "directory" && fileKey(rename.path) === fileKey(path);
  const renamingFile = (filename: string) => rename?.kind === "file" && fileKey(rename.filename) === fileKey(filename);

  const renderExplorerTree = (nodes: ExplorerTreeNode[], depth = 0): ReactNode[] => {
    // `nodes` is one folder's children, so a file's position among them is its slot there.
    const siblingSlots = new Map(nodes.filter((node) => node.kind === "file").map((node, slot) => [node.file.id, slot]));
    return nodes.flatMap((node) => {
    if (node.kind === "directory") {
      const collapsed = collapsedDirectories.has(fileKey(node.path));
      if (rename && renamingDirectory(node.path)) {
        return [<div className="explorer-tree-branch" key={`directory-${node.path}`}>
          <div className="explorer-rename-row explorer-directory-rename" style={{ paddingLeft: `${10 + depth * 14}px` }}>
            <Icon name="chevronRight" size={12} className={`explorer-directory-chevron ${collapsed ? "" : "open"}`} /><Icon name={collapsed ? "folder" : "folderOpen"} size={14} />{renameInput(rename)}
          </div>
          {!collapsed && <div className="explorer-tree-children">{renderExplorerTree(node.children, depth + 1)}</div>}
        </div>];
      }
      return [<div className="explorer-tree-branch" key={`directory-${node.path}`}>
        <button className={`explorer-directory ${dragInto !== undefined && fileKey(dragInto) === fileKey(node.path) ? "drop-target" : ""}`} data-drop-directory={node.path} onPointerDown={(event) => beginDrag({ kind: "directory", path: node.path }, node.name, event)} style={{ paddingLeft: `${10 + depth * 14}px` }} title={node.path} onClick={(event) => { if (dragClickRef.current) return; event.currentTarget.focus(); setExplorerSelection({ kind: "directory", path: node.path }); toggleDirectory(node.path); }} onFocus={() => setExplorerSelection({ kind: "directory", path: node.path })} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); setExplorerSelection({ kind: "directory", path: node.path }); overlays.set({ menu: { directory: node.path, x: event.clientX, y: event.clientY } }); }}>
          <Icon name="chevronRight" size={12} className={`explorer-directory-chevron ${collapsed ? "" : "open"}`} /><Icon name={collapsed ? "folder" : "folderOpen"} size={14} /><span>{node.name}</span>
        </button>
        {!collapsed && <div className="explorer-tree-children">{renderExplorerTree(node.children, depth + 1)}</div>}
      </div>];
    }
    const tab = node.file;
    const openIndex = openIndexes.get(fileKey(tab.filename)) ?? -1;
    if (rename && renamingFile(tab.filename)) {
      return [<div className="explorer-file-row" key={tab.id}>
        <div className="explorer-rename-row" style={{ paddingLeft: `${14 + depth * 14}px` }}><LanguageIcon language={tab.language} />{renameInput(rename)}</div>
      </div>];
    }
    return [<div className="explorer-file-row" key={tab.id}>
      <button className={`explorer-file ${fileKey(tab.filename) === fileKey(activeFilename) ? "active" : ""}`} data-drop-directory={explorerParent(tab.filename)} data-file-slot={siblingSlots.get(tab.id)} onPointerDown={(event) => beginDrag({ kind: "file", filename: tab.filename }, explorerBasename(tab.filename), event)} style={{ paddingLeft: `${14 + depth * 14}px` }} onClick={(event) => { if (dragClickRef.current) return; event.currentTarget.focus(); openFile(tab.filename); }} onFocus={() => setExplorerSelection({ kind: "file", filename: tab.filename })} onContextMenu={(event) => { if (!workspacePath) return; event.preventDefault(); event.stopPropagation(); setExplorerSelection({ kind: "file", filename: tab.filename }); overlays.set({ menu: { file: tab.filename, x: event.clientX, y: event.clientY } }); }} title={`${tab.filename}${openIndex >= 0 && openIndex < 9 ? ` (${modLabel}${openIndex + 1})` : ""}`}>
        <LanguageIcon language={tab.language} />
        <span className="explorer-file-name">{explorerBasename(tab.filename)}</span>
        {tab.judgeStatus && <VerdictBadge status={tab.judgeStatus} title={tab.submissionUrl} />}
        {openIndex >= 0 && openIndex < 9 && <kbd>{openIndex + 1}</kbd>}
      </button>
    </div>];
    });
  };

  return <>
    <div className="explorer-folder" title={workspacePath || "Save the contest to create a folder"}>
      <span className="explorer-folder-name">{workspacePath ? workspacePath.split(/[\\/]/).filter(Boolean).at(-1) : t("unsavedWorkspace")}</span>
      <span className="explorer-header-actions">
        <button onClick={() => newFile("")} title={t("newFile")} aria-label={t("newFile")}><Icon name="filePlus" /></button>
        <button onClick={() => beginFolderCreation()} title={t("newFolder")} aria-label={t("newFolder")}><Icon name="folderPlus" /></button>
        {workspacePath && <button onClick={() => void rescanWorkspace(showStatus, t("explorerRescanned"))} title={t("explorerRefresh")} aria-label={t("explorerRefresh")}><Icon name="refresh" /></button>}
      </span>
    </div>
    <div className="explorer-controls">
      <label title="sort files"><span>{t("sort")}</span><select value={explorerSort} onChange={(event) => setExplorerSort(event.target.value as ExplorerSort)} aria-label="Explorer sort order"><option value="modified">{t("latestModified")}</option><option value="problem">{t("problemNumber")}</option><option value="name">{t("name")}</option><option value="custom">{t("customOrder")}</option></select></label>
      <label title="filter by source"><span>{t("show")}</span><select value={explorerSource} onChange={(event) => setExplorerSource(event.target.value as ProblemSource | "all")} aria-label="Explorer source filter"><option value="all">{t("allSources")}</option><option value="atcoder">AtCoder</option><option value="codeforces">Codeforces</option><option value="doj">DOJ</option><option value="other">{t("local")}</option></select></label>
    </div>
    <div className={`explorer-files ${dragInto === "" ? "drop-target" : ""}`} data-drop-directory="" onContextMenu={(event) => {
      if (!workspacePath || (event.target instanceof Element && event.target.closest(".explorer-file, .explorer-metadata"))) return;
      event.preventDefault();
      overlays.set({ menu: { x: event.clientX, y: event.clientY } });
    }}>
      {!explorerFiles.length && !workspaceDirectories.length && <div className="explorer-empty">{t("noFiles")}</div>}
      {renderExplorerTree(explorerTree)}
      {workspacePath && <div className="explorer-metadata"><Icon name="braces" size={14} className="file-icon json" /><span>.mild-editor.json</span></div>}
    </div>
  </>;
});

/** The menu a right-click in the explorer opens: on a file, on a folder, or on the empty space below the tree. */
export const ExplorerContextMenu = memo(function ExplorerContextMenu(props: ExplorerProps) {
  const { t, newFile, fileCommand } = props;
  const menu = overlays.use((state) => state.menu);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<{ menu: ExplorerMenu; x: number; y: number } | null>(null);
  // The menu opens at the pointer, which near the right or bottom edge would push
  // part of it off screen. Measured after layout, before paint, and kept beside the
  // menu it was measured for so a re-render cannot undo the correction.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element || !menu) return;
    const { width, height } = element.getBoundingClientRect();
    const margin = 6;
    let { x, y } = menu;
    // Until it settles: a menu folded back from one edge is checked again where it landed.
    for (;;) {
      const nextX = x + width + margin > window.innerWidth ? Math.max(margin, x - width) : x;
      const nextY = y + height + margin > window.innerHeight ? Math.max(margin, y - height) : y;
      if (nextX === x && nextY === y) break;
      x = nextX;
      y = nextY;
    }
    if (x !== menu.x || y !== menu.y) setPlaced({ menu, x, y });
  }, [menu]);
  if (!menu) return null;
  const { x, y } = placed?.menu === menu ? placed : menu;
  const { file, directory } = menu;
  const command = (name: ExplorerFileCommand, filename: string) => { fileCommand(name, filename); closeMenu(); };
  return <div className="explorer-context-menu" ref={menuRef} style={{ left: x, top: y }} role="menu">
    {file ? <>
      <button role="menuitem" onClick={() => { closeMenu(); newFile(explorerParent(file)); }}>{t("newFile")}</button>
      <button role="menuitem" onClick={() => beginFolderCreation(explorerParent(file))}>{t("newFolder")}</button>
      <div className="explorer-menu-separator" />
      <button role="menuitem" onClick={() => command("importTests", file)}>{t("menuImportTests")}</button>
      <button role="menuitem" onClick={() => { revealFile(props, file); closeMenu(); }}>{t("menuOpenFileLocation")}</button>
      <button role="menuitem" onClick={() => command("duplicate", file)}>{t("menuDuplicate")}</button>
      <button role="menuitem" onClick={() => command("setSource", file)}>{t("menuSetSource")}</button>
      <button role="menuitem" onClick={() => beginRename({ kind: "file", filename: file })}>{t("menuRename")}</button>
      <button role="menuitem" onClick={() => overlays.set({ moveEntry: { kind: "file", filename: file }, menu: null })}>{t("moveTo")}</button>
      <button className="menu-danger" role="menuitem" onClick={() => command("delete", file)}>{t("menuDelete")}</button>
    </> : directory ? <>
      <button role="menuitem" onClick={() => { closeMenu(); newFile(directory); }}>{t("newFile")}</button>
      <button role="menuitem" onClick={() => beginFolderCreation(directory)}>{t("newFolder")}</button>
      <div className="explorer-menu-separator" />
      <button role="menuitem" onClick={() => { revealFolder(props, directory); closeMenu(); }}>{t("menuOpenFolderLocation")}</button>
      <button role="menuitem" onClick={() => beginRename({ kind: "directory", path: directory })}>{t("menuRename")}</button>
      <button role="menuitem" onClick={() => overlays.set({ moveEntry: { kind: "directory", path: directory }, menu: null })}>{t("moveTo")}</button>
      <button className="menu-danger" role="menuitem" onClick={() => overlays.set({ deleteDirectory: directory, menu: null })}>{t("menuDelete")}</button>
    </> : <>
      <button role="menuitem" onClick={() => { closeMenu(); newFile(""); }}>{t("newFile")}</button>
      <button role="menuitem" onClick={() => beginFolderCreation()}>{t("newFolder")}</button>
    </>}
  </div>;
});

/**
 * What a drag shows while it is under way, and the explorer's own dialogs: "move to…",
 * deleting a folder, naming a new one. Always mounted, unlike the panel, and so also the
 * one that answers the menu bar, the palette and the keyboard (`ref`).
 */
export const ExplorerDialogs = memo(function ExplorerDialogs({ ref, ...props }: ExplorerProps & { ref?: Ref<ExplorerHandle> }) {
  const { t, showStatus } = props;
  const drag = overlays.use((state) => state.drag);
  const moving = overlays.use((state) => state.moveEntry);
  const deleteDirectory = overlays.use((state) => state.deleteDirectory);
  const newFolder = overlays.use((state) => state.newFolder);
  const workspaceDirectories = useWorkspaceDirectories();
  // The name being typed belongs to the dialog it was typed in: opening the dialog again starts from nothing.
  const [folderDraft, setFolderDraft] = useState<{ dialog: object; name: string } | null>(null);
  const folderName = newFolder && folderDraft?.dialog === newFolder ? folderDraft.name : "";

  const createFolder = async () => {
    if (!newFolder || !workspace.get().workspacePath || !folderName.trim()) return;
    try {
      await createWorkspaceFolder(folderName, newFolder.parent);
      dismissExplorerOverlay("newFolder");
      await refreshDirectories(showStatus);
      showStatus("saved");
    } catch (error) {
      showStatus(errorMessage(error));
    }
  };

  const deleteFolder = async () => {
    if (!deleteDirectory) return;
    try {
      const removedKeys = await deleteWorkspaceFolder(deleteDirectory);
      if (!removedKeys) return;
      props.onFilesDeleted(removedKeys);
      dismissExplorerOverlay("deleteDirectory");
      await refreshDirectories(showStatus);
      showStatus("saved");
    } catch (error) {
      showStatus(errorMessage(error));
    }
  };

  // The handle is made once and reads this render's props and dialogs when it is used.
  const latest = useLatest({ props, createFolder, deleteFolder });
  useImperativeHandle(ref, () => ({
    creationParent: () => creationParent(latest.current.props.openFiles),
    newFolder: () => beginFolderCreation(creationParent(latest.current.props.openFiles)),
    renameSelection: () => renameSelection(latest.current.props.openFiles),
    revealSelection: () => revealSelection(latest.current.props),
    deleteSelection: () => deleteSelection(latest.current.props),
    confirmDeleteFolder: () => void latest.current.deleteFolder(),
    confirmNewFolder: () => void latest.current.createFolder(),
  }), [latest]);

  return <>
    {drag?.target?.kind === "between" && <div className="explorer-drop-line" style={{ left: drag.target.line.x, top: drag.target.line.y, width: drag.target.line.width }} />}
    {drag && <div className={`explorer-drag-ghost ${drag.target ? "ok" : ""}`} style={{ left: drag.x + 12, top: drag.y + 10 }}>{drag.label}{drag.target && <small>→ {drag.target.directory || t("contestWorkspaceRoot")}</small>}</div>}

    {moving && (() => {
      const targets = ["", ...workspaceDirectories].filter((directory) => canMoveInto(moving, directory)).sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
      return <div className="modal-backdrop close-confirm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) dismissExplorerOverlay("moveEntry"); }}>
        <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="move-entry-title">
          <h2 id="move-entry-title">{t("moveTitle")} {explorerBasename(moving.kind === "file" ? moving.filename : moving.path)}</h2>
          <p>{targets.length ? t("moveHelp") : t("moveNoTargets")}</p>
          <div className="move-folder-list">{targets.map((directory) => <button key={directory} onClick={() => { dismissExplorerOverlay("moveEntry"); void moveEntry(props, moving, directory); }} title={directory || t("contestWorkspaceRoot")}>
            <Icon name="folder" size={14} /><span>{directory || t("contestWorkspaceRoot")}</span>
          </button>)}</div>
          <footer className="settings-footer"><span className="footer-spacer" /><button className="subtle-button" onClick={() => dismissExplorerOverlay("moveEntry")}>{t("cancel")}</button></footer>
        </section>
      </div>;
    })()}

    {deleteDirectory && <ConfirmDialog id="delete-folder-confirm-title" eyebrow="delete folder" title={<>Delete {deleteDirectory}?</>} cancel={t("cancel")} onCancel={() => dismissExplorerOverlay("deleteDirectory")} actions={<><button className="danger-button" onClick={() => void deleteFolder()}>Delete folder</button></>}>
      <p>This permanently deletes the folder, every file inside it, and their saved test cases.</p>
    </ConfirmDialog>}

    {newFolder && <ConfirmDialog id="folder-name-title" eyebrow={t("newFolder")} title={<>Choose a folder name{newFolder.parent ? ` in ${newFolder.parent}` : ""}</>} cancel={t("cancel")} onCancel={() => dismissExplorerOverlay("newFolder")} actions={<><button className="primary-button" onClick={() => void createFolder()}>Create</button></>}>
      <input className="atcoder-url" value={folderName} onChange={(event) => setFolderDraft({ dialog: newFolder, name: event.target.value })} autoFocus spellCheck={false} />
    </ConfirmDialog>}
  </>;
});
