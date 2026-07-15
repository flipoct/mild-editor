import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { ClangdClient, type ClangdInfo } from "./clangd";

type Language = "cpp" | "python";
type Status = "idle" | "running" | "passed" | "failed" | "error";
type UiTheme = "pastel" | "midnight" | "latte" | "sakura" | "blossom" | "nord" | "tokyo";
type ProblemSource = "atcoder" | "codeforces" | "doj" | "other";
type ExplorerSort = "modified" | "problem" | "name";
type EditorFont = string;
type EditorFontOption = { id: string; label: string; family: string; path?: string };

type TestCase = {
  id: number;
  name: string;
  input: string;
  expected: string;
  output: string;
  error: string;
  status: Status;
  open: boolean;
  timeMs?: number;
};

type NativeRunResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timeMs: number;
};

type TestResultEvent = { runId: string; index: number; result: NativeRunResult };

type ProblemTab = {
  id: string;
  title: string;
  filename: string;
  language: Language;
  codes: Record<Language, string>;
  tests: TestCase[];
  dirty?: boolean;
  source?: ProblemSource;
  modifiedAt?: number;
};

type LoadedProblem = {
  title: string;
  folderPath: string;
  language: Language;
  code: string;
  tests: Array<{ name: string; input: string; expected: string }>;
};

type LoadedWorkspace = {
  folderPath: string;
  problems: Array<{
    filename: string;
    title: string;
    language: Language;
    code: string;
    tests: LoadedProblem["tests"];
    source?: ProblemSource;
    modifiedAt: number;
  }>;
};

type ImportedAtCoderProblem = {
  title: string;
  suggestedFilename: string;
  tests: LoadedProblem["tests"];
  source: ProblemSource;
};

type CodeSnippet = {
  id: string;
  name: string;
  language: Language;
  code: string;
};

type ImportCollision = { existing: ProblemTab; imported: ImportedAtCoderProblem[] };

type ExplorerMenu = { file: ProblemTab; x: number; y: number };
type WorkspaceFileResult = { filename: string; title: string; language: Language; code: string; tests: LoadedProblem["tests"]; source?: ProblemSource; modifiedAt: number };

const templates: Record<Language, string> = {
  cpp: `#include <iostream>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n\n    int a, b;\n    cin >> a >> b;\n    cout << a + b << '\\n';\n    return 0;\n}\n`,
  python: `import sys\n\n\ndef solve():\n    a, b = map(int, sys.stdin.readline().split())\n    print(a + b)\n\n\nif __name__ == "__main__":\n    solve()\n`,
};

const initialTests: TestCase[] = [
  { id: 1, name: "test 1", input: "1 2\n", expected: "3", output: "", error: "", status: "idle", open: true },
  { id: 2, name: "test 2", input: "41 1\n", expected: "42", output: "", error: "", status: "idle", open: false },
];

const knownEditorFonts: EditorFontOption[] = [
  { id: "cascadia", label: "Cascadia Code", family: "'Cascadia Code', Consolas, monospace" },
  { id: "jetbrains", label: "JetBrains Mono", family: "'JetBrains Mono', monospace" },
  { id: "fira", label: "Fira Code", family: "'Fira Code', monospace" },
  { id: "consolas", label: "Consolas", family: "Consolas, monospace" },
];
const loadCustomFonts = (): EditorFontOption[] => {
  try { return JSON.parse(localStorage.getItem("mild-custom-fonts") || "[]"); } catch { return []; }
};

const normalize = (value: string) => value.replace(/\r\n/g, "\n").trimEnd();
const fileKey = (filename: string) => filename.trim().toLocaleLowerCase();
const languageFromFilename = (filename: string): Language | null => /\.(cpp|cc|cxx)$/i.test(filename) ? "cpp" : /\.py$/i.test(filename) ? "python" : null;
const filenameForLanguage = (filename: string, language: Language) => filename.replace(/\.(cpp|cc|cxx|py)$/i, language === "cpp" ? ".cpp" : ".py");
const storedTemplate = (language: Language) => localStorage.getItem(`mild-template-${language}`) || templates[language];
const defaultFilename = (index: number, language: Language = "cpp") => `${index < 26 ? String.fromCharCode(65 + index) : `problem${index + 1}`}.${language === "cpp" ? "cpp" : "py"}`;
const mexFilename = (requested: string, occupied: Set<string>) => {
  if (!occupied.has(fileKey(requested))) return requested;
  const match = /^(.*?)(\.[^.]+)?$/.exec(requested);
  const base = match?.[1] || requested;
  const extension = match?.[2] || ".cpp";
  for (let number = 1; ; number += 1) {
    const candidate = `${base} (${number})${extension}`;
    if (!occupied.has(fileKey(candidate))) return candidate;
  }
};
const loadSnippets = (): CodeSnippet[] => {
  try { return JSON.parse(localStorage.getItem("mild-snippets") || "[]"); } catch { return []; }
};
let completionsRegistered = false;
let snippetCompletionSource: CodeSnippet[] = [];
const APP_VERSION = "1.0.0";

