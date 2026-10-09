import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DEMO_MODE, demoTabs } from "./demo";
import { fileKey } from "./fileNaming";
import { errorMessage } from "./platform";
import { makeTab } from "./problems";
import { createStore } from "./store";
import type { ExplorerSelection, ProblemTab, WorkspaceFileResult } from "./types";

/**
 * The workspace as it is on disk, and the explorer's view of it. It lives outside the
 * components because more than one of them follows it — the explorer, its dialogs, the
 * contest board, the stress dialog, quick open — and none of them should redraw for a part
 * it does not show.
 *
 * `savedFiles` is the workspace file's list; a file that is open is also a tab, and the tab
 * is then the one copy of its code and tests. The functions below only touch this state and
 * the backend: what a change means for the open tabs is the caller's business, and each
 * returns what the caller needs to carry it over.
 */
type WorkspaceState = {
  workspacePath: string | null;
  savedFiles: ProblemTab[];
  workspaceDirectories: string[];
  /** File keys of the folded folders, remembered per workspace. */
  collapsedDirectories: Set<string>;
  explorerSelection: ExplorerSelection;
};

type Update<T> = T | ((current: T) => T);

const collapsedKey = (workspacePath: string) => `mild-collapsed-directories:${workspacePath}`;

const storedCollapsedDirectories = (workspacePath: string | null) => {
  if (!workspacePath) return new Set<string>();
  try {
    const stored = JSON.parse(localStorage.getItem(collapsedKey(workspacePath)) || "[]");
    return new Set<string>(Array.isArray(stored) ? stored.filter((path): path is string => typeof path === "string") : []);
  } catch { return new Set<string>(); }
};

const initialPath = DEMO_MODE !== null ? "C:/contests/september" : null;

export const workspace = createStore<WorkspaceState>({
  workspacePath: initialPath,
  savedFiles: demoTabs,
  workspaceDirectories: [],
  collapsedDirectories: storedCollapsedDirectories(initialPath),
  explorerSelection: null,
});

/** A setter that takes a value or an updater, like a `useState` one, for one field of the store. */
const setter = <K extends keyof WorkspaceState>(key: K) => (update: Update<WorkspaceState[K]>) =>
  workspace.set((state) => ({ [key]: typeof update === "function" ? (update as (current: WorkspaceState[K]) => WorkspaceState[K])(state[key]) : update }) as Partial<WorkspaceState>);

export const setSavedFiles = setter("savedFiles");
export const setWorkspaceDirectories = setter("workspaceDirectories");
export const setExplorerSelection = setter("explorerSelection");

/** Another folder is the workspace now; its folded folders come back with it, in the same step. */
export const setWorkspacePath = (workspacePath: string | null) => {
  if (workspacePath === workspace.get().workspacePath) return;
  workspace.set({ workspacePath, collapsedDirectories: storedCollapsedDirectories(workspacePath) });
};

/**
 * One part of the workspace, re-rendering when it changes. Not `workspace.use`: that renders
 * at once and on its own, and most changes here arrive with the backend's answer, together
 * with changes to the app's own state — the tabs, the active file. Following the store
 * through an ordinary state update keeps the two in one render, so nothing is ever drawn,
 * and no effect ever runs, with the new file list beside the old tabs.
 */
const useWorkspace = <Part>(part: (state: WorkspaceState) => Part): Part => {
  const [value, setValue] = useState(() => part(workspace.get()));
  useEffect(() => {
    const follow = () => setValue(() => part(workspace.get()));
    // Whatever changed between the render and this subscription.
    follow();
    return workspace.subscribe(follow);
  }, []);
  return value;
};

export const useWorkspacePath = () => useWorkspace((state) => state.workspacePath);
export const useSavedFiles = () => useWorkspace((state) => state.savedFiles);
export const useWorkspaceDirectories = () => useWorkspace((state) => state.workspaceDirectories);
export const useCollapsedDirectories = () => useWorkspace((state) => state.collapsedDirectories);

