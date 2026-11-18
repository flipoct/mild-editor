import { invoke } from "@tauri-apps/api/core";
import { legacyTemplates, setFolderTemplates, templateFile, templateSources, templateStorageKey } from "./problems";
import { IS_TAURI } from "./platform";
import { LIBRARY_IMPORT_KEY, LIBRARY_MOVED_KEY, loadSnippets } from "./settings";
import { getSetting, onSnippetsSaved, refreshSetting, setSetting } from "./settingsStore";
import { createStore } from "./store";
import type { CodeSnippet, Language, ProblemSource } from "./types";

/**
 * The user's templates and snippets, kept as files in a folder (src-tauri/src/library.rs):
 * `templates/default.cpp`, `templates/atcoder.py`, `snippets/segtree.cpp`… — one in the
 * app's own data unless another is chosen, which may be a git repository or a synced folder.
 *
 * The folder is the truth. It is read when the editor starts and again whenever a file in
 * it changes (looked for when the window comes back to the front, and every few seconds),
 * so a template edited in another editor is the one the next new file starts from. Saving
 * in Settings writes the files.
 *
 * Templates and snippets used to live in the settings: the first time a folder with nothing
 * in it is opened, they are written into it, and the settings keep their copy untouched.
 */

type LibrarySnippet = { name: string; language: Language; code: string };
type Library = { folder: string; templates: Record<string, string>; snippets: LibrarySnippet[]; empty: boolean; stamp: string };

type State = { folder: string; ready: boolean; error: string };

export const library = createStore<State>({ folder: "", ready: false, error: "" });

let stamp = "";
/** Snippets saved before the folder was read: written once it is. */
let pending: CodeSnippet[] | null = null;

const toSnippets = (list: LibrarySnippet[]): CodeSnippet[] =>
  list.map((snippet) => ({ id: `${snippet.language}:${snippet.name}`, name: snippet.name, language: snippet.language, code: snippet.code }));

const fromSnippets = (list: CodeSnippet[]): LibrarySnippet[] =>
  list.filter((snippet) => snippet.name.trim()).map((snippet) => ({ name: snippet.name.trim(), language: snippet.language, code: snippet.code }));

const apply = (read: Library) => {
  stamp = read.stamp;
  setFolderTemplates(read.templates);
  refreshSetting("snippets", toSnippets(read.snippets));
  library.set({ folder: read.folder, ready: true, error: "" });
};

const read = (folder: string) => invoke<Library>("library_read", { folder });

/** Writes the library as the editor has it now into `folder`, which has none: the first folder, or a new one. */
const fill = async (folder: string, templates: Record<string, string>, snippets: CodeSnippet[]) => {
  for (const [name, text] of Object.entries(templates)) await invoke("library_write_template", { folder, name, text });
  if (snippets.length) await invoke("library_write_snippets", { folder, snippets: fromSnippets(snippets) });
};

/** Opens `folder` (empty: the app's own), bringing what the editor has into it when it holds nothing yet. */
const open = async (folder: string, bring: { templates: Record<string, string>; snippets: CodeSnippet[] }) => {
  const path = folder || await invoke<string>("library_default_folder");
  let found = await read(path);
  // A settings backup was just restored: its templates and snippets are the ones wanted.
  const restoring = localStorage.getItem(LIBRARY_IMPORT_KEY) === "1";
  if (restoring) localStorage.removeItem(LIBRARY_IMPORT_KEY);
  if ((found.empty || restoring) && (Object.keys(bring.templates).length || bring.snippets.length)) {
    await fill(path, bring.templates, bring.snippets);
    found = await read(path);
  }
  apply(found);
  if (pending) {
    const saved = pending;
    pending = null;
    await writeSnippets(saved);
  }
};

const fail = (error: unknown) => library.set({ error: String(error) });

/**
 * Reads the folder again if anything in it changed since it was last read. The regular look
 * is skipped while the window is out of sight; coming back to it always looks.
 */
const recheck = async (always = false) => {
  const { folder, ready } = library.get();
  if (!ready || (document.hidden && !always)) return;
  const now = await invoke<string>("library_stamp", { folder }).catch(() => stamp);
  if (now !== stamp) await read(folder).then(apply, fail);
};

const writeSnippets = async (snippets: CodeSnippet[]) => {
  const { folder, ready } = library.get();
  if (!ready) { pending = snippets; return; }
  try {
    stamp = await invoke<string>("library_write_snippets", { folder, snippets: fromSnippets(snippets) });
    library.set({ error: "" });
  } catch (error) {
    fail(error);
    // What the folder really holds, rather than a list it refused.
    await read(folder).then(apply, () => undefined);
  }
};

/** Saves a template; none removes it, and the default one or the editor's own takes its place. */
export const saveTemplate = async (source: ProblemSource, language: Language, text: string | null) => {
  const { folder, ready } = library.get();
  if (!ready) return;
  stamp = await invoke<string>("library_write_template", { folder, name: templateFile(source, language), text });
  await read(folder).then(apply, fail);
};

/**
 * Moves the library to `folder` ("" for the app's own). A folder that has templates or
 * snippets already is taken as it is; an empty one gets a copy of what the editor has now.
 */
export const changeLibraryFolder = async (folder: string) => {
  const current = await read(library.get().folder).catch(() => null);
  try {
    await open(folder, { templates: current?.templates ?? {}, snippets: toSnippets(current?.snippets ?? []) });
    setSetting("libraryFolder", folder);
  } catch (error) {
    fail(error);
    throw error;
  }
};

/**
 * The templates and snippets a settings backup carries, read from the folder now and put
 * under the keys they had in the settings before there was a folder, which a restore writes
 * back into it (see `open`). The settings' own copies stopped changing when the folder came,
 * so a backup made from them brought old templates back and dropped newer snippets.
 */
export const libraryBackupEntries = async (): Promise<Record<string, string> | null> => {
  const { folder, ready } = library.get();
  if (!IS_TAURI || !ready) return null;
  const found = await read(folder);
  const entries: Record<string, string> = { "mild-snippets": JSON.stringify(toSnippets(found.snippets)) };
  for (const language of ["cpp", "python"] as Language[]) {
    for (const source of templateSources) {
      const text = found.templates[templateFile(source, language)];
      if (text !== undefined) entries[templateStorageKey(source, language)] = text;
    }
  }
  return entries;
};

export const revealLibrary = () => invoke("library_reveal", { folder: library.get().folder });

if (IS_TAURI) {
  onSnippetsSaved((snippets) => void writeSnippets(snippets));
  // The first time, or after a backup was restored: whatever the settings hold goes into the
  // folder. Not again after that, or emptying the folder would bring the old ones back.
  const bring = localStorage.getItem(LIBRARY_MOVED_KEY) !== "1" || localStorage.getItem(LIBRARY_IMPORT_KEY) === "1";
  void open(getSetting("libraryFolder"), bring ? { templates: legacyTemplates(), snippets: loadSnippets() } : { templates: {}, snippets: [] })
    .then(() => localStorage.setItem(LIBRARY_MOVED_KEY, "1"), fail);
  window.addEventListener("focus", () => void recheck(true));
  window.setInterval(() => void recheck(), 4000);
}
