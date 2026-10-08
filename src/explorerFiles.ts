import { useMemo, useRef } from "react";
import { explorerParent, fileKey, normalizedExplorerPath } from "./fileNaming";
import type { ExplorerFile, ExplorerSort, ExplorerTreeNode, ProblemTab } from "./types";

const FACTS = ["id", "title", "filename", "language", "source", "judgeStatus", "submissionUrl", "order"] as const;

const sameFacts = (left: ExplorerFile, right: ExplorerFile) =>
  left.modifiedAt === right.modifiedAt && FACTS.every((fact) => left[fact] === right[fact]);

/**
 * `files` as the explorer sees them, in the same order. The list keeps its identity, and
 * each row its own, for as long as nothing in it has changed: an open tab is a new object on
 * every keystroke, and whatever is built from this list (the sort, the tree, the rows) must
 * not be built again for that. `withModified` is for the "latest modified" sort, the one
 * view an edit does change.
 */
export function useExplorerFiles(files: ProblemTab[], withModified: boolean): ExplorerFile[] {
  const previous = useRef<ExplorerFile[]>([]);
  return useMemo(() => {
    const before = previous.current;
    // Almost always the same files in the same places; the map is only for when they moved.
    let byId: Map<string, ExplorerFile> | undefined;
    const known = (id: string, index: number) => before[index]?.id === id
      ? before[index]
      : (byId ??= new Map(before.map((file) => [file.id, file]))).get(id);
    const next = files.map((file, index): ExplorerFile => {
      const facts: ExplorerFile = {
        id: file.id, title: file.title, filename: file.filename, language: file.language, source: file.source,
        judgeStatus: file.judgeStatus, submissionUrl: file.submissionUrl, order: file.order,
        modifiedAt: withModified ? file.modifiedAt : undefined,
      };
      const old = known(file.id, index);
      return old && sameFacts(old, facts) ? old : facts;
    });
    const unchanged = next.length === before.length && next.every((file, index) => file === before[index]);
    return previous.current = unchanged ? before : next;
  }, [files, withModified]);
}

/**
 * Every file the explorer lists: the saved ones in their order, each as its open tab when it
 * has one, then the tabs that were never saved. Without a workspace there are only tabs.
 */
export const mergeExplorerFiles = <File extends { filename: string; order?: number }>(inWorkspace: boolean, saved: File[], open: File[]): File[] => {
  if (!inWorkspace) return open;
  // The first of two tabs with one name wins, as a search from the front would have it.
  const openByKey = new Map<string, File>();
  open.forEach((file) => { const key = fileKey(file.filename); if (!openByKey.has(key)) openByKey.set(key, file); });
  const savedKeys = new Set(saved.map((file) => fileKey(file.filename)));
  // Where a file sits in a hand-arranged folder is written to the saved entry alone, so the
  // tab standing in for it takes its place from there.
  const placed = (file: File) => {
    const tab = openByKey.get(fileKey(file.filename));
    return !tab ? file : tab.order === file.order ? tab : { ...tab, order: file.order };
  };
  return [...saved.map(placed), ...open.filter((file) => !savedKeys.has(fileKey(file.filename)))];
};

export const sortExplorerFiles = (files: ExplorerFile[], sort: ExplorerSort) => {
  const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...files].sort((left, right) => {
    if (sort === "modified") return (right.modifiedAt || 0) - (left.modifiedAt || 0) || natural.compare(left.filename, right.filename);
    if (sort === "name") return natural.compare(left.title || left.filename, right.title || right.filename);
    // Hand-arranged files come first, in the order they were dragged into; the rest keep
    // the problem-number order behind them, so a folder never has to be arranged in full.
    if (sort === "custom" && (left.order !== undefined || right.order !== undefined)) {
      if (left.order === undefined) return 1;
      if (right.order === undefined) return -1;
      if (left.order !== right.order) return left.order - right.order;
    }
    return natural.compare(left.filename.replace(/\.[^.]+$/, ""), right.filename.replace(/\.[^.]+$/, "")) || natural.compare(left.filename, right.filename);
  });
};

/** The folders of the workspace with `files` (already sorted) hung in them: folders first and by name, files in the order given. */
export const buildExplorerTree = (files: ExplorerFile[], workspaceDirectories: string[]): ExplorerTreeNode[] => {
  type DirectoryNode = Extract<ExplorerTreeNode, { kind: "directory" }>;
  const root: DirectoryNode = { kind: "directory", name: "", path: "", children: [] };
  const directories = new Map<string, DirectoryNode>([["", root]]);
  const ensureDirectory = (rawPath: string) => {
    const path = normalizedExplorerPath(rawPath);
    let current = root;
    let built = "";
    for (const part of path.split("/").filter(Boolean)) {
      built = built ? `${built}/${part}` : part;
      let child = directories.get(fileKey(built));
      if (!child) {
        child = { kind: "directory", name: part, path: built, children: [] };
        directories.set(fileKey(built), child);
        current.children.push(child);
      }
      current = child;
    }
    return current;
  };
  workspaceDirectories.forEach(ensureDirectory);
  files.forEach((file) => ensureDirectory(explorerParent(file.filename)).children.push({ kind: "file", file }));
  const fileOrder = new Map(files.map((file, index) => [fileKey(file.filename), index]));
  const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const sortChildren = (directory: DirectoryNode) => {
    directory.children.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      if (left.kind === "directory" && right.kind === "directory") return natural.compare(left.name, right.name);
      if (left.kind === "file" && right.kind === "file") return (fileOrder.get(fileKey(left.file.filename)) || 0) - (fileOrder.get(fileKey(right.file.filename)) || 0);
      return 0;
    });
    directory.children.forEach((child) => { if (child.kind === "directory") sortChildren(child); });
  };
  sortChildren(root);
  return root.children;
};