export const updateCollapsedDirectories = (update: (items: Set<string>) => Set<string>) => {
  const { workspacePath, collapsedDirectories } = workspace.get();
  const next = update(collapsedDirectories);
  if (workspacePath) localStorage.setItem(collapsedKey(workspacePath), JSON.stringify([...next]));
  workspace.set({ collapsedDirectories: next });
};

export const expandDirectories = (...directories: string[]) => updateCollapsedDirectories((items) => {
  const next = new Set(items);
  directories.forEach((directory) => next.delete(fileKey(directory)));
  return next;
});

export const toggleDirectory = (directory: string) => updateCollapsedDirectories((items) => {
  const next = new Set(items);
  const key = fileKey(directory);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
});

// ── The backend ──
// Each of these rejects with the backend's error. A reply for a folder that is no longer
// the workspace is dropped: it would otherwise fill the explorer with another folder's files.

/** Where a status-line message goes. */
type Report = (message: string) => void;

const stillOpen = (folderPath: string) => workspace.get().workspacePath === folderPath;

export const refreshWorkspaceDirectories = async (folderPath = workspace.get().workspacePath) => {
  if (!folderPath) { setWorkspaceDirectories([]); return; }
  const directories = await invoke<string[]>("list_workspace_directories", { request: { folderPath } });
  if (stillOpen(folderPath)) setWorkspaceDirectories(directories);
};

/** The same, for the callers that carry on whether it worked or not: a failure only goes to the status line. */
export const refreshDirectories = (report: Report, folderPath?: string | null) =>
  refreshWorkspaceDirectories(folderPath).catch((error) => report(errorMessage(error)));

let lastRescanAt = 0;
/**
 * Picks up whatever changed in the folder behind the editor's back. `.mild-editor.json`
 * is only reconciled with the disk by a scan, and the one in `load_workspace` runs at
 * start-up, so a file dropped in by another program — an unzipped contest, a copy from a
 * terminal — would otherwise stay invisible until the workspace was opened again. Open
 * tabs keep their own text; only the saved-file list is rebuilt.
 *
 * `announcement` is what the status line says when the scan was asked for by hand; a scan
 * nobody asked for says nothing, fails quietly, and — unless `force`d — is not repeated
 * within three seconds of the last one.
 */
export const rescanWorkspace = async (report: Report, announcement?: string, force = false) => {
  const folderPath = workspace.get().workspacePath;
  if (!folderPath) return;
  if (announcement === undefined && !force && Date.now() - lastRescanAt < 3000) return;
  lastRescanAt = Date.now();
  try {
    const files = await invoke<WorkspaceFileResult[]>("reload_workspace_files", { request: { folderPath } });
    if (!stillOpen(folderPath)) return;
    setSavedFiles((current) => files.map((file) => {
      // A file the editor already knew keeps its tab identity, so a scan that found
      // nothing new leaves every binding to it — an open tab, the contest board — alone.
      const known = current.find((item) => fileKey(item.filename) === fileKey(file.filename));
      return known ? { ...known, ...makeTab(file), id: known.id } : makeTab(file);
    }));
    await refreshDirectories(report, folderPath);
    if (announcement !== undefined) report(announcement);
  } catch (error) {
    if (announcement !== undefined) report(errorMessage(error));
  }
};

export const revealWorkspaceFile = async (filename: string) => {
  const folderPath = workspace.get().workspacePath;
  if (folderPath) await invoke("open_workspace_file_location", { request: { folderPath, filename } });
};

export const revealWorkspaceFolder = async (directory: string) => {
  const folderPath = workspace.get().workspacePath;
  if (folderPath) await invoke("open_workspace_folder_location", { request: { folderPath, directory } });
};