function App() {
  const [language, setLanguage] = useState<Language>(() => (localStorage.getItem("mild-language") as Language) || "cpp");
  const [codes, setCodes] = useState<Record<Language, string>>(() => ({
    cpp: localStorage.getItem("mild-code-cpp") || storedTemplate("cpp"),
    python: localStorage.getItem("mild-code-python") || storedTemplate("python"),
  }));
  const [tests, setTests] = useState<TestCase[]>(initialTests);
  const [running, setRunning] = useState(false);
  const runCancelledRef = useRef(false);
  const testSaveTimerRef = useRef<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [templateLanguage, setTemplateLanguage] = useState<Language>(language);
  const [draftTemplates, setDraftTemplates] = useState<Record<Language, string>>(() => ({ cpp: storedTemplate("cpp"), python: storedTemplate("python") }));
  const [tabs, setTabs] = useState<ProblemTab[]>([]);
  const [activeTabId, setActiveTabId] = useState("");
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [savedFiles, setSavedFiles] = useState<ProblemTab[]>([]);
  const [testPanelWidth, setTestPanelWidth] = useState(() => Number(localStorage.getItem("mild-test-panel-width")) || 306);
  const [explorerWidth, setExplorerWidth] = useState(() => Number(localStorage.getItem("mild-explorer-width")) || 218);
  const resizeRef = useRef<{ panel: "test" | "explorer"; startX: number; startWidth: number; width: number } | null>(null);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const tabDragRef = useRef<string | null>(null);
  const tabDropTargetRef = useRef<string | null>(null);
  const [closeConfirmTabId, setCloseConfirmTabId] = useState<string | null>(null);
  const [appCloseConfirm, setAppCloseConfirm] = useState(false);
  const [deleteConfirmFile, setDeleteConfirmFile] = useState<ProblemTab | null>(null);
  const [explorerMenu, setExplorerMenu] = useState<ExplorerMenu | null>(null);
  const [explorerSort, setExplorerSort] = useState<ExplorerSort>(() => (localStorage.getItem("mild-explorer-sort") as ExplorerSort) || "problem");
  const [explorerSource, setExplorerSource] = useState<ProblemSource | "all">(() => (localStorage.getItem("mild-explorer-source") as ProblemSource | "all") || "all");
  const [renameFile, setRenameFile] = useState<ProblemTab | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [tabRenameDraft, setTabRenameDraft] = useState<{ id: string; value: string } | null>(null);
  const [fileStatus, setFileStatus] = useState("not saved");
  const [autoSaveRevision, setAutoSaveRevision] = useState(0);
  const [atCoderOpen, setAtCoderOpen] = useState(false);
  const [newFileImportPending, setNewFileImportPending] = useState(false);
  const [blankFilenameOpen, setBlankFilenameOpen] = useState(false);
  const [blankFilename, setBlankFilename] = useState("");
  const [importCollision, setImportCollision] = useState<ImportCollision | null>(null);
  const [atCoderUrl, setAtCoderUrl] = useState("");
  const [importingAtCoder, setImportingAtCoder] = useState(false);
  const [settingsPage, setSettingsPage] = useState<"appearance" | "template" | "snippets" | "language-server">("template");
  const [uiTheme, setUiTheme] = useState<UiTheme>(() => (localStorage.getItem("mild-ui-theme") as UiTheme) || "pastel");
  const [editorFont, setEditorFont] = useState<EditorFont>(() => (localStorage.getItem("mild-editor-font") as EditorFont) || "cascadia");
  const [systemFonts, setSystemFonts] = useState<EditorFontOption[]>([]);
  const [customFonts, setCustomFonts] = useState<EditorFontOption[]>(loadCustomFonts);
  const [snippets, setSnippets] = useState<CodeSnippet[]>(loadSnippets);
  const [snippetDraft, setSnippetDraft] = useState<CodeSnippet>(() => ({ id: crypto.randomUUID(), name: "", language: "cpp", code: "" }));
  const [insertSnippetId, setInsertSnippetId] = useState("");
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const runRef = useRef<() => void>(() => {});
  const hasUnsavedChangesRef = useRef(false);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  const diagnosticDecorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const clangdClientRef = useRef<ClangdClient | null>(null);
  const [clangdPath, setClangdPath] = useState(() => localStorage.getItem("mild-clangd-path") || "");
  const [clangdStatus, setClangdStatus] = useState<"idle" | "connecting" | "ready" | "missing" | "error">("idle");
  const [clangdInfo, setClangdInfo] = useState<ClangdInfo | null>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0];
  const monacoTheme = `mild-${uiTheme}`;
  const fontOptions = useMemo(() => [...systemFonts, ...customFonts], [customFonts, systemFonts]);
  const selectedFont = fontOptions.find((font) => font.id === editorFont) || fontOptions[0] || knownEditorFonts.at(-1)!;
  const editorFontFamily = selectedFont.family;
  const explorerFiles = useMemo(() => {
    const files = workspacePath
      ? [...savedFiles.map((saved) => tabs.find((tab) => fileKey(tab.filename) === fileKey(saved.filename)) || saved), ...tabs.filter((tab) => !savedFiles.some((saved) => fileKey(saved.filename) === fileKey(tab.filename)))]
      : tabs;
    const filtered = explorerSource === "all" ? files : files.filter((file) => (file.source || "other") === explorerSource);
    const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    return [...filtered].sort((left, right) => {
      if (explorerSort === "modified") return (right.modifiedAt || 0) - (left.modifiedAt || 0) || natural.compare(left.filename, right.filename);
      if (explorerSort === "name") return natural.compare(left.title || left.filename, right.title || right.filename);
      return natural.compare(left.filename.replace(/\.[^.]+$/, ""), right.filename.replace(/\.[^.]+$/, "")) || natural.compare(left.filename, right.filename);
    });
  }, [explorerSort, explorerSource, savedFiles, tabs, workspacePath]);
  const hasFileStatusError = !["not saved", "saving…", "saved", "loaded", "modified", "project created", "ready"].includes(fileStatus);

  useEffect(() => {
    hasUnsavedChangesRef.current = tabs.some((tab) => tab.dirty) || fileStatus === "modified";
  }, [fileStatus, tabs]);

  useEffect(() => {
    setTabs((items) => items.map((tab) => tab.id === activeTabId ? { ...tab, language, codes, tests } : tab));
  }, [activeTabId, codes, language, tests]);

  useEffect(() => {
    snippetCompletionSource = snippets;
  }, [snippets]);

  useEffect(() => {
    document.documentElement.dataset.theme = uiTheme;
    localStorage.setItem("mild-ui-theme", uiTheme);
  }, [uiTheme]);

  useEffect(() => {
    localStorage.setItem("mild-editor-font", editorFont);
  }, [editorFont]);

  useEffect(() => {
    localStorage.setItem("mild-explorer-sort", explorerSort);
    localStorage.setItem("mild-explorer-source", explorerSource);
  }, [explorerSort, explorerSource]);

  useEffect(() => {
    if (fontOptions.length && !fontOptions.some((font) => font.id === editorFont)) setEditorFont(fontOptions[0].id);
  }, [fontOptions, editorFont]);

  useEffect(() => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return;
    const sample = "mmmmmmmmmmlliWW00";
    context.font = "72px monospace";
    const baseline = context.measureText(sample).width;
    const installed = knownEditorFonts.filter((font) => {
      const family = font.label.replace(/'/g, "");
      context.font = `72px '${family}', monospace`;
      return Math.abs(context.measureText(sample).width - baseline) > 0.1 || family.toLowerCase() === "consolas";
    });
    setSystemFonts(installed.length ? installed : [knownEditorFonts.at(-1)!]);
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    customFonts.forEach((font) => {
      if (!font.path || document.fonts.check(`12px ${font.family}`)) return;
      void invoke<number[]>("read_font_file", { request: { path: font.path } }).then(async (bytes) => {
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
        try {
          const faceFamily = font.family.split(",")[0].trim().replace(/["']/g, "");
          const face = new FontFace(faceFamily, `url(${url})`);
          await face.load();
          document.fonts.add(face);
        } finally { URL.revokeObjectURL(url); }
      }).catch(() => undefined);
    });
  }, [customFonts]);

  const startPanelResize = (panel: "test" | "explorer", event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startWidth = panel === "test" ? testPanelWidth : explorerWidth;
    resizeRef.current = { panel, startX: event.clientX, startWidth, width: startWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("panel-resizing");
  };

  useEffect(() => {
    const resize = (event: PointerEvent) => {
      const current = resizeRef.current;
      if (!current) return;
      const delta = event.clientX - current.startX;
      const width = Math.max(190, Math.min(520, current.startWidth + (current.panel === "test" ? delta : -delta)));
      current.width = width;
      if (current.panel === "test") setTestPanelWidth(width);
      else setExplorerWidth(width);
    };
    const finish = () => {
      const current = resizeRef.current;
      if (!current) return;
      localStorage.setItem(current.panel === "test" ? "mild-test-panel-width" : "mild-explorer-width", String(current.width));
      resizeRef.current = null;
      document.body.classList.remove("panel-resizing");
    };
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => { window.removeEventListener("pointermove", resize); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); };
  }, [explorerWidth, testPanelWidth]);

  const activateTab = (tab: ProblemTab) => {
    clearDiagnostics();
    setActiveTabId(tab.id);
    setLanguage(tab.language);
    setCodes(tab.codes);
    setTests(tab.tests);
    setFileStatus(tab.dirty ? "modified" : workspacePath ? "saved" : "not saved");
  };

  const markActiveDirty = () => {
    setFileStatus("modified");
    setTabs((items) => items.map((tab) => tab.id === activeTabId ? { ...tab, dirty: true, modifiedAt: Date.now() } : tab));
  };

  const moveTab = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    setTabs((items) => {
      const from = items.findIndex((tab) => tab.id === fromId);
      const to = items.findIndex((tab) => tab.id === toId);
      if (from < 0 || to < 0) return items;
      const next = [...items];
      const [tab] = next.splice(from, 1);
      next.splice(to, 0, tab);
      return next;
    });
  };

  const finishTabDrag = () => {
    const fromId = tabDragRef.current;
    const toId = tabDropTargetRef.current;
    if (fromId && toId) moveTab(fromId, toId);
    tabDragRef.current = null;
    tabDropTargetRef.current = null;
    setDraggedTabId(null);
  };

  useEffect(() => {
    window.addEventListener("pointerup", finishTabDrag);
    window.addEventListener("pointercancel", finishTabDrag);
    return () => {
      window.removeEventListener("pointerup", finishTabDrag);
      window.removeEventListener("pointercancel", finishTabDrag);
    };
  });

  const openSavedFile = (file: ProblemTab) => {
    const openTab = tabs.find((tab) => fileKey(tab.filename) === fileKey(file.filename));
    if (openTab) {
      activateTab(openTab);
      return;
    }
    setTabs((items) => [...items, file]);
    activateTab(file);
  };

  const makeTab = (file: WorkspaceFileResult): ProblemTab => ({
    id: crypto.randomUUID(), title: file.title, filename: file.filename, language: file.language,
    codes: { cpp: storedTemplate("cpp"), python: storedTemplate("python"), [file.language]: file.code },
    tests: hydrateTests(file.tests),
    source: file.source || "other", modifiedAt: file.modifiedAt,
  });

  const changeActiveLanguage = async (next: Language) => {
    if (!activeTab || next === language) return;
    const filename = filenameForLanguage(activeTab.filename, next);
    const existing = [...tabs, ...savedFiles].find((tab) => tab.id !== activeTab.id && fileKey(tab.filename) === fileKey(filename));
    if (existing) {
      openSavedFile(existing);
      return;
    }
    const saved = workspacePath && savedFiles.find((tab) => fileKey(tab.filename) === fileKey(activeTab.filename));
    if (saved) {
      try {
        await invoke("rename_workspace_file", { request: { folderPath: workspacePath, filename: activeTab.filename, newFilename: filename } });
        setSavedFiles((items) => items.map((tab) => fileKey(tab.filename) === fileKey(activeTab.filename) ? { ...tab, filename, language: next } : tab));
      } catch (error) {
        setFileStatus(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    setLanguage(next);
    setTabs((items) => items.map((tab) => tab.id === activeTabId ? { ...tab, filename, language: next, dirty: false } : tab));
    setFileStatus("saved");
    setAutoSaveRevision((revision) => revision + 1);
  };

  const deleteSavedFile = async () => {
    const file = deleteConfirmFile;
    if (!file || !workspacePath) return;
    const isSaved = savedFiles.some((item) => fileKey(item.filename) === fileKey(file.filename)) && !file.dirty;
    if (!isSaved) {
      setSavedFiles((items) => items.filter((item) => fileKey(item.filename) !== fileKey(file.filename)));
      closeProblem(file.id);
      setDeleteConfirmFile(null);
      return;
    }
    try {
      await invoke("delete_workspace_file", { request: { folderPath: workspacePath, filename: file.filename } });
      const index = tabs.findIndex((tab) => fileKey(tab.filename) === fileKey(file.filename));
      const remainingTabs = tabs.filter((tab) => fileKey(tab.filename) !== fileKey(file.filename));
      setSavedFiles((items) => items.filter((tab) => fileKey(tab.filename) !== fileKey(file.filename)));
      setTabs(remainingTabs);
      if (activeTab && fileKey(activeTab.filename) === fileKey(file.filename)) {
        const next = remainingTabs[Math.min(Math.max(index, 0), remainingTabs.length - 1)];
        if (next) activateTab(next);
        else {
          clearDiagnostics();
          setActiveTabId("");
          setFileStatus("saved");
        }
      }
      setDeleteConfirmFile(null);
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const duplicateWorkspaceFile = async (file: ProblemTab) => {
    if (!workspacePath) return;
    const extension = file.filename.slice(file.filename.lastIndexOf("."));
    const base = file.filename.slice(0, file.filename.length - extension.length);
    let number = 2;
    let filename = `${base} copy${extension}`;
    const occupied = new Set(savedFiles.map((item) => fileKey(item.filename)));
    tabs.forEach((item) => occupied.add(fileKey(item.filename)));
    while (occupied.has(fileKey(filename))) filename = `${base} copy ${number++}${extension}`;
    if (!savedFiles.some((item) => fileKey(item.filename) === fileKey(file.filename))) {
      const tab: ProblemTab = { ...file, id: crypto.randomUUID(), filename, title: filename.replace(/\.[^.]+$/, ""), dirty: true };
      const nextTabs = [...tabs, tab];
      try { await persistTabs(nextTabs, tab.id); }
      catch (error) { setFileStatus(error instanceof Error ? error.message : String(error)); }
      return;
    }
    try {
      const result = await invoke<WorkspaceFileResult>("duplicate_workspace_file", { request: { folderPath: workspacePath, filename: file.filename, newFilename: filename } });
      const tab = makeTab(result);
      setSavedFiles((items) => [...items, tab]);
      setTabs((items) => [...items, tab]);
      activateTab(tab);
      setFileStatus("saved");
    } catch (error) { setFileStatus(error instanceof Error ? error.message : String(error)); }
  };

  const commitWorkspaceRename = async (original: ProblemTab, requestedFilename: string) => {
    if (!workspacePath) return;
    const filename = requestedFilename.trim();
    if (!filename) return;
    if (fileKey(filename) === fileKey(original.filename) && filename === original.filename) return;
    if (savedFiles.some((file) => fileKey(file.filename) === fileKey(filename) && fileKey(file.filename) !== fileKey(original.filename))) {
      setFileStatus("a file with that extension and name already exists");
      return;
    }
    if (!savedFiles.some((file) => fileKey(file.filename) === fileKey(original.filename))) {
      const nextLanguage = languageFromFilename(filename);
      setTabs((items) => items.map((tab) => tab.id === original.id ? { ...tab, filename, title: filename.replace(/\.[^.]+$/, ""), language: nextLanguage || tab.language, dirty: false } : tab));
      if (activeTab?.id === original.id && nextLanguage) setLanguage(nextLanguage);
      setRenameFile(null);
      setFileStatus("saved");
      setAutoSaveRevision((revision) => revision + 1);
      return;
    }
    try {
      const result = await invoke<WorkspaceFileResult>("rename_workspace_file", { request: { folderPath: workspacePath, filename: original.filename, newFilename: filename } });
      const update = (tab: ProblemTab): ProblemTab => tab.id === original.id || fileKey(tab.filename) === fileKey(original.filename)
        ? { ...tab, filename: result.filename, title: result.title, language: result.language }
        : tab;
      setTabs((items) => items.map(update));
      setSavedFiles((items) => items.map((tab) => fileKey(tab.filename) === fileKey(original.filename) ? { ...update(tab), dirty: false } : tab));
      if (activeTab?.id === original.id) setLanguage(result.language);
      setRenameFile(null);
      setFileStatus("saved");
    } catch (error) {
      setTabs((items) => items.map((tab) => tab.id === original.id ? { ...tab, filename: original.filename, language: original.language } : tab));
      if (activeTab?.id === original.id) setLanguage(original.language);
      setFileStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const renameWorkspaceFile = async () => {
    if (!renameFile) return;
    await commitWorkspaceRename(renameFile, renameValue);
  };

  const openFileLocation = async (file: ProblemTab) => {
    if (!workspacePath) return;
    try { await invoke("open_workspace_file_location", { request: { folderPath: workspacePath, filename: file.filename } }); }
    catch (error) { setFileStatus(error instanceof Error ? error.message : String(error)); }
  };

  const createWorkspace = async () => {
    try {
      const folderPath = await open({ directory: true, multiple: false, title: "Create Mild Editor project" });
      if (!folderPath || Array.isArray(folderPath)) return;
      const created = await invoke<{ folderPath: string }>("create_workspace", { request: { folderPath } });
      setWorkspacePath(created.folderPath);
      setSavedFiles([]);
      setFileStatus("project created");
    } catch (error) { setFileStatus(error instanceof Error ? error.message : String(error)); }
  };

  const persistTabs = async (nextTabs: ProblemTab[], nextActiveId: string) => {
    if (!workspacePath) return false;
    const snapshot = nextTabs.map((tab) => tab.id === activeTabId ? { ...tab, language, codes, tests, dirty: false } : { ...tab, dirty: false });
    const persistedTabs = [
      ...savedFiles.map((savedFile) => snapshot.find((tab) => fileKey(tab.filename) === fileKey(savedFile.filename)) || savedFile),
      ...snapshot.filter((tab) => !savedFiles.some((savedFile) => fileKey(savedFile.filename) === fileKey(tab.filename))),
    ];
    const saved = await invoke<LoadedWorkspace>("save_workspace", {
      request: {
        folderPath: workspacePath,
        problems: persistedTabs.map((tab) => ({ filename: tab.filename, title: tab.title, language: tab.language, code: tab.codes[tab.language], tests: tab.tests.map(({ name, input, expected }) => ({ name, input, expected })), source: tab.source, modifiedAt: tab.modifiedAt })),
      },
    });
    setWorkspacePath(saved.folderPath);
    setTabs(snapshot);
    setSavedFiles(persistedTabs);
    const nextActive = snapshot.find((tab) => tab.id === nextActiveId);
    if (nextActive) activateTab(nextActive);
    setFileStatus("saved");
    return true;
  };

  const createBlankProblem = async (requestedFilename: string) => {
    const typedName = requestedFilename.trim() || defaultFilename(savedFiles.length + tabs.length);
    const withExtension = languageFromFilename(typedName) ? typedName : `${typedName}.cpp`;
    const occupied = new Set([...savedFiles, ...tabs].map((tab) => fileKey(tab.filename)));
    const filename = mexFilename(withExtension, occupied);
    const tab: ProblemTab = {
      id: crypto.randomUUID(),
      title: filename.replace(/\.[^.]+$/, ""),
      filename,
      language: "cpp",
      codes: { cpp: storedTemplate("cpp"), python: storedTemplate("python") },
      tests: [{ id: 1, name: "test 1", input: "", expected: "", output: "", error: "", status: "idle", open: true }],
      source: "other",
      modifiedAt: Date.now(),
    };
    const nextTabs = [...tabs, tab];
    try {
      if (!(await persistTabs(nextTabs, tab.id))) {
        setTabs(nextTabs);
        activateTab(tab);
      }
    } catch (error) {
      setTabs(nextTabs);
      activateTab(tab);
      setFileStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const newProblem = () => {
    if (!workspacePath) { void createWorkspace(); return; }
  };

  const beginImport = () => {
    if (!workspacePath) return;
    setNewFileImportPending(true);
    setAtCoderOpen(true);
  };

  const cancelProblemImport = () => {
    setAtCoderOpen(false);
    if (newFileImportPending) {
      setBlankFilename(defaultFilename(savedFiles.length + tabs.length));
      setBlankFilenameOpen(true);
    }
    setNewFileImportPending(false);
    setAtCoderUrl("");
  };

  const confirmBlankProblem = () => {
    void createBlankProblem(blankFilename);
    setBlankFilenameOpen(false);
    setBlankFilename("");
  };

  const closeProblem = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    const remaining = tabs.filter((tab) => tab.id !== id);
    if (!remaining.length) {
      clearDiagnostics();
      setTabs([]);
      setActiveTabId("");
      setFileStatus("not saved");
      return;
    }
    setTabs(remaining);
    if (id === activeTabId) activateTab(remaining[Math.min(index, remaining.length - 1)]);
  };

  const requestCloseProblem = (id: string) => {
    const tab = tabs.find((item) => item.id === id);
    if (tab && (tab.dirty || !workspacePath)) {
      setCloseConfirmTabId(id);
      return;
    }
    closeProblem(id);
  };

  const beforeMount: BeforeMount = (monaco) => {
    monaco.editor.defineTheme("mild-pastel", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "8f9b82", fontStyle: "italic" },
        { token: "keyword", foreground: "d7a8c4" },
        { token: "string", foreground: "d8c692" },
        { token: "number", foreground: "b6c9a8" },
        { token: "type", foreground: "a9c7cf" },
      ],
      colors: {
        "editor.background": "#2b2c28",
        "editor.foreground": "#dedbd2",
        "editorLineNumber.foreground": "#666861",
        "editorLineNumber.activeForeground": "#c8c4b8",
        "editorCursor.foreground": "#e6c98f",
        "editor.selectionBackground": "#59665f88",
        "editor.lineHighlightBackground": "#31322e",
        "editorIndentGuide.background1": "#3c3d38",
        "editorIndentGuide.activeBackground1": "#62645c",
      },
    });
    monaco.editor.defineTheme("mild-midnight", {
      base: "vs-dark",
      inherit: true,
      rules: [{ token: "comment", foreground: "6c7086", fontStyle: "italic" }, { token: "keyword", foreground: "cba6f7" }, { token: "string", foreground: "a6e3a1" }, { token: "number", foreground: "fab387" }, { token: "type", foreground: "89dceb" }],
      colors: { "editor.background": "#1e1e2e", "editor.foreground": "#cdd6f4", "editorLineNumber.foreground": "#585b70", "editorLineNumber.activeForeground": "#bac2de", "editorCursor.foreground": "#f5e0dc", "editor.selectionBackground": "#585b7088", "editor.lineHighlightBackground": "#252536", "editorIndentGuide.background1": "#313244", "editorIndentGuide.activeBackground1": "#585b70" },
    });
    monaco.editor.defineTheme("mild-latte", {
      base: "vs",
      inherit: true,
      rules: [{ token: "comment", foreground: "9893a5", fontStyle: "italic" }, { token: "keyword", foreground: "907aa9" }, { token: "string", foreground: "286983" }, { token: "number", foreground: "d7827e" }, { token: "type", foreground: "56949f" }],
      colors: { "editor.background": "#faf4ed", "editor.foreground": "#575279", "editorLineNumber.foreground": "#9893a5", "editorLineNumber.activeForeground": "#575279", "editorCursor.foreground": "#b4637a", "editor.selectionBackground": "#dfdad9aa", "editor.lineHighlightBackground": "#f2e9e1", "editorIndentGuide.background1": "#dfdad9", "editorIndentGuide.activeBackground1": "#cecacd" },
    });
    monaco.editor.defineTheme("mild-sakura", {
      base: "vs-dark", inherit: true,
      rules: [{ token: "comment", foreground: "967987", fontStyle: "italic" }, { token: "keyword", foreground: "f2a6c2" }, { token: "string", foreground: "b8d8ba" }, { token: "number", foreground: "e8c07d" }, { token: "type", foreground: "b9b5e8" }],
      colors: { "editor.background": "#211820", "editor.foreground": "#f2dce5", "editorLineNumber.foreground": "#765e69", "editorLineNumber.activeForeground": "#e8bdcf", "editorCursor.foreground": "#f2a6c2", "editor.selectionBackground": "#8d526c66", "editor.lineHighlightBackground": "#2b2029", "editorIndentGuide.background1": "#3c2c38", "editorIndentGuide.activeBackground1": "#765466" },
    });
    monaco.editor.defineTheme("mild-blossom", {
      base: "vs", inherit: true,
      rules: [{ token: "comment", foreground: "a58491", fontStyle: "italic" }, { token: "keyword", foreground: "b84d7b" }, { token: "string", foreground: "5f8f72" }, { token: "number", foreground: "b7791f" }, { token: "type", foreground: "725eaa" }],
      colors: { "editor.background": "#fff7fa", "editor.foreground": "#553d49", "editorLineNumber.foreground": "#bfa5b0", "editorLineNumber.activeForeground": "#7b5365", "editorCursor.foreground": "#c45a87", "editor.selectionBackground": "#f0bfd288", "editor.lineHighlightBackground": "#fcecf2", "editorIndentGuide.background1": "#ead8df", "editorIndentGuide.activeBackground1": "#d2a9b9" },
    });
    monaco.editor.defineTheme("mild-nord", {
      base: "vs-dark", inherit: true,
      rules: [{ token: "comment", foreground: "616e88", fontStyle: "italic" }, { token: "keyword", foreground: "b48ead" }, { token: "string", foreground: "a3be8c" }, { token: "number", foreground: "d08770" }, { token: "type", foreground: "88c0d0" }],
      colors: { "editor.background": "#2e3440", "editor.foreground": "#d8dee9", "editorLineNumber.foreground": "#4c566a", "editorLineNumber.activeForeground": "#d8dee9", "editorCursor.foreground": "#88c0d0", "editor.selectionBackground": "#434c5eaa", "editor.lineHighlightBackground": "#343b49", "editorIndentGuide.background1": "#3b4252", "editorIndentGuide.activeBackground1": "#616e88" },
    });
    monaco.editor.defineTheme("mild-tokyo", {
      base: "vs-dark", inherit: true,
      rules: [{ token: "comment", foreground: "565f89", fontStyle: "italic" }, { token: "keyword", foreground: "bb9af7" }, { token: "string", foreground: "9ece6a" }, { token: "number", foreground: "ff9e64" }, { token: "type", foreground: "7dcfff" }],
      colors: { "editor.background": "#1a1b26", "editor.foreground": "#c0caf5", "editorLineNumber.foreground": "#3b4261", "editorLineNumber.activeForeground": "#a9b1d6", "editorCursor.foreground": "#7aa2f7", "editor.selectionBackground": "#33467c88", "editor.lineHighlightBackground": "#202230", "editorIndentGuide.background1": "#292e42", "editorIndentGuide.activeBackground1": "#515c7e" },
    });
    if (!completionsRegistered) {
      completionsRegistered = true;
      const register = (languageId: string, entries: Array<[string, string, string?]>) => monaco.languages.registerCompletionItemProvider(languageId, {
        provideCompletionItems(model: Monaco.editor.ITextModel, position: Monaco.Position) {
          const word = model.getWordUntilPosition(position);
          const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
          const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
          const snippetPrefix = /snippet::[\w-]*$/.exec(linePrefix)?.[0];
          const snippetRange = snippetPrefix
            ? { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: position.column - snippetPrefix.length, endColumn: position.column }
            : range;
          const language = languageId === "cpp" ? "cpp" : "python";
          const builtIns = entries.map(([label, insertText, detail]) => ({ label, insertText, detail, range, kind: monaco.languages.CompletionItemKind.Snippet, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }));
          const snippets = snippetCompletionSource
            .filter((snippet) => snippet.language === language && snippet.name.trim())
            .map((snippet) => ({
              label: `snippet::${snippet.name.trim()}`,
              filterText: `snippet::${snippet.name.trim()}`,
              insertText: snippet.code,
              detail: "Mild Editor snippet",
              range: snippetRange,
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            }));
          return { suggestions: [...snippets, ...builtIns] };
        },
      });
      register("cpp", [
        ["vector", "vector", "std::vector type"], ["pair", "pair", "std::pair type"],
        ["sort", "sort(${1:v}.begin(), ${1:v}.end());", "std::sort"], ["lower_bound", "lower_bound(${1:v}.begin(), ${1:v}.end(), ${2:value})", "std::lower_bound"],
        ["upper_bound", "upper_bound(${1:v}.begin(), ${1:v}.end(), ${2:value})", "std::upper_bound"], ["priority_queue", "priority_queue", "std::priority_queue type"],
        ["unordered_map", "unordered_map", "std::unordered_map type"], ["fori", "for (int ${1:i} = 0; ${1:i} < ${2:n}; ++${1:i}) {\n\t${0}\n}", "indexed loop"],
      ]);
      register("python", [
        ["forrange", "for ${1:i} in range(${2:n}):\n\t${0}", "range loop"], ["enumerate", "for ${1:i}, ${2:value} in enumerate(${3:items}):\n\t${0}", "enumerate loop"],
        ["listcomp", "[${1:expr} for ${2:x} in ${3:items}]", "list comprehension"], ["readints", "list(map(int, input().split()))", "read integer list"],
        ["heap", "import heapq\n${1:heap} = []\nheapq.heappush(${1:heap}, ${2:value})", "heapq"],
      ]);
    }
  };

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    diagnosticDecorationsRef.current = editor.createDecorationsCollection();
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void runRef.current());
    if (language === "cpp") void connectClangd(editor, monaco);
  };

  const connectClangd = async (editor = editorRef.current, monaco = monacoRef.current) => {
    if (!editor || !monaco || !("__TAURI_INTERNALS__" in window)) return;
    setClangdStatus("connecting");
    await clangdClientRef.current?.dispose();
    const client = new ClangdClient(monaco, editor);
    clangdClientRef.current = client;
    try {
      const info = await client.start(clangdPath || null, workspacePath, activeTab?.filename || "A.cpp", codes.cpp);
      setClangdInfo(info);
      setClangdStatus("ready");
    } catch (error) {
      setClangdInfo(null);
      setClangdStatus(String(error).toLowerCase().includes("not found") ? "missing" : "error");
    }
  };

  useEffect(() => {
    if (language !== "cpp") {
      void clangdClientRef.current?.dispose();
      clangdClientRef.current = null;
      setClangdStatus("idle");
      return;
    }
    if (editorRef.current && !clangdClientRef.current) void connectClangd();
  }, [language]);

  useEffect(() => {
    if (language === "cpp" && clangdStatus === "ready") {
      window.setTimeout(() => void clangdClientRef.current?.setDocument(workspacePath, activeTab?.filename || "A.cpp", codes.cpp), 0);
    }
  }, [activeTabId, activeTab?.filename, workspacePath]);

  useEffect(() => () => { void clangdClientRef.current?.dispose(); }, []);

  const clearDiagnostics = () => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (model && monaco) monaco.editor.setModelMarkers(model, "mild-compiler", []);
    diagnosticDecorationsRef.current?.clear();
  };

  const showDiagnostics = (stderr: string) => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monaco || !model) return false;

    const markers: Monaco.editor.IMarkerData[] = [];
    const cppPattern = /main\.cpp:(\d+):(\d+):\s+(fatal error|error|warning):\s+(.+)/g;
    for (const match of stderr.matchAll(cppPattern)) {
      const line = Math.min(Number(match[1]), model.getLineCount());
      const column = Math.min(Number(match[2]), model.getLineMaxColumn(line));
      markers.push({
        startLineNumber: line,
        startColumn: column,
        endLineNumber: line,
        endColumn: Math.min(column + 1, model.getLineMaxColumn(line)),
        message: match[4].trim(),
        source: "g++",
        severity: match[3] === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
      });
    }

    if (language === "python") {
      const pythonMatches = [...stderr.matchAll(/File ".*main\.py", line (\d+)/g)];
      const syntaxMessage = stderr.match(/(?:SyntaxError|IndentationError|TabError):\s*(.+)/)?.[0];
      const lastMatch = pythonMatches.at(-1);
      if (lastMatch && syntaxMessage) {
        const line = Math.min(Number(lastMatch[1]), model.getLineCount());
        markers.push({
          startLineNumber: line,
          startColumn: 1,
          endLineNumber: line,
          endColumn: model.getLineMaxColumn(line),
          message: syntaxMessage,
          source: "python",
          severity: monaco.MarkerSeverity.Error,
        });
      }
    }

    monaco.editor.setModelMarkers(model, "mild-compiler", markers);
    diagnosticDecorationsRef.current?.set(markers.map((marker) => ({
      range: new monaco.Range(
        marker.startLineNumber,
        model.getLineMaxColumn(marker.startLineNumber),
        marker.startLineNumber,
        model.getLineMaxColumn(marker.startLineNumber),
      ),
      options: {
        after: {
          content: `  ← ${marker.message}`,
          inlineClassName: marker.severity === monaco.MarkerSeverity.Warning ? "diagnostic-inline warning" : "diagnostic-inline error",
        },
        showIfCollapsed: true,
      },
    })));
    if (markers.length) {
      editor.revealPositionInCenter({ lineNumber: markers[0].startLineNumber, column: markers[0].startColumn });
      editor.setPosition({ lineNumber: markers[0].startLineNumber, column: markers[0].startColumn });
      editor.focus();
    }
    return markers.length > 0;
  };

  const openSettings = () => {
    setTemplateLanguage(language);
    setSettingsPage("appearance");
    setSettingsOpen(true);
  };

  const addEditorFont = async () => {
    try {
      const path = await open({ multiple: false, directory: false, title: "Add editor font", filters: [{ name: "Font files", extensions: ["ttf", "otf", "woff", "woff2"] }] });
      if (!path || Array.isArray(path)) return;
      const label = path.split(/[\\/]/).at(-1)?.replace(/\.(ttf|otf|woff2?)$/i, "") || "Custom font";
      const id = `custom-${crypto.randomUUID()}`;
      const faceFamily = `MildCustom_${id.replace(/-/g, "_")}`;
      const bytes = await invoke<number[]>("read_font_file", { request: { path } });
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
      try {
        const face = new FontFace(faceFamily, `url(${url})`);
        await face.load();
        document.fonts.add(face);
      } finally { URL.revokeObjectURL(url); }
      const font = { id, label, family: `'${faceFamily}', monospace`, path };
      const next = [...customFonts, font];
      setCustomFonts(next);
      localStorage.setItem("mild-custom-fonts", JSON.stringify(next));
      setEditorFont(id);
    } catch (error) { setFileStatus(error instanceof Error ? error.message : String(error)); }
  };

  const removeEditorFont = () => {
    const next = customFonts.filter((font) => font.id !== editorFont);
    setCustomFonts(next);
    localStorage.setItem("mild-custom-fonts", JSON.stringify(next));
    setEditorFont(systemFonts[0]?.id || "consolas");
  };

  const saveTemplates = () => {
    localStorage.setItem("mild-template-cpp", draftTemplates.cpp);
    localStorage.setItem("mild-template-python", draftTemplates.python);
    setSettingsOpen(false);
  };

  const saveSnippet = () => {
    if (!snippetDraft.name.trim() || !snippetDraft.code.trim()) return;
    const next = snippets.some((snippet) => snippet.id === snippetDraft.id)
      ? snippets.map((snippet) => snippet.id === snippetDraft.id ? { ...snippetDraft, name: snippetDraft.name.trim() } : snippet)
      : [...snippets, { ...snippetDraft, name: snippetDraft.name.trim() }];
    setSnippets(next);
    localStorage.setItem("mild-snippets", JSON.stringify(next));
    setSnippetDraft({ id: crypto.randomUUID(), name: "", language, code: "" });
  };

  const deleteSnippet = (id: string) => {
    const next = snippets.filter((snippet) => snippet.id !== id);
    setSnippets(next);
    localStorage.setItem("mild-snippets", JSON.stringify(next));
    if (snippetDraft.id === id) setSnippetDraft({ id: crypto.randomUUID(), name: "", language, code: "" });
  };

  const insertSnippet = () => {
    const snippet = snippets.find((item) => item.id === insertSnippetId && item.language === language);
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    if (!snippet || !editor || !selection) return;
    editor.executeEdits("mild-snippet", [{ range: selection, text: snippet.code, forceMoveMarkers: true }]);
    editor.focus();
    setInsertSnippetId("");
  };

  const applyTemplate = () => {
    clearDiagnostics();
    setCodes((current) => ({ ...current, [templateLanguage]: draftTemplates[templateLanguage] }));
    markActiveDirty();
    setLanguage(templateLanguage);
    setSettingsOpen(false);
  };

  const hydrateTests = (saved: LoadedProblem["tests"]): TestCase[] => saved.length
    ? saved.map((test, index) => ({ ...test, name: test.name.replace(/^sample\s+/i, "test "), id: index + 1, output: "", error: "", status: "idle", open: index === 0 }))
    : [{ id: 1, name: "test 1", input: "", expected: "", output: "", error: "", status: "idle", open: true }];

  const saveProblem = async (): Promise<boolean> => {
    try {
      let folderPath = workspacePath;
      if (!folderPath) {
        folderPath = await open({ directory: true, multiple: false, title: "Choose a workspace folder" });
      }
      if (!folderPath || Array.isArray(folderPath)) return false;
      setFileStatus("saving…");
      const snapshot = tabs.map((tab) => tab.id === activeTabId ? { ...tab, language, codes, tests, dirty: false } : { ...tab, dirty: false });
      const saved = await invoke<LoadedWorkspace>("save_workspace", {
        request: {
          folderPath,
          problems: snapshot.map((tab) => ({
            filename: tab.filename,
            title: tab.title,
            language: tab.language,
            code: tab.codes[tab.language],
            tests: tab.tests.map(({ name, input, expected }) => ({ name, input, expected })),
            source: tab.source,
            modifiedAt: tab.modifiedAt,
          })),
        },
      });
      setWorkspacePath(saved.folderPath);
      setTabs(snapshot);
      setSavedFiles((items) => {
        if (!items.length) return snapshot;
        const updated = new Map(snapshot.map((tab) => [fileKey(tab.filename), tab]));
        return [...items.map((tab) => updated.get(fileKey(tab.filename)) || tab), ...snapshot.filter((tab) => !items.some((item) => fileKey(item.filename) === fileKey(tab.filename)))];
      });
      setFileStatus("saved");
      return true;
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  useEffect(() => {
    if (!autoSaveRevision) return;
    void saveProblem();
  }, [autoSaveRevision]);

  const closeApplication = () => {
    void invoke("close_app");
  };

  const saveAndCloseApplication = async () => {
    if (await saveProblem()) closeApplication();
  };

  const requestApplicationClose = () => {
    if (hasUnsavedChangesRef.current) setAppCloseConfirm(true);
    else closeApplication();
  };

  const openProblem = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: "Open a Mild Editor workspace",
        filters: [{ name: "Mild Editor workspace", extensions: ["json", "cpp", "cc", "cxx", "py"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      const loaded = await invoke<LoadedWorkspace>("load_workspace", { path: selected });
      const loadedTabs: ProblemTab[] = loaded.problems.map((problem) => ({
        id: crypto.randomUUID(), title: problem.title, filename: problem.filename,
        language: problem.language,
        codes: { cpp: storedTemplate("cpp"), python: storedTemplate("python"), [problem.language]: problem.code },
        tests: hydrateTests(problem.tests),
        source: problem.source || "other", modifiedAt: problem.modifiedAt,
      }));
      setWorkspacePath(loaded.folderPath);
      setTabs([]);
      setSavedFiles(loadedTabs);
      clearDiagnostics();
      setActiveTabId("");
      setFileStatus("loaded");
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    const lastWorkspace = localStorage.getItem("mild-last-workspace");
    if (!lastWorkspace) return;
    void invoke<LoadedWorkspace>("load_workspace", { path: lastWorkspace }).then((loaded) => {
      const loadedTabs: ProblemTab[] = loaded.problems.map((problem) => ({
        id: crypto.randomUUID(), title: problem.title, filename: problem.filename,
        language: problem.language,
        codes: { cpp: storedTemplate("cpp"), python: storedTemplate("python"), [problem.language]: problem.code },
        tests: hydrateTests(problem.tests),
        source: problem.source || "other", modifiedAt: problem.modifiedAt,
      }));
      let restoredFilenames: string[] = [];
      let restoredActiveFilename = "";
      try {
        const restored = JSON.parse(localStorage.getItem("mild-last-open-tabs") || "{}");
        if (restored.workspacePath === loaded.folderPath && Array.isArray(restored.filenames)) {
          restoredFilenames = restored.filenames;
          restoredActiveFilename = typeof restored.activeFilename === "string" ? restored.activeFilename : "";
        }
      } catch { /* Ignore stale tab restore data. */ }
      const restoredTabs = restoredFilenames.map((filename) => loadedTabs.find((tab) => fileKey(tab.filename) === fileKey(filename))).filter((tab): tab is ProblemTab => Boolean(tab));
      const restoredActive = restoredTabs.find((tab) => fileKey(tab.filename) === fileKey(restoredActiveFilename)) || restoredTabs[0];
      setWorkspacePath(loaded.folderPath);
      setTabs(restoredTabs);
      setSavedFiles(loadedTabs);
      clearDiagnostics();
      if (restoredActive) {
        setActiveTabId(restoredActive.id);
        setLanguage(restoredActive.language);
        setCodes(restoredActive.codes);
        setTests(restoredActive.tests);
      } else setActiveTabId("");
      setFileStatus("loaded");
    }).catch(() => localStorage.removeItem("mild-last-workspace"));
  }, []);

  useEffect(() => {
    if (workspacePath) localStorage.setItem("mild-last-workspace", workspacePath);
  }, [workspacePath]);

  useEffect(() => {
    if (!workspacePath) return;
    localStorage.setItem("mild-last-open-tabs", JSON.stringify({ workspacePath, filenames: tabs.map((tab) => tab.filename), activeFilename: activeTab?.filename || "" }));
  }, [activeTab?.filename, tabs, workspacePath]);

  const addImportedProblems = async (imported: ImportedAtCoderProblem[], renameDuplicates = false) => {
    const existingFiles = [...savedFiles, ...tabs].filter((file, index, files) => files.findIndex((item) => fileKey(item.filename) === fileKey(file.filename)) === index);
    const collision = imported.find((problem) => existingFiles.some((file) => fileKey(file.filename) === fileKey(problem.suggestedFilename)));
    if (collision && !renameDuplicates) {
      setImportCollision({ existing: existingFiles.find((file) => fileKey(file.filename) === fileKey(collision.suggestedFilename))!, imported });
      setAtCoderOpen(false);
      setNewFileImportPending(false);
      setAtCoderUrl("");
      return;
    }
    const used = new Set(existingFiles.map((file) => fileKey(file.filename)));
    const importedTabs = imported.map((problem): ProblemTab => {
      const filename = mexFilename(problem.suggestedFilename, used);
      used.add(fileKey(filename));
      return {
        id: crypto.randomUUID(), title: problem.title, filename, language: "cpp",
        codes: { cpp: storedTemplate("cpp"), python: storedTemplate("python") },
        tests: hydrateTests(problem.tests),
        source: problem.source,
        modifiedAt: Date.now(),
      };
    });
    if (!importedTabs.length) throw new Error("No problems were imported.");
    const nextTabs = [...tabs, ...importedTabs];
    if (workspacePath) await persistTabs(nextTabs, importedTabs[0].id);
    else {
      setTabs(nextTabs);
      activateTab(importedTabs[0]);
    }
    setAtCoderOpen(false);
    setNewFileImportPending(false);
    setAtCoderUrl("");
    setFileStatus("saved");
  };

  const importAtCoderProblem = async () => {
    if (!atCoderUrl.trim()) return;
    setImportingAtCoder(true);
    try {
      const imported = await invoke<ImportedAtCoderProblem[]>("import_problem", { url: atCoderUrl.trim() });
      await addImportedProblems(imported);
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setImportingAtCoder(false);
    }
  };

  const finishTabRename = () => {
    const draft = tabRenameDraft;
    setTabRenameDraft(null);
    if (!draft) return;
    const current = tabs.find((tab) => tab.id === draft.id);
    if (!current || current.filename === draft.value.trim()) return;
    void commitWorkspaceRename(current, draft.value);
  };

  const autoSaveTests = (nextTests: TestCase[]) => {
    if (!workspacePath || !activeTab) return;
    const savedTests = nextTests.map(({ name, input, expected }) => ({ name, input, expected }));
    setSavedFiles((items) => items.map((file) => fileKey(file.filename) === fileKey(activeTab.filename) ? { ...file, tests: nextTests } : file));
    if (testSaveTimerRef.current !== null) window.clearTimeout(testSaveTimerRef.current);
    testSaveTimerRef.current = window.setTimeout(() => {
      testSaveTimerRef.current = null;
      void invoke("save_workspace_tests", { request: { folderPath: workspacePath, filename: activeTab.filename, tests: savedTests } }).catch((error) => setFileStatus(error instanceof Error ? error.message : String(error)));
    }, 250);
  };

  const updateTest = (id: number, patch: Partial<TestCase>) => {
    const next = tests.map((test) => (test.id === id ? { ...test, ...patch } : test));
    setTests(next);
    autoSaveTests(next);
  };

  const addTest = () => {
    const id = Math.max(0, ...tests.map((test) => test.id)) + 1;
    const next: TestCase[] = [...tests.map((test) => ({ ...test, open: false })), { id, name: `test ${tests.length + 1}`, input: "", expected: "", output: "", error: "", status: "idle", open: true }];
    setTests(next);
    autoSaveTests(next);
  };

  const removeTest = (id: number) => {
    const next = tests.filter((test) => test.id !== id);
    setTests(next);
    autoSaveTests(next);
  };

  const run = async () => {
    if (!activeTab || !tests.length || running) return;
    if (!(await saveProblem())) return;
    clearDiagnostics();
    setRunning(true);
    runCancelledRef.current = false;
    const runId = crypto.randomUUID();
    const snapshot = tests;
    setTests((items) => items.map((test, index) => ({ ...test, status: index === 0 ? "running" : "idle", output: "", error: "" })));
    const unlisten = await listen<TestResultEvent>("test-result", (event) => {
      if (event.payload.runId !== runId) return;
      const { index, result } = event.payload;
      const hasEditorDiagnostics = showDiagnostics(result.stderr || "");
      const expected = snapshot[index]?.expected || "";
      const passed = result.ok && normalize(result.stdout) === normalize(expected);
      setTests((items) => items.map((test, itemIndex) => itemIndex === index
        ? { ...test, output: hasEditorDiagnostics ? "" : result.stdout, error: hasEditorDiagnostics ? "" : result.stderr, timeMs: result.timeMs, status: result.ok ? (passed ? "passed" : "failed") : "error", open: passed ? false : test.open }
        : itemIndex === index + 1 && !runCancelledRef.current ? { ...test, status: "running" } : test));
    });

    try {
      await invoke<{ results: NativeRunResult[] }>("run_code", {
        request: {
          language,
          code: codes[language],
          tests: tests.map(({ input, expected }) => ({ input, expected })),
          runId,
        },
      });
    } catch (error) {
      setTests((items) => items.map((test) => ({ ...test, status: "error", error: error instanceof Error ? error.message : "Execution failed" })));
    } finally {
      unlisten();
      setTests((items) => items.map((test) => test.status === "running" ? { ...test, status: "idle" } : test));
      setRunning(false);
    }
  };

  const stopRun = () => {
    if (!running) return;
    runCancelledRef.current = true;
    void invoke("stop_run");
  };

  useEffect(() => { runRef.current = () => void run(); }, [run]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen("native-close-requested", () => requestApplicationClose()).then((stopListening) => { unlisten = stopListening; });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const handleRunShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void run();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveProblem();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        newProblem();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "t") {
        event.preventDefault();
        beginImport();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void openProblem();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w") {
        event.preventDefault();
        if (activeTab) requestCloseProblem(activeTab.id);
      }
      if ((event.ctrlKey || event.metaKey) && /^[1-9]$/.test(event.key)) {
        const tab = tabs[Number(event.key) - 1];
        if (tab) {
          event.preventDefault();
          activateTab(tab);
        }
      }
    };
    window.addEventListener("keydown", handleRunShortcut);
    return () => window.removeEventListener("keydown", handleRunShortcut);
  });

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (hasFileStatusError) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setFileStatus("ready");
      }
      else if (appCloseConfirm) setAppCloseConfirm(false);
      else if (closeConfirmTabId) setCloseConfirmTabId(null);
      else if (deleteConfirmFile) setDeleteConfirmFile(null);
      else if (renameFile) setRenameFile(null);
      else if (blankFilenameOpen) setBlankFilenameOpen(false);
      else if (importCollision) setImportCollision(null);
      else if (settingsOpen) setSettingsOpen(false);
      else if (atCoderOpen) cancelProblemImport();
      else if (explorerMenu) setExplorerMenu(null);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [appCloseConfirm, atCoderOpen, blankFilenameOpen, closeConfirmTabId, deleteConfirmFile, explorerMenu, hasFileStatusError, importCollision, renameFile, settingsOpen]);

  useEffect(() => {
    const isAllowedContextTarget = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(".file-explorer, .monaco-editor, textarea"));
    const dismissMenu = (target: EventTarget | null) => {
      if (!(target instanceof Element) || !target.closest(".explorer-context-menu")) setExplorerMenu(null);
    };
    const handlePointerDown = (event: PointerEvent) => dismissMenu(event.target);
    const handleContextMenu = (event: MouseEvent) => {
      if (!isAllowedContextTarget(event.target)) event.preventDefault();
      if (!(event.target instanceof Element) || !event.target.closest(".explorer-context-menu, .file-explorer")) setExplorerMenu(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("contextmenu", handleContextMenu);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("contextmenu", handleContextMenu);
    };
  }, []);

  useEffect(() => {
    const handleConfirm = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      if (hasFileStatusError) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setFileStatus("ready");
        return;
      }
      if (event.defaultPrevented) return;
      if (appCloseConfirm) {
        event.preventDefault();
        void saveAndCloseApplication();
      } else if (closeConfirmTabId) {
        event.preventDefault();
        closeProblem(closeConfirmTabId);
        setCloseConfirmTabId(null);
      } else if (deleteConfirmFile) {
        event.preventDefault();
        void deleteSavedFile();
      } else if (renameFile) {
        event.preventDefault();
        void renameWorkspaceFile();
      } else if (blankFilenameOpen) {
        event.preventDefault();
        confirmBlankProblem();
      } else if (importCollision) {
        event.preventDefault();
        openSavedFile(importCollision.existing);
        setImportCollision(null);
      } else if (atCoderOpen) {
        event.preventDefault();
        if (atCoderUrl.trim()) void importAtCoderProblem();
        else cancelProblemImport();
      }
    };
    window.addEventListener("keydown", handleConfirm, true);
    return () => window.removeEventListener("keydown", handleConfirm, true);
  }, [appCloseConfirm, atCoderOpen, atCoderUrl, blankFilenameOpen, closeConfirmTabId, deleteConfirmFile, hasFileStatusError, importCollision, renameFile]);

  const summary = useMemo(() => {
    const passed = tests.filter((test) => test.status === "passed").length;
    return running ? "running tests…" : tests.some((test) => test.status !== "idle") ? `${passed} / ${tests.length} passed` : "ready";
  }, [running, tests]);

  return (
    <main className="app-shell">
      <div className="window-titlebar" data-tauri-drag-region>
        <div className="titlebar-identity" data-tauri-drag-region>
          <span className="titlebar-logo" aria-hidden="true">m</span>
          <span className="titlebar-name" data-tauri-drag-region>mild editor</span>
          <span className="titlebar-separator" data-tauri-drag-region>·</span>
          <span className="titlebar-file" data-tauri-drag-region>{workspacePath ? `${workspacePath.split(/[\\/]/).at(-1)}${activeTab ? ` / ${activeTab.filename}` : ""}` : "no workspace"}</span>
        </div>
        <div className="titlebar-tools">
          <div className="file-actions">
            <button onClick={newProblem}>new</button>
            <button onClick={() => void openProblem()}>open</button>
            <button onClick={() => void saveProblem()}>save</button>
            <button className="atcoder-button" onClick={beginImport}>import</button>
          </div>
          <div className="snippet-insert">
            <select value={insertSnippetId} onChange={(event) => setInsertSnippetId(event.target.value)} aria-label="Select a code snippet">
              <option value="">snippet…</option>
              {snippets.filter((snippet) => snippet.language === language).map((snippet) => <option value={snippet.id} key={snippet.id}>{snippet.name}</option>)}
            </select>
            <button onClick={insertSnippet} disabled={!insertSnippetId}>insert</button>
          </div>
        </div>
        <div className="window-controls">
          <button onClick={() => { if ("__TAURI_INTERNALS__" in window) void getCurrentWindow().minimize(); }} aria-label="Minimize window"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 8.5h8v1H2z" /></svg></button>
          <button onClick={() => { if ("__TAURI_INTERNALS__" in window) void getCurrentWindow().toggleMaximize(); }} aria-label="Maximize window"><svg viewBox="0 0 12 12" aria-hidden="true"><path fillRule="evenodd" d="M2 2h8v8H2V2Zm1 1v6h6V3H3Z" /></svg></button>
          <button className="window-close" onClick={requestApplicationClose} aria-label="Close window"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 3.2.7-.7L6 5.3l2.8-2.8.7.7L6.7 6l2.8 2.8-.7.7L6 6.7 3.2 9.5l-.7-.7L5.3 6 2.5 3.2Z" /></svg></button>
        </div>
      </div>
      <nav className="problem-tabs" aria-label="Open problems">
        <div className="tab-strip">
          {tabs.map((tab) => (
            <div
              className={`problem-tab ${tab.id === activeTabId ? "active" : ""} ${tab.id === draggedTabId ? "dragging" : ""}`}
              key={tab.id}
              data-tab-id={tab.id}
            >
              <span
                className="tab-drag-handle"
                title="drag to reorder"
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  tabDragRef.current = tab.id;
                  setDraggedTabId(tab.id);
                }}
                onPointerMove={(event) => {
                  if (!tabDragRef.current) return;
                  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-tab-id]");
                  const targetId = target?.getAttribute("data-tab-id");
                  if (targetId) tabDropTargetRef.current = targetId;
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                  finishTabDrag();
                }}
              >⠿</span>
              {tab.id === activeTabId ? <div className="tab-edit"><span className={`tab-status ${tab.dirty ? "dirty" : ""}`}>{tab.dirty ? "●" : "○"}</span>{tabRenameDraft?.id === tab.id
                ? <input autoFocus value={tabRenameDraft.value} onBlur={finishTabRename} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setTabRenameDraft(null); event.currentTarget.blur(); } }} onChange={(event) => setTabRenameDraft({ id: tab.id, value: event.target.value })} aria-label="Active tab filename" spellCheck={false} />
                : <button className="tab-rename-trigger" onClick={() => setTabRenameDraft({ id: tab.id, value: tab.filename })} title="click to rename"><span className="tab-title">{tab.filename}</span></button>}</div>
                : <button className="tab-select" onClick={() => activateTab(tab)} title={tab.filename}><span className={`tab-status ${tab.dirty ? "dirty" : ""}`}>{tab.dirty ? "●" : "○"}</span><span className="tab-title">{tab.filename}</span></button>}
              <button className="tab-close" onClick={() => requestCloseProblem(tab.id)} aria-label={`Close ${tab.title} tab`}><svg className="close-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 3.2.7-.7L6 5.3l2.8-2.8.7.7L6.7 6l2.8 2.8-.7.7L6 6.7 3.2 9.5l-.7-.7L5.3 6 2.5 3.2Z" /></svg></button>
            </div>
          ))}
        </div>
      </nav>
      <section className={`workspace ${tabs.length ? "" : "empty-workspace"} ${workspacePath ? "" : "no-project"}`} style={{ "--test-panel-width": `${testPanelWidth}px`, "--explorer-width": `${explorerWidth}px` } as CSSProperties}>
          <aside className="test-panel">
            <div className="panel-heading">
              <span>test cases</span>
              <span className="count">{tests.length}</span>
              <button className="panel-run" onClick={run} disabled={running} aria-label="run all tests" title="run tests">
                {running ? <span className="spinner" /> : <svg className="play-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.25 2.4 13 8l-8.75 5.6Z" /></svg>}
              </button>
              {running && <button className="panel-stop" onClick={stopRun} aria-label="stop running" title="stop running">■</button>}
            </div>
            <div className="test-list">
              {tests.map((test) => (
                <article className={`test-card ${test.open ? "open" : ""}`} key={test.id}>
                  <div className="test-row">
                    <button className="test-toggle" onClick={() => updateTest(test.id, { open: !test.open })}>
                      <span>{test.name}</span>
                      {test.timeMs !== undefined && <span className="time">{test.timeMs} ms</span>}
                    </button>
                    <span className={`signal ${test.status}`} aria-label={test.status} />
                    <button className="delete-test" onClick={() => removeTest(test.id)} aria-label={`Delete ${test.name}`}><svg className="close-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 3.2.7-.7L6 5.3l2.8-2.8.7.7L6.7 6l2.8 2.8-.7.7L6 6.7 3.2 9.5l-.7-.7L5.3 6 2.5 3.2Z" /></svg></button>
                  </div>
                  {test.open && (
                    <div className="test-fields">
                      <label>input<textarea value={test.input} onChange={(event) => updateTest(test.id, { input: event.target.value, status: "idle" })} spellCheck={false} /></label>
                      <label><span className="field-label">expected<button className="accept-output" onClick={() => updateTest(test.id, { expected: test.output, status: "idle" })} disabled={test.timeMs === undefined || Boolean(test.error)}>use output</button></span><textarea value={test.expected} onChange={(event) => updateTest(test.id, { expected: event.target.value, status: "idle" })} spellCheck={false} /></label>
                      <label>output<textarea value={test.error || test.output} readOnly className={test.error ? "has-error" : ""} placeholder="run to see output" /></label>
                    </div>
                  )}
                </article>
              ))}
            </div>
            <div className="test-actions"><button className="add-test" onClick={addTest} aria-label="Add test case" title="add test case">＋</button></div>
          </aside>
          <div className="panel-resizer test-resizer" onPointerDown={(event) => startPanelResize("test", event)} role="separator" aria-label="Resize test case panel" aria-orientation="vertical" />

        <section className="editor-area">
          {tabs.length ? <>
          <Editor
            beforeMount={beforeMount}
            onMount={handleMount}
            theme={monacoTheme}
            language={language === "cpp" ? "cpp" : "python"}
            path={`file:///${activeTabId}/main.${language === "cpp" ? "cpp" : "py"}`}
            value={codes[language]}
            onChange={(value) => {
              clearDiagnostics();
              markActiveDirty();
              setCodes((current) => ({ ...current, [language]: value || "" }));
            }}
            options={{
              automaticLayout: true,
              fontFamily: editorFontFamily,
              fontSize: 14,
              lineHeight: 22,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              padding: { top: 18, bottom: 18 },
              renderLineHighlight: "line",
              overviewRulerBorder: false,
              hideCursorInOverviewRuler: true,
              quickSuggestions: { other: true, comments: false, strings: false },
              suggestOnTriggerCharacters: true,
              wordBasedSuggestions: "allDocuments",
              tabCompletion: "on",
              snippetSuggestions: "top",
              wordWrap: "off",
              tabSize: 4,
            }}
          />
          </> : <div className="welcome-screen">
            <div className="welcome-mark">m</div>
            <p className="eyebrow">lightweight competitive programming editor</p>
            <h1>mild editor</h1>
            <p>Code, test, save. Built for contest flow.</p>
            <div className="welcome-actions"><button className="primary-button" onClick={newProblem}>new workspace <kbd>Ctrl+N</kbd></button><button className="subtle-button" onClick={() => void openProblem()}>open workspace <kbd>Ctrl+O</kbd></button></div>
            <small>C++ · Python · sample tests · local save</small>
          </div>}
        </section>
        {workspacePath && <><div className="panel-resizer explorer-resizer" onPointerDown={(event) => startPanelResize("explorer", event)} role="separator" aria-label="Resize file explorer" aria-orientation="vertical" />
        <aside className="file-explorer" aria-label="Saved files">
          <div className="explorer-folder" title={workspacePath || "Save the contest to create a folder"}>
            <span className="explorer-chevron">⌄</span>
            <span className="explorer-folder-name">{workspacePath ? workspacePath.split(/[\\/]/).filter(Boolean).at(-1) : "unsaved contest"}</span>
          </div>
          <div className="explorer-controls">
            <label title="sort files"><span>sort</span><select value={explorerSort} onChange={(event) => setExplorerSort(event.target.value as ExplorerSort)} aria-label="Explorer sort order"><option value="modified">latest modified</option><option value="problem">problem number</option><option value="name">name</option></select></label>
            <label title="filter by source"><span>show</span><select value={explorerSource} onChange={(event) => setExplorerSource(event.target.value as ProblemSource | "all")} aria-label="Explorer source filter"><option value="all">all sources</option><option value="atcoder">AtCoder</option><option value="codeforces">Codeforces</option><option value="doj">DOJ</option><option value="other">local / other</option></select></label>
          </div>
          <div className="explorer-files">
            {!explorerFiles.length && <div className="explorer-empty">no matching files</div>}
            {explorerFiles.map((tab) => {
              const openIndex = tabs.findIndex((item) => fileKey(item.filename) === fileKey(tab.filename));
              return (
              <div className="explorer-file-row" key={tab.id}>
                <button
                  className={`explorer-file ${tab.id === activeTabId ? "active" : ""}`}
                  onClick={() => openSavedFile(tab)}
                  onContextMenu={(event) => { if (!workspacePath) return; event.preventDefault(); setExplorerMenu({ file: tab, x: event.clientX, y: event.clientY }); }}
                  title={`${tab.filename}${openIndex >= 0 && openIndex < 9 ? ` (Ctrl+${openIndex + 1})` : ""}`}
                >
                  <span className={`file-icon ${tab.language}`}>{tab.language === "cpp" ? "C++" : "Py"}</span>
                  <span className="explorer-file-name">{tab.filename}</span>
                  {openIndex >= 0 && openIndex < 9 && <kbd>{openIndex + 1}</kbd>}
                </button>
                {workspacePath && <button className="explorer-delete" onClick={() => setDeleteConfirmFile(tab)} aria-label={`Delete ${tab.filename}`} title="delete file"><svg className="close-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 3.2.7-.7L6 5.3l2.8-2.8.7.7L6.7 6l2.8 2.8-.7.7L6 6.7 3.2 9.5l-.7-.7L5.3 6 2.5 3.2Z" /></svg></button>}
              </div>
              );
            })}
            {workspacePath && <div className="explorer-metadata"><span className="file-icon json">{`{}`}</span><span>.mild-editor.json</span></div>}
          </div>
        </aside></>}
      </section>

      {hasFileStatusError && <section className="error-notice" role="alertdialog" aria-modal="true" aria-labelledby="error-notice-title">
        <header><strong id="error-notice-title">error</strong><button className="error-close" onClick={() => setFileStatus("ready")} aria-label="close error">×</button></header>
        <p>{fileStatus}</p>
        <footer><button className="error-confirm" onClick={() => setFileStatus("ready")}>confirm</button></footer>
      </section>}

      {explorerMenu && <div className="explorer-context-menu" style={{ left: explorerMenu.x, top: explorerMenu.y }} role="menu">
        <button role="menuitem" onClick={() => { void openFileLocation(explorerMenu.file); setExplorerMenu(null); }}>open file location</button>
        <button role="menuitem" onClick={() => { void duplicateWorkspaceFile(explorerMenu.file); setExplorerMenu(null); }}>duplicate file</button>
        <button role="menuitem" onClick={() => { setRenameValue(explorerMenu.file.filename); setRenameFile(explorerMenu.file); setExplorerMenu(null); }}>rename file</button>
        <button className="menu-danger" role="menuitem" onClick={() => { setDeleteConfirmFile(explorerMenu.file); setExplorerMenu(null); }}>delete file</button>
      </div>}

      {closeConfirmTabId && (() => {
        const tab = tabs.find((item) => item.id === closeConfirmTabId);
        return <div className="modal-backdrop close-confirm" role="presentation">
          <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="close-confirm-title">
            <span className="eyebrow">unsaved changes</span>
            <h2 id="close-confirm-title">{tab?.filename || "file"} is not saved</h2>
            <p>Close this tab and discard its code changes?</p>
            <footer className="settings-footer"><span className="footer-spacer" /><button className="subtle-button" onClick={() => setCloseConfirmTabId(null)}>cancel</button><button className="danger-button" onClick={() => { closeProblem(closeConfirmTabId); setCloseConfirmTabId(null); }}>close without saving</button></footer>
          </section>
        </div>;
      })()}

      {appCloseConfirm && <div className="modal-backdrop close-confirm" role="presentation">
        <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="app-close-confirm-title">
          <span className="eyebrow">unsaved changes</span>
          <h2 id="app-close-confirm-title">save before closing?</h2>
          <p>The open source file has unsaved code changes. Save them before closing Mild Editor?</p>
          <footer className="settings-footer"><span className="footer-spacer" /><button className="subtle-button" onClick={() => setAppCloseConfirm(false)}>cancel</button><button className="danger-button" onClick={closeApplication}>close without saving</button><button className="primary-button" onClick={() => void saveAndCloseApplication()}>save and close</button></footer>
        </section>
      </div>}

      {deleteConfirmFile && <div className="modal-backdrop close-confirm" role="presentation">
        <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-confirm-title">
          <span className="eyebrow">delete saved file</span>
          <h2 id="delete-confirm-title">Delete {deleteConfirmFile.filename}?</h2>
          <p>This permanently deletes the source file and its saved test cases.</p>
          <footer className="settings-footer"><span className="footer-spacer" /><button className="subtle-button" onClick={() => setDeleteConfirmFile(null)}>cancel</button><button className="danger-button" onClick={() => void deleteSavedFile()}>delete file</button></footer>
        </section>
      </div>}

      {renameFile && <div className="modal-backdrop close-confirm" role="presentation">
        <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-file-title">
          <span className="eyebrow">rename saved file</span>
          <h2 id="rename-file-title">Rename file</h2>
          <input className="atcoder-url" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void renameWorkspaceFile(); } }} autoFocus spellCheck={false} />
          <footer className="settings-footer"><span className="footer-spacer" /><button className="subtle-button" onClick={() => setRenameFile(null)}>cancel</button><button className="primary-button" onClick={() => void renameWorkspaceFile()}>rename</button></footer>
        </section>
      </div>}

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
          <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <header className="settings-header">
              <div><span className="eyebrow">preferences</span><h2 id="settings-title">{settingsPage === "appearance" ? "appearance" : settingsPage === "template" ? "default template" : settingsPage === "snippets" ? "code snippets" : "language server"}</h2></div>
              <button className="modal-close" onClick={() => setSettingsOpen(false)} aria-label="Close settings">×</button>
            </header>
            <div className="settings-pages">
              <button className={settingsPage === "appearance" ? "active" : ""} onClick={() => setSettingsPage("appearance")}>appearance</button>
              <button className={settingsPage === "template" ? "active" : ""} onClick={() => setSettingsPage("template")}>template</button>
              <button className={settingsPage === "snippets" ? "active" : ""} onClick={() => setSettingsPage("snippets")}>snippets</button>
              <button className={settingsPage === "language-server" ? "active" : ""} onClick={() => setSettingsPage("language-server")}>language server</button>
            </div>
            {settingsPage === "appearance" ? <div className="appearance-settings">
              <p className="settings-help">Themes update the full interface and Monaco Editor. Only detected fonts are listed; use Add font file to load another programming font.</p>
              <div className="appearance-group"><span>theme</span><div className="theme-options">
                <button className={`theme-option pastel ${uiTheme === "pastel" ? "active" : ""}`} onClick={() => setUiTheme("pastel")}><i /><strong>pastel dusk</strong><small>muted Sublime-inspired</small></button>
                <button className={`theme-option midnight ${uiTheme === "midnight" ? "active" : ""}`} onClick={() => setUiTheme("midnight")}><i /><strong>Catppuccin Mocha</strong><small>official palette inspired</small></button>
                <button className={`theme-option latte ${uiTheme === "latte" ? "active" : ""}`} onClick={() => setUiTheme("latte")}><i /><strong>Rosé Pine Dawn</strong><small>official palette inspired</small></button>
                <button className={`theme-option sakura ${uiTheme === "sakura" ? "active" : ""}`} onClick={() => setUiTheme("sakura")}><i /><strong>Sakura Night</strong><small>deep muted pink</small></button>
                <button className={`theme-option blossom ${uiTheme === "blossom" ? "active" : ""}`} onClick={() => setUiTheme("blossom")}><i /><strong>Blossom Milk</strong><small>soft pink light</small></button>
                <button className={`theme-option nord ${uiTheme === "nord" ? "active" : ""}`} onClick={() => setUiTheme("nord")}><i /><strong>Nord Frost</strong><small>calm arctic blue</small></button>
                <button className={`theme-option tokyo ${uiTheme === "tokyo" ? "active" : ""}`} onClick={() => setUiTheme("tokyo")}><i /><strong>Tokyo Night</strong><small>clear neon contrast</small></button>
              </div></div>
              <div className="appearance-group"><label>editor font<select value={selectedFont.id} onChange={(event) => setEditorFont(event.target.value)}>{fontOptions.map((font) => <option value={font.id} key={font.id}>{font.label}</option>)}</select></label><div className="font-actions"><button className="subtle-button" onClick={() => void addEditorFont()}>add font file</button>{selectedFont.path && <button className="danger-button" onClick={removeEditorFont}>remove</button>}</div><pre style={{ fontFamily: editorFontFamily }}>int main() {'{'} return 0; {'}'}</pre></div>
            </div> : settingsPage === "template" ? <>
              <div className="template-tabs" role="tablist" aria-label="Template language">
                <button className={templateLanguage === "cpp" ? "active" : ""} onClick={() => setTemplateLanguage("cpp")}>C++</button>
                <button className={templateLanguage === "python" ? "active" : ""} onClick={() => setTemplateLanguage("python")}>Python</button>
              </div>
              <p className="settings-help">The saved template is used when a new file is created in this language. Apply to editor replaces the current file body.</p>
              <div className="template-monaco"><Editor beforeMount={beforeMount} height="100%" language={templateLanguage === "cpp" ? "cpp" : "python"} value={draftTemplates[templateLanguage]} onChange={(code) => setDraftTemplates((current) => ({ ...current, [templateLanguage]: code || "" }))} theme={monacoTheme} options={{ minimap: { enabled: false }, fontFamily: editorFontFamily, fontSize: 12, lineNumbers: "on", scrollBeyondLastLine: false, automaticLayout: true, tabSize: 4, padding: { top: 10, bottom: 10 } }} /></div>
              <footer className="settings-footer">
                <button className="subtle-button" onClick={() => setDraftTemplates((current) => ({ ...current, [templateLanguage]: templates[templateLanguage] }))}>reset</button>
                <span className="footer-spacer" />
                <button className="subtle-button" onClick={applyTemplate}>apply to editor</button>
                <button className="primary-button" onClick={saveTemplates}>save template</button>
              </footer>
            </> : settingsPage === "snippets" ? <div className="snippet-settings">
              <aside className="snippet-list">
                <button className="new-snippet" onClick={() => setSnippetDraft({ id: crypto.randomUUID(), name: "", language, code: "" })}>＋ new snippet</button>
                {snippets.map((snippet) => <div className={`snippet-item ${snippet.id === snippetDraft.id ? "active" : ""}`} key={snippet.id}>
                  <button onClick={() => setSnippetDraft(snippet)}><span>{snippet.name}</span><small>{snippet.language}</small></button>
                  <button className="snippet-delete" onClick={() => deleteSnippet(snippet.id)} aria-label={`Delete ${snippet.name}`}><svg className="close-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 3.2.7-.7L6 5.3l2.8-2.8.7.7L6.7 6l2.8 2.8-.7.7L6 6.7 3.2 9.5l-.7-.7L5.3 6 2.5 3.2Z" /></svg></button>
                </div>)}
              </aside>
              <div className="snippet-form">
                <div className="snippet-guide">
                  <strong>How to use snippets</strong>
                  <span>Choose a name and language, write the code, then save it. Insert it from the title-bar snippet menu, or type <code>snippet::name</code> in a matching editor and accept the suggestion with Tab or Enter.</span>
                  <span>Monaco placeholders are supported: <code>{"${1:value}"}</code> selects the first editable field and <code>{"${0}"}</code> sets the final cursor position. Snippets are stored locally on this device.</span>
                </div>
                <div className="snippet-meta">
                  <input value={snippetDraft.name} onChange={(event) => setSnippetDraft((current) => ({ ...current, name: event.target.value }))} placeholder="snippet name" aria-label="Snippet name" />
                  <select value={snippetDraft.language} onChange={(event) => setSnippetDraft((current) => ({ ...current, language: event.target.value as Language }))} aria-label="Snippet language"><option value="cpp">C++</option><option value="python">Python</option></select>
                </div>
                <div className="snippet-monaco"><Editor beforeMount={beforeMount} height="100%" language={snippetDraft.language === "cpp" ? "cpp" : "python"} value={snippetDraft.code} onChange={(code) => setSnippetDraft((current) => ({ ...current, code: code || "" }))} theme={monacoTheme} options={{ minimap: { enabled: false }, fontFamily: editorFontFamily, fontSize: 12, lineNumbers: "on", scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, padding: { top: 10, bottom: 10 } }} /></div>
                <footer className="settings-footer"><span className="footer-spacer" /><button className="primary-button" onClick={saveSnippet} disabled={!snippetDraft.name.trim() || !snippetDraft.code.trim()}>save snippet</button></footer>
              </div>
            </div> : <div className="language-server-settings">
              <div className={`lsp-state ${clangdStatus}`}><span className="lsp-dot" /><div><strong>{clangdStatus === "ready" ? "clangd connected" : clangdStatus === "connecting" ? "connecting…" : clangdStatus === "missing" ? "clangd not found" : clangdStatus === "error" ? "connection failed" : "clangd idle"}</strong><small>{clangdInfo?.version || "C++ semantic completion, diagnostics, hover and signature help"}</small></div></div>
              <label className="clangd-path-label">clangd executable path<input value={clangdPath} onChange={(event) => setClangdPath(event.target.value)} placeholder="Auto-detect from PATH, or C:\\Program Files\\LLVM\\bin\\clangd.exe" spellCheck={false} /></label>
              <p className="settings-help">Leave the path empty to search PATH automatically. If LLVM clangd is unavailable, Mild Editor keeps using its built-in lightweight completions.</p>
              <footer className="settings-footer"><span className="footer-spacer" /><button className="subtle-button" onClick={() => { setClangdPath(""); localStorage.removeItem("mild-clangd-path"); }}>auto detect</button><button className="primary-button" onClick={() => { localStorage.setItem("mild-clangd-path", clangdPath); void connectClangd(); }}>connect clangd</button></footer>
            </div>}
          </section>
        </div>
      )}

      {blankFilenameOpen && <div className="modal-backdrop close-confirm" role="presentation">
        <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="blank-file-title">
          <span className="eyebrow">new file</span>
          <h2 id="blank-file-title">Choose a file name</h2>
          <input className="atcoder-url" value={blankFilename} onChange={(event) => setBlankFilename(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); confirmBlankProblem(); } }} autoFocus spellCheck={false} />
          <footer className="settings-footer"><span className="footer-spacer" /><button className="subtle-button" onClick={() => setBlankFilenameOpen(false)}>cancel</button><button className="primary-button" onClick={confirmBlankProblem}>create</button></footer>
        </section>
      </div>}

      {importCollision && <div className="modal-backdrop close-confirm" role="presentation">
        <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="import-collision-title">
          <span className="eyebrow">file already exists</span>
          <h2 id="import-collision-title">{importCollision.existing.filename} already exists</h2>
          <p>Open the existing file, or import a new copy with the smallest available number suffix.</p>
          <footer className="settings-footer"><span className="footer-spacer" /><button className="subtle-button" onClick={() => setImportCollision(null)}>cancel</button><button className="subtle-button" onClick={() => { openSavedFile(importCollision.existing); setImportCollision(null); }}>open existing</button><button className="primary-button" onClick={() => { const pending = importCollision.imported; setImportCollision(null); void addImportedProblems(pending, true); }}>import copy</button></footer>
        </section>
      </div>}

      {atCoderOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) cancelProblemImport(); }}>
          <section className="atcoder-dialog" role="dialog" aria-modal="true" aria-labelledby="atcoder-title">
            <header className="settings-header">
              <div><span className="eyebrow">import samples</span><h2 id="atcoder-title">Online judge problem</h2></div>
              <button className="modal-close" onClick={cancelProblemImport} aria-label="Close problem import">×</button>
            </header>
            <p className="settings-help">An AtCoder or Codeforces contest URL imports its listed problems. A supported problem URL imports one problem with its sample test cases.</p>
            <input className="atcoder-url" value={atCoderUrl} onChange={(event) => setAtCoderUrl(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void importAtCoderProblem(); } }} placeholder="AtCoder, Codeforces, or doj.kr problem URL" autoFocus />
            <footer className="settings-footer">
              <span className="footer-spacer" />
              <button className="subtle-button" onClick={cancelProblemImport}>{newFileImportPending ? "create blank file" : "cancel"}</button>
              <button className="primary-button" onClick={() => void importAtCoderProblem()} disabled={importingAtCoder || !atCoderUrl.trim()}>{importingAtCoder ? "importing…" : "import samples"}</button>
            </footer>
          </section>
        </div>
      )}

      <footer className="statusbar">
        <span className="wordmark">mild editor <small>v{APP_VERSION}</small></span>
        <span className="status-copy">{summary}</span>
        <span className="file-status">{fileStatus}</span>
        <button className={`lsp-status ${clangdStatus}`} onClick={() => { setSettingsPage("language-server"); setSettingsOpen(true); }} title={clangdInfo?.path || "Configure clangd"}><span />{language === "python" ? "python basic" : clangdStatus === "ready" ? "clangd ready" : clangdStatus === "connecting" ? "clangd…" : "clangd missing"}</button>
        <button className="status-settings" onClick={openSettings} aria-label="settings" title="settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.1 13a7.7 7.7 0 0 0 .05-1 7.7 7.7 0 0 0-.05-1l2.1-1.64-2-3.46-2.55 1.03a7.5 7.5 0 0 0-1.72-1L14.55 3h-4l-.38 2.93a7.5 7.5 0 0 0-1.72 1L5.9 5.9l-2 3.46L6 11a7.7 7.7 0 0 0-.05 1 7.7 7.7 0 0 0 .05 1l-2.1 1.64 2 3.46 2.55-1.03a7.5 7.5 0 0 0 1.72 1l.38 2.93h4l.38-2.93a7.5 7.5 0 0 0 1.72-1l2.55 1.03 2-3.46L19.1 13ZM12.55 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" /></svg></button>
        <select className="status-language" value={language} onChange={(event) => {
          const next = event.target.value as Language;
          void changeActiveLanguage(next);
        }} aria-label="Select language"><option value="cpp">C++</option><option value="python">Python 3</option></select>
      </footer>
    </main>
  );
}

export default App;