/** Creates the folder and unfolds the way down to it. The directory list is the caller's to refresh. */
export const createWorkspaceFolder = async (name: string, parentDirectory: string) => {
  const folderPath = workspace.get().workspacePath;
  if (!folderPath) return;
  const created = await invoke<string>("create_workspace_folder", { request: { folderPath, name, parentDirectory } });
  expandDirectories(parentDirectory, created);
};

/** What became of the paths under a folder that was renamed or moved. */
export type RelocatedFolder = {
  /** File key of each file as it was → the name it has now. */
  renamedFiles: Map<string, string>;
  /** Any workspace path, as it reads after the move; one outside the folder comes back unchanged. */
  movePath: (path: string) => string;
};

/**
 * Rename and move share this: `request` tells the backend which of the two it is. The saved
 * files, the folded folders and the selection follow the folder; the open tabs are the
 * caller's, from what this returns.
 */
export const relocateWorkspaceFolder = async (directory: string, command: "rename_workspace_folder" | "move_workspace_folder", request: Record<string, string>): Promise<RelocatedFolder | null> => {
  const folderPath = workspace.get().workspacePath;
  if (!folderPath) return null;
  const result = await invoke<{ directory: string; renamed: Array<[string, string]> }>(command, { request: { folderPath, directory, ...request } });
  const renamedFiles = new Map(result.renamed.map(([from, to]) => [fileKey(from), to]));
  const oldKey = fileKey(directory);
  const movePath = (path: string) => fileKey(path) === oldKey ? result.directory : fileKey(path).startsWith(`${oldKey}/`) ? `${result.directory}${path.slice(directory.length)}` : path;
  setSavedFiles((items) => items.map((tab) => { const next = renamedFiles.get(fileKey(tab.filename)); return next ? { ...tab, filename: next } : tab; }));
  updateCollapsedDirectories((items) => new Set([...items].map((key) => fileKey(movePath(key)))));
  setExplorerSelection((selected) => selected?.kind === "directory" ? { kind: "directory", path: movePath(selected.path) } : selected?.kind === "file" ? { kind: "file", filename: renamedFiles.get(fileKey(selected.filename)) || selected.filename } : selected);
  return { renamedFiles, movePath };
};

/** Deletes the folder and everything in it. Returns the file keys of the files that went, or null without a workspace. */
export const deleteWorkspaceFolder = async (directory: string): Promise<Set<string> | null> => {
  const folderPath = workspace.get().workspacePath;
  if (!folderPath) return null;
  const removed = await invoke<string[]>("delete_workspace_folder", { request: { folderPath, directory } });
  const removedKeys = new Set(removed.map(fileKey));
  const removedRoot = fileKey(directory);
  setSavedFiles((files) => files.filter((file) => !removedKeys.has(fileKey(file.filename))));
  setExplorerSelection((selected) => {
    if (selected?.kind === "file") return removedKeys.has(fileKey(selected.filename)) ? null : selected;
    if (selected?.kind !== "directory") return selected;
    return fileKey(selected.path) === removedRoot || fileKey(selected.path).startsWith(`${removedRoot}/`) ? null : selected;
  });
  updateCollapsedDirectories((items) => new Set([...items].filter((path) => path !== removedRoot && !path.startsWith(`${removedRoot}/`))));
  return removedKeys;
};

/**
 * Writes the order of one folder's files, exactly as the explorer is showing them. The
 * list takes the order at once and the backend follows; when it refuses, a rescan is what
 * puts the list right again.
 */
export const reorderWorkspaceFiles = async (directory: string, filenames: string[]) => {
  const folderPath = workspace.get().workspacePath;
  if (!folderPath) return false;
  const positions = new Map(filenames.map((filename, index) => [fileKey(filename), index]));
  setSavedFiles((items) => items.map((file) => positions.has(fileKey(file.filename)) ? { ...file, order: positions.get(fileKey(file.filename)) } : file));
  await invoke("reorder_workspace_files", { request: { folderPath, directory, filenames } });
  return true;
};
