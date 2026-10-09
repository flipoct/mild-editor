import { VerdictBadge } from "./VerdictBadge";
import { commonFolder, contestPlan, verdictView, type ContestSchedule } from "./workbench";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { AppMark, Icon, LanguageIcon } from "./icons";
import { diffLines, splitFlags } from "./judge";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { getVersion as getAppVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { ClangdClient, type ClangdInfo } from "./clangd";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContestHeader, ContestStatusButton } from "./ContestClock";
import { dismissExplorerOverlay, Explorer, ExplorerContextMenu, ExplorerDialogs, useExplorerOverlays, type ExplorerFileCommand, type ExplorerHandle, type ExplorerProps } from "./Explorer";
import { mergeExplorerFiles, useExplorerFiles } from "./explorerFiles";
import { errorMessage, IS_TAURI, isMac, modLabel } from "./platform";
import { IDLE_BROWSER_STATUS, PROBLEM_WINDOW_IMPORT_EVENT, type BrowserStatus } from "./ProblemWindow";
import { explorerBasename, explorerParent, fileKey, findStressCompanion, fuzzyMatch, isHelperFile, importFolder, importedFilename, mexFilename, normalizedExplorerPath, problemIdentity, stressCompanionName, type StressRole } from "./fileNaming";
import { columnsFromOrder, dropPanel, edgeAt, layoutRects, visibleLayout, type Edge } from "./panelLayout";
import { fillSubmitFormScript, pressSubmitFormScript, SUBMIT_MARK, submitTarget, type PressResult } from "./submit";
import { renderTemplateWithCursor } from "./templateParser";
import { BuiltinTerminal, terminalHost, terminalKeyIsEditors, typedInTerminal, useTerminalStatus, type TerminalStatus } from "./BuiltinTerminal";
import { COMMAND_PREFIX, checkerStarter, matchCommands, summarizeTests, type PaletteCommand } from "./workbench";
import type { AvailableUpdate, ClangdStatus, CompanionProblem, CompanionStatus, ContestState, EditorFontOption, ImportCollision, ImportedAtCoderProblem, InteractiveEntry, InteractiveExitEvent, InteractiveOutputEvent, Language, LoadedWorkspace, NativeRunResult, PanelId, PanelMode, ProblemLimits, ProblemSource, ProblemTab, SettingsPage, StressChoice, StressOutcome, SubmissionStatusResult, TestCase, TestResultEvent, UpdateStatus, VerdictNotice, WorkspaceFileResult } from "./types";
import { messages, updateStatusLine } from "./i18n";
import { createThemeWindowIcon } from "./themeIcon";
import { renderReleaseNotes } from "./releaseNotes";
import { DEMO_MODE, demoTabs } from "./demo";
import { blankTest, combinedRunOutput, companionCannotParse, companionToImported, CONTEST_PENALTY_MINUTES, contestStorageKey, DEBUG_TIME_FACTOR, DEFAULT_TIME_LIMIT_MS, filenameForLanguage, finalVerdicts, formatClock, formatMemory, hydrateTests, inferredSourceUrl, isAccepted, isContestImportUrl, isPendingVerdict, isSamePage, judge, languageFromFilename, loadContest, makeTab, NEEDS_BROWSER, nextDefaultFilename, rekeyContest, savedProblem, storedTemplate, STRESS_CREATE, stressChoiceKey, VERDICT_NOTICE_MS, verdictLabels, visibleWhitespace } from "./problems";
import { alwaysInstalledFontIds, APP_VERSION, DEFAULT_WEIGHT, editorLineHeightFor, fallbackEditorFont, IS_DEV_BUILD, isPortableSetting, knownEditorFonts, OPEN_TABS_KEY, PANEL_DIVIDER_HIT, PANEL_IDS, pickEditorFont, RELEASE_NOTES_KEY, SETTINGS_BACKUP_KIND, shortcutLabel, UI_THEMES, UI_ZOOM_STEP, UPDATES_SUPPORTED, wallpaperCss, WORKSPACE_KEY } from "./settings";
import { setSnippetCompletions, setupMonaco } from "./monacoSetup";
import { useLatest, useNextRender, useStableCallback } from "./hooks";
import { SettingsDialog } from "./SettingsDialog";
import { useBackgroundImage } from "./backgroundImage";
import { adjustUiZoom, getSetting, persistSettings, useSetting } from "./settingsStore";
import { expandDirectories, refreshDirectories, rescanWorkspace, setExplorerSelection, setSavedFiles, setWorkspaceDirectories, setWorkspacePath, useSavedFiles, useWorkspaceDirectories, useWorkspacePath, type RelocatedFolder } from "./workspaceStore";

/** What the editor and the test panel read while no file is open. Constants, so nothing re-runs over them. */
const NO_CODES: Record<Language, string> = { cpp: "", python: "" };
const NO_TESTS: TestCase[] = [];

function App() {
  // Defaults, legacy keys and clamped values become the stored ones as soon as the app is up.
  useEffect(persistSettings, []);
  const [running, setRunning] = useState(false);
  const runCancelledRef = useRef(false);
  const testSaveTimerRef = useRef<number | null>(null);
  const [tabs, setTabs] = useState<ProblemTab[]>(demoTabs.slice(0, 3));
  const [activeTabId, setActiveTabId] = useState(demoTabs[0]?.id ?? "");
  // The workspace on disk lives in a store of its own, which the explorer follows by itself.
  const workspacePath = useWorkspacePath();
  const savedFiles = useSavedFiles();
  const workspaceDirectories = useWorkspaceDirectories();
  const resizeRef = useRef<{
    axis: "x" | "y"; before: PanelId; after: PanelId; start: number; span: number;
    beforeWeight: number; afterWeight: number;
  } | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const [panelLayout, setPanelLayout] = useSetting("panelLayout");
  const [panelWeights, setPanelWeights] = useSetting("panelWeights");
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const tabDragRef = useRef<string | null>(null);
  const tabDropTargetRef = useRef<string | null>(null);
  const [closeConfirmTabId, setCloseConfirmTabId] = useState<string | null>(null);
  const [appCloseConfirm, setAppCloseConfirm] = useState(false);
  const [deleteConfirmFile, setDeleteConfirmFile] = useState<ProblemTab | null>(null);
  const [stressOpen, setStressOpen] = useState(false);
  const [stressChoice, setStressChoice] = useState<StressChoice>({ generator: "", reference: "" });
  const [stressRounds, setStressRounds] = useState(() => localStorage.getItem("mild-stress-rounds") || "300");
  const [stressRound, setStressRound] = useState(0);
  const [stressBusy, setStressBusy] = useState(false);
  const [stressOutcome, setStressOutcome] = useState<StressOutcome | null>(null);
  /** Files the last press created, shown in the dialog so the next step is obvious. */
  const [stressCreated, setStressCreated] = useState<string[]>([]);
  /** Quick open (Ctrl+P): the typed query, and which row the arrow keys are on. */
  const [quickOpen, setQuickOpen] = useState<string | null>(null);
  const [quickOpenIndex, setQuickOpenIndex] = useState(0);
  /** Filenames of closed tabs, newest first, for Ctrl+Shift+T. Only the name is kept: the
   * file is read from the workspace again, so reopening never resurrects stale code. */
  const closedTabsRef = useRef<string[]>([]);
  const [verdictNotices, setVerdictNotices] = useState<VerdictNotice[]>([]);
  /** Latest submission the poll has seen per problem URL; a change from it is what gets announced. */
  const seenSubmissionsRef = useRef(new Map<string, { status?: string; submissionUrl?: string }>());
  const [explorerSort] = useSetting("explorerSort");
  const [sourceFile, setSourceFile] = useState<ProblemTab | null>(null);
  const [sourceValue, setSourceValue] = useState<ProblemSource>("other");
  const [sourceUrlValue, setSourceUrlValue] = useState("");
  const [tabRenameDraft, setTabRenameDraft] = useState<{ id: string; value: string } | null>(null);
  const [fileStatus, setFileStatus] = useState("not saved");
  const [autoSaveRevision, setAutoSaveRevision] = useState(0);
  const [atCoderOpen, setAtCoderOpen] = useState(false);
  const [testcaseImportTarget, setTestcaseImportTarget] = useState<ProblemTab | null>(null);
  const [newFileImportPending, setNewFileImportPending] = useState(false);
  const [blankFilenameOpen, setBlankFilenameOpen] = useState(false);
  const [blankFilename, setBlankFilename] = useState("");
  const [entryParentDirectory, setEntryParentDirectory] = useState("");
  const [importCollision, setImportCollision] = useState<ImportCollision | null>(null);
  const [atCoderUrl, setAtCoderUrl] = useState("");
  const [importingAtCoder, setImportingAtCoder] = useState(false);
  const importInFlightRef = useRef(false);
  /** The settings page on show, `null` while the dialog is closed; every way in names the page it opens on. */
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(!DEMO_MODE?.startsWith("settings") ? null : DEMO_MODE === "settings-appearance" ? "appearance" : DEMO_MODE === "settings-judge" ? "judge" : DEMO_MODE === "settings-build" ? "build" : DEMO_MODE === "settings-snippets" ? "snippets" : "template");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ phase: UPDATES_SUPPORTED ? "idle" : "unavailable" });
  // The version the binary actually carries, which is what the updater compares
  // against; package.json is only the fallback for the browser preview.
  const [appVersion, setAppVersion] = useState(APP_VERSION);
  const [updateNoticeDismissed, setUpdateNoticeDismissed] = useState(false);
  /**
   * The release notes of the version now running, shown once after an update replaced the
   * app under it. They are kept from the moment the download finished, because by the time
   * the new build starts there is nothing left to ask: the updater has already handed over.
   */
  const [releaseNotes, setReleaseNotes] = useState<{ version: string; notes?: string } | null>(null);
  const pendingUpdateRef = useRef<AvailableUpdate | null>(null);
  const [uiLocale, setUiLocale] = useSetting("uiLocale");
  const [atcoderHandle] = useSetting("atcoderHandle");
  const [codeforcesHandle] = useSetting("codeforcesHandle");
  const [dojHandle] = useSetting("dojHandle");
  const [defaultLanguage, setDefaultLanguage] = useSetting("defaultLanguage");
  const [atcoderLibraryPath] = useSetting("atcoderLibraryPath");
  const [refreshingJudge, setRefreshingJudge] = useState(false);
  const [uiTheme, setUiTheme] = useSetting("uiTheme");
  const [acrylicOpacity] = useSetting("acrylicOpacity");
  const [acrylicBlur] = useSetting("acrylicBlur");
  const [uiZoom, setUiZoom] = useSetting("uiZoom");
  const [editorFontSize] = useSetting("editorFontSize");
  const [wallpaperLayout] = useSetting("wallpaperLayout");
  const [wallpaperScale] = useSetting("wallpaperScale");
  const [wallpaperPositionX] = useSetting("wallpaperPositionX");
  const [wallpaperPositionY] = useSetting("wallpaperPositionY");
  const [editorFont, setEditorFont] = useSetting("editorFont");
  const [systemFonts, setSystemFonts] = useState<EditorFontOption[]>([]);
  const [customFonts] = useSetting("customFonts");
  const [snippets] = useSetting("snippets");
  const [insertSnippetId, setInsertSnippetId] = useState("");
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const pendingTemplateCursorRef = useRef<{ tabId: string; language: Language; offset: number } | null>(null);
  const runRef = useRef<() => void>(() => {});
  const interactiveRef = useRef<() => void>(() => {});
  const submitRef = useRef<() => void>(() => {});
  const paletteRef = useRef<() => void>(() => {});
  const hasUnsavedChangesRef = useRef(false);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  const diagnosticDecorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const clangdClientRef = useRef<ClangdClient | null>(null);
  const [clangdStatus, setClangdStatus] = useState<ClangdStatus>("idle");
  const [clangdInfo, setClangdInfo] = useState<ClangdInfo | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [explorerVisible, setExplorerVisible] = useSetting("explorerVisible");
  const [testPanelVisible, setTestPanelVisible] = useSetting("testPanelVisible");
  // Embedded Chromium problem panel. The native view is positioned over `.problem-host`;
  // React only owns the rectangle, the toolbar and the status it is told about.
  const [problemPanelOpen, setProblemPanelOpen] = useSetting("problemPanelOpen");
  const [browserStatus, setBrowserStatus] = useState<BrowserStatus>(IDLE_BROWSER_STATUS);
  const [problemUrlDraft, setProblemUrlDraft] = useState("");
  const problemHostRef = useRef<HTMLDivElement | null>(null);
  const problemUrlEditingRef = useRef(false);
  const [problemBrowserMode] = useSetting("problemBrowserMode");
  // True from the browser view taking the keyboard until this page gets it back. The
  // view is native, so `document.activeElement` does not know about it.
  const cefFocusedRef = useRef(false);
  // When the browser was last closed by Ctrl+W: on macOS the same keystroke can reach
  // both the menu bar and the view, and the second arrival must not close a file too.
  const browserClosedAtRef = useRef(0);
  const [organizeImports] = useSetting("organizeImports");
  const [autoContest] = useSetting("autoContest");
  const [autoSave, setAutoSave] = useSetting("autoSave");
  const [submitPress] = useSetting("submitPress");
  const [companionEnabled] = useSetting("companionEnabled");
  const [companionPort] = useSetting("companionPort");
  const [companionStatus, setCompanionStatus] = useState<CompanionStatus>({ listening: false, port: null });
  const [companionError, setCompanionError] = useState("");
  const [rawOutputTests, setRawOutputTests] = useState<number[]>([]);
  const [panelMode, setPanelMode] = useState<PanelMode>("tests");
  const [interactiveLog, setInteractiveLog] = useState<InteractiveEntry[]>([]);
  const [interactiveDraft, setInteractiveDraft] = useState("");
  const [interactiveRunning, setInteractiveRunning] = useState(false);
  const [interactiveStarting, setInteractiveStarting] = useState(false);
  const interactiveSessionRef = useRef<string | null>(null);
  const interactiveEntryIdRef = useRef(0);
  const interactiveLogRef = useRef<HTMLDivElement | null>(null);
  const interactiveInputRef = useRef<HTMLTextAreaElement | null>(null);
  const companionBatchRef = useRef<{ id: string; size: number; problems: ImportedAtCoderProblem[]; timer: number; opened: boolean } | null>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0];
  // What the editor and the test panel show is the open tab itself: one copy, so a
  // keystroke is one update of `tabs` and nothing has to be mirrored back into it.
  const language = activeTab?.language ?? defaultLanguage;
  const codes = activeTab?.codes ?? NO_CODES;
  const tests = activeTab?.tests ?? NO_TESTS;
  const activeId = activeTab?.id;
  const patchActiveTab = (patch: (tab: ProblemTab) => Partial<ProblemTab>) =>
    setTabs((items) => items.map((tab) => tab.id === activeId ? { ...tab, ...patch(tab) } : tab));
  const setTests = (update: TestCase[] | ((tests: TestCase[]) => TestCase[])) =>
    patchActiveTab((tab) => ({ tests: typeof update === "function" ? update(tab.tests) : update }));
  /**
   * Puts what a save wrote back into `tabs`. The save was made from a snapshot, and the
   * editor stayed live while it ran: a tab whose code or tests moved on in the meantime
   * keeps them, and stays unsaved.
   */
  const settleSavedTabs = (snapshot: ProblemTab[], before: ProblemTab[]) => setTabs((items) => snapshot.map((saved) => {
    const live = items.find((tab) => tab.id === saved.id);
    const sent = before.find((tab) => tab.id === saved.id);
    return live && sent && (live.codes !== sent.codes || live.tests !== sent.tests)
      ? { ...saved, codes: live.codes, tests: live.tests, dirty: live.dirty, modifiedAt: live.modifiedAt }
      : saved;
  }));
  const testSummary = useMemo(() => summarizeTests(tests), [tests]);
  // One function per language, so a memoised panel that is handed it is not redrawn for nothing.
  const t = useCallback((key: keyof typeof messages.en): string => messages[uiLocale][key], [uiLocale]);
  const monacoTheme = `mild-${uiTheme}`;
  const fontOptions = useMemo(() => [...systemFonts, ...customFonts], [customFonts, systemFonts]);
  const selectedFont = pickEditorFont(fontOptions, editorFont);
  const editorFontFamily = selectedFont.family;
  const wallpaper = wallpaperCss(wallpaperLayout, wallpaperScale, wallpaperPositionX, wallpaperPositionY);
  // What the explorer is told about the open tabs: their names and badges, nothing of their
  // code. The list is the same one from keystroke to keystroke, so the panel is left alone.
  const openExplorerFiles = useExplorerFiles(tabs, explorerSort === "modified");
  // Quick open only follows the tabs while its list is on show.
  const quickOpenTabs = quickOpen === null || quickOpen.startsWith(COMMAND_PREFIX) ? null : tabs;
  /** The files a quick-open query matches, best first and capped so the list stays short. */
  const quickOpenMatches = useMemo(() => {
    if (quickOpen === null || quickOpenTabs === null) return [];
    const query = quickOpen.trim();
    return mergeExplorerFiles(Boolean(workspacePath), savedFiles, quickOpenTabs)
      .map((file) => ({ file, match: fuzzyMatch(file.filename, query) }))
      .filter((row): row is { file: ProblemTab; match: NonNullable<ReturnType<typeof fuzzyMatch>> } => row.match !== null)
      .sort((left, right) => right.match.score - left.match.score
        // With nothing typed the list is simply the most recently touched files.
        || (right.file.modifiedAt || 0) - (left.file.modifiedAt || 0))
      .slice(0, 40);
  }, [quickOpen, quickOpenTabs, savedFiles, workspacePath]);
  // Which problems the judge is asked about. The open tabs' URLs come in as one string,
  // which typing does not change, so the key is not put together again for every keystroke.
  const openSourceUrls = tabs.map((tab) => tab.sourceUrl || "").join("\n");
  const judgeProblemKey = useMemo(() => [...new Set([...savedFiles.map((file) => file.sourceUrl), ...openSourceUrls.split("\n")].filter(Boolean))].sort().join("|"), [savedFiles, openSourceUrls]);
  const reportedStatuses = ["not saved", "saving…", "saved", "loaded", "modified", "project created", "ready", "submission results updated", "no matching submissions found", "test cases imported", "source updated",
    t("problemImportWaiting"), t("submitFilled"), t("submitCopied"), t("submitLogin"), t("submitOpening"), t("submitPressing"), t("submitPressed"),
    t("explorerRescanned"), t("customOrderSet"), t("noClosedTabs"), t("settingsExported"), t("settingsImported"), t("checkerCreated"),
    t("contestAutoEnded"), t("contestAutoUpcoming"), t("contestAutoUnknown"), t("contestAutoBusy"), t("contestAutoNoFolder")];
  const hasFileStatusError = !reportedStatuses.includes(fileStatus) && !fileStatus.startsWith(t("submitCopied"))
    && !fileStatus.startsWith("imported ") && !fileStatus.startsWith(t("contestAutoStarted")) && !fileStatus.startsWith(t("importingContest"));

  useEffect(() => {
    hasUnsavedChangesRef.current = tabs.some((tab) => tab.dirty) || fileStatus === "modified";
  }, [fileStatus, tabs]);

  useEffect(() => {
    const pending = pendingTemplateCursorRef.current;
    if (!pending || pending.tabId !== activeTabId || pending.language !== language) return;
    let frame = 0;
    let attempts = 0;
    const placeCursor = () => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if ((!editor || !model) && attempts++ < 10) {
        frame = window.requestAnimationFrame(placeCursor);
        return;
      }
      if (!editor || !model) return;
      const position = model.getPositionAt(Math.min(pending.offset, model.getValueLength()));
      editor.setPosition(position);
      editor.revealPositionInCenterIfOutsideViewport(position);
      editor.focus();
      pendingTemplateCursorRef.current = null;
    };
    frame = window.requestAnimationFrame(placeCursor);
    return () => window.cancelAnimationFrame(frame);
  }, [activeTabId, codes, language]);

  useEffect(() => {
    setSnippetCompletions(snippets);
  }, [snippets]);

  useEffect(() => {
    document.documentElement.dataset.theme = uiTheme;
  }, [uiTheme]);

  // Single hook every macOS-only rule in styles.css keys off.
  useEffect(() => {
    document.documentElement.dataset.platform = isMac ? "mac" : "other";
  }, []);

  // macOS slides the traffic lights away in fullscreen, so the space reserved for them has to go with it.
  useEffect(() => {
    if (!isMac || !IS_TAURI) return;
    const appWindow = getCurrentWindow();
    const sync = () => void appWindow.isFullscreen().then(setFullscreen).catch(() => undefined);
    let unlisten: (() => void) | undefined;
    let disposed = false;
    sync();
    void appWindow.onResized(sync).then((stopListening) => { if (disposed) stopListening(); else unlisten = stopListening; });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.fullscreen = fullscreen ? "true" : "false";
  }, [fullscreen]);

  // Native webview zoom scales Monaco and every panel together and keeps pointer
  // coordinates honest, which CSS zoom does not. The CSS form only serves the
  // browser preview.
  useEffect(() => {
    // The macOS title bar counter-scales with this so it keeps its native height and
    // stays lined up with the traffic lights, which the webview zoom does not move.
    document.documentElement.style.setProperty("--ui-zoom-inverse", String(100 / uiZoom));
    if (IS_TAURI) void getCurrentWebview().setZoom(uiZoom / 100).catch(() => undefined);
    else document.documentElement.style.setProperty("zoom", `${uiZoom}%`);
  }, [uiZoom]);

  // True once the running build has told us its version. Anything that compares against
  // it has to wait: until then `appVersion` is only what package.json said at build time.
  const [appVersionResolved, setAppVersionResolved] = useState(!IS_TAURI);
  useEffect(() => {
    if (!IS_TAURI) return;
    void getAppVersion().then(setAppVersion).catch(() => undefined).finally(() => setAppVersionResolved(true));
  }, []);

  // One check per launch, a few seconds in so it never competes with opening the workspace.
  useEffect(() => {
    if (!UPDATES_SUPPORTED) return;
    const timer = window.setTimeout(() => void checkForUpdates(), 4000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!IS_TAURI) return;
    let cancelled = false;
    const apply = (status: CompanionStatus) => {
      if (cancelled) return;
      setCompanionStatus(status);
      setCompanionError("");
    };
    if (!companionEnabled) {
      void invoke<CompanionStatus>("stop_companion").then(apply).catch(() => undefined);
    } else {
      void invoke<CompanionStatus>("start_companion", { port: companionPort })
        .then(apply)
        .catch((error) => {
          if (cancelled) return;
          setCompanionStatus({ listening: false, port: null });
          setCompanionError(errorMessage(error));
        });
    }
    return () => { cancelled = true; };
  }, [companionEnabled, companionPort]);

  useEffect(() => {
    if (!IS_TAURI) return;
    let cancelled = false;
    void createThemeWindowIcon(uiTheme)
      .then(async (icon) => {
        if (!cancelled) await getCurrentWindow().setIcon(icon);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [uiTheme]);

  const background = useBackgroundImage(t);

  useEffect(() => {
    document.documentElement.lang = uiLocale;
  }, [uiLocale]);

  // Build and judging preferences (Settings → build & judging).
  const [compileProfile, setCompileProfile] = useSetting("compileProfile");
  const [profileFlags] = useSetting("profileFlags");
  const [precompileHeaders] = useSetting("precompileHeaders");
  const [floatTolerance] = useSetting("floatTolerance");
  const buildOptions = () => ({ compileFlags: splitFlags(profileFlags[compileProfile]), precompileHeaders });

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
      // The generic `monospace` baseline is Consolas on Windows and Menlo on macOS, so the
      // stock face of each platform measures identically to it and has to be kept explicitly.
      if (alwaysInstalledFontIds.includes(font.id)) return true;
      const family = font.label.replace(/'/g, "");
      context.font = `72px '${family}', monospace`;
      return Math.abs(context.measureText(sample).width - baseline) > 0.1;
    });
    setSystemFonts(installed.length ? installed : [fallbackEditorFont]);
  }, []);

  useEffect(() => {
    if (!IS_TAURI) return;
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

  /**
   * Dividers trade weight between the two panels they sit between, so the rest of the
   * workspace keeps the size it had. Weight is a share of the container, which keeps a
   * layout looking the same when the window is resized.
   */
  const startPanelResize = (
    axis: "x" | "y",
    before: PanelId,
    after: PanelId,
    pair: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    event.preventDefault();
    const box = workspace.getBoundingClientRect();
    resizeRef.current = {
      axis, before, after,
      start: axis === "x" ? event.clientX : event.clientY,
      // Pixels the two panels cover together: their combined weight maps onto this, so
      // the divider follows the pointer one-to-one.
      span: (axis === "x" ? box.width : box.height) * pair,
      beforeWeight: weightOf(before, axis === "x" ? "width" : "height"),
      afterWeight: weightOf(after, axis === "x" ? "width" : "height"),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add(axis === "x" ? "panel-resizing" : "panel-resizing-y");
  };

  useEffect(() => {
    const resize = (event: PointerEvent) => {
      const current = resizeRef.current;
      if (!current || !current.span) return;
      const moved = (current.axis === "x" ? event.clientX : event.clientY) - current.start;
      const total = current.beforeWeight + current.afterWeight;
      // The pair keeps its combined weight; the pointer decides how it is split.
      const limit = 0.08 * total;
      const beforeWeight = Math.max(limit, Math.min(total - limit, current.beforeWeight + moved / current.span * total));
      const key = current.axis === "x" ? "width" : "height";
      setPanelWeights((weights) => ({
        ...weights,
        [current.before]: { ...weights[current.before], [key]: beforeWeight },
        [current.after]: { ...weights[current.after], [key]: total - beforeWeight },
      }));
    };
    const finish = () => {
      if (!resizeRef.current) return;
      resizeRef.current = null;
      document.body.classList.remove("panel-resizing");
      document.body.classList.remove("panel-resizing-y");
    };
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => { window.removeEventListener("pointermove", resize); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); };
  }, []);

  // Tabs in the order they were last active, newest first, so closing one can return to
  // the tab that was in use before it.
  const tabHistoryRef = useRef<string[]>([]);
  const activateTab = (tab: ProblemTab) => {
    tabHistoryRef.current = [tab.id, ...tabHistoryRef.current.filter((id) => id !== tab.id)];
    clearDiagnostics();
    setActiveTabId(tab.id);
    setFileStatus(tab.dirty ? "modified" : workspacePath ? "saved" : "not saved");
  };

  // When the code was last typed into, so a save that was already on its way can tell it
  // did not catch the newest edit.
  const lastEditAtRef = useRef(0);
  const markActiveDirty = () => {
    lastEditAtRef.current = Date.now();
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
    setExplorerSelection({ kind: "file", filename: file.filename });
    const openTab = tabs.find((tab) => fileKey(tab.filename) === fileKey(file.filename));
    if (openTab) {
      activateTab(openTab);
      return;
    }
    setTabs((items) => [...items, file]);
    activateTab(file);
  };

  /** Opens every one of `files` as a tab and leaves the first of them in front. */
  const openSavedFiles = (files: ProblemTab[]) => {
    if (!files.length) return;
    const fresh = files.filter((file) => !tabs.some((tab) => fileKey(tab.filename) === fileKey(file.filename)));
    if (fresh.length) setTabs((items) => [...items, ...fresh]);
    const first = files[0];
    const focus = tabs.find((tab) => fileKey(tab.filename) === fileKey(first.filename)) || first;
    setExplorerSelection({ kind: "file", filename: focus.filename });
    activateTab(focus);
  };

  const changeActiveLanguage = async (next: Language) => {
    if (!activeTab || next === language) return;
    const requestedFilename = filenameForLanguage(activeTab.filename, next);
    const occupied = [...tabs, ...savedFiles]
      .filter((tab) => tab.id !== activeTab.id && fileKey(tab.filename) !== fileKey(activeTab.filename))
      .map((tab) => tab.filename);
    const filename = mexFilename(requestedFilename, occupied);
    const saved = workspacePath && savedFiles.find((tab) => fileKey(tab.filename) === fileKey(activeTab.filename));
    let resolvedFilename = filename;
    if (saved) {
      try {
        const result = await invoke<WorkspaceFileResult>("rename_workspace_file", { request: { folderPath: workspacePath, filename: activeTab.filename, newFilename: filename } });
        resolvedFilename = result.filename;
        setSavedFiles((items) => items.map((tab) => fileKey(tab.filename) === fileKey(activeTab.filename) ? { ...tab, filename: resolvedFilename, language: next } : tab));
      } catch (error) {
        setFileStatus(errorMessage(error));
        return;
      }
    }
    setTabs((items) => items.map((tab) => tab.id === activeTabId ? { ...tab, filename: resolvedFilename, language: next, dirty: false } : tab));
    setFileStatus("saved");
    setAutoSaveRevision((revision) => revision + 1);
  };

  const deleteSavedFile = async () => {
    const file = deleteConfirmFile;
    if (!file || !workspacePath) return;
    const isSaved = savedFiles.some((item) => fileKey(item.filename) === fileKey(file.filename)) && !file.dirty;
    if (!isSaved) {
      setSavedFiles((items) => items.filter((item) => fileKey(item.filename) !== fileKey(file.filename)));
      setExplorerSelection((selected) => selected?.kind === "file" && fileKey(selected.filename) === fileKey(file.filename) ? null : selected);
      closeProblem(file.id);
      setDeleteConfirmFile(null);
      return;
    }
    try {
      await invoke("delete_workspace_file", { request: { folderPath: workspacePath, filename: file.filename } });
      const index = tabs.findIndex((tab) => fileKey(tab.filename) === fileKey(file.filename));
      const remainingTabs = tabs.filter((tab) => fileKey(tab.filename) !== fileKey(file.filename));
      setSavedFiles((items) => items.filter((tab) => fileKey(tab.filename) !== fileKey(file.filename)));
      setExplorerSelection((selected) => selected?.kind === "file" && fileKey(selected.filename) === fileKey(file.filename) ? null : selected);
      setTabs((items) => items.filter((tab) => fileKey(tab.filename) !== fileKey(file.filename)));
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
      setFileStatus(errorMessage(error));
    }
  };

  const duplicateWorkspaceFile = async (file: ProblemTab) => {
    if (!workspacePath) return;
    const extension = file.filename.slice(file.filename.lastIndexOf("."));
    const base = file.filename.slice(0, file.filename.length - extension.length);
    const filename = mexFilename(`${base} copy${extension}`, [...savedFiles, ...tabs].map((item) => item.filename));
    if (!savedFiles.some((item) => fileKey(item.filename) === fileKey(file.filename))) {
      const tab: ProblemTab = { ...file, id: crypto.randomUUID(), filename, title: filename.replace(/\.[^.]+$/, ""), dirty: true };
      const nextTabs = [...tabs, tab];
      try { await persistTabs(nextTabs, tab.id); }
      catch (error) { setFileStatus(errorMessage(error)); }
      return;
    }
    try {
      const result = await invoke<WorkspaceFileResult>("duplicate_workspace_file", { request: { folderPath: workspacePath, filename: file.filename, newFilename: filename } });
      const tab = makeTab(result);
      setSavedFiles((items) => [...items, tab]);
      setTabs((items) => [...items, tab]);
      activateTab(tab);
      setFileStatus("saved");
    } catch (error) { setFileStatus(errorMessage(error)); }
  };

  /** Returns the name the file now has, or null when nothing was renamed. */
  const commitWorkspaceRename = async (original: ProblemTab, requestedFilename: string): Promise<string | null> => {
    if (!workspacePath) return null;
    const typed = requestedFilename.trim();
    if (!typed) return null;
    if (!languageFromFilename(typed) && /\.[^./\\]+$/.test(explorerBasename(typed))) {
      setFileStatus("Use a .cpp, .cc, .cxx or .py extension, or leave it off.");
      return null;
    }
    // A bare name takes the default language, so `foo` becomes foo.py or foo.cpp.
    const requested = languageFromFilename(typed) ? typed : filenameForLanguage(`${typed}.cpp`, defaultLanguage);
    if (fileKey(requested) === fileKey(original.filename) && requested === original.filename) return original.filename;
    const occupied = [...savedFiles, ...tabs]
      .filter((file) => file.id !== original.id && fileKey(file.filename) !== fileKey(original.filename))
      .map((file) => file.filename);
    const filename = mexFilename(requested, occupied);
    if (!savedFiles.some((file) => fileKey(file.filename) === fileKey(original.filename))) {
      const nextLanguage = languageFromFilename(filename);
      setTabs((items) => items.map((tab) => tab.id === original.id ? { ...tab, filename, title: filename.replace(/\.[^.]+$/, ""), language: nextLanguage || tab.language, dirty: false } : tab));
      setFileStatus("saved");
      setAutoSaveRevision((revision) => revision + 1);
      return filename;
    }
    try {
      const result = await invoke<WorkspaceFileResult>("rename_workspace_file", { request: { folderPath: workspacePath, filename: original.filename, newFilename: filename } });
      const update = (tab: ProblemTab): ProblemTab => tab.id === original.id || fileKey(tab.filename) === fileKey(original.filename)
        ? { ...tab, filename: result.filename, title: result.title, language: result.language }
        : tab;
      setTabs((items) => items.map(update));
      setSavedFiles((items) => items.map((tab) => fileKey(tab.filename) === fileKey(original.filename) ? { ...update(tab), dirty: false } : tab));
      setExplorerSelection((selected) => selected?.kind === "file" && fileKey(selected.filename) === fileKey(original.filename) ? { kind: "file", filename: result.filename } : selected);
      setContest((current) => current && rekeyContest(current, (key) => key === fileKey(original.filename) ? fileKey(result.filename) : key));
      setFileStatus("saved");
      return result.filename;
    } catch (error) {
      setTabs((items) => items.map((tab) => tab.id === original.id ? { ...tab, filename: original.filename, language: original.language } : tab));
      setFileStatus(errorMessage(error));
      return null;
    }
  };

  const beginSourceEdit = (file: ProblemTab) => {
    setSourceFile(file);
    setSourceValue(file.source || "other");
    setSourceUrlValue(file.sourceUrl || inferredSourceUrl(file.source, file.filename) || "");
  };

  const updateProblemSource = async () => {
    if (!sourceFile || !workspacePath) return;
    const sourceUrl = sourceValue === "other" ? undefined : sourceUrlValue.trim() || undefined;
    try {
      await invoke("update_workspace_source", { request: { folderPath: workspacePath, filename: sourceFile.filename, source: sourceValue, sourceUrl } });
      const update = (file: ProblemTab): ProblemTab => fileKey(file.filename) === fileKey(sourceFile.filename)
        ? { ...file, source: sourceValue, sourceUrl, judgeStatus: undefined, submissionUrl: undefined }
        : file;
      setTabs((items) => items.map(update));
      setSavedFiles((items) => items.map(update));
      setSourceFile(null);
      setFileStatus("source updated");
    } catch (error) {
      setFileStatus(errorMessage(error));
    }
  };

  /** A scan of the folder for what changed behind the editor's back; `announce` is for one asked for by hand. */
  const rescanWorkspaceFiles = (announce = false, force = false) =>
    rescanWorkspace(setFileStatus, announce ? t("explorerRescanned") : undefined, force);
  const rescanWorkspaceFilesRef = useLatest(rescanWorkspaceFiles);
  // Coming back to the editor is when a change made elsewhere matters, and it is the one
  // moment a scan cannot be mistaken for the editor reacting to its own writes.
  useEffect(() => {
    const rescan = () => { if (document.visibilityState === "visible") void rescanWorkspaceFilesRef.current(); };
    window.addEventListener("focus", rescan);
    document.addEventListener("visibilitychange", rescan);
    return () => {
      window.removeEventListener("focus", rescan);
      document.removeEventListener("visibilitychange", rescan);
    };
  }, []);
  const beginBlankFile = (parentDirectory = "") => {
    dismissExplorerOverlay("menu");
    const parent = normalizedExplorerPath(parentDirectory);
    const siblingNames = [...savedFiles, ...tabs].filter((file) => fileKey(explorerParent(file.filename)) === fileKey(parent)).map((file) => explorerBasename(file.filename));
    setEntryParentDirectory(parent);
    setBlankFilename(nextDefaultFilename(siblingNames, defaultLanguage));
    setBlankFilenameOpen(true);
  };

  // ── What the explorer asks of the app ──
  // The explorer names a file; the app knows it as its open tab when it has one, which is
  // how the explorer lists it, and as the saved file otherwise.
  const explorerRef = useRef<ExplorerHandle | null>(null);
  const explorerOverlays = useExplorerOverlays();
  const explorerFile = (filename: string) => [...tabs, ...savedFiles].find((file) => fileKey(file.filename) === fileKey(filename));
  const openExplorerFile = useStableCallback((filename: string) => {
    const file = explorerFile(filename);
    if (file) openSavedFile(file);
  });
  const renameExplorerFile = useStableCallback(async (filename: string, requested: string) => {
    const original = explorerFile(filename);
    return original ? commitWorkspaceRename(original, requested) : null;
  });
  const runExplorerFileCommand = useStableCallback((command: ExplorerFileCommand, filename: string) => {
    const file = explorerFile(filename);
    if (!file) return;
    if (command === "importTests") beginTestcaseImport(file);
    else if (command === "duplicate") void duplicateWorkspaceFile(file);
    else if (command === "setSource") beginSourceEdit(file);
    else setDeleteConfirmFile(file);
  });
  /** A folder was renamed or moved: the tabs of its files and the contest board go with it. */
  const followRelocatedFolder = useStableCallback(({ renamedFiles, movePath }: RelocatedFolder) => {
    setTabs((items) => items.map((tab) => { const next = renamedFiles.get(fileKey(tab.filename)); return next ? { ...tab, filename: next } : tab; }));
    setContest((current) => current && { ...rekeyContest(current, (key) => fileKey(renamedFiles.get(key) || key)), folder: movePath(current.folder) });
  });
  /** A folder was deleted: the tabs of the files that were in it close. */
  const closeDeletedFiles = useStableCallback((removedKeys: Set<string>) => {
    const remainingTabs = tabs.filter((tab) => !removedKeys.has(fileKey(tab.filename)));
    setTabs((items) => items.filter((tab) => !removedKeys.has(fileKey(tab.filename))));
    if (activeTab && removedKeys.has(fileKey(activeTab.filename))) {
      const next = remainingTabs[0];
      if (next) activateTab(next);
      else { setActiveTabId(""); clearDiagnostics(); }
    }
  });
  const explorerProps: ExplorerProps = {
    t,
    openFiles: openExplorerFiles,
    activeFilename: activeTab?.filename || "",
    openFile: openExplorerFile,
    newFile: useStableCallback(beginBlankFile),
    renameFile: renameExplorerFile,
    fileCommand: runExplorerFileCommand,
    onFolderRelocated: followRelocatedFolder,
    onFilesDeleted: closeDeletedFiles,
    showStatus: setFileStatus,
  };

  const createWorkspace = async () => {
    try {
      const folderPath = await open({ directory: true, multiple: false, title: "Create Mild Editor project" });
      if (!folderPath || Array.isArray(folderPath)) return;
      const created = await invoke<{ folderPath: string }>("create_workspace", { request: { folderPath } });
      setWorkspacePath(created.folderPath);
      setTabs([]);
      setSavedFiles([]);
      setWorkspaceDirectories([]);
      setActiveTabId("");
      setExplorerSelection(null);
      clearDiagnostics();
      setFileStatus("project created");
    } catch (error) { setFileStatus(errorMessage(error)); }
  };

  const persistTabs = async (nextTabs: ProblemTab[], nextActiveId: string) => {
    if (!workspacePath) return false;
    const snapshot = nextTabs.map((tab) => ({ ...tab, dirty: false }));
    const persistedTabs = [
      ...savedFiles.map((savedFile) => snapshot.find((tab) => fileKey(tab.filename) === fileKey(savedFile.filename)) || savedFile),
      ...snapshot.filter((tab) => !savedFiles.some((savedFile) => fileKey(savedFile.filename) === fileKey(tab.filename))),
    ];
    const saved = await invoke<LoadedWorkspace>("save_workspace", {
      request: {
        folderPath: workspacePath,
        problems: persistedTabs.map(savedProblem),
      },
    });
    setWorkspacePath(saved.folderPath);
    settleSavedTabs(snapshot, nextTabs);
    setSavedFiles(persistedTabs);
    const nextActive = snapshot.find((tab) => tab.id === nextActiveId);
    if (nextActive) activateTab(nextActive);
    setFileStatus("saved");
    return true;
  };

  const createBlankProblem = async (requestedFilename: string) => {
    const diskFiles = workspacePath ? await invoke<string[]>("list_workspace_source_filenames", { request: { folderPath: workspacePath } }) : [];
    const occupiedNames = [...savedFiles.map((tab) => tab.filename), ...tabs.map((tab) => tab.filename), ...diskFiles];
    const requestedPath = requestedFilename.trim() || nextDefaultFilename(occupiedNames, defaultLanguage);
    const typedName = entryParentDirectory ? `${entryParentDirectory}/${explorerBasename(requestedPath)}` : requestedPath;
    const detectedLanguage = languageFromFilename(typedName);
    if (!detectedLanguage && /(^|[\\/])[^\\/]+\.[^\\/.]+$/.test(typedName)) return;
    const withExtension = detectedLanguage ? typedName : filenameForLanguage(`${typedName}.cpp`, defaultLanguage);
    const occupied = new Set(occupiedNames);
    const filename = mexFilename(withExtension, occupied);
    if (entryParentDirectory) expandDirectories(entryParentDirectory);
    const fileLanguage = languageFromFilename(filename) || defaultLanguage;
    const title = explorerBasename(filename).replace(/\.[^.]+$/, "");
    const createdAt = new Date();
    const renderedCpp = renderTemplateWithCursor(storedTemplate("cpp", "other"), { source: "other", filename, title, url: "", now: createdAt });
    const renderedPython = renderTemplateWithCursor(storedTemplate("python", "other"), { source: "other", filename, title, url: "", now: createdAt });
    const tab: ProblemTab = {
      id: crypto.randomUUID(),
      title,
      filename,
      language: fileLanguage,
      codes: {
        cpp: renderedCpp.code,
        python: renderedPython.code,
      },
      tests: [blankTest()],
      source: "other",
      modifiedAt: Date.now(),
    };
    const cursorOffset = fileLanguage === "cpp" ? renderedCpp.cursorOffset : renderedPython.cursorOffset;
    if (cursorOffset !== undefined) pendingTemplateCursorRef.current = { tabId: tab.id, language: fileLanguage, offset: cursorOffset };
    const nextTabs = [...tabs, tab];
    try {
      if (!(await persistTabs(nextTabs, tab.id))) {
        setTabs((items) => [...items, tab]);
        activateTab(tab);
      }
    } catch (error) {
      setTabs((items) => [...items, tab]);
      activateTab(tab);
      setFileStatus(errorMessage(error));
    }
  };

  const newProblem = () => {
    void createWorkspace();
  };

  const beginImport = () => {
    if (!workspacePath) return;
    setNewFileImportPending(true);
    setAtCoderOpen(true);
  };

  const cancelProblemImport = () => {
    setAtCoderOpen(false);
    if (newFileImportPending) {
      setEntryParentDirectory("");
      setBlankFilename(nextDefaultFilename([...savedFiles, ...tabs].map((file) => file.filename), defaultLanguage));
      setBlankFilenameOpen(true);
    }
    setNewFileImportPending(false);
    setTestcaseImportTarget(null);
    setAtCoderUrl("");
  };

  const beginTestcaseImport = (file: ProblemTab) => {
    setTestcaseImportTarget(file);
    setNewFileImportPending(false);
    setAtCoderUrl(file.sourceUrl || inferredSourceUrl(file.source, file.filename) || "");
    setAtCoderOpen(true);
  };

  const confirmBlankProblem = () => {
    void createBlankProblem(blankFilename);
    setBlankFilenameOpen(false);
    setBlankFilename("");
    setEntryParentDirectory("");
  };

  const closeProblem = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    const closed = tabs.find((tab) => tab.id === id);
    if (closed && savedFiles.some((file) => fileKey(file.filename) === fileKey(closed.filename))) {
      closedTabsRef.current = [closed.filename, ...closedTabsRef.current.filter((name) => fileKey(name) !== fileKey(closed.filename))].slice(0, 20);
    }
    const remaining = tabs.filter((tab) => tab.id !== id);
    tabHistoryRef.current = tabHistoryRef.current.filter((item) => item !== id);
    if (!remaining.length) {
      clearDiagnostics();
      setTabs([]);
      setActiveTabId("");
      setFileStatus("not saved");
      return;
    }
    setTabs(remaining);
    if (id === activeTabId) {
      // Go back to the tab that was active before this one, so Ctrl+W lands where you
      // came from every time. With no history left, the neighbour on the left: the same
      // rule whether the closed tab was in the middle of the strip or at its end.
      const previous = tabHistoryRef.current
        .map((item) => remaining.find((tab) => tab.id === item))
        .find((tab): tab is ProblemTab => Boolean(tab));
      activateTab(previous ?? remaining[Math.max(0, index - 1)]);
      // Whether the close came from the keyboard or the tab's button, typing continues in
      // the editor; the button that had focus is gone with the tab.
      editorRef.current?.focus();
    }
  };

  const requestCloseProblem = (id: string) => {
    const tab = tabs.find((item) => item.id === id);
    if (tab && (tab.dirty || !workspacePath)) {
      setCloseConfirmTabId(id);
      return;
    }
    closeProblem(id);
  };

  /** Reopens the most recently closed tab, skipping any whose file has since gone. */
  const reopenClosedTab = () => {
    while (closedTabsRef.current.length) {
      const filename = closedTabsRef.current.shift() as string;
      if (tabs.some((tab) => fileKey(tab.filename) === fileKey(filename))) continue;
      const file = savedFiles.find((item) => fileKey(item.filename) === fileKey(filename));
      if (file) { openSavedFile(file); return; }
    }
    setFileStatus(t("noClosedTabs"));
  };

  /** Ctrl+W with the problem browser focused: the panel or window goes, and typing resumes in the editor. */
  const closeProblemBrowser = () => {
    browserClosedAtRef.current = Date.now();
    cefFocusedRef.current = false;
    setProblemPanelOpen(false);
    editorRef.current?.focus();
  };

  /**
   * Ctrl+W closes what has the keyboard: the problem browser when its page or URL field
   * does, otherwise the file in the editor.
   */
  const closeWithShortcut = () => {
    if (Date.now() - browserClosedAtRef.current < 400) return;
    const inToolbar = document.activeElement instanceof Element && Boolean(document.activeElement.closest(".problem-panel"));
    if (problemPanelOpen && (cefFocusedRef.current || inToolbar)) {
      closeProblemBrowser();
      return;
    }
    if (activeTab) requestCloseProblem(activeTab.id);
  };
  const closeWithShortcutRef = useLatest(closeWithShortcut);
  const closeProblemBrowserRef = useLatest(closeProblemBrowser);


  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.updateOptions({ stickyScroll: { enabled: false } });
    diagnosticDecorationsRef.current = editor.createDecorationsCollection();
    // Monaco binds these to insert-line-after/before, which would swallow the run
    // shortcuts while the editor has focus. They must run the command here: once
    // Monaco has called preventDefault on the keystroke, WebKit no longer offers it
    // to the native menu bar, so the accelerator there never fires in this case.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => submitRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => interactiveRef.current());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => paletteRef.current());
    if (language === "cpp") void connectClangd(editor, monaco);
  };

  const connectClangd = async (editor = editorRef.current, monaco = monacoRef.current) => {
    if (!editor || !monaco || !IS_TAURI) return;
    setClangdStatus("connecting");
    await clangdClientRef.current?.dispose();
    const client = new ClangdClient(monaco, editor);
    clangdClientRef.current = client;
    try {
      const info = await client.start(getSetting("clangdPath") || null, workspacePath, activeTab?.filename || "A.cpp", codes.cpp, atcoderLibraryPath || null);
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
    if (model && monaco) {
      monaco.editor.setModelMarkers(model, "mild-compiler", []);
      monaco.editor.setModelMarkers(model, "mild-compiler-warnings", []);
    }
    diagnosticDecorationsRef.current?.clear();
  };

  /** Warnings from a build that succeeded: marked in the editor, without taking the caret or hiding any output. */
  const showCompileWarnings = (stderr: string) => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    const markers: Monaco.editor.IMarkerData[] = [];
    for (const match of stderr.matchAll(/main\.cpp:(\d+):(\d+):\s+warning:\s+(.+)/g)) {
      const line = Math.min(Number(match[1]), model.getLineCount());
      const column = Math.min(Number(match[2]), model.getLineMaxColumn(line));
      const word = model.getWordAtPosition({ lineNumber: line, column });
      markers.push({ startLineNumber: line, startColumn: word?.startColumn ?? column, endLineNumber: line, endColumn: word?.endColumn ?? Math.min(column + 1, model.getLineMaxColumn(line)), message: match[3].trim(), source: "g++", severity: monaco.MarkerSeverity.Warning });
    }
    monaco.editor.setModelMarkers(model, "mild-compiler-warnings", markers);
  };

  /**
   * Marks what a run reported. A compile error takes over: the caret moves to it and the test
   * shows no output. A failure at run time (a sanitizer report, a Python exception) only
   * marks its line, and the test keeps its output.
   */
  const showDiagnostics = (stderr: string, compileError = true) => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monaco || !model) return false;

    const markers: Monaco.editor.IMarkerData[] = [];
    const cppPattern = compileError
      ? /main\.cpp:(\d+):(\d+):\s+(fatal error|error|warning):\s+(.+)/g
      : /main\.cpp:(\d+):(\d+):\s+(runtime error):\s+(.+)/g;
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
      const syntaxMessage = stderr.match(/(?:SyntaxError|IndentationError|TabError):\s*(.+)/)?.[0]
        // An exception at run time ends the traceback with its own line.
        ?? (compileError ? undefined : stderr.split("\n").map((line) => line.trim()).filter((line) => /^\w+(?:\.\w+)*(?:Error|Exception|Interrupt)\b/.test(line)).at(-1));
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
    if (markers.length && !compileError) {
      editor.revealLineInCenterIfOutsideViewport(markers[0].startLineNumber);
      return false;
    }
    if (markers.length) {
      editor.revealPositionInCenter({ lineNumber: markers[0].startLineNumber, column: markers[0].startColumn });
      editor.setPosition({ lineNumber: markers[0].startLineNumber, column: markers[0].startColumn });
      editor.focus();
    }
    return markers.length > 0;
  };

  const openSettings = () => setSettingsPage("appearance");

  const insertSnippet = () => {
    const snippet = snippets.find((item) => item.id === insertSnippetId && item.language === language);
    const editor = editorRef.current;
    if (!snippet || !editor) return;
    editor.trigger("mild-snippet", "editor.action.insertSnippet", { snippet: snippet.code });
    editor.focus();
    setInsertSnippetId("");
  };

  /** Settings → template → "Apply to editor": the template as it stands in the dialog replaces the open file's code. */
  const applyTemplate = (template: string, templateSource: ProblemSource, templateLanguage: Language) => {
    clearDiagnostics();
    if (!activeTab) return;
    const rendered = renderTemplateWithCursor(template, { source: templateSource, filename: activeTab.filename, title: activeTab.title, url: activeTab.sourceUrl });
    if (rendered.cursorOffset !== undefined) pendingTemplateCursorRef.current = { tabId: activeTab.id, language: templateLanguage, offset: rendered.cursorOffset };
    patchActiveTab((tab) => ({ codes: { ...tab.codes, [templateLanguage]: rendered.code }, language: templateLanguage }));
    markActiveDirty();
    setSettingsPage(null);
  };

  const saveProblem = async (): Promise<boolean> => {
    try {
      let folderPath = workspacePath;
      if (!folderPath) {
        folderPath = await open({ directory: true, multiple: false, title: "Choose a workspace folder" });
      }
      if (!folderPath || Array.isArray(folderPath)) return false;
      setFileStatus("saving…");
      const startedAt = Date.now();
      const snapshot = tabs.map((tab) => ({ ...tab, dirty: false }));
      const saved = await invoke<LoadedWorkspace>("save_workspace", {
        request: {
          folderPath,
          problems: snapshot.map(savedProblem),
        },
      });
      setWorkspacePath(saved.folderPath);
      // Typing does not wait for the disk. A tab edited while this save was on its way keeps
      // its newer text and stays marked modified, so nothing typed in that moment is
      // mistaken for saved — which matters most with auto save writing every second.
      const editedSince = lastEditAtRef.current > startedAt;
      settleSavedTabs(snapshot, tabs);
      setSavedFiles((items) => {
        if (!items.length) return snapshot;
        const updated = new Map(snapshot.map((tab) => [fileKey(tab.filename), tab]));
        return [...items.map((tab) => updated.get(fileKey(tab.filename)) || tab), ...snapshot.filter((tab) => !items.some((item) => fileKey(item.filename) === fileKey(tab.filename)))];
      });
      setFileStatus(editedSince ? "modified" : "saved");
      return true;
    } catch (error) {
      setFileStatus(errorMessage(error));
      return false;
    }
  };

  // Auto save: a second after the typing stops, the same save Ctrl+S makes. Only inside a
  // workspace — a save without one asks for a folder, which no timer should do — and not
  // while tests run, which save first anyway.
  const activeTabDirty = Boolean(activeTab?.dirty);
  useEffect(() => {
    if (!autoSave || !workspacePath || !activeTabDirty || running) return;
    const timer = window.setTimeout(() => setAutoSaveRevision((revision) => revision + 1), 1000);
    return () => window.clearTimeout(timer);
  }, [autoSave, workspacePath, activeTabDirty, codes, running]);

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
      const loadedTabs = loaded.problems.map(makeTab);
      setWorkspacePath(loaded.folderPath);
      setPanelMode(loaded.panelMode === "interactive" ? "interactive" : "tests");
      setTabs([]);
      setSavedFiles(loadedTabs);
      clearDiagnostics();
      setActiveTabId("");
      setFileStatus("loaded");
    } catch (error) {
      setFileStatus(errorMessage(error));
    }
  };

  useEffect(() => {
    const remembered = localStorage.getItem(WORKSPACE_KEY);
    if (!remembered && !(IS_DEV_BUILD && IS_TAURI)) return;
    // Asking for the scratch folder first also recreates it, so a development build whose
    // workspace was deleted starts a new one instead of falling back to its parent.
    const opening = IS_DEV_BUILD && IS_TAURI
      ? invoke<string>("dev_workspace_path").then((scratch) => remembered || scratch)
      : Promise.resolve(remembered as string);
    void opening.then((lastWorkspace) => invoke<LoadedWorkspace>("load_workspace", { path: lastWorkspace })).then((loaded) => {
      const loadedTabs = loaded.problems.map(makeTab);
      let restoredFilenames: string[] = [];
      let restoredActiveFilename = "";
      try {
        const restored = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) || "{}");
        if (restored.workspacePath === loaded.folderPath && Array.isArray(restored.filenames)) {
          restoredFilenames = restored.filenames;
          restoredActiveFilename = typeof restored.activeFilename === "string" ? restored.activeFilename : "";
        }
      } catch { /* Ignore stale tab restore data. */ }
      const restoredTabs = restoredFilenames.map((filename) => loadedTabs.find((tab) => fileKey(tab.filename) === fileKey(filename))).filter((tab): tab is ProblemTab => Boolean(tab));
      const restoredActive = restoredTabs.find((tab) => fileKey(tab.filename) === fileKey(restoredActiveFilename)) || restoredTabs[0];
      setWorkspacePath(loaded.folderPath);
      setPanelMode(loaded.panelMode === "interactive" ? "interactive" : "tests");
      setTabs(restoredTabs);
      setSavedFiles(loadedTabs);
      clearDiagnostics();
      if (restoredActive) {
        setActiveTabId(restoredActive.id);
      } else setActiveTabId("");
      setFileStatus("loaded");
    }).catch(() => localStorage.removeItem(WORKSPACE_KEY));
  }, []);

  useEffect(() => {
    if (workspacePath) localStorage.setItem(WORKSPACE_KEY, workspacePath);
  }, [workspacePath]);

  // An update left its notes behind; this is the build it was talking about. The notes are
  // only dropped once they have been shown, so a version that arrives late cannot lose them.
  useEffect(() => {
    if (!appVersionResolved) return;
    let stored: { version?: string; notes?: string } | null = null;
    try { stored = JSON.parse(localStorage.getItem(RELEASE_NOTES_KEY) || "null"); } catch { localStorage.removeItem(RELEASE_NOTES_KEY); }
    if (!stored?.version || stored.version.replace(/^v/, "") !== appVersion.replace(/^v/, "")) return;
    localStorage.removeItem(RELEASE_NOTES_KEY);
    setReleaseNotes({ version: stored.version, notes: stored.notes?.trim() || undefined });
  }, [appVersion, appVersionResolved]);

  // The folded folders come back with the path, in the store; the folders themselves are asked for here.
  useEffect(() => {
    void refreshDirectories(setFileStatus, workspacePath);
  }, [workspacePath]);

  useEffect(() => {
    if (!workspacePath) return;
    localStorage.setItem(OPEN_TABS_KEY, JSON.stringify({ workspacePath, filenames: tabs.map((tab) => tab.filename), activeFilename: activeTab?.filename || "" }));
  }, [activeTab?.filename, tabs, workspacePath]);

  /** The page the last import was asked for from: a contest page tells when the contest runs. */
  const importPageRef = useRef("");
  /**
   * Contest mode for a contest just imported, when the setting asks for it: on the folder the
   * problems went into, with the contest's own clock. A contest that is over, or a clock that
   * is already running, is left alone, and the status bar says why.
   */
  const startImportedContest = async (filenames: string[], urls: string[]) => {
    const folder = commonFolder(filenames);
    if (!folder) { setFileStatus(t("contestAutoNoFolder")); return; }
    if (contestRunningRef.current) { setFileStatus(t("contestAutoBusy")); return; }
    let schedule: ContestSchedule | null = null;
    try {
      schedule = await invoke<ContestSchedule | null>("contest_schedule", { urls: urls.filter(Boolean) });
    } catch { /* treated as unknown below */ }
    const plan = contestPlan(schedule, Date.now());
    if ("skip" in plan) {
      setFileStatus(t(plan.skip === "ended" ? "contestAutoEnded" : plan.skip === "upcoming" ? "contestAutoUpcoming" : "contestAutoUnknown"));
      return;
    }
    setContest({ startedAt: plan.startedAt, durationMin: plan.durationMin, folder, solved: {} });
    // The board comes up with it: the contest has begun, and its problems are what matters now.
    setContestOpen(true);
    setFileStatus(`${t("contestAutoStarted")} · ${formatClock(plan.startedAt + plan.durationMin * 60_000 - Date.now())}`);
  };
  /**
   * `activate: false` adds the problems without taking the editor from what is open — the rest
   * of a contest loading behind the problem already being read. `contestClock: false` leaves the
   * contest clock to the import that opened the contest.
   */
  const addImportedProblemsNow = async (imported: ImportedAtCoderProblem[], renameDuplicates = false, contestImport = imported.length > 1, options: { activate?: boolean; contestClock?: boolean } = {}) => {
    const activate = options.activate !== false;
    const existingFiles = [...savedFiles, ...tabs].filter((file, index, files) => files.findIndex((item) => fileKey(item.filename) === fileKey(file.filename)) === index);
    const existingProblemIds = new Set(existingFiles.map((file) => problemIdentity(file.source, file.sourceUrl)).filter(Boolean));
    const incomingProblemIds = new Set<string>();
    const candidates = imported.filter((problem) => {
      const identity = problemIdentity(problem.source, problem.sourceUrl);
      if (identity && incomingProblemIds.has(identity)) return false;
      if (identity) incomingProblemIds.add(identity);
      return !(contestImport && identity && existingProblemIds.has(identity));
    });
    if (!candidates.length) {
      setAtCoderOpen(false);
      setNewFileImportPending(false);
      setAtCoderUrl("");
      setFileStatus("saved");
      return;
    }
    const importLanguage = defaultLanguage;
    const requestedNames = new Map(candidates.map((problem) => [
      problem.sourceUrl,
      importFolder(organizeImports, contestImport, problem) + importedFilename(problem.title, problem.suggestedFilename, importLanguage),
    ]));
    const collision = candidates.find((problem) => existingFiles.some((file) => fileKey(file.filename) === fileKey(requestedNames.get(problem.sourceUrl) || problem.suggestedFilename)));
    if (collision && !renameDuplicates && !contestImport) {
      const requested = requestedNames.get(collision.sourceUrl) || collision.suggestedFilename;
      setImportCollision({ existing: existingFiles.find((file) => fileKey(file.filename) === fileKey(requested))!, imported: candidates, contestImport });
      setAtCoderOpen(false);
      setNewFileImportPending(false);
      setAtCoderUrl("");
      return;
    }
    const diskFiles = workspacePath ? await invoke<string[]>("list_workspace_source_filenames", { request: { folderPath: workspacePath } }) : [];
    const used = new Set([...existingFiles.map((file) => file.filename), ...diskFiles]);
    const importedCursorOffsets = new Map<string, number>();
    const importedTabs = candidates.map((problem): ProblemTab => {
      const filename = mexFilename(requestedNames.get(problem.sourceUrl) || problem.suggestedFilename, used);
      used.add(filename);
      const createdAt = new Date();
      const renderedCpp = renderTemplateWithCursor(storedTemplate("cpp", problem.source), { source: problem.source, filename, title: problem.title, url: problem.sourceUrl, now: createdAt });
      const renderedPython = renderTemplateWithCursor(storedTemplate("python", problem.source), { source: problem.source, filename, title: problem.title, url: problem.sourceUrl, now: createdAt });
      const id = crypto.randomUUID();
      const cursorOffset = importLanguage === "cpp" ? renderedCpp.cursorOffset : renderedPython.cursorOffset;
      if (cursorOffset !== undefined) importedCursorOffsets.set(id, cursorOffset);
      return {
        id, title: problem.title, filename, language: importLanguage,
        codes: {
          cpp: renderedCpp.code,
          python: renderedPython.code,
        },
        tests: hydrateTests(problem.tests),
        source: problem.source,
        sourceUrl: problem.sourceUrl,
        limits: problem.limits,
        modifiedAt: Date.now(),
      };
    });
    if (!importedTabs.length) throw new Error("No problems were imported.");
    const firstCursorOffset = importedCursorOffsets.get(importedTabs[0].id);
    if (activate && firstCursorOffset !== undefined) pendingTemplateCursorRef.current = { tabId: importedTabs[0].id, language: importLanguage, offset: firstCursorOffset };
    const nextTabs = [...tabs, ...importedTabs];
    if (workspacePath) await persistTabs(nextTabs, activate ? importedTabs[0].id : "");
    else {
      setTabs((items) => [...items, ...importedTabs]);
      if (activate) activateTab(importedTabs[0]);
    }
    setAtCoderOpen(false);
    setNewFileImportPending(false);
    setAtCoderUrl("");
    setFileStatus("saved");
    if (contestImport && options.contestClock !== false && autoContestRef.current) void startImportedContest(importedTabs.map((tab) => tab.filename), [importPageRef.current, ...candidates.map((problem) => problem.sourceUrl)]);
  };
  /**
   * Imports run one at a time. Each works from the tabs and files as it finds them — which
   * names are taken, which tabs exist — and writes the whole list back, so two that overlap
   * (Competitive Companion posts problems as they are parsed) picked the same filename and
   * one dropped the other's tab; a workspace with one name twice then refused every save.
   * The next import starts only once this one's result has been rendered.
   */
  const addImportedNowRef = useLatest(addImportedProblemsNow);
  const autoContestRef = useLatest(autoContest);
  const importQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const nextRender = useNextRender();
  const addImportedProblems = (...args: Parameters<typeof addImportedProblemsNow>) => {
    const run = importQueueRef.current.then(() => addImportedNowRef.current(...args));
    importQueueRef.current = run.catch(() => undefined).then(nextRender);
    return run;
  };

  /**
   * Imports `url` with the editor's own importer. A contest arrives a problem at a time: the
   * first opens the moment it is fetched — the problems come in contest order — and the rest
   * are added behind it without taking the editor away from it. Throws what the backend says.
   */
  const problemPanelOpenRef = useLatest(problemPanelOpen);
  const problemBrowserModeRef = useLatest(problemBrowserMode);
  const openProblemUrlRef = useLatest((target: string) => openProblemUrl(target));
  const importFromJudge = async (url: string) => {
    importPageRef.current = url;
    const stream = crypto.randomUUID();
    const streamed = new Set<string>();
    const stopListening = await listen<{ stream: string; index: number; total: number; problem: ImportedAtCoderProblem }>("import-problem", (event) => {
      if (event.payload.stream !== stream || streamed.has(event.payload.problem.sourceUrl)) return;
      const first = streamed.size === 0;
      streamed.add(event.payload.problem.sourceUrl);
      void addImportedProblems([event.payload.problem], false, true, { activate: first, contestClock: first })
        .then(() => setFileStatus(`${t("importingContest")} ${streamed.size}/${event.payload.total}`))
        .catch((error) => setFileStatus(errorMessage(error)));
    });
    // The first problem's statement starts loading as soon as the contest's list is known,
    // while the import is still fetching that problem's samples.
    const stopFirstPage = await listen<{ stream: string; url: string }>("import-first-page", (event) => {
      if (event.payload.stream !== stream || !problemPanelOpenRef.current) return;
      if (problemBrowserModeRef.current === "window") void invoke("problem_window_open", { url: event.payload.url, focus: false }).catch(() => undefined);
      else openProblemUrlRef.current(event.payload.url);
    });
    let imported: ImportedAtCoderProblem[];
    try {
      imported = await invoke<ImportedAtCoderProblem[]>("import_problem", { url, stream });
      // The last events may land just after the answer does.
      const deadline = Date.now() + 1500;
      while (streamed.size && streamed.size < imported.length && Date.now() < deadline) await new Promise((resolve) => window.setTimeout(resolve, 50));
    } finally {
      stopListening();
      stopFirstPage();
    }
    if (!streamed.size) {
      await addImportedProblems(imported, false, isContestImportUrl(url));
      return;
    }
    const missing = imported.filter((problem) => !streamed.has(problem.sourceUrl));
    if (missing.length) await addImportedProblems(missing, false, true, { activate: false, contestClock: false });
    await importQueueRef.current;
    setFileStatus(`imported ${imported.length} problems`);
  };

  const importAtCoderProblem = async () => {
    if (!atCoderUrl.trim() || importInFlightRef.current) return;
    importInFlightRef.current = true;
    setImportingAtCoder(true);
    try {
      if (!testcaseImportTarget) {
        await importFromJudge(atCoderUrl.trim());
        return;
      }
      const imported = await invoke<ImportedAtCoderProblem[]>("import_problem", { url: atCoderUrl.trim() });
      if (testcaseImportTarget) {
        const targetStem = testcaseImportTarget.filename.replace(/\.[^.]+$/, "").toLocaleLowerCase();
        const selected = imported.find((problem) => problem.suggestedFilename.replace(/\.[^.]+$/, "").toLocaleLowerCase() === targetStem) || imported[0];
        if (!selected) throw new Error("No problem test cases were imported.");
        const nextTests = hydrateTests(selected.tests);
        if (workspacePath) {
          await invoke("save_workspace_tests", { request: { folderPath: workspacePath, filename: testcaseImportTarget.filename, tests: selected.tests, source: selected.source, sourceUrl: selected.sourceUrl } });
        }
        const update = (file: ProblemTab) => fileKey(file.filename) === fileKey(testcaseImportTarget.filename)
          ? { ...file, tests: nextTests, source: selected.source, sourceUrl: selected.sourceUrl }
          : file;
        setTabs((items) => items.map(update));
        setSavedFiles((items) => items.map(update));
        setAtCoderOpen(false);
        setTestcaseImportTarget(null);
        setAtCoderUrl("");
        setFileStatus("test cases imported");
        return;
      }
      await addImportedProblems(imported, false, isContestImportUrl(atCoderUrl.trim()));
    } catch (error) {
      const message = errorMessage(error);
      if (!message.startsWith(NEEDS_BROWSER)) setFileStatus(message);
      // Test cases for a file that exists go into that file, which a page import cannot aim at.
      else if (testcaseImportTarget) setFileStatus(t("importNeedsBrowserTests"));
      else {
        const url = atCoderUrl.trim();
        // The dialog is over the browser, and its work is done either way.
        setAtCoderOpen(false);
        setNewFileImportPending(false);
        setAtCoderUrl("");
        void importThroughBrowser(url);
      }
    } finally {
      importInFlightRef.current = false;
      setImportingAtCoder(false);
    }
  };

  /** An import error as the status line shows it; the backend's marker for "only a browser can" is not for reading. */
  const importErrorText = (error: unknown) => errorMessage(error).startsWith(NEEDS_BROWSER) ? t("importNeedsBrowser") : errorMessage(error);

  const importCompanionProblems = async (problems: ImportedAtCoderProblem[]) => {
    if (!problems.length) return;
    try {
      await addImportedProblems(problems);
      setFileStatus(problems.length > 1 ? `imported ${problems.length} problems` : "saved");
    } catch (error) {
      setFileStatus(errorMessage(error));
    }
  };

  // Competitive Companion sends a contest as `batch.size` separate POSTs, in contest order. Each
  // is added the moment it arrives and the first opens at once, rather than all of them waiting
  // for the last.
  const queueCompanionProblem = (problem: ImportedAtCoderProblem, batch?: CompanionProblem["batch"]) => {
    if (!batch || batch.size <= 1) {
      void importCompanionProblems([problem]);
      return;
    }
    const pending = companionBatchRef.current?.id === batch.id
      ? companionBatchRef.current
      : { id: batch.id, size: batch.size, problems: [], timer: 0, opened: false };
    companionBatchRef.current = pending;
    // The extension sends a contest's problems in contest order, so the first to arrive is the first problem.
    const first = !pending.opened;
    if (first) pending.opened = true;
    pending.problems = [...pending.problems, problem];
    void addImportedProblems([problem], false, true, { activate: first, contestClock: first })
      .then(() => setFileStatus(`${t("importingContest")} ${pending.problems.length}/${pending.size}`))
      .catch((error) => setFileStatus(errorMessage(error)));
    window.clearTimeout(pending.timer);
    const finish = () => {
      window.clearTimeout(pending.timer);
      if (companionBatchRef.current === pending) companionBatchRef.current = null;
      void importQueueRef.current.then(() => setFileStatus(`imported ${pending.problems.length} problems`));
    };
    if (pending.problems.length >= pending.size) { finish(); return; }
    // The extension can drop a problem it failed to parse, so never wait on the count alone.
    pending.timer = window.setTimeout(finish, 1500);
  };

  // Kept in a ref so the single event subscription always sees the current tab and workspace state.
  const companionHandlerRef = useRef<(problem: CompanionProblem) => void>(() => {});
  const companionWaitRef = useRef(0);
  // Counts what the extension has sent, for a caller waiting to see whether its request was answered.
  const companionArrivalsRef = useRef(0);
  useEffect(() => {
    companionHandlerRef.current = (problem) => {
      window.clearTimeout(companionWaitRef.current);
      companionArrivalsRef.current += 1;
      queueCompanionProblem(companionToImported(problem), problem.batch);
    };
  });

  const editorCanImport = (url: string) => {
    try {
      const host = new URL(url).hostname;
      return ["atcoder.jp", "codeforces.com", "doj.kr"].some((site) => host === site || host.endsWith(`.${site}`));
    } catch { return false; }
  };

  // The panel's import button. Competitive Companion, when installed, parses the page it
  // is looking at (a contest page yields every problem); without it the built-in importer
  // handles the judges it knows. Resolves to whether the extension was asked: its answer,
  // if it has one, arrives later as a `companion-problem` event.
  const importFromProblemPage = async () => {
    const url = browserStatusRef.current.url;
    if (!url || importInFlightRef.current) return false;
    importPageRef.current = url;
    // A whole contest goes through the editor's own importer first: it hands over each problem
    // as it is fetched, where Competitive Companion parses every problem before sending any.
    // Only a page the editor cannot read (a Cloudflare check) is left to the extension.
    if (isContestImportUrl(url) && editorCanImport(url)) {
      importInFlightRef.current = true;
      setImportingAtCoder(true);
      try {
        await importFromJudge(url);
        return false;
      } catch (error) {
        // Left to the extension only when it can read this page; otherwise asking again is no use.
        if (!errorMessage(error).startsWith(NEEDS_BROWSER) || companionCannotParse(url)) {
          setFileStatus(importErrorText(error));
          return false;
        }
      } finally {
        importInFlightRef.current = false;
        setImportingAtCoder(false);
      }
    }
    if (!companionCannotParse(url)) {
      try {
        if (await invoke<boolean>("browser_import_page", { port: companionPort })) {
          setFileStatus(t("problemImportWaiting"));
          window.clearTimeout(companionWaitRef.current);
          // A page that has only just loaded may not have its statement on screen yet (the
          // judges that render in the browser), and the extension says nothing when it finds
          // no problem. So the request is made once more before giving up — an answer comes
          // within a second when there is one, and its arrival cancels all of this.
          const arrivals = companionArrivalsRef.current;
          companionWaitRef.current = window.setTimeout(() => {
            if (companionArrivalsRef.current !== arrivals) return;
            void invoke("browser_import_page", { port: companionPort }).catch(() => undefined);
            companionWaitRef.current = window.setTimeout(() => setFileStatus(t("problemImportNothing")), 5000);
          }, 3000);
          return true;
        }
      } catch (error) {
        setFileStatus(errorMessage(error));
        return false;
      }
    }
    if (!editorCanImport(url)) {
      setFileStatus(t("problemImportUnsupported"));
      return false;
    }
    importInFlightRef.current = true;
    setImportingAtCoder(true);
    try {
      await importFromJudge(url);
    } catch (error) {
      setFileStatus(importErrorText(error));
    } finally {
      importInFlightRef.current = false;
      setImportingAtCoder(false);
    }
    return false;
  };
  const importFromProblemPageRef = useLatest(importFromProblemPage);

  useEffect(() => {
    if (!IS_TAURI) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<CompanionProblem>("companion-problem", (event) => companionHandlerRef.current(event.payload))
      .then((stopListening) => { if (disposed) stopListening(); else unlisten = stopListening; });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  const refreshSubmissionStatuses = async (silent = false) => {
    const files = [...savedFiles, ...tabs].filter((file, index, all) => file.sourceUrl && all.findIndex((candidate) => candidate.sourceUrl === file.sourceUrl) === index);
    if (!files.length || refreshingJudge) return;
    setRefreshingJudge(true);
    try {
      const results = await invoke<SubmissionStatusResult[]>("refresh_submission_statuses", {
        request: {
          folderPath: workspacePath,
          problems: files.map((file) => ({ source: file.source || "other", sourceUrl: file.sourceUrl })),
          atcoderHandle,
          codeforcesHandle,
          dojHandle,
        },
      });
      const update = (file: ProblemTab) => {
        const result = results.find((item) => item.sourceUrl === file.sourceUrl);
        return result?.status ? { ...file, judgeStatus: result.status, submissionUrl: result.submissionUrl || file.submissionUrl, submissions: result.submissions?.length ? result.submissions : file.submissions } : file;
      };
      setTabs((items) => items.map(update));
      setSavedFiles((items) => items.map(update));
      // A verdict on a submission newer than the last one seen is news. The first sight of a
      // problem only records where it stands, so old results are not announced at start-up.
      const seen = seenSubmissionsRef.current;
      const fresh: VerdictNotice[] = [];
      for (const result of results) {
        const before = seen.get(result.sourceUrl);
        const status = result.status || undefined;
        const submissionUrl = result.submissionUrl || undefined;
        if (before && status && !isPendingVerdict(status) && (before.status !== status || before.submissionUrl !== submissionUrl)) {
          const file = files.find((item) => item.sourceUrl === result.sourceUrl);
          if (file) fresh.push({ id: Date.now() + fresh.length, filename: file.filename, status, submissionUrl });
        }
        seen.set(result.sourceUrl, { status, submissionUrl });
      }
      if (fresh.length) {
        setVerdictNotices((items) => [...items.filter((item) => !fresh.some((notice) => fileKey(notice.filename) === fileKey(item.filename))), ...fresh].slice(-4));
        fresh.forEach((notice) => window.setTimeout(() => setVerdictNotices((items) => items.filter((item) => item.id !== notice.id)), VERDICT_NOTICE_MS));
      }
      if (!silent) setFileStatus(results.some((result) => result.status) ? "submission results updated" : "no matching submissions found");
    } catch (error) {
      if (!silent) setFileStatus(errorMessage(error));
    } finally {
      setRefreshingJudge(false);
    }
  };

  useEffect(() => {
    if (!workspacePath || (!atcoderHandle && !codeforcesHandle && !dojHandle)) return;
    // AtCoder's public submission feed is eventually consistent. Polling a
    // little more often makes virtual-contest verdicts appear soon after the
    // feed catches up without requiring a manual refresh.
    const timer = window.setInterval(() => void refreshSubmissionStatuses(true), 20_000);
    void refreshSubmissionStatuses(true);
    return () => window.clearInterval(timer);
    // File lists intentionally do not restart polling after every returned status update.
  }, [workspacePath, atcoderHandle, codeforcesHandle, dojHandle, judgeProblemKey]);

  const finishTabRename = () => {
    const draft = tabRenameDraft;
    setTabRenameDraft(null);
    if (!draft) return;
    const current = tabs.find((tab) => tab.id === draft.id);
    if (!current || current.filename === draft.value.trim()) return;
    void commitWorkspaceRename(current, draft.value);
  };

  const autoSaveTests = (nextTests: TestCase[], limits?: ProblemLimits) => {
    if (!workspacePath || !activeTab) return;
    const savedTests = nextTests.map(({ name, input, expected }) => ({ name, input, expected }));
    setSavedFiles((items) => items.map((file) => fileKey(file.filename) === fileKey(activeTab.filename) ? { ...file, tests: nextTests } : file));
    if (testSaveTimerRef.current !== null) window.clearTimeout(testSaveTimerRef.current);
    testSaveTimerRef.current = window.setTimeout(() => {
      testSaveTimerRef.current = null;
      void invoke("save_workspace_tests", { request: { folderPath: workspacePath, filename: activeTab.filename, tests: savedTests, limits } }).catch((error) => setFileStatus(errorMessage(error)));
    }, 250);
  };

  const updateTest = (id: number, patch: Partial<TestCase>) => {
    const next = tests.map((test) => (test.id === id ? { ...test, ...patch } : test));
    setTests(next);
    autoSaveTests(next);
  };

  /** Limits belong to the file, so they are saved with its test cases. */
  const updateLimits = (patch: ProblemLimits) => {
    if (!activeTab) return;
    const limits = { ...activeTab.limits, ...patch };
    const update = (file: ProblemTab): ProblemTab => fileKey(file.filename) === fileKey(activeTab.filename) ? { ...file, limits } : file;
    setTabs((items) => items.map(update));
    setSavedFiles((items) => items.map(update));
    autoSaveTests(tests, limits);
  };
  const limitInput = (value: string, min: number, max: number) => {
    const parsed = Math.round(Number(value));
    return value.trim() && Number.isFinite(parsed) && parsed > 0 ? Math.min(max, Math.max(min, parsed)) : undefined;
  };

  const addTest = () => {
    const id = Math.max(0, ...tests.map((test) => test.id)) + 1;
    const next: TestCase[] = [...tests.map((test) => ({ ...test, open: false })), { id, name: `test ${tests.length + 1}`, input: "", expected: "", output: "", error: "", status: "idle", open: true }];
    setTests(next);
    autoSaveTests(next);
  };

  const toggleRawOutput = (id: number) => {
    setRawOutputTests((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
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
    const checker = checkerProgram();
    setTests((items) => items.map((test, index) => ({ ...test, status: index === 0 ? "running" : "idle", output: "", error: "", checkerMessage: undefined })));
    const unlisten = await listen<TestResultEvent>("test-result", (event) => {
      if (event.payload.runId !== runId) return;
      const { index, result, checker: checked } = event.payload;
      const hasEditorDiagnostics = showDiagnostics(result.stderr || "", result.verdict === "ce");
      const expected = snapshot[index]?.expected || "";
      const verdict = judge(result, expected, floatTolerance, checked);
      setTests((items) => items.map((test, itemIndex) => itemIndex === index
        ? {
          ...test,
          output: hasEditorDiagnostics ? "" : result.stdout,
          error: hasEditorDiagnostics ? "" : result.stderr,
          timeMs: result.timeMs,
          memoryKb: result.memoryKb ?? undefined,
          status: verdict,
          checkerMessage: checked ? checked.message || (checked.accepted ? "" : t("checkerRejected")) : undefined,
          open: verdict === "ac" ? false : test.open,
        }
        : itemIndex === index + 1 && !runCancelledRef.current ? { ...test, status: "running" } : test));
    });

    try {
      const response = await invoke<{ results: NativeRunResult[]; compileWarnings?: string }>("run_code", {
        request: {
          language,
          code: codes[language],
          tests: tests.map(({ input, expected }) => ({ input, expected })),
          runId,
          atcoderLibraryPath: atcoderLibraryPath || null,
          timeLimitMs: (activeTab.limits?.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS) * (language === "cpp" && compileProfile === "debug" ? DEBUG_TIME_FACTOR : 1),
          memoryLimitMb: activeTab.limits?.memoryLimitMb ?? null,
          checker,
          ...buildOptions(),
        },
      });
      // Last, so the per-test results above cannot wipe them.
      showCompileWarnings(response.compileWarnings || "");
    } catch (error) {
      // Tauri rejects with the backend's message as a plain string.
      const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Execution failed";
      setTests((items) => items.map((test) => ({ ...test, status: "re", error: message })));
    } finally {
      unlisten();
      setTests((items) => items.map((test) => test.status === "running" ? { ...test, status: "idle" } : test));
      setRunning(false);
    }
  };

  const appendInteractive = (kind: InteractiveEntry["kind"], text: string) => {
    if (!text) return;
    setInteractiveLog((entries) => {
      const last = entries[entries.length - 1];
      // Output arrives in chunks that rarely line up with lines, so a run of the same
      // stream is kept as one entry and the transcript stays readable.
      const merged = last && last.kind === kind && kind !== "info"
        ? [...entries.slice(0, -1), { ...last, text: last.text + text }]
        : [...entries, { id: interactiveEntryIdRef.current++, kind, text }];
      return merged.length > 400 ? merged.slice(merged.length - 400) : merged;
    });
  };

  const startInteractive = async () => {
    if (!activeTab || interactiveStarting) return;
    if (!(await saveProblem())) return;
    clearDiagnostics();
    const sessionId = crypto.randomUUID();
    setInteractiveLog([]);
    setInteractiveDraft("");
    setInteractiveStarting(true);
    interactiveSessionRef.current = sessionId;
    setInteractiveRunning(true);
    // Logged before the call resolves so that a program which exits at once still shows
    // its start and exit lines in the order they happened.
    appendInteractive("info", t("interactiveStarted"));
    try {
      await invoke("start_interactive", {
        request: {
          language,
          code: codes[language],
          sessionId,
          atcoderLibraryPath: atcoderLibraryPath || null,
          ...buildOptions(),
        },
      });
      interactiveInputRef.current?.focus();
    } catch (error) {
      interactiveSessionRef.current = null;
      setInteractiveRunning(false);
      appendInteractive("stderr", errorMessage(error));
    } finally {
      setInteractiveStarting(false);
    }
  };

  const sendInteractive = async () => {
    const sessionId = interactiveSessionRef.current;
    if (!interactiveRunning || !sessionId) return;
    const text = interactiveDraft.endsWith("\n") ? interactiveDraft : `${interactiveDraft}\n`;
    setInteractiveDraft("");
    appendInteractive("input", text);
    try {
      await invoke("send_interactive", { request: { sessionId, text } });
    } catch (error) {
      appendInteractive("stderr", `${errorMessage(error)}\n`);
    }
  };

  const endInteractiveInput = async () => {
    if (!interactiveRunning) return;
    try {
      await invoke("close_interactive_input");
      appendInteractive("info", t("interactiveEofSent"));
    } catch (error) {
      appendInteractive("stderr", `${errorMessage(error)}\n`);
    }
  };

  const stopInteractive = () => {
    if (!interactiveRunning) return;
    void invoke("stop_interactive");
  };

  const exportSettings = async () => {
    try {
      const path = await save({ title: t("settingsExport"), defaultPath: `mild-editor-settings-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path) return;
      const settings: Record<string, string> = {};
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key && isPortableSetting(key)) settings[key] = localStorage.getItem(key) ?? "";
      }
      const contents = JSON.stringify({ kind: SETTINGS_BACKUP_KIND, version: appVersion, savedAt: new Date().toISOString(), settings }, null, 2);
      await invoke("export_settings_file", { request: { path, contents } });
      setFileStatus(t("settingsExported"));
    } catch (error) {
      setFileStatus(errorMessage(error));
    }
  };

  const importSettings = async () => {
    try {
      const path = await open({ multiple: false, title: t("settingsImport"), filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path || Array.isArray(path)) return;
      const contents = await invoke<string>("import_settings_file", { request: { path } });
      const parsed = JSON.parse(contents) as { kind?: string; settings?: Record<string, unknown> };
      if (parsed?.kind !== SETTINGS_BACKUP_KIND || !parsed.settings || typeof parsed.settings !== "object") {
        setFileStatus(t("settingsImportWrongFile"));
        return;
      }
      const entries = Object.entries(parsed.settings).filter((entry): entry is [string, string] => isPortableSetting(entry[0]) && typeof entry[1] === "string");
      // Settings the backup does not mention are cleared, so what comes back is the setup
      // that was exported rather than a mix of it and whatever this machine had.
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index);
        if (key && isPortableSetting(key)) localStorage.removeItem(key);
      }
      for (const [key, value] of entries) localStorage.setItem(key, value);
      setFileStatus(t("settingsImported"));
      // Almost every setting is read once at start-up, so the only honest way to apply a
      // restored set is to start again.
      window.setTimeout(() => window.location.reload(), 600);
    } catch (error) {
      setFileStatus(errorMessage(error));
    }
  };

  const checkForUpdates = async () => {
    if (!UPDATES_SUPPORTED) { setUpdateStatus({ phase: "unavailable" }); return; }
    setUpdateStatus((current) => ({ ...current, phase: "checking", error: undefined }));
    try {
      const update = await invoke<AvailableUpdate | null>("check_update");
      pendingUpdateRef.current = update;
      if (update) {
        setUpdateStatus({ phase: "available", version: update.version, notes: update.notes || undefined });
        setUpdateNoticeDismissed(false);
      } else {
        setUpdateStatus({ phase: "up-to-date" });
      }
    } catch (error) {
      setUpdateStatus({ phase: "error", error: errorMessage(error) });
    }
  };

  const installUpdate = async () => {
    const update = pendingUpdateRef.current;
    if (!update) return;
    setUpdateStatus({ phase: "downloading", version: update.version, notes: update.notes || undefined, received: 0 });
    // Progress arrives as events because the download runs on the Rust side.
    const unlisten = await listen<{ received: number; total: number | null }>("update-download-progress", (event) => {
      const { received, total } = event.payload;
      setUpdateStatus((current) => ({ ...current, phase: "downloading", received, total: total ?? undefined }));
    });
    const unlistenFinished = await listen("update-download-finished", () => {
      setUpdateStatus((current) => ({ ...current, phase: "installing" }));
      // Written before the install, which does not return once it relaunches the app.
      try { localStorage.setItem(RELEASE_NOTES_KEY, JSON.stringify({ version: update.version, notes: update.notes || "" })); } catch { /* notes are a nicety */ }
    });
    try {
      await invoke("install_update");
      await relaunch();
      // Normally the process is gone by now. If it is not, say so instead of
      // sitting on "installing…" forever.
      setUpdateStatus({ phase: "installed", version: update.version });
    } catch (error) {
      setUpdateStatus({ phase: "error", version: update.version, error: errorMessage(error) });
    } finally {
      unlisten();
      unlistenFinished();
    }
  };

  /** Reveals the panel before running: the interactive run button lives inside it. */
  const beginInteractiveRun = () => {
    setTestPanelVisible(true);
    setPanelMode("interactive");
    void startInteractive();
  };

  const showTestPanel = testPanelVisible && tabs.length > 0;
  const showExplorer = explorerVisible && Boolean(workspacePath);
  const showProblemPanel = problemPanelOpen && problemBrowserMode === "panel";
  const panelShown = (id: PanelId) => id === "editor" || (id === "tests" ? showTestPanel : id === "problem" ? showProblemPanel : showExplorer);
  const shownLayout = visibleLayout(panelLayout, panelShown);
  const weightOf = (id: PanelId, axis: "width" | "height") =>
    panelWeights[id]?.[axis] ?? (axis === "width" ? DEFAULT_WEIGHT[id] : 1);
  const panelRects = layoutRects(shownLayout, weightOf);
  // The problem page is a native view over the webview, so CSS stacking cannot put a modal,
  // popover or menu above it: hide it while anything floats over it. A dialog dims the whole
  // window, so it always counts; the contest board and the explorer menu are small and sit
  // where they were opened, so they only count when they actually reach the page — the
  // board is for reading beside the problem, not instead of it.
  const [overlayOpen, setOverlayOpen] = useState(false);
  useEffect(() => {
    const host = problemHostRef.current?.getBoundingClientRect();
    const reachesPage = (element: Element) => {
      const box = element.getBoundingClientRect();
      return Boolean(host) && box.right > host!.left && box.left < host!.right && box.bottom > host!.top && box.top < host!.bottom;
    };
    setOverlayOpen(Boolean(document.querySelector(".modal-backdrop, .error-notice, .quick-open"))
      || [...document.querySelectorAll(".explorer-context-menu, .contest-popover")].some(reachesPage));
  });
  /**
   * The contest board opens at the left edge, above its button. A problem page docked there
   * would have to be hidden for as long as the board is up, and the board is read beside the
   * problem: so it opens just past the page instead, whenever there is room for it there.
   */
  const contestPopoverLeft = () => {
    const host = showProblemPanel ? problemHostRef.current?.getBoundingClientRect() : undefined;
    const margin = 10;
    const width = Math.min(420, window.innerWidth - 2 * margin);
    if (!host || host.left >= margin + width || host.right + 2 * margin + width > window.innerWidth) return undefined;
    return host.right + margin;
  };
  // Panels keep a fixed DOM order (PANEL_IDS) and take their place through CSS `order`.
  // Reordering the DOM instead would move keyed subtrees, and React's StrictMode re-runs
  // the effects of a moved subtree in development: @monaco-editor/react disposes its editor
  // in that pass without recreating it, and the next setModel throws and unmounts the app.
  /**
   * Panels are placed by percentage rather than reordered in the DOM. React moves a keyed
   * subtree when its position changes, and in development StrictMode re-runs the effects of
   * a moved subtree, which made the Monaco wrapper dispose its editor and take the whole
   * tree down with it.
   */
  const panelStyle = (id: PanelId): CSSProperties => {
    const rect = panelRects.get(id);
    if (!rect) return { display: "none" };
    return { left: `${rect.left}%`, top: `${rect.top}%`, width: `${rect.width}%`, height: `${rect.height}%` };
  };
  /** The divider before `index` resizes its non-editor neighbour, preferring the left one. */
  /**
   * One divider per gap: between neighbouring columns, and between panels stacked in a
   * column. Dragging one moves weight from the panel on one side to the other.
   */
  const dividers = shownLayout.flatMap((column, index) => {
    // `pair` is the share of the workspace the two panels cover together, along the
    // divider's axis. The divider is centred on the boundary, half over each panel.
    const between: Array<{ key: string; axis: "x" | "y"; before: PanelId; after: PanelId; pair: number; style: CSSProperties }> = [];
    if (index > 0) {
      const before = shownLayout[index - 1][0];
      const after = column[0];
      const rect = panelRects.get(after)!;
      const pair = (panelRects.get(before)!.width + rect.width) / 100;
      between.push({ key: `col-${after}`, axis: "x", before, after, pair, style: { left: `calc(${rect.left}% - ${PANEL_DIVIDER_HIT / 2}px)`, top: 0, height: "100%" } });
    }
    column.forEach((panel, row) => {
      if (row === 0) return;
      const rect = panelRects.get(panel)!;
      const pair = (panelRects.get(column[row - 1])!.height + rect.height) / 100;
      between.push({
        key: `row-${panel}`, axis: "y", before: column[row - 1], after: panel, pair,
        style: { left: `${rect.left}%`, top: `calc(${rect.top}% - ${PANEL_DIVIDER_HIT / 2}px)`, width: `${rect.width}%` },
      });
    });
    return between;
  });
  // The problem page is a native view, so a divider's half over it cannot be grabbed:
  // the host steps back from those edges, and the divider is whole again.
  const problemHostInset = {
    left: dividers.some((divider) => divider.axis === "x" && divider.after === "problem"),
    right: dividers.some((divider) => divider.axis === "x" && divider.before === "problem"),
    bottom: dividers.some((divider) => divider.axis === "y" && divider.before === "problem"),
  };
  const problemHostStyle: CSSProperties = {
    marginLeft: problemHostInset.left ? PANEL_DIVIDER_HIT / 2 : 0,
    marginRight: problemHostInset.right ? PANEL_DIVIDER_HIT / 2 : 0,
    marginBottom: problemHostInset.bottom ? PANEL_DIVIDER_HIT / 2 : 0,
  };
  const togglePanel = (id: PanelId) => {
    if (id === "tests") setTestPanelVisible((visible) => !visible);
    else if (id === "problem") setProblemPanelOpen((open) => !open);
    else if (id === "explorer") setExplorerVisible((visible) => !visible);
  };
  /** Put `id` against one edge of `target`: beside it as a column, or into its stack. */
  const dropPanelOn = (id: PanelId, target: PanelId, edge: Edge) =>
    setPanelLayout((layout) => dropPanel(layout, id, target, edge));

  // ── Submitting through the problem browser ──
  const browserStatusRef = useLatest(browserStatus);
  const [submitting, setSubmitting] = useState(false);
  // While a submission is opening its page, "follow the active file" must not put the problem page back.
  const submitHoldRef = useRef(false);
  // `<nonce>:<result>` from the last press script, taken off the page title as it arrives.
  const submitMarkerRef = useRef<string | null>(null);
  const waitFor = async (ready: () => boolean, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (ready()) return true;
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    }
    return false;
  };
  const pathOf = (value: string) => { try { return new URL(value).pathname.replace(/\/+$/, ""); } catch { return ""; } };
  /** Brings `url` up in the problem browser, opening the panel or the window if it is closed. Returns once a browser is there; the page may still be loading. */
  const showInProblemBrowser = async (url: string) => {
    if (!browserStatusRef.current.available) throw new Error(`${t("problemUnavailable")} ${browserStatusRef.current.error || ""}`.trim());
    const alreadyThere = browserStatusRef.current.open && pathOf(browserStatusRef.current.url) === pathOf(url);
    if (problemBrowserMode === "window") {
      // The window hosts the browser: it opens (or comes forward) on the page it is handed.
      if (!problemPanelOpen) setProblemPanelOpen(true);
      await invoke("problem_window_open", { url: alreadyThere ? "" : url, focus: true });
    } else {
      if (!problemPanelOpen) {
        setProblemPanelOpen(true);
        // The panel's host element has to be on screen before a browser can be placed over it.
        await waitFor(() => Boolean(problemHostRef.current), 3000);
      }
      if (!alreadyThere) {
        if (browserStatusRef.current.open) await invoke("browser_navigate", { url });
        else openProblemUrl(url);
      }
    }
    if (!(await waitFor(() => browserStatusRef.current.open, 8000))) throw new Error(t("submitNoBrowser"));
  };

  // What the URL importer hands over when a judge will only answer a browser: Cloudflare's
  // check in front of Codeforces, a DOJ contest problem that wants the login. The page opens
  // in the problem browser — which passes the check the way any browser does, being one, and
  // carries the user's own session — and Competitive Companion reads it there, as if the
  // user had opened the page and pressed import. Nothing is done to the check itself.
  const importThroughBrowser = async (url: string) => {
    // "Follow the active file" must not put another page back meanwhile.
    submitHoldRef.current = true;
    setFileStatus(t("importOpeningBrowser"));
    try {
      await showInProblemBrowser(url);
      const deadline = Date.now() + 45_000;
      let askedOn: string | null = null;
      while (Date.now() < deadline) {
        const status = browserStatusRef.current;
        // Cloudflare's interstitial sits at the address of the page it stands in for and gives
        // way to it under a new title, so each title that settles there is asked once. Its
        // wording follows the browser's language, which is why it is not matched by name.
        if (status.open && !status.loading && isSamePage(status.url, url) && status.title !== askedOn) {
          askedOn = status.title;
          // The extension's content script arrives with the page, a moment after it.
          await new Promise((resolve) => window.setTimeout(resolve, 600));
          const arrivals = companionArrivalsRef.current;
          // Not asked: the extension is missing, and what was done instead has said how it went.
          if (!(await importFromProblemPageRef.current())) return;
          if (await waitFor(() => companionArrivalsRef.current !== arrivals, 6000)) return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
      // Never arrived (a login page, a check that wants a click) or nothing to parse: the
      // page is in front of the user now, and the rest is theirs.
      window.clearTimeout(companionWaitRef.current);
      setFileStatus(t("importNeedsBrowser"));
    } catch (error) {
      setFileStatus(errorMessage(error));
    } finally {
      window.setTimeout(() => { submitHoldRef.current = false; }, 1500);
    }
  };

  const submitSolution = async () => {
    if (submitting) return;
    if (!activeTab?.sourceUrl) { setFileStatus(t("submitNoSource")); return; }
    if (!(await saveProblem())) return;
    const code = codes[language];
    // The clipboard is the fallback for every judge, known or not.
    try { await navigator.clipboard.writeText(code); } catch { /* the form is filled below where possible */ }
    const target = submitTarget(activeTab.sourceUrl);
    const url = target?.url ?? activeTab.sourceUrl;
    setSubmitting(true);
    submitHoldRef.current = true;
    setFileStatus(t("submitOpening"));
    try {
      await showInProblemBrowser(url);
      if (!target) { setFileStatus(t("submitCopied")); return; }
      const arrived = await waitFor(() => !browserStatusRef.current.loading && pathOf(browserStatusRef.current.url) === pathOf(target.url), 20000);
      if (!arrived) {
        // A judge sends a logged-out visitor to its login page instead.
        const reached = browserStatusRef.current.url;
        setFileStatus(/login|enter/i.test(reached) ? t("submitLogin") : `${t("submitCopied")} (${reached || "no page"})`);
        return;
      }
      const payload = { judge: target.judge, code, language, taskScreenName: target.taskScreenName, problemIndex: target.problemIndex, problemCode: target.problemCode, problemSlug: target.problemSlug };
      const script = fillSubmitFormScript(payload);
      await invoke("browser_fill_submission", { script });
      if (!submitPress) {
        // Again for an editor widget, or a client-rendered form, that arrives after the page does.
        for (const delay of [1200, 3000]) window.setTimeout(() => void invoke("browser_fill_submission", { script }).catch(() => undefined), delay);
        setFileStatus(t("submitFilled"));
        return;
      }
      setFileStatus(t("submitPressing"));
      // The page fills the form again, checks every field against the file and presses the button only
      // when all of them agree. A check that fails gets one more try, for an editor widget that arrives late.
      let result: PressResult | "timeout" = "timeout";
      for (const delay of [1200, 3000]) {
        await new Promise((resolve) => window.setTimeout(resolve, delay));
        const nonce = Math.random().toString(36).slice(2);
        submitMarkerRef.current = null;
        await invoke("browser_fill_submission", { script: pressSubmitFormScript({ ...payload, nonce }) });
        // DOJ's IDE builds itself after the page loads, and the script waits up to 20 s for it.
        const answered = await waitFor(() => submitMarkerRef.current?.startsWith(`${nonce}:`) ?? false, 30000);
        result = answered ? (submitMarkerRef.current ?? "").slice(nonce.length + 1) as PressResult : "timeout";
        // A second look cannot log anyone in.
        if (result === "pressed" || result === "login") break;
      }
      if (result !== "pressed") {
        if (result === "login") { setFileStatus(t("submitLogin")); return; }
        const reason: Record<Exclude<typeof result, "pressed" | "login">, string> = { form: t("submitCheckForm"), problem: t("submitCheckProblem"), language: t("submitCheckLanguage"), code: t("submitCheckCode"), button: t("submitCheckButton"), timeout: t("submitCheckTimeout") };
        setFileStatus(`${t("submitUnverified")}: ${reason[result]}`);
        return;
      }
      // The judge answers a submission by moving to its status page; staying put means it refused.
      const moved = await waitFor(() => !browserStatusRef.current.loading && pathOf(browserStatusRef.current.url) !== pathOf(target.url), 15000);
      setFileStatus(moved ? t("submitPressed") : t("submitPressUnconfirmed"));
      if (moved) window.setTimeout(() => void refreshSubmissionStatuses(true), 8000);
    } catch (error) {
      setFileStatus(errorMessage(error));
    } finally {
      setSubmitting(false);
      // Released a little later: the status events of the navigation are still arriving.
      window.setTimeout(() => { submitHoldRef.current = false; }, 1500);
    }
  };

  // ── Contest mode ──
  const [contest, setContest] = useState<ContestState | null>(() => DEMO_MODE?.startsWith("contest") ? { startedAt: Date.now() - 47 * 60000, durationMin: 100, folder: "AtCoder/abc400", solved: { [fileKey("AtCoder/abc400/A_Sum.cpp")]: 6 * 60000 + 12000 } } : loadContest(workspacePath));
  const [contestOpen, setContestOpen] = useState(DEMO_MODE === "contest-open");
  const [contestMinutes, setContestMinutes] = useState(() => localStorage.getItem("mild-contest-minutes") || "120");
  const contestWorkspaceRef = useRef(workspacePath);
  useEffect(() => {
    if (contestWorkspaceRef.current === workspacePath) return;
    contestWorkspaceRef.current = workspacePath;
    setContest(loadContest(workspacePath));
  }, [workspacePath]);
  useEffect(() => {
    if (DEMO_MODE !== null) return;
    if (contest) localStorage.setItem(contestStorageKey(workspacePath), JSON.stringify(contest));
    else localStorage.removeItem(contestStorageKey(workspacePath));
  }, [contest, workspacePath]);
  const contestEndsAt = contest ? contest.startedAt + contest.durationMin * 60000 : 0;
  // The seconds are counted by the pieces that show them (ContestClock.tsx). All this
  // component needs from the clock is the one moment the contest ends.
  const contestRunning = Boolean(contest) && Date.now() < contestEndsAt;
  const contestRunningRef = useLatest(contestRunning);
  const contestSpan = useMemo(() => contest ? { startedAt: contest.startedAt, endsAt: contestEndsAt } : null, [contest?.startedAt, contestEndsAt]);
  const [, markContestOver] = useState(0);
  useEffect(() => {
    const left = contestEndsAt - Date.now();
    if (!contest || left <= 0) return;
    const timer = window.setTimeout(() => markContestOver((count) => count + 1), left);
    return () => window.clearTimeout(timer);
  }, [contest?.startedAt, contestEndsAt]);
  // Time is up: the board comes forward once, so the end does not pass unnoticed.
  const contestWasRunningRef = useRef(contestRunning);
  useEffect(() => {
    if (contestWasRunningRef.current && !contestRunning && contest) setContestOpen(true);
    contestWasRunningRef.current = contestRunning;
  }, [contestRunning]);
  // Generators, brute forces and checkers sit beside the problems but are not problems.
  const problemsOfFolder = (folder: string) => (savedFiles.length ? savedFiles : tabs)
    .filter((file) => fileKey(explorerParent(file.filename)) === fileKey(folder) && !isHelperFile(file.filename))
    .sort((left, right) => explorerBasename(left.filename).localeCompare(explorerBasename(right.filename), undefined, { numeric: true }));
  const contestProblems = useMemo(() => {
    if (!contest) return [];
    const excluded = new Set(contest.excluded);
    return problemsOfFolder(contest.folder).filter((file) => !excluded.has(fileKey(file.filename)));
  }, [contest?.folder, contest?.excluded, savedFiles, tabs]);
  // What the next contest covers: a folder (the active file's until another is picked) minus
  // the problems clicked away, so a contest needs no workspace of its own.
  const [contestFolderChoice, setContestFolderChoice] = useState<string | null>(null);
  const [contestExcluded, setContestExcluded] = useState<Set<string>>(() => new Set());
  const contestFolderOptions = ["", ...workspaceDirectories];
  const contestNextFolder = contestFolderChoice !== null && contestFolderOptions.some((directory) => fileKey(directory) === fileKey(contestFolderChoice))
    ? contestFolderChoice
    : activeTab ? explorerParent(activeTab.filename) : "";
  const contestCandidates = contest ? [] : problemsOfFolder(contestNextFolder);
  /** Accepted, and not by a submission from before the contest. */
  const acceptedInContest = (file: ProblemTab) => {
    if (!isAccepted(file.judgeStatus)) return false;
    const before = contest?.acceptedBefore?.[fileKey(file.filename)];
    return before === undefined || (before !== "" && Boolean(file.submissionUrl) && file.submissionUrl !== before);
  };
  // A verdict of AC from the judge, first seen while the clock runs, is the solve time.
  useEffect(() => {
    if (!contest || !contestRunning) return;
    const fresh = contestProblems.filter((file) => acceptedInContest(file) && contest.solved[fileKey(file.filename)] === undefined);
    if (!fresh.length) return;
    const elapsed = Date.now() - contest.startedAt;
    setContest((current) => current && { ...current, solved: { ...current.solved, ...Object.fromEntries(fresh.map((file) => [fileKey(file.filename), elapsed])) } });
  }, [contestProblems, contestRunning]);
  const startContest = () => {
    const minutes = Math.min(24 * 60, Math.max(1, Math.round(Number(contestMinutes)) || 120));
    localStorage.setItem("mild-contest-minutes", String(minutes));
    setContestMinutes(String(minutes));
    const excluded = contestCandidates.map((file) => fileKey(file.filename)).filter((key) => contestExcluded.has(key));
    const acceptedBefore = Object.fromEntries(contestCandidates.filter((file) => isAccepted(file.judgeStatus)).map((file) => [fileKey(file.filename), file.submissionUrl || ""]));
    setContest({ startedAt: Date.now(), durationMin: minutes, folder: contestNextFolder, solved: {}, ...(excluded.length ? { excluded } : {}), ...(Object.keys(acceptedBefore).length ? { acceptedBefore } : {}) });
    setContestFolderChoice(null);
    setContestExcluded(new Set());
  };
  /**
   * The submissions this contest is answerable for: the ones the judge timestamped after
   * the clock started. A judge that reports no time is taken at its word only for the
   * verdict, never for the score, so an untimed submission counts for nothing here.
   */
  const contestSubmissions = (file: ProblemTab) => {
    if (!contest) return [];
    const startedSecond = Math.floor(contest.startedAt / 1000);
    return (file.submissions || []).filter((record) => record.at >= startedSecond);
  };

  /** Tries that were rejected before the problem was solved, which is what a penalty counts. */
  const contestPenaltyTries = (file: ProblemTab) => {
    const records = contestSubmissions(file);
    const solved = records.findIndex((record) => isAccepted(record.status));
    return (solved === -1 ? records : records.slice(0, solved))
      .filter((record) => !isPendingVerdict(record.status)).length;
  };

  /** Solve time plus the penalty its rejected tries carry, in milliseconds. */
  const contestScore = useMemo(() => {
    if (!contest) return { solved: 0, penalty: 0 };
    let solved = 0;
    let penalty = 0;
    for (const file of contestProblems) {
      const solvedAt = contest.solved[fileKey(file.filename)];
      if (solvedAt === undefined) continue;
      solved += 1;
      penalty += solvedAt + contestPenaltyTries(file) * CONTEST_PENALTY_MINUTES * 60000;
    }
    return { solved, penalty };
  }, [contest, contestProblems]);

  /** What the board shows for one problem: the judge's word first, the local tests otherwise. */
  const contestProblemState = (file: ProblemTab): { tone: "solved" | "failed" | "ready" | "partial" | "idle"; label: string; tries?: number } => {
    const solvedAt = contest?.solved[fileKey(file.filename)];
    const tries = contest ? contestPenaltyTries(file) : 0;
    if (solvedAt !== undefined || acceptedInContest(file)) return { tone: "solved", label: solvedAt !== undefined ? formatClock(solvedAt) : "AC", tries };
    // An AC from before the contest says nothing about this attempt.
    if (file.judgeStatus && !isAccepted(file.judgeStatus)) {
      const view = verdictView(file.judgeStatus);
      return { tone: view.tone === "partial" ? "partial" : "failed", label: view.text, tries };
    }
    const open = tabs.find((tab) => fileKey(tab.filename) === fileKey(file.filename));
    const results = (open?.id === activeTabId ? tests : open?.tests ?? []).filter((test) => finalVerdicts.includes(test.status));
    if (!results.length) return { tone: "idle", label: "" };
    const passed = results.filter((test) => test.status === "ac").length;
    return passed === results.length ? { tone: "ready", label: t("contestReady") } : { tone: "partial", label: `${passed}/${results.length}` };
  };

  /** The grip in a panel's top-left corner drags it exactly as its status-bar chip does. */
  const panelGrip = (id: PanelId) => (
    <button
      type="button"
      className="panel-grip"
      title={t("panelGrip")}
      aria-label={`${chipLabel(id)}: ${t("panelGrip")}`}
      onPointerDown={(event) => startPanelDrag(id, event)}
      onPointerMove={trackPanelDrag}
      onPointerUp={finishPanelDrag}
      onPointerCancel={finishPanelDrag}
    ><Icon name="grip" size={14} /></button>
  );

  /**
   * Dragging a chip onto a panel places it against the edge the pointer is nearest. Pointer
   * events with a capture, the same mechanism the dividers use; HTML5 drag and drop was
   * unreliable in this webview.
   */
  const [panelDrag, setPanelDrag] = useState<{ id: PanelId; over: { target: PanelId; edge: Edge } | null } | null>(null);
  const panelDragRef = useRef<{ id: PanelId; over: { target: PanelId; edge: Edge } | null; moved: boolean } | null>(null);

  const startPanelDrag = (id: PanelId, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    panelDragRef.current = { id, over: null, moved: false };
    // Capture keeps the moves coming when the pointer leaves the grip; not every pointer
    // can be captured, and the drag still works from the events that follow.
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* keep dragging */ }
  };

  const trackPanelDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = panelDragRef.current;
    const workspace = workspaceRef.current;
    if (!drag || !workspace) return;
    if (!drag.moved) {
      drag.moved = true;
      setPanelDrag({ id: drag.id, over: null });
      document.body.classList.add("panel-dragging");
    }
    const box = workspace.getBoundingClientRect();
    const x = ((event.clientX - box.left) / (box.width || 1)) * 100;
    const y = ((event.clientY - box.top) / (box.height || 1)) * 100;
    let over: { target: PanelId; edge: Edge } | null = null;
    for (const [target, rect] of panelRects) {
      if (x < rect.left || x > rect.left + rect.width || y < rect.top || y > rect.top + rect.height) continue;
      if (target !== drag.id) over = { target, edge: edgeAt(rect, x, y) };
      break;
    }
    drag.over = over;
    setPanelDrag({ id: drag.id, over });
  };

  const finishPanelDrag = () => {
    const drag = panelDragRef.current;
    panelDragRef.current = null;
    document.body.classList.remove("panel-dragging");
    setPanelDrag(null);
    if (!drag) return false;
    if (drag.over) dropPanelOn(drag.id, drag.over.target, drag.over.edge);
  };
  const chipLabel = (id: PanelId) => t(id === "tests" ? "chipTests" : id === "editor" ? "chipEditor" : id === "problem" ? "chipProblem" : "chipExplorer");
  /** A chip is lit while its panel is on screen; the problem chip also while the browser has its own window up. */
  const chipActive = (id: PanelId) => id === "problem" ? problemPanelOpen : panelShown(id);
  const resetLayout = () => {
    setPanelLayout(columnsFromOrder(PANEL_IDS));
    setPanelWeights({});
    setTestPanelVisible(true);
    setExplorerVisible(true);
    setProblemPanelOpen(false);
  };

  // ── Problem panel ────────────────────────────────────────────────────────────

  const problemHostBounds = () => {
    const host = problemHostRef.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, scale: uiZoom / 100 };
  };

  const openProblemUrl = (raw: string) => {
    const typed = raw.trim();
    if (!typed) return;
    const url = /^[a-z]+:\/\//i.test(typed) ? typed : `https://${typed}`;
    const bounds = problemHostBounds();
    if (!bounds) return;
    invoke("browser_open", { url, bounds }).catch((error) => setFileStatus(errorMessage(error)));
  };

  const activeSourceUrlRef = useLatest(activeTab?.sourceUrl || "");
  // The page the browser is on, kept so a move between panel and window can reopen it.
  const lastBrowserUrlRef = useRef("");
  if (browserStatus.url) lastBrowserUrlRef.current = browserStatus.url;

  // Moving the browser between the panel and its own window. The view cannot change
  // windows, so the page is reopened in the new host: the window is destroyed when the
  // panel takes over, and the window's page opens what it is handed the other way round.
  const previousBrowserModeRef = useRef(problemBrowserMode);
  useEffect(() => {
    if (previousBrowserModeRef.current === problemBrowserMode) return;
    previousBrowserModeRef.current = problemBrowserMode;
    if (!IS_TAURI) return;
    const url = lastBrowserUrlRef.current || activeSourceUrlRef.current;
    if (problemBrowserMode === "panel") {
      void invoke("problem_window_close").catch(() => undefined).then(() => { if (url && problemPanelOpen) openProblemUrl(url); });
    } else if (url && problemPanelOpen) {
      invoke("problem_window_open", { url, focus: true }).catch((error) => setFileStatus(errorMessage(error)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemBrowserMode]);

  // In window mode the chip shows and hides the window.
  useEffect(() => {
    if (!IS_TAURI || problemBrowserMode !== "window" || !browserStatus.available) return;
    if (problemPanelOpen) invoke("problem_window_open", { url: "", focus: true }).catch((error) => setFileStatus(errorMessage(error)));
    else void invoke("problem_window_hide").catch(() => undefined);
  }, [problemBrowserMode, problemPanelOpen, browserStatus.available]);

  // What the browser sends back, whichever window it is in: its import button, Ctrl+W
  // pressed in the page, its focus, and the window being hidden by its own close button.
  useEffect(() => {
    if (!IS_TAURI) return;
    const stops: Array<() => void> = [];
    let disposed = false;
    const track = (promise: Promise<() => void>) => { void promise.then((stop) => { if (disposed) stop(); else stops.push(stop); }); };
    track(listen(PROBLEM_WINDOW_IMPORT_EVENT, () => { void importFromProblemPageRef.current(); }));
    track(listen<{ action: string }>("browser-hotkey", (event) => { if (event.payload.action === "close") closeProblemBrowserRef.current(); }));
    track(listen("browser-focus", () => { cefFocusedRef.current = true; }));
    track(listen("problem-window-hidden", () => { setProblemPanelOpen(false); cefFocusedRef.current = false; editorRef.current?.focus(); }));
    // The keyboard is back in this page: a click or focus anywhere in it says so.
    const regained = () => { cefFocusedRef.current = false; };
    document.addEventListener("focusin", regained);
    document.addEventListener("pointerdown", regained);
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
      document.removeEventListener("focusin", regained);
      document.removeEventListener("pointerdown", regained);
    };
  }, []);

  useEffect(() => {
    if (!IS_TAURI) return;
    void invoke<BrowserStatus>("browser_status").then(setBrowserStatus).catch(() => undefined);
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<BrowserStatus>("browser-status", (event) => {
      // A press script answers through the page title; caught here so a title that changes again is not missed.
      if (event.payload.title.startsWith(SUBMIT_MARK)) submitMarkerRef.current = event.payload.title.slice(SUBMIT_MARK.length);
      setBrowserStatus(event.payload);
    })
      .then((stop) => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  // Keep the URL field in step with the page unless the user is typing in it.
  useEffect(() => {
    if (!problemUrlEditingRef.current) setProblemUrlDraft(browserStatus.url);
  }, [browserStatus.url]);

  // The native view sits over `.problem-host`: report the host's rectangle whenever it
  // moves or resizes, and hide the view while the host is not on screen at all.
  useEffect(() => {
    if (!IS_TAURI || !browserStatus.available || problemBrowserMode === "window") return;
    const host = problemHostRef.current;
    if (!showProblemPanel || !host) {
      if (browserStatus.open) void invoke("browser_set_visible", { visible: false }).catch(() => undefined);
      return;
    }
    const report = () => {
      const bounds = problemHostBounds();
      if (bounds && bounds.width > 0 && bounds.height > 0) void invoke("browser_set_bounds", { bounds }).catch(() => undefined);
    };
    report();
    if (browserStatus.open) void invoke("browser_set_visible", { visible: !overlayOpen }).catch(() => undefined);
    const observer = new ResizeObserver(report);
    observer.observe(host);
    window.addEventListener("resize", report);
    return () => { observer.disconnect(); window.removeEventListener("resize", report); };
  }, [browserStatus.available, browserStatus.open, overlayOpen, panelLayout, panelWeights, problemBrowserMode, showExplorer, showProblemPanel, showTestPanel, uiZoom]);

  // Follow the active file: a tab imported from a judge carries its problem URL. With no
  // file open, VITE_PROBLEM_PANEL_URL (development only) seeds the panel instead.
  useEffect(() => {
    if (!problemPanelOpen || !browserStatus.available || submitHoldRef.current) return;
    const url = activeTab?.sourceUrl || (browserStatus.open ? "" : import.meta.env.VITE_PROBLEM_PANEL_URL || "");
    if (!url || url === browserStatus.url) return;
    // Following a file changes the page only; the window stays where it is in the stack.
    if (problemBrowserMode === "window") invoke("problem_window_open", { url, focus: false }).catch((error) => setFileStatus(errorMessage(error)));
    else openProblemUrl(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.sourceUrl, browserStatus.available, problemPanelOpen, problemBrowserMode]);

  // Tampermonkey installs a userscript from its dashboard, which the backend drives once
  // the panel is on screen; the host element only exists after the panel renders.
  const [pendingUserscript, setPendingUserscript] = useState("");
  const installUserscript = (url: string) => {
    setSettingsPage(null);
    setProblemPanelOpen(true);
    setPendingUserscript(url);
  };
  useEffect(() => {
    if (!pendingUserscript || !problemPanelOpen || !browserStatus.available) return;
    const bounds = problemBrowserMode === "window" ? null : problemHostBounds();
    if (problemBrowserMode === "panel" && !bounds) return;
    setPendingUserscript("");
    invoke("browser_install_userscript", { url: pendingUserscript, bounds }).catch((error) => setFileStatus(errorMessage(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingUserscript, problemPanelOpen, problemBrowserMode, browserStatus.available]);

  /** Runs what the user is looking at: the interactive panel when it is showing, otherwise the tests. */
  const runActivePanel = () => {
    if (testPanelVisible && tabs.length > 0 && panelMode === "interactive") beginInteractiveRun();
    else void run();
  };

  useEffect(() => {
    let disposed = false;
    const stops: Array<() => void> = [];
    const track = (stop: () => void) => (disposed ? stop() : stops.push(stop));
    void listen<InteractiveOutputEvent>("interactive-output", (event) => {
      if (event.payload.sessionId !== interactiveSessionRef.current) return;
      appendInteractive(event.payload.stream === "stderr" ? "stderr" : "stdout", event.payload.text);
    }).then(track);
    void listen<InteractiveExitEvent>("interactive-exit", (event) => {
      if (event.payload.sessionId !== interactiveSessionRef.current) return;
      interactiveSessionRef.current = null;
      setInteractiveRunning(false);
      const { code, timeMs, stopped } = event.payload;
      appendInteractive("info", stopped
        ? `${t("interactiveStopped")} · ${timeMs} ms`
        : `${t("interactiveExited")} ${code ?? "?"} · ${timeMs} ms`);
    }).then(track);
    return () => { disposed = true; stops.forEach((stop) => stop()); };
  }, [uiLocale]);

  useEffect(() => {
    const log = interactiveLogRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [interactiveLog]);

  useEffect(() => {
    // The terminal belongs to the window, not to a workspace, so it is not what one reopens on.
    if (!workspacePath || panelMode === "terminal") return;
    void invoke("save_workspace_panel_mode", { request: { folderPath: workspacePath, panelMode } })
      .catch(() => undefined);
  }, [panelMode, workspacePath]);

  // A session belongs to the file it was started from, so leaving that file ends it.
  useEffect(() => {
    if (!interactiveSessionRef.current) return;
    interactiveSessionRef.current = null;
    setInteractiveRunning(false);
    setInteractiveLog([]);
    setInteractiveDraft("");
    void invoke("stop_interactive");
  }, [activeTab?.id]);

  useEffect(() => () => { void invoke("stop_interactive"); }, []);

  const storedStressChoices = (): Record<string, StressChoice> => {
    try {
      const stored = JSON.parse(localStorage.getItem(stressChoiceKey(workspacePath)) || "{}");
      return stored && typeof stored === "object" ? stored as Record<string, StressChoice> : {};
    } catch { return {}; }
  };

  /**
   * Creates one of the two helpers, saved straight into the workspace and left closed: the
   * file under test has to stay the active tab, since that is what the search runs.
   */
  const createStressCompanion = async (filename: string, fileLanguage: Language) => {
    if (!workspacePath) return "";
    const title = explorerBasename(filename).replace(/\.[^.]+$/, "");
    const rendered = (forLanguage: Language) => renderTemplateWithCursor(storedTemplate(forLanguage, "other"), { source: "other", filename, title, url: "", now: new Date() }).code;
    await invoke<LoadedWorkspace>("save_workspace", {
      request: {
        folderPath: workspacePath,
        problems: [{ filename, title, language: fileLanguage, code: rendered(fileLanguage), tests: [], source: "other", sourceUrl: null, judgeStatus: null, limits: null, modifiedAt: Date.now() }],
      },
    });
    return filename;
  };

  /**
   * Settles which generator and reference this problem uses. An existing pair is taken as
   * it is; anything missing is created from the new-file template, so the dialog always
   * opens on two real files and the only thing left to do is write them.
   */
  /**
   * Settles which file each role starts on: the one picked last time if it is still there,
   * otherwise the problem's own helper if it has been written, otherwise `STRESS_CREATE`,
   * which offers to make it. Nothing is written here — opening the dialog to look at it
   * must not leave files behind.
   */
  const openStressDialog = () => {
    if (!activeTab) return;
    setStressOpen(true);
    setStressOutcome(null);
    setStressCreated([]);
    if (!workspacePath) return;
    const remembered = storedStressChoices()[fileKey(activeTab.filename)];
    const resolve = (role: StressRole) => {
      const chosen = remembered?.[role];
      if (chosen && savedFiles.some((file) => fileKey(file.filename) === fileKey(chosen))) return chosen;
      return findStressCompanion(savedFiles, activeTab.filename, role)?.filename ?? STRESS_CREATE;
    };
    setStressChoice({ generator: resolve("generator"), reference: resolve("reference") });
  };

  /**
   * Runs the generator and the reference against this file on random inputs until their
   * answers part. The two helpers are ordinary workspace files, so their saved text is
   * what runs; the file under test uses the editor's current text, unsaved edits included,
   * which is the whole point of looking for the case that breaks it.
   */
  const startStressTest = async () => {
    if (!activeTab || stressBusy || running) return;
    // A role left on "create" gets its file now. The search does not follow: the file is a
    // bare template, so there would be nothing to compare until it has been written.
    if (stressChoice.generator === STRESS_CREATE || stressChoice.reference === STRESS_CREATE) {
      const settled = { ...stressChoice };
      const created: string[] = [];
      for (const role of ["generator", "reference"] as StressRole[]) {
        if (settled[role] !== STRESS_CREATE) continue;
        const filename = stressCompanionName(activeTab.filename, role, activeTab.language);
        // Something may have written that file since the dialog opened; taking it is right,
        // overwriting it with a template is not.
        const already = savedFiles.find((file) => fileKey(file.filename) === fileKey(filename));
        try {
          settled[role] = already ? already.filename : await createStressCompanion(filename, activeTab.language);
          if (!already) created.push(settled[role]);
        } catch (error) {
          setFileStatus(errorMessage(error));
          return;
        }
      }
      await rescanWorkspaceFiles(false, true);
      setStressChoice(settled);
      setStressCreated(created);
      return;
    }
    const pick = (filename: string) => savedFiles.find((file) => fileKey(file.filename) === fileKey(filename));
    const generator = pick(stressChoice.generator);
    const reference = pick(stressChoice.reference);
    if (!generator || !reference) { setFileStatus(t("stressNeedFiles")); return; }
    if (fileKey(generator.filename) === fileKey(activeTab.filename) || fileKey(reference.filename) === fileKey(activeTab.filename)) {
      setFileStatus(t("stressSameFile"));
      return;
    }
    localStorage.setItem(stressChoiceKey(workspacePath), JSON.stringify({ ...storedStressChoices(), [fileKey(activeTab.filename)]: stressChoice }));
    const rounds = Math.min(100000, Math.max(1, Math.round(Number(stressRounds)) || 300));
    localStorage.setItem("mild-stress-rounds", String(rounds));
    setStressRounds(String(rounds));
    const runId = crypto.randomUUID();
    setStressBusy(true);
    setStressOutcome(null);
    setStressCreated([]);
    setStressRound(0);
    const unlisten = await listen<{ runId: string; round: number }>("stress-progress", (event) => {
      if (event.payload.runId === runId) setStressRound(event.payload.round);
    });
    try {
      const outcome = await invoke<StressOutcome>("stress_test", {
        request: {
          runId,
          generator: { language: generator.language, code: generator.codes[generator.language] },
          reference: { language: reference.language, code: reference.codes[reference.language] },
          solution: { language, code: codes[language] },
          rounds,
          timeLimitMs: (activeTab.limits?.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS) * (language === "cpp" && compileProfile === "debug" ? DEBUG_TIME_FACTOR : 1),
          atcoderLibraryPath: atcoderLibraryPath || null,
          floatTolerance,
          checker: checkerProgram(),
          ...buildOptions(),
        },
      });
      setStressOutcome(outcome);
    } catch (error) {
      setFileStatus(errorMessage(error));
    } finally {
      unlisten();
      setStressBusy(false);
    }
  };

  /** Keeps a counterexample: it becomes a test case, which is where it is of use. */
  const addStressCase = () => {
    if (stressOutcome?.kind !== "mismatch" && stressOutcome?.kind !== "crashed") return;
    const id = Math.max(0, ...tests.map((test) => test.id)) + 1;
    const expected = stressOutcome.kind === "mismatch" ? stressOutcome.expected : "";
    const next: TestCase[] = [...tests.map((test) => ({ ...test, open: false })),
      { id, name: `counterexample ${id}`, input: stressOutcome.input, expected, output: "", error: "", status: "idle", open: true }];
    setTests(next);
    autoSaveTests(next);
    setStressOpen(false);
  };

  // ── The problem's checker ──
  // A checker is a file beside the problem, `<problem>_checker.cpp` or `.py`, found the way
  // the search helpers are: writing one is all it takes. Switching it off is remembered per
  // workspace, without touching the file.
  const checkerOffKey = `mild-checker-off:${workspacePath ?? ""}`;
  const [checkerOffRevision, setCheckerOffRevision] = useState(0);
  const checkersOff = useMemo(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(checkerOffKey) || "[]");
      return new Set<string>(Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : []);
    } catch { return new Set<string>(); }
  }, [checkerOffKey, checkerOffRevision]);
  const checkerApplies = Boolean(activeTab && workspacePath && !isHelperFile(activeTab.filename));
  const activeChecker = checkerApplies && activeTab ? findStressCompanion(savedFiles, activeTab.filename, "checker") : undefined;
  const checkerOn = Boolean(activeChecker && activeTab && !checkersOff.has(fileKey(activeTab.filename)));
  /** The checker as the runner takes it: from its tab when open, which is never behind the file. */
  const checkerProgram = () => {
    if (!checkerOn || !activeChecker) return null;
    const source = tabs.find((tab) => fileKey(tab.filename) === fileKey(activeChecker.filename)) ?? activeChecker;
    return { language: source.language, code: source.codes[source.language] };
  };
  const toggleChecker = () => {
    if (!activeTab) return;
    const key = fileKey(activeTab.filename);
    const next = new Set(checkersOff);
    if (next.has(key)) next.delete(key); else next.add(key);
    localStorage.setItem(checkerOffKey, JSON.stringify([...next]));
    setCheckerOffRevision((value) => value + 1);
    setTests((items) => items.map((test) => finalVerdicts.includes(test.status) ? { ...test, status: "idle", checkerMessage: undefined } : test));
  };
  /** Writes a starter checker beside the problem and opens it, since writing it is the next step. */
  const createChecker = async () => {
    if (!activeTab || !workspacePath || !checkerApplies) return;
    if (activeChecker) { openSavedFile(activeChecker); return; }
    const filename = stressCompanionName(activeTab.filename, "checker", activeTab.language);
    const title = explorerBasename(filename).replace(/\.[^.]+$/, "");
    const code = checkerStarter(activeTab.language, explorerBasename(activeTab.filename).replace(/\.[^.]+$/, "").replace(/_/g, " "));
    try {
      await invoke<LoadedWorkspace>("save_workspace", {
        request: {
          folderPath: workspacePath,
          problems: [{ filename, title, language: activeTab.language, code, tests: [], source: "other", sourceUrl: null, judgeStatus: null, limits: null, modifiedAt: Date.now() }],
        },
      });
      const tab = makeTab({ filename, title, language: activeTab.language, code, tests: [], source: "other", modifiedAt: Date.now() });
      await rescanWorkspaceFiles(false, true);
      openSavedFile(tab);
      setFileStatus(t("checkerCreated"));
    } catch (error) {
      setFileStatus(errorMessage(error));
    }
  };

  // The counterexample search shares the runner's cancel flag, so one stop serves both.
  const stopRun = () => {
    if (!running && !stressBusy) return;
    if (running) runCancelledRef.current = true;
    void invoke("stop_run");
  };

  // Refreshed every render so Monaco's bindings see the current panel state.
  useEffect(() => { runRef.current = runActivePanel; interactiveRef.current = beginInteractiveRun; submitRef.current = () => void submitSolution(); paletteRef.current = openCommandPalette; });

  // Subscriptions resolve asynchronously, so a cleanup that runs first (StrictMode
  // does this in development) has nothing to call yet; without the flag the first
  // listener leaks and every event arrives twice.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen("native-close-requested", () => requestApplicationClose()).then((stopListening) => { if (disposed) stopListening(); else unlisten = stopListening; });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  // The macOS menu bar drives the same handlers as the toolbar; only the entry point differs.
  const menuHandlerRef = useRef<(id: string) => void>(() => {});
  useEffect(() => {
    menuHandlerRef.current = (id) => {
      switch (id) {
        case "app:settings": openSettings(); break;
        case "app:quit": requestApplicationClose(); break;
        case "file:new": newProblem(); break;
        case "file:new-folder": explorerRef.current?.newFolder(); break;
        case "file:rename": explorerRef.current?.renameSelection(); break;
        case "file:reveal": explorerRef.current?.revealSelection(); break;
        case "file:delete": explorerRef.current?.deleteSelection(); break;
        case "file:open": void openProblem(); break;
        case "file:save": void saveProblem(); break;
        case "file:import": beginImport(); break;
        case "file:close-tab": closeWithShortcutRef.current(); break;
        case "view:toggle-explorer": setExplorerVisible((visible) => !visible); break;
        case "view:toggle-tests": setTestPanelVisible((visible) => !visible); break;
        case "view:panel-tests": setTestPanelVisible(true); setPanelMode("tests"); break;
        case "view:panel-interactive": setTestPanelVisible(true); setPanelMode("interactive"); break;
        case "view:panel-problem": setProblemPanelOpen((open) => !open); break;
        case "view:layout": resetLayout(); break;
        case "view:zoom-in": adjustUiZoom(UI_ZOOM_STEP); break;
        case "view:zoom-out": adjustUiZoom(-UI_ZOOM_STEP); break;
        case "view:zoom-reset": setUiZoom(100); break;
        case "run:active": runActivePanel(); break;
        case "run:tests": void run(); break;
        case "run:interactive": beginInteractiveRun(); break;
        case "run:submit": void submitSolution(); break;
        case "run:stop": stopRun(); stopInteractive(); break;
        case "view:command-palette": openCommandPalette(); break;
        case "view:terminal": toggleTerminal(); break;
        case "view:go-to-file": setQuickOpen((open) => open === null || open.startsWith(COMMAND_PREFIX) ? "" : null); setQuickOpenIndex(0); break;
      }
    };
  });

  // ── The built-in terminal ──
  const [terminalStatus, setTerminalStatus] = useState<TerminalStatus>({ running: false, shell: "", exitCode: null, error: "" });
  useTerminalStatus(setTerminalStatus);
  useEffect(() => { terminalHost().setLabels({ exited: t("terminalExitedWith"), ended: t("terminalEnded"), again: t("terminalAgain") }); }, [uiLocale]);
  const terminalShown = testPanelVisible && panelMode === "terminal";
  /** Ctrl+`: shows the terminal, or puts the test cases back when it is already showing. */
  const toggleTerminal = () => {
    if (terminalShown) { setPanelMode("tests"); editorRef.current?.focus(); return; }
    setTestPanelVisible(true);
    setPanelMode("terminal");
    window.setTimeout(() => terminalHost().focus(), 0);
  };
  /** A new shell in the workspace folder, ending the one running. */
  const restartTerminal = () => {
    setTestPanelVisible(true);
    setPanelMode("terminal");
    void terminalHost().start(workspacePath).then(() => terminalHost().focus());
  };

  // ── The command palette ──
  // Everything the editor can do, findable by name in either language, with its shortcut
  // beside it: quick open with a leading ">", as in VS Code.
  const openCommandPalette = () => {
    setQuickOpen((open) => open !== null && open.startsWith(COMMAND_PREFIX) ? null : COMMAND_PREFIX);
    setQuickOpenIndex(0);
  };
  type PaletteEntry = PaletteCommand & { run: () => void };
  const paletteCommands: PaletteEntry[] = (() => {
    const noFile = !activeTab;
    const entries: PaletteEntry[] = [
      { id: "run.all", label: t("cmdRunAll"), keywords: "execute test 실행 테스트", shortcut: shortcutLabel("Enter"), disabled: noFile || running, run: () => { setTestPanelVisible(true); setPanelMode("tests"); void run(); } },
      { id: "run.submit", label: t("cmdSubmit"), keywords: "submit judge 제출", shortcut: shortcutLabel("Enter", { shift: true }), disabled: !activeTab?.sourceUrl || submitting, run: () => void submitSolution() },
      { id: "run.interactive", label: t("cmdInteractive"), keywords: "interactive 인터랙티브", shortcut: shortcutLabel("Enter", { alt: true }), disabled: noFile, run: beginInteractiveRun },
      { id: "run.stop", label: t("cmdStop"), keywords: "stop kill 중지 정지", shortcut: shortcutLabel("."), disabled: !running && !stressBusy && !interactiveRunning, run: () => { stopRun(); stopInteractive(); } },
      { id: "run.stress", label: t("stress"), keywords: "stress counterexample brute 반례 스트레스", disabled: noFile || !workspacePath, run: openStressDialog },
      { id: "test.add", label: t("addTest"), keywords: "test case 테스트 추가", disabled: noFile, run: () => { setTestPanelVisible(true); setPanelMode("tests"); addTest(); } },
      { id: "test.fold", label: t("cmdFoldTests"), keywords: "collapse 접기", disabled: !tests.some((test) => test.open), run: () => setTests((items) => items.map((test) => ({ ...test, open: false }))) },
      { id: "test.unfold", label: t("cmdUnfoldTests"), keywords: "expand 펼치기", disabled: !tests.some((test) => !test.open), run: () => setTests((items) => items.map((test) => ({ ...test, open: true }))) },
      ...(checkerApplies ? activeChecker ? [
        { id: "checker.toggle", label: checkerOn ? t("cmdCheckerOff") : t("cmdCheckerOn"), keywords: "checker special judge spj 체커 스페셜 저지", run: toggleChecker },
        { id: "checker.open", label: t("cmdCheckerOpen"), keywords: "checker 체커", run: () => openSavedFile(activeChecker) },
      ] : [
        { id: "checker.create", label: t("cmdCheckerCreate"), keywords: "checker special judge spj multiple answers 체커 스페셜 저지", run: () => void createChecker() },
      ] : []),
      { id: "file.goto", label: t("cmdGoToFile"), keywords: "quick open find 파일 찾기", shortcut: shortcutLabel("P"), run: () => { setQuickOpen(""); setQuickOpenIndex(0); } },
      { id: "file.new", label: t("cmdNewFile"), keywords: "create file 만들기 파일", disabled: !workspacePath, run: () => beginBlankFile(explorerRef.current?.creationParent()) },
      { id: "workspace.new", label: t("cmdNewWorkspace"), keywords: "create project folder 프로젝트 폴더", shortcut: shortcutLabel("N"), run: newProblem },
      { id: "file.folder", label: t("cmdNewFolder"), keywords: "directory 디렉터리", shortcut: shortcutLabel("N", { shift: true }), disabled: !workspacePath, run: () => explorerRef.current?.newFolder() },
      { id: "file.import", label: t("cmdImport"), keywords: "import url atcoder codeforces doj 가져오기", shortcut: shortcutLabel("T"), run: beginImport },
      { id: "file.open", label: t("cmdOpen"), keywords: "open folder workspace 열기", shortcut: shortcutLabel("O"), run: () => void openProblem() },
      { id: "file.save", label: t("cmdSave"), keywords: "save 저장", shortcut: shortcutLabel("S"), disabled: noFile, run: () => void saveProblem() },
      { id: "file.reopen", label: t("cmdReopen"), keywords: "reopen undo close 복원", shortcut: shortcutLabel("T", { shift: true }), run: reopenClosedTab },
      { id: "file.close", label: t("cmdCloseTab"), keywords: "close 닫기", shortcut: shortcutLabel("W"), disabled: noFile, run: () => closeWithShortcutRef.current() },
      { id: "terminal.toggle", label: terminalShown ? t("cmdTerminalHide") : t("cmdTerminalShow"), keywords: "terminal shell console cli cmd powershell 터미널 콘솔 셸 명령줄", shortcut: isMac ? "⌃`" : "Ctrl+`", run: toggleTerminal },
      { id: "terminal.restart", label: t("cmdTerminalRestart"), keywords: "terminal shell new restart 터미널 새 다시", run: restartTerminal },
      { id: "terminal.clear", label: t("cmdTerminalClear"), keywords: "terminal clear 터미널 지우기", disabled: !terminalStatus.running, run: () => terminalHost().clear() },
      { id: "terminal.stop", label: t("cmdTerminalStop"), keywords: "terminal kill stop 터미널 종료", disabled: !terminalStatus.running, run: () => terminalHost().stop() },
      { id: "file.rescan", label: t("cmdRescan"), keywords: "refresh reload rescan 새로고침", disabled: !workspacePath, run: () => void rescanWorkspaceFiles(true) },
      { id: "view.explorer", label: t("cmdExplorer"), keywords: "explorer sidebar files 탐색기", shortcut: shortcutLabel("B"), run: () => setExplorerVisible((visible) => !visible) },
      { id: "view.tests", label: t("cmdTestPanel"), keywords: "tests panel 테스트 패널", shortcut: shortcutLabel("B", { shift: true }), run: () => setTestPanelVisible((visible) => !visible) },
      { id: "view.interactive", label: t("cmdInteractivePanel"), keywords: "interactive 인터랙티브", shortcut: shortcutLabel("2", { alt: true }), run: () => { setTestPanelVisible(true); setPanelMode("interactive"); } },
      { id: "view.problem", label: t("cmdProblem"), keywords: "browser statement problem 문제 브라우저 지문", shortcut: shortcutLabel("3", { alt: true }), run: () => setProblemPanelOpen((open) => !open) },
      { id: "view.layout", label: t("cmdLayout"), keywords: "layout reset panels 배치", run: resetLayout },
      { id: "view.zoom-in", label: t("cmdZoomIn"), keywords: "zoom bigger 확대", shortcut: shortcutLabel("="), run: () => adjustUiZoom(UI_ZOOM_STEP) },
      { id: "view.zoom-out", label: t("cmdZoomOut"), keywords: "zoom smaller 축소", shortcut: shortcutLabel("-"), run: () => adjustUiZoom(-UI_ZOOM_STEP) },
      { id: "view.zoom-reset", label: t("cmdZoomReset"), keywords: "zoom 100 배율", shortcut: shortcutLabel("0"), run: () => setUiZoom(100) },
      { id: "lang.cpp", label: t("cmdToCpp"), keywords: "language c++ cpp 언어", disabled: noFile || language === "cpp", run: () => void changeActiveLanguage("cpp") },
      { id: "lang.python", label: t("cmdToPython"), keywords: "language python py 언어 파이썬", disabled: noFile || language === "python", run: () => void changeActiveLanguage("python") },
      { id: "profile.release", label: t("cmdRelease"), keywords: "compile O2 optimise 컴파일 프로필", disabled: compileProfile === "release", run: () => setCompileProfile("release") },
      { id: "profile.debug", label: t("cmdDebug"), keywords: "compile sanitizer debug 컴파일 프로필 디버그", disabled: compileProfile === "debug", run: () => setCompileProfile("debug") },
      { id: "judge.refresh", label: t("cmdRefreshJudge"), keywords: "verdict status submissions 채점 결과", disabled: refreshingJudge, run: () => void refreshSubmissionStatuses() },
      { id: "contest.board", label: t("cmdContest"), keywords: "contest timer board 컨테스트 대회", run: () => setContestOpen(true) },
      { id: "autosave", label: autoSave ? t("cmdAutoSaveOff") : t("cmdAutoSaveOn"), keywords: "auto save 자동 저장", run: () => setAutoSave((value) => !value) },
      ...UI_THEMES.map(([theme, name]): PaletteEntry => ({ id: `theme.${theme}`, label: `${t("cmdTheme")}${name}`, keywords: "theme colour color 테마 색", disabled: uiTheme === theme, run: () => setUiTheme(theme) })),
      { id: "locale", label: `${t("cmdLocale")}${uiLocale === "en" ? "한국어" : "English"}`, keywords: "language locale korean english 언어 한국어 영어", run: () => setUiLocale((locale) => locale === "en" ? "ko" : "en") },
      { id: "settings", label: t("cmdSettings"), keywords: "preferences options 설정", shortcut: shortcutLabel(","), run: openSettings },
      { id: "updates", label: t("cmdUpdates"), keywords: "update version 업데이트", disabled: !UPDATES_SUPPORTED, run: () => { openSettings(); setSettingsPage("updates"); void checkForUpdates(); } },
    ];
    return entries;
  })();
  const paletteMode = quickOpen !== null && quickOpen.startsWith(COMMAND_PREFIX);
  const paletteMatches = paletteMode && quickOpen !== null ? matchCommands(paletteCommands, quickOpen.slice(COMMAND_PREFIX.length)) : [];
  const runPaletteCommand = (command: PaletteEntry) => {
    if (command.disabled) return;
    setQuickOpen(null);
    command.run();
  };

  useEffect(() => {
    if (!isMac || !IS_TAURI) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<string>("menu", (event) => menuHandlerRef.current(event.payload))
      .then((stopListening) => { if (disposed) stopListening(); else unlisten = stopListening; });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    const handleRunShortcut = (event: KeyboardEvent) => {
      // Typing in the terminal: Ctrl+P, Ctrl+W and the rest are the shell's keys there.
      if (typedInTerminal(event) && !terminalKeyIsEditors(event)) return;
      // On macOS these accelerators live on the native menu bar, which fires first;
      // handling them here as well would run every command twice.
      if (isMac && IS_TAURI) {
        const key = event.key.toLowerCase();
        if ((event.metaKey || event.ctrlKey) && !(event.shiftKey && key === "t") && ["enter", "s", "n", "t", "o", "w", "b", "p", ",", ".", "=", "+", "-", "_", "0"].includes(key)) return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        if (event.shiftKey) void submitSolution();
        else if (event.altKey) beginInteractiveRun();
        else runActivePanel();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveProblem();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (event.shiftKey) explorerRef.current?.newFolder();
        else newProblem();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "t") {
        event.preventDefault();
        if (event.shiftKey) reopenClosedTab();
        else beginImport();
      }
      // Ctrl+` shows and hides the terminal — Control on macOS too, as in VS Code. The
      // physical key is matched, since a Korean layout types ₩ there.
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.code === "Backquote") {
        event.preventDefault();
        toggleTerminal();
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        menuHandlerRef.current(event.shiftKey ? "view:command-palette" : "view:go-to-file");
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void openProblem();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w") {
        event.preventDefault();
        closeWithShortcut();
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && ["=", "+"].includes(event.key)) {
        event.preventDefault();
        adjustUiZoom(UI_ZOOM_STEP);
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && ["-", "_"].includes(event.key)) {
        event.preventDefault();
        adjustUiZoom(-UI_ZOOM_STEP);
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === "0") {
        event.preventDefault();
        setUiZoom(100);
      }
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key === "3") {
        event.preventDefault();
        setProblemPanelOpen((open) => !open);
      }
      // Cmd+Alt+1/2 selects a side-panel mode, so plain tab switching ignores Alt.
      if ((event.ctrlKey || event.metaKey) && !event.altKey && /^[1-9]$/.test(event.key)) {
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
      // Escape in the terminal is for the program running there (vim, less, a REPL).
      if (typedInTerminal(event)) return;
      if (hasFileStatusError) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setFileStatus("ready");
      }
      else if (appCloseConfirm) setAppCloseConfirm(false);
      else if (closeConfirmTabId) setCloseConfirmTabId(null);
      else if (deleteConfirmFile) setDeleteConfirmFile(null);
      else if (explorerOverlays.deleteDirectory) dismissExplorerOverlay("deleteDirectory");
      else if (quickOpen !== null) setQuickOpen(null);
      else if (stressOpen) setStressOpen(false);
      else if (explorerOverlays.moveEntry) dismissExplorerOverlay("moveEntry");
      else if (sourceFile) setSourceFile(null);
      else if (explorerOverlays.rename) dismissExplorerOverlay("rename");
      else if (explorerOverlays.newFolder) dismissExplorerOverlay("newFolder");
      else if (blankFilenameOpen) setBlankFilenameOpen(false);
      else if (importCollision) setImportCollision(null);
      else if (settingsPage) setSettingsPage(null);
      else if (atCoderOpen) cancelProblemImport();
      else if (explorerOverlays.menu) dismissExplorerOverlay("menu");
      else if (releaseNotes) setReleaseNotes(null);
      else if (contestOpen) setContestOpen(false);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [appCloseConfirm, atCoderOpen, blankFilenameOpen, closeConfirmTabId, contestOpen, deleteConfirmFile, explorerOverlays.deleteDirectory, explorerOverlays.menu, explorerOverlays.moveEntry, explorerOverlays.newFolder, explorerOverlays.rename, hasFileStatusError, importCollision, quickOpen, releaseNotes, settingsPage, sourceFile, stressOpen]);

  useEffect(() => {
    const isAllowedContextTarget = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(".file-explorer, .monaco-editor, textarea"));
    const dismissMenu = (target: EventTarget | null) => {
      if (!(target instanceof Element) || !target.closest(".explorer-context-menu")) dismissExplorerOverlay("menu");
    };
    const handlePointerDown = (event: PointerEvent) => dismissMenu(event.target);
    const handleContextMenu = (event: MouseEvent) => {
      if (!isAllowedContextTarget(event.target)) event.preventDefault();
      if (!(event.target instanceof Element) || !event.target.closest(".explorer-context-menu, .file-explorer")) dismissExplorerOverlay("menu");
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
      // An IME commits its composition with Enter; that keystroke must not also submit.
      if (event.isComposing || event.keyCode === 229) return;
      if (hasFileStatusError) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setFileStatus("ready");
        return;
      }
      if (event.defaultPrevented) return;
      if (!(appCloseConfirm || closeConfirmTabId || deleteConfirmFile || explorerOverlays.deleteDirectory || sourceFile || explorerOverlays.newFolder || blankFilenameOpen || importCollision || atCoderOpen)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (appCloseConfirm) {
        void saveAndCloseApplication();
      } else if (closeConfirmTabId) {
        closeProblem(closeConfirmTabId);
        setCloseConfirmTabId(null);
      } else if (deleteConfirmFile) {
        void deleteSavedFile();
      } else if (explorerOverlays.deleteDirectory) {
        explorerRef.current?.confirmDeleteFolder();
      } else if (sourceFile) {
        void updateProblemSource();
      } else if (explorerOverlays.newFolder) {
        explorerRef.current?.confirmNewFolder();
      } else if (blankFilenameOpen) {
        confirmBlankProblem();
      } else if (importCollision) {
        openSavedFile(importCollision.existing);
        setImportCollision(null);
      } else if (atCoderOpen) {
        if (atCoderUrl.trim()) void importAtCoderProblem();
        else cancelProblemImport();
      }
    };
    window.addEventListener("keydown", handleConfirm, true);
    return () => window.removeEventListener("keydown", handleConfirm, true);
  // Every value a confirm handler reads has to be listed here, or Enter submits
  // what the field held when the dialog opened rather than what it holds now.
  }, [appCloseConfirm, atCoderOpen, atCoderUrl, blankFilename, blankFilenameOpen, closeConfirmTabId, deleteConfirmFile, explorerOverlays.deleteDirectory, explorerOverlays.newFolder, hasFileStatusError, importCollision, sourceFile, sourceUrlValue, sourceValue]);

  const summary = useMemo(() => {
    if (running) return "running tests…";
    if (!tests.some((test) => test.status !== "idle")) return "ready";
    const accepted = tests.filter((test) => test.status === "ac").length;
    // A compile error fails every test the same way; naming it beats reporting "0 / 5 AC".
    if (tests.every((test) => test.status === "ce")) return "compile error";
    const worst = finalVerdicts.find((verdict) => verdict !== "ac" && tests.some((test) => test.status === verdict));
    return `${accepted} / ${tests.length} AC${worst ? ` · ${verdictLabels[worst]}` : ""}`;
  }, [running, tests]);

  return (
    <main
      className="app-shell"
      data-wallpaper={background.url ? "image" : undefined}
      style={{
        "--wallpaper-image": background.url ? `url(${background.url})` : "none",
        "--wallpaper-size": wallpaper.size,
        "--wallpaper-repeat": wallpaper.repeat,
        "--wallpaper-position": wallpaper.position,
        "--acrylic-opacity": `${acrylicOpacity}%`,
        "--acrylic-blur": `${acrylicBlur}px`,
      } as CSSProperties}
    >
      <div className="window-titlebar" data-tauri-drag-region>
        <div className="titlebar-identity" data-tauri-drag-region>
          <span className="titlebar-logo"><AppMark /></span>
          <span className="titlebar-name" data-tauri-drag-region>Mild Editor</span>
          {IS_DEV_BUILD && <span className="titlebar-dev" data-tauri-drag-region title="tauri dev build">dev</span>}
          <span className="titlebar-file" data-tauri-drag-region>
            {workspacePath ? <>
              <span className="crumb">{workspacePath.split(/[\\/]/).filter(Boolean).at(-1)}</span>
              {activeTab && activeTab.filename.split("/").map((part, index, parts) => <Fragment key={index}><Icon name="chevronRight" size={10} /><span className={`crumb ${index === parts.length - 1 ? "current" : ""}`}>{part}</span></Fragment>)}
            </> : <span className="crumb">{t("noWorkspace")}</span>}
          </span>
        </div>
        <div className="titlebar-tools">
          <div className="file-actions">
            <button onClick={newProblem} title={`${t("new")} (${modLabel}N)`}><Icon name="filePlus" /><span>{t("new")}</span></button>
            <button onClick={() => void openProblem()} title={`${t("open")} (${modLabel}O)`}><Icon name="folderOpen" /><span>{t("open")}</span></button>
            <button onClick={() => void saveProblem()} title={`${t("save")} (${modLabel}S)`}><Icon name="save" /><span>{t("save")}</span></button>
            <button className="atcoder-button" onClick={beginImport} title={`${t("import")} (${modLabel}T)`}><Icon name="download" /><span>{t("import")}</span></button>
          </div>
          <div className="snippet-insert">
            <select value={insertSnippetId} onChange={(event) => setInsertSnippetId(event.target.value)} aria-label="Select a code snippet">
              <option value="">{t("snippetPlaceholder")}</option>
              {snippets.filter((snippet) => snippet.language === language).map((snippet) => <option value={snippet.id} key={snippet.id}>{snippet.name}</option>)}
            </select>
            <button onClick={insertSnippet} disabled={!insertSnippetId}>{t("insert")}</button>
          </div>
          <button className={`run-top ${running ? "running" : ""}`} onClick={running ? stopRun : () => void run()} disabled={!tabs.length} title={`${running ? t("stop") : t("runTests")} (${modLabel}${isMac ? "↵" : "Enter"})`}>
            <Icon name={running ? "stop" : "play"} size={14} /><span>{running ? t("stop") : t("run")}</span>
          </button>
          <button className="submit-top" onClick={() => void submitSolution()} disabled={!activeTab?.sourceUrl || submitting} title={activeTab?.sourceUrl ? `${t("submitHint")} (${isMac ? "⌘⇧↵" : "Ctrl+Shift+Enter"})` : t("submitNoSource")}>
            {submitting ? <span className="spinner" /> : <Icon name="send" size={14} />}<span>{t("submit")}</span>
          </button>
        </div>
        {/* macOS draws its own traffic lights over the title bar; a second set of controls would be redundant. */}
        {!isMac && <div className="window-controls">
          <button onClick={() => { if (IS_TAURI) void getCurrentWindow().minimize(); }} aria-label="Minimize window"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 8.5h8v1H2z" /></svg></button>
          <button onClick={() => { if (IS_TAURI) void getCurrentWindow().toggleMaximize(); }} aria-label="Maximize window"><svg viewBox="0 0 12 12" aria-hidden="true"><path fillRule="evenodd" d="M2 2h8v8H2V2Zm1 1v6h6V3H3Z" /></svg></button>
          <button className="window-close" onClick={requestApplicationClose} aria-label="Close window"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 3.2.7-.7L6 5.3l2.8-2.8.7.7L6.7 6l2.8 2.8-.7.7L6 6.7 3.2 9.5l-.7-.7L5.3 6 2.5 3.2Z" /></svg></button>
        </div>}
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
              ><LanguageIcon language={tab.language} /></span>
              {tab.id === activeTabId ? <div className="tab-edit"><span className={`tab-status ${tab.dirty ? "dirty" : ""}`} />{tabRenameDraft?.id === tab.id
                ? <input autoFocus value={tabRenameDraft.value} onBlur={finishTabRename} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setTabRenameDraft(null); event.currentTarget.blur(); } }} onChange={(event) => setTabRenameDraft({ id: tab.id, value: event.target.value })} aria-label="Active tab filename" spellCheck={false} />
                : <button className="tab-rename-trigger" onClick={() => setTabRenameDraft({ id: tab.id, value: tab.filename })} title="click to rename"><span className="tab-title">{explorerBasename(tab.filename)}</span></button>}</div>
                : <button className="tab-select" onClick={() => activateTab(tab)} title={tab.filename}><span className={`tab-status ${tab.dirty ? "dirty" : ""}`} /><span className="tab-title">{explorerBasename(tab.filename)}</span></button>}
              <button className="tab-close" onClick={() => requestCloseProblem(tab.id)} aria-label={`Close ${tab.title} tab`}><Icon name="close" size={12} /></button>
            </div>
          ))}
        </div>
      </nav>
      <section className="workspace" ref={workspaceRef}>
        {dividers.map((divider) => (
          <div
            key={divider.key}
            className={`panel-resizer panel-resizer-${divider.axis}`}
            style={divider.style}
            onPointerDown={(event) => startPanelResize(divider.axis, divider.before, divider.after, divider.pair, event)}
            role="separator"
            aria-label="Resize panel"
            aria-orientation={divider.axis === "x" ? "vertical" : "horizontal"}
          />
        ))}
        {panelDrag && [...panelRects].map(([id, rect]) => (
          <div key={`drop-${id}`} className="panel-drop-zone" style={{ left: `${rect.left}%`, top: `${rect.top}%`, width: `${rect.width}%`, height: `${rect.height}%` }} aria-hidden="true">
            {panelDrag.over?.target === id && <span className={`panel-drop-edge edge-${panelDrag.over.edge}`} />}
          </div>
        ))}
        {PANEL_IDS.filter(panelShown).map((id) => (<Fragment key={id}>
          {id === "tests" && <aside className="test-panel" style={panelStyle(id)}>
            {panelGrip(id)}
            <div className="panel-heading">
              <div className="panel-modes">
                <button className={panelMode === "tests" ? "active" : ""} aria-pressed={panelMode === "tests"} onClick={() => setPanelMode("tests")}>{t("testCases")}</button>
                <button className={panelMode === "interactive" ? "active" : ""} aria-pressed={panelMode === "interactive"} onClick={() => setPanelMode("interactive")}>{t("interactive")}</button>
                <button className={panelMode === "terminal" ? "active" : ""} aria-pressed={panelMode === "terminal"} onClick={() => setPanelMode("terminal")} title={`${t("terminal")} (${isMac ? "⌃`" : "Ctrl+`"})`}>{t("terminal")}</button>
              </div>
              {panelMode === "tests" ? <>
                {testSummary.judged > 0
                  ? <span className={`test-summary ${testSummary.tone}`} title={`${testSummary.passed}/${testSummary.total} ${t("testsPassed")}${testSummary.slowestMs !== null ? ` · max ${testSummary.slowestMs} ms` : ""}`}>{testSummary.passed}/{testSummary.total}</span>
                  : <span className="count">{tests.length}</span>}
                <button className="panel-run" onClick={() => void run()} disabled={running} aria-label="run all tests" title={`${t("cmdRunAll")} (${shortcutLabel("Enter")})`}>
                  {running ? <span className="spinner" /> : <Icon name="play" size={14} />}
                </button>
                {running && <button className="panel-stop" onClick={stopRun} aria-label="stop running" title="stop running"><Icon name="stop" size={14} /></button>}
              </> : panelMode === "terminal" ? <>
                <span className="terminal-shell" title={terminalStatus.error || undefined}>{terminalStatus.running ? terminalStatus.shell : terminalStatus.error ? "!" : t("terminalIdle")}</span>
                <button className="panel-tool" onClick={() => terminalHost().clear()} disabled={!terminalStatus.running} aria-label={t("terminalClear")} title={t("terminalClear")}><Icon name="close" size={13} /></button>
                <button className="panel-run" onClick={restartTerminal} aria-label={t("terminalRestart")} title={t("terminalRestart")}><Icon name="plus" size={14} /></button>
                {terminalStatus.running && <button className="panel-stop" onClick={() => terminalHost().stop()} aria-label={t("terminalStop")} title={t("terminalStop")}><Icon name="stop" size={14} /></button>}
              </> : <>
                <button className="panel-run" onClick={() => void startInteractive()} disabled={interactiveStarting} aria-label="start interactive run" title={t("interactiveStart")}>
                  {interactiveStarting ? <span className="spinner" /> : <Icon name="play" size={14} />}
                </button>
                {interactiveRunning && <button className="panel-stop" onClick={stopInteractive} aria-label="stop interactive run" title="stop running"><Icon name="stop" size={14} /></button>}
              </>}
            </div>
            {panelMode === "tests" ? <>
            <div className="limits-bar">
              <label title={t("timeLimit")}><Icon name="clock" size={13} /><input type="number" min={100} max={60000} step={100} placeholder={String(DEFAULT_TIME_LIMIT_MS)} value={activeTab?.limits?.timeLimitMs ?? ""} onChange={(event) => updateLimits({ timeLimitMs: limitInput(event.target.value, 100, 60000) })} aria-label={t("timeLimit")} /><span>ms</span></label>
              <label title={t("memoryLimit")}><Icon name="chip" size={13} /><input type="number" min={1} max={16384} step={16} placeholder="—" value={activeTab?.limits?.memoryLimitMb ?? ""} onChange={(event) => updateLimits({ memoryLimitMb: limitInput(event.target.value, 1, 16384) })} aria-label={t("memoryLimit")} /><span>MB</span></label>
              {checkerApplies && (activeChecker
                ? <span className={`checker-chip ${checkerOn ? "on" : ""}`}>
                    <button onClick={toggleChecker} aria-pressed={checkerOn} title={checkerOn ? t("checkerOnHint") : t("checkerOffHint")}><Icon name={checkerOn ? "check" : "scale"} size={12} />{t("checker")}</button>
                    <button className="checker-open" onClick={() => openSavedFile(activeChecker)} aria-label={t("checkerOpen")} title={`${t("checkerOpen")}: ${explorerBasename(activeChecker.filename)}`}><Icon name="file" size={12} /></button>
                  </span>
                : <button className="checker-add" onClick={() => void createChecker()} title={t("checkerAddHint")}><Icon name="scale" size={12} />{t("checker")}</button>)}
              {language === "cpp" && compileProfile === "debug" && <span className="limits-note" title={t("debugTimeNote")}>Debug ×{DEBUG_TIME_FACTOR}</span>}
            </div>
            <div className="test-list">
              {tests.map((test) => (
                <article className={`test-card ${test.open ? "open" : ""}`} key={test.id}>
                  <div className="test-row">
                    <button className="test-toggle" onClick={() => updateTest(test.id, { open: !test.open })}>
                      <Icon name={test.open ? "chevronDown" : "chevronRight"} size={12} className="test-chevron" />
                      <span className={`signal ${test.status}`} aria-label={test.status} />
                      <span className="test-name">{test.name}</span>
                      {test.timeMs !== undefined && <span className="time">{test.timeMs} ms{test.memoryKb ? ` · ${formatMemory(test.memoryKb)}` : ""}</span>}
                    </button>
                    {finalVerdicts.includes(test.status) && <span className={`verdict ${test.status}`}>{verdictLabels[test.status]}</span>}
                    <button className="delete-test" onClick={() => removeTest(test.id)} aria-label={`Delete ${test.name}`}><Icon name="close" size={12} /></button>
                  </div>
                  {test.open && (
                    <div className="test-fields">
                      <label>{t("input")}<textarea value={test.input} onChange={(event) => updateTest(test.id, { input: event.target.value, status: "idle" })} spellCheck={false} /></label>
                      <label><span className="field-label">{t("expected")}<button className="accept-output" onClick={() => updateTest(test.id, { expected: test.output, status: "idle" })} disabled={test.timeMs === undefined || Boolean(test.error)}>{t("useOutput")}</button></span><textarea value={test.expected} onChange={(event) => updateTest(test.id, { expected: event.target.value, status: "idle" })} spellCheck={false} /></label>
                      <label>
                        <span className="field-label">{t("output")}{test.status === "wa" && <button className="accept-output" onClick={() => toggleRawOutput(test.id)}>{rawOutputTests.includes(test.id) ? t("showDiff") : t("showRaw")}</button>}</span>
                        {test.checkerMessage !== undefined && test.checkerMessage !== "" && <pre className={`checker-message ${test.status}`}><b>{t("checkerSays")}</b> {test.checkerMessage}</pre>}
                        {test.status === "wa" && !rawOutputTests.includes(test.id)
                          ? <div className="test-diff">
                              <div className="diff-row diff-head"><span className="diff-line" /><span>{t("diffExpected")}</span><span>{t("diffActual")}</span></div>
                              {diffLines(test.expected, test.output, floatTolerance).map((row) => (
                                <div className={`diff-row ${row.same ? "same" : row.whitespaceOnly ? "whitespace" : "different"}`} key={row.line} title={row.whitespaceOnly ? t("diffWhitespace") : undefined}>
                                  <span className="diff-line">{row.line}</span>
                                  <span className="diff-cell">{row.expected === null ? "" : row.whitespaceOnly ? visibleWhitespace(row.expected) : row.expected}</span>
                                  <span className="diff-cell">{row.actual === null ? "" : row.whitespaceOnly ? visibleWhitespace(row.actual) : row.actual}</span>
                                </div>
                              ))}
                            </div>
                          : <textarea value={combinedRunOutput(test.output, test.error)} readOnly className={test.error ? "has-error" : ""} placeholder={t("runToSee")} />}
                      </label>
                    </div>
                  )}
                </article>
              ))}
            </div>
            <div className="test-actions">
              <button className="add-test" onClick={addTest} aria-label="Add test case" title="add test case"><Icon name="plus" size={14} /><span>{t("addTest")}</span></button>
              <button className="add-test" onClick={openStressDialog} disabled={!activeTab || !workspacePath} title={t("stressHint")}><Icon name="flask" size={14} /><span>{t("stress")}</span></button>
            </div>
            </> : panelMode === "interactive" ? <div className="interactive-panel">
              <div className="interactive-log" ref={interactiveLogRef}>
                {interactiveLog.length
                  ? interactiveLog.map((entry) => <pre className={`interactive-entry ${entry.kind}`} key={entry.id}>{entry.text}</pre>)
                  : <p className="interactive-hint">{t("interactiveHint")}</p>}
              </div>
              <div className="interactive-compose">
                <textarea
                  ref={interactiveInputRef}
                  value={interactiveDraft}
                  onChange={(event) => setInteractiveDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendInteractive();
                    }
                    // The panel stands in for a terminal, so Ctrl+D closes stdin there too.
                    if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "d") {
                      event.preventDefault();
                      void endInteractiveInput();
                    }
                  }}
                  placeholder={interactiveRunning ? t("interactiveReply") : t("interactiveIdle")}
                  disabled={!interactiveRunning}
                  spellCheck={false}
                  rows={2}
                />
                <div className="interactive-buttons">
                  <button className="subtle-button" onClick={() => void sendInteractive()} disabled={!interactiveRunning}>{t("interactiveSend")}</button>
                  <button className="subtle-button" onClick={() => void endInteractiveInput()} disabled={!interactiveRunning}>{t("interactiveEof")}</button>
                </div>
              </div>
            </div> : null}
            {/* Always mounted, hidden when another tab shows, so the shell and its scrollback stay. */}
            <div className={`terminal-pane ${panelMode === "terminal" ? "" : "hidden"}`}>
              <BuiltinTerminal visible={terminalShown} cwd={workspacePath} look={{ fontFamily: editorFontFamily, fontSize: editorFontSize }} themeKey={uiTheme} />
            </div>
          </aside>}
          {id === "editor" && <section className="editor-area" style={panelStyle(id)}>
          {panelGrip(id)}
          {/* Inside the editor on purpose: the problem browser is a native view that would cover a notice floating over it. */}
          {verdictNotices.length > 0 && <div className="verdict-notices" role="status" aria-live="polite">
            {verdictNotices.map((notice) => {
              const file = [...tabs, ...savedFiles].find((item) => fileKey(item.filename) === fileKey(notice.filename));
              const dismiss = () => setVerdictNotices((items) => items.filter((item) => item.id !== notice.id));
              const view = verdictView(notice.status);
              return <div key={notice.id} className={`verdict-notice ${view.tone === "accepted" ? "accepted" : view.tone === "partial" ? "partial" : "rejected"}`}>
                <button className="verdict-notice-body" title={t("verdictOpen")} onClick={() => { if (file) openSavedFile(file); dismiss(); }}>
                  <small>{t("verdictNotice")}</small>
                  <strong>{view.text}</strong>
                  <span>{explorerBasename(notice.filename)}</span>
                </button>
                <button className="verdict-notice-close" aria-label={t("verdictDismiss")} title={t("verdictDismiss")} onClick={dismiss}><Icon name="close" size={12} /></button>
              </div>;
            })}
          </div>}
          {tabs.length ? <>
          <Editor
            beforeMount={setupMonaco}
            onMount={handleMount}
            theme={monacoTheme}
            language={language === "cpp" ? "cpp" : "python"}
            path={`file:///${activeTabId}/main.${language === "cpp" ? "cpp" : "py"}`}
            value={codes[language]}
            onChange={(value) => {
              clearDiagnostics();
              markActiveDirty();
              patchActiveTab((tab) => ({ codes: { ...tab.codes, [language]: value || "" } }));
            }}
            options={{
              automaticLayout: true,
              fontFamily: editorFontFamily,
              fontSize: editorFontSize,
              lineHeight: editorLineHeightFor(editorFontSize),
              smoothScrolling: true,
              editContext: false,
              disableLayerHinting: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              padding: { top: 18, bottom: 18 },
              renderLineHighlight: "none",
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
            <div className="welcome-mark"><AppMark /></div>
            <p className="eyebrow">{t("welcomeTagline")}</p>
            <h1>Mild Editor</h1>
            <p>{t("welcomeBody")}</p>
            <div className="welcome-actions"><button className="primary-button" onClick={newProblem}>{t("newWorkspace")} <kbd>{modLabel}N</kbd></button><button className="subtle-button" onClick={() => void openProblem()}>{t("openWorkspace")} <kbd>{modLabel}O</kbd></button></div>
          </div>}
        </section>}
        {id === "problem" && <aside className="problem-panel" style={panelStyle(id)} aria-label="Problem browser">
          {panelGrip(id)}
          <div className="problem-toolbar">
            <button onClick={() => void invoke("browser_go", { action: "back" })} disabled={!browserStatus.canGoBack} aria-label="back" title="back"><Icon name="arrowLeft" size={14} /></button>
            <button onClick={() => void invoke("browser_go", { action: "forward" })} disabled={!browserStatus.canGoForward} aria-label="forward" title="forward"><Icon name="arrowRight" size={14} /></button>
            <button onClick={() => void invoke("browser_go", { action: browserStatus.loading ? "stop" : "reload" })} disabled={!browserStatus.open} aria-label={browserStatus.loading ? "stop" : "reload"} title={browserStatus.loading ? "stop" : "reload"}><Icon name={browserStatus.loading ? "close" : "reload"} size={14} /></button>
            <input className="problem-url" value={problemUrlDraft} placeholder="https://" spellCheck={false}
              onFocus={() => { problemUrlEditingRef.current = true; }}
              onBlur={() => { problemUrlEditingRef.current = false; setProblemUrlDraft(browserStatus.url); }}
              onChange={(event) => setProblemUrlDraft(event.target.value)}
              onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter") { event.preventDefault(); openProblemUrl(problemUrlDraft); event.currentTarget.blur(); } }}
              aria-label="problem URL" />
            <button className="problem-import" onClick={() => void importFromProblemPage()} disabled={!browserStatus.open || !browserStatus.url || browserStatus.loading || importingAtCoder} title={t("problemImportHint")}><Icon name="download" size={14} />{t("import")}</button>
            <button onClick={() => setProblemPanelOpen(false)} aria-label="close problem panel" title="close"><Icon name="close" size={14} /></button>
          </div>
          {browserStatus.available
            ? <div className="problem-host" ref={problemHostRef} style={problemHostStyle}>{!browserStatus.open && <p className="problem-hint">{t("problemPanelHint")}</p>}</div>
            : <div className="problem-host problem-unavailable"><p className="problem-hint"><strong>{t("problemUnavailable")}</strong><br />{browserStatus.error || "CEF is not initialised"}</p></div>}
        </aside>}
        {id === "explorer" && <aside className="file-explorer" style={panelStyle(id)} aria-label="Saved files">
          {panelGrip(id)}
          <Explorer {...explorerProps} />
        </aside>}
        </Fragment>))}
      </section>

      {(updateStatus.phase === "available" || updateStatus.phase === "downloading" || updateStatus.phase === "installing" || updateStatus.phase === "installed" || (updateStatus.phase === "error" && updateStatus.version)) && !updateNoticeDismissed && <aside className={`update-notice ${updateStatus.phase}`} role="status" aria-live="polite">
        <strong>{updateStatus.phase === "error" ? t("updatesError") : updateStatusLine(updateStatus, t)}</strong>
        {updateStatus.phase === "downloading" && <progress max={updateStatus.total || 1} value={updateStatus.total ? updateStatus.received || 0 : undefined} aria-label={t("updatesDownloading")} />}
        {updateStatus.phase === "error" && <small>{updateStatus.error}</small>}
        {(updateStatus.phase === "available" || updateStatus.phase === "error" || updateStatus.phase === "installed") && <span className="update-notice-actions">
          <button className="subtle-button" onClick={() => setUpdateNoticeDismissed(true)}>{t("updatesLater")}</button>
          {updateStatus.phase !== "installed" && <button className="primary-button" onClick={() => void installUpdate()}>{updateStatus.phase === "error" ? t("updatesRetry") : t("updatesInstall")}</button>}
        </span>}
      </aside>}
      {hasFileStatusError && DEMO_MODE === null && <section className="error-notice" role="alertdialog" aria-modal="true" aria-labelledby="error-notice-title">
        <header><strong id="error-notice-title">{t("errorTitle")}</strong><button className="error-close" onClick={() => setFileStatus("ready")} aria-label="close error"><Icon name="close" size={14} /></button></header>
        <p>{fileStatus}</p>
        <footer><button className="error-confirm" onClick={() => setFileStatus("ready")}>OK</button></footer>
      </section>}

      <ExplorerContextMenu {...explorerProps} />

      {closeConfirmTabId && (() => {
        const tab = tabs.find((item) => item.id === closeConfirmTabId);
        return <ConfirmDialog id="close-confirm-title" eyebrow={t("unsavedChanges")} title={<>{t("tabNotSaved").replace("{name}", tab?.filename || "file")}</>} cancel={t("cancel")} onCancel={() => setCloseConfirmTabId(null)} actions={<><button className="danger-button" onClick={() => { closeProblem(closeConfirmTabId); setCloseConfirmTabId(null); }}>{t("closeWithoutSaving")}</button><button className="primary-button" autoFocus onClick={() => { const id = closeConfirmTabId; setCloseConfirmTabId(null); void saveProblem().then((saved) => { if (saved) closeProblem(id); }); }}>{t("saveAndClose")}</button></>}>
          <p>{t("tabNotSavedBody")}</p>
        </ConfirmDialog>;
      })()}

      {appCloseConfirm && <ConfirmDialog id="app-close-confirm-title" eyebrow={t("unsavedChanges")} title={<>{t("appNotSaved")}</>} cancel={t("cancel")} onCancel={() => setAppCloseConfirm(false)} actions={<><button className="danger-button" onClick={closeApplication}>{t("closeWithoutSaving")}</button><button className="primary-button" onClick={() => void saveAndCloseApplication()}>{t("saveAndClose")}</button></>}>
        <p>{t("appNotSavedBody")}</p>
      </ConfirmDialog>}

      {deleteConfirmFile && <ConfirmDialog id="delete-confirm-title" eyebrow="delete saved file" title={<>Delete {deleteConfirmFile.filename}?</>} cancel={t("cancel")} onCancel={() => setDeleteConfirmFile(null)} actions={<><button className="danger-button" onClick={() => void deleteSavedFile()}>Delete file</button></>}>
        <p>This permanently deletes the source file and its saved test cases.</p>
      </ConfirmDialog>}


      {sourceFile && <ConfirmDialog id="source-file-title" eyebrow="problem classification" title={<>Set source for {sourceFile.filename}</>} cancel={t("cancel")} onCancel={() => setSourceFile(null)} actions={<><button className="primary-button" onClick={() => void updateProblemSource()}>Save</button></>}>
        <label className="clangd-path-label">Platform
          <select value={sourceValue} onChange={(event) => setSourceValue(event.target.value as ProblemSource)} autoFocus>
            <option value="other">Local / other</option>
            <option value="atcoder">AtCoder</option>
            <option value="codeforces">Codeforces</option>
            <option value="doj">DOJ</option>
          </select>
        </label>
        {sourceValue !== "other" && <label className="clangd-path-label">Problem URL (optional)
          <input value={sourceUrlValue} onChange={(event) => setSourceUrlValue(event.target.value)} placeholder="https://..." spellCheck={false} />
        </label>}
        <p>The classification is saved even when the test cases were created manually.</p>
      </ConfirmDialog>}

      <SettingsDialog
        t={t} page={settingsPage} onPage={setSettingsPage} language={language} systemFonts={systemFonts} background={background}
        showStatus={setFileStatus} resetLayout={resetLayout} applyTemplate={applyTemplate}
        companionStatus={companionStatus} companionError={companionError}
        refreshingJudge={refreshingJudge} refreshSubmissionStatuses={() => void refreshSubmissionStatuses()}
        browserStatus={browserStatus} installUserscript={installUserscript}
        clangdStatus={clangdStatus} clangdInfo={clangdInfo} connectClangd={() => void connectClangd()}
        appVersion={appVersion} updateStatus={updateStatus} updateRetryable={Boolean(pendingUpdateRef.current)}
        checkForUpdates={() => void checkForUpdates()} installUpdate={() => void installUpdate()}
        exportSettings={() => void exportSettings()} importSettings={() => void importSettings()}
      />

      {blankFilenameOpen && <ConfirmDialog id="blank-file-title" eyebrow="new file" title={<>Choose a file name{entryParentDirectory ? ` in ${entryParentDirectory}` : ""}</>} cancel={t("cancel")} onCancel={() => setBlankFilenameOpen(false)} actions={<><button className="primary-button" onClick={confirmBlankProblem}>Create</button></>}>
        <input className="atcoder-url" value={blankFilename} onChange={(event) => setBlankFilename(event.target.value)} autoFocus spellCheck={false} />
      </ConfirmDialog>}

      {stressOpen && (() => {
        const candidates = savedFiles.filter((file) => fileKey(file.filename) !== fileKey(activeTab?.filename || ""));
        const creating = stressChoice.generator === STRESS_CREATE || stressChoice.reference === STRESS_CREATE;
        const chooser = (which: StressRole) => {
          const picked = stressChoice[which] === STRESS_CREATE ? undefined : savedFiles.find((file) => fileKey(file.filename) === fileKey(stressChoice[which]));
          const wouldCreate = activeTab ? stressCompanionName(activeTab.filename, which, activeTab.language) : "";
          return <label className="stress-field">{which === "generator" ? t("stressGenerator") : t("stressReference")}
            <span className="stress-picker">
              <select value={stressChoice[which]} disabled={stressBusy} onChange={(event) => setStressChoice((choice) => ({ ...choice, [which]: event.target.value }))}>
                <option value={STRESS_CREATE}>{t("stressCreateNew")} · {explorerBasename(wouldCreate)}</option>
                {candidates.map((file) => <option key={file.id} value={file.filename}>{file.filename}</option>)}
              </select>
              <button className="subtle-button" disabled={!picked} title={t("stressEdit")} aria-label={t("stressEdit")} onClick={() => { if (picked) { openSavedFile(picked); setStressOpen(false); } }}><Icon name="file" size={14} /></button>
            </span>
          </label>;
        };
        return <div className="modal-backdrop close-confirm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !stressBusy) setStressOpen(false); }}>
          <section className="confirm-dialog stress-dialog" role="dialog" aria-modal="true" aria-labelledby="stress-title">
            <h2 id="stress-title">{t("stress")}</h2>
            <p>{t("stressHelp")}</p>
            <>
              <div className="stress-fields">
                {chooser("generator")}
                {chooser("reference")}
                <label className="stress-field">{t("stressRounds")}
                  <input type="number" min={1} max={100000} value={stressRounds} disabled={stressBusy} onChange={(event) => setStressRounds(event.target.value)} />
                </label>
              </div>
              {stressCreated.length > 0 && (() => {
                const made = stressCreated.map((filename) => savedFiles.find((item) => fileKey(item.filename) === fileKey(filename))).filter((file): file is ProblemTab => Boolean(file));
                return <div className="stress-result made">
                  <strong>{t("stressMade")}</strong>
                  <span>{t("stressMadeNext")}</span>
                  <ul className="stress-made-files">{stressCreated.map((filename) => {
                    const file = savedFiles.find((item) => fileKey(item.filename) === fileKey(filename));
                    return <li key={filename}><LanguageIcon language={file?.language || "cpp"} />{explorerBasename(filename)}</li>;
                  })}</ul>
                  <button className="subtle-button stress-open-made" disabled={!made.length} onClick={() => { openSavedFiles(made); setStressOpen(false); }}>{t("stressOpenMade")}</button>
                </div>;
              })()}
              {checkerOn && activeChecker && <p className="settings-help"><Icon name="check" size={12} /> {t("stressUsesChecker").replace("{name}", explorerBasename(activeChecker.filename))}</p>}
              {stressBusy && <p className="stress-progress">{t("stressRunning")} {stressRound}</p>}
              {stressOutcome?.kind === "passed" && <p className="stress-result ok">{t("stressPassed")} {stressOutcome.rounds} {t("stressPassedRounds")}</p>}
              {stressOutcome?.kind === "stopped" && <p className="stress-result">{t("stop")} · {stressOutcome.rounds} {t("stressPassedRounds")}</p>}
              {stressOutcome?.kind === "compileError" && <div className="stress-result bad"><strong>{stressOutcome.program} {t("stressCompileError")}</strong><pre>{stressOutcome.message}</pre></div>}
              {stressOutcome?.kind === "crashed" && <div className="stress-result bad">
                <strong>{stressOutcome.program} {t("stressCrashed")} · {stressOutcome.rounds} {t("stressFoundIn")}</strong>
                <pre>{stressOutcome.message}</pre>
                {stressOutcome.input && <><small>{t("stressInput")}</small><pre className="stress-case">{stressOutcome.input}</pre></>}
              </div>}
              {stressOutcome?.kind === "mismatch" && <div className="stress-result bad">
                <strong>{t("stressFoundTitle")} · {stressOutcome.rounds} {t("stressFoundIn")}</strong>
                {stressOutcome.reason && <pre className="checker-message wa"><b>{t("checkerSays")}</b> {stressOutcome.reason}</pre>}
                <div className="stress-case-grid">
                  <div><small>{t("stressInput")}</small><pre className="stress-case">{stressOutcome.input}</pre></div>
                  <div><small>{t("stressExpected")}</small><pre className="stress-case">{stressOutcome.expected}</pre></div>
                  <div><small>{t("stressActual")}</small><pre className="stress-case">{stressOutcome.actual}</pre></div>
                </div>
              </div>}
            </>
            <footer className="settings-footer">
              <span className="footer-spacer" />
              {(stressOutcome?.kind === "mismatch" || (stressOutcome?.kind === "crashed" && stressOutcome.input)) && <button className="subtle-button" onClick={addStressCase}>{t("stressAddTest")}</button>}
              <button className="subtle-button" onClick={() => setStressOpen(false)} disabled={stressBusy}>{t("cancel")}</button>
              {stressBusy
                ? <button className="danger-button" onClick={stopRun}>{t("stop")}</button>
                : <button className="primary-button" onClick={() => void startStressTest()} disabled={!stressChoice.generator || !stressChoice.reference}>{creating ? t("stressCreate") : t("stressStart")}</button>}
            </footer>
          </section>
        </div>;
      })()}

      {quickOpen !== null && <div className="modal-backdrop quick-open" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setQuickOpen(null); }}>
        <section className="quick-open-dialog" role="dialog" aria-modal="true" aria-label={paletteMode ? t("paletteTitle") : t("quickOpen")}>
          <input
            className="quick-open-field"
            autoFocus
            spellCheck={false}
            value={quickOpen}
            placeholder={paletteMode ? t("palettePlaceholder") : `${t("quickOpenPlaceholder")} · ${t("quickOpenCommandsTip")}`}
            aria-label={paletteMode ? t("paletteTitle") : t("quickOpen")}
            onChange={(event) => { setQuickOpen(event.target.value); setQuickOpenIndex(0); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              const count = paletteMode ? paletteMatches.length : quickOpenMatches.length;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setQuickOpenIndex((index) => count ? (index + step + count) % count : 0);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (paletteMode) {
                  const chosen = paletteMatches[quickOpenIndex];
                  if (chosen) runPaletteCommand(chosen.command);
                  return;
                }
                const chosen = quickOpenMatches[quickOpenIndex];
                if (!chosen) return;
                setQuickOpen(null);
                openSavedFile(chosen.file);
              }
            }}
          />
          {paletteMode ? <div className="quick-open-list" role="listbox">
            {paletteMatches.length ? paletteMatches.map((row, index) => {
              const marked = new Set(row.positions);
              return <button
                key={row.command.id}
                role="option"
                aria-selected={index === quickOpenIndex}
                aria-disabled={row.command.disabled || undefined}
                className={`quick-open-row palette-row ${index === quickOpenIndex ? "active" : ""} ${row.command.disabled ? "disabled" : ""}`}
                onMouseMove={() => setQuickOpenIndex(index)}
                onClick={() => runPaletteCommand(row.command)}
              >
                <span className="quick-open-name">{[...row.command.label].map((character, position) => marked.has(position)
                  ? <b key={position}>{character}</b>
                  : <span key={position}>{character}</span>)}</span>
                {row.command.shortcut && <kbd>{row.command.shortcut}</kbd>}
              </button>;
            }) : <p className="quick-open-empty">{t("paletteEmpty")}</p>}
          </div> : <div className="quick-open-list" role="listbox">
            {quickOpenMatches.length ? quickOpenMatches.map((row, index) => {
              const marked = new Set(row.match.positions);
              const parent = explorerParent(row.file.filename);
              return <button
                key={row.file.id}
                role="option"
                aria-selected={index === quickOpenIndex}
                className={`quick-open-row ${index === quickOpenIndex ? "active" : ""}`}
                onMouseMove={() => setQuickOpenIndex(index)}
                onClick={() => { setQuickOpen(null); openSavedFile(row.file); }}
              >
                <LanguageIcon language={row.file.language} />
                <span className="quick-open-name">{[...row.file.filename].map((character, position) => marked.has(position)
                  ? <b key={position}>{character}</b>
                  : <span key={position}>{character}</span>)}</span>
                {parent && <small>{parent}</small>}
                {row.file.judgeStatus && <VerdictBadge status={row.file.judgeStatus} />}
              </button>;
            }) : <p className="quick-open-empty">{t("quickOpenEmpty")}</p>}
          </div>}
          <footer className="quick-open-hint">{paletteMode ? t("paletteHint") : t("quickOpenHint")}</footer>
        </section>
      </div>}

      {releaseNotes && <div className="modal-backdrop close-confirm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setReleaseNotes(null); }}>
        <section className="confirm-dialog release-notes" role="dialog" aria-modal="true" aria-labelledby="release-notes-title">
          <span className="eyebrow">{t("releaseNotesUpdated")}{releaseNotes.version.replace(/^v/, "")}</span>
          <h2 id="release-notes-title">{t("releaseNotesTitle")}</h2>
          {releaseNotes.notes
            ? <div className="release-notes-body">{renderReleaseNotes(releaseNotes.notes)}</div>
            : <p>{t("releaseNotesNone")}</p>}
          <footer className="settings-footer"><span className="footer-spacer" /><button className="primary-button" autoFocus onClick={() => setReleaseNotes(null)}>{t("releaseNotesClose")}</button></footer>
        </section>
      </div>}

      <ExplorerDialogs ref={explorerRef} {...explorerProps} />

      {importCollision && <ConfirmDialog id="import-collision-title" eyebrow="file already exists" title={<>{importCollision.existing.filename} already exists</>} cancel={t("cancel")} onCancel={() => setImportCollision(null)} actions={<><button className="subtle-button" onClick={() => { openSavedFile(importCollision.existing); setImportCollision(null); }}>Open existing</button><button className="primary-button" onClick={() => { const { imported: pending, contestImport } = importCollision; setImportCollision(null); void addImportedProblems(pending, true, contestImport); }}>Import copy</button></>}>
        <p>Open the existing file, or import a new copy with the smallest available number suffix.</p>
      </ConfirmDialog>}

      {atCoderOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) cancelProblemImport(); }}>
          <section className="atcoder-dialog" role="dialog" aria-modal="true" aria-labelledby="atcoder-title">
            <header className="settings-header">
              <div><span className="eyebrow">{t("importSamples")}</span><h2 id="atcoder-title">{testcaseImportTarget ? `Import test cases · ${testcaseImportTarget.filename}` : t("onlineProblem")}</h2></div>
              <button className="modal-close" onClick={cancelProblemImport} aria-label="Close problem import"><Icon name="close" size={14} /></button>
            </header>
            <p className="settings-help">{testcaseImportTarget ? "Replace only this file's test cases. Its code and filename stay unchanged." : t("importHelp")}</p>
            <input className="atcoder-url" value={atCoderUrl} onChange={(event) => setAtCoderUrl(event.target.value)} placeholder="AtCoder, Codeforces, or doj.kr problem URL" autoFocus />
            <footer className="settings-footer">
              <span className="footer-spacer" />
              <button className="subtle-button" onClick={cancelProblemImport}>{newFileImportPending ? (uiLocale === "ko" ? "빈 파일 만들기" : "create blank file") : t("cancel")}</button>
              <button className="primary-button" onClick={() => void importAtCoderProblem()} disabled={importingAtCoder || !atCoderUrl.trim()}>{importingAtCoder ? (uiLocale === "ko" ? "가져오는 중…" : "importing…") : t("importSamples")}</button>
            </footer>
          </section>
        </div>
      )}

      {contestOpen && <>
        <div className="popover-dismiss" onMouseDown={() => setContestOpen(false)} />
        <section className="contest-popover" style={{ left: contestPopoverLeft() }} role="dialog" aria-label={t("contest")} onKeyDown={(event) => { if (event.key === "Escape") setContestOpen(false); }}>
          {contest && contestSpan ? <>
            <ContestHeader span={contestSpan} remainingLabel={t("contestRemaining")} overLabel={t("contestOver")} elapsedLabel={t("contestElapsed")} />
            <div className="contest-board">
              {contestProblems.length ? contestProblems.map((file) => {
                const state = contestProblemState(file);
                const tries = state.tries || 0;
                return <button key={file.id} className={`contest-problem ${state.tone} ${fileKey(file.filename) === fileKey(activeTab?.filename || "") ? "current" : ""}`} onClick={() => openSavedFile(file)} title={`${file.title || file.filename}${tries ? ` \u00b7 ${tries} ${t("contestTries")}` : ""}`}>
                  <strong>{explorerBasename(file.filename).replace(/\.[^.]+$/, "").split(/[_\s]/)[0]}</strong>
                  <span>{state.label || "\u2014"}</span>
                  {tries > 0 && <i className="contest-tries">-{tries}</i>}
                </button>;
              }) : <p className="settings-help">{t("contestNoProblems")}</p>}
            </div>
            <footer>
              <small>{contest.folder || t("contestWorkspaceRoot")} · {contestScore.solved}/{contestProblems.length} {t("contestSolved")}{contestScore.solved > 0 ? ` · ${t("contestPenalty")} ${Math.round(contestScore.penalty / 60000)}` : ""}</small>
              <button className="subtle-button" onClick={() => setContest(null)}>{t("contestEnd")}</button>
            </footer>
          </> : <>
            <header><div><small>{t("contest")}</small><strong className="contest-title">{t("contestNew")}</strong></div></header>
            <p className="settings-help">{t("contestHelp")}</p>
            <label className="contest-duration">{t("contestDuration")}
              <span><input type="number" min={1} max={1440} value={contestMinutes} onChange={(event) => setContestMinutes(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") startContest(); }} autoFocus /><small>{t("contestMinutes")}</small></span>
            </label>
            <div className="contest-presets">{[100, 120, 150, 300].map((minutes) => <button key={minutes} className={contestMinutes === String(minutes) ? "active" : ""} onClick={() => setContestMinutes(String(minutes))}>{minutes}</button>)}</div>
            <label className="contest-folder">{t("contestFolder")}
              <select value={contestNextFolder} onChange={(event) => { setContestFolderChoice(event.target.value); setContestExcluded(new Set()); }}>
                {contestFolderOptions.map((directory) => <option key={directory} value={directory}>{directory || t("contestWorkspaceRoot")}</option>)}
              </select>
            </label>
            <div className="contest-board contest-pick">
              {contestCandidates.length ? contestCandidates.map((file) => {
                const key = fileKey(file.filename);
                const out = contestExcluded.has(key);
                const words = explorerBasename(file.filename).replace(/\.[^.]+$/, "").split(/[_\s]/);
                return <button key={file.id} className={`contest-problem ${out ? "excluded" : ""}`} aria-pressed={!out} onClick={() => setContestExcluded((items) => { const next = new Set(items); if (out) next.delete(key); else next.add(key); return next; })} title={file.title || file.filename}>
                  <strong>{words[0]}</strong>
                  <span>{words.slice(1).join(" ") || "—"}</span>
                </button>;
              }) : <p className="settings-help">{t("contestNoCandidates")}</p>}
            </div>
            <footer>
              <small>{contestCandidates.length ? `${contestCandidates.filter((file) => !contestExcluded.has(fileKey(file.filename))).length}/${contestCandidates.length} · ${t("contestPick")}` : ""}</small>
              <button className="primary-button" onClick={startContest}><Icon name="timer" size={14} />{t("contestStart")}</button>
            </footer>
          </>}
        </section>
      </>}

      <footer className="statusbar">
        <span className="wordmark">v{appVersion}</span>
        {updateStatus.phase === "available" && <button className="status-update" onClick={() => setSettingsPage("updates")} title={`${t("updatesAvailable")} v${updateStatus.version}`}>↑ v{updateStatus.version}</button>}
        <ContestStatusButton span={contestSpan} open={contestOpen} onToggle={() => setContestOpen((open) => !open)} title={t("contest")} overLabel={t("contestOver")} />
        <span className="status-copy">{summary}</span>
        <span className="file-status">{fileStatus}</span>
        <span className="status-services">
          <button className={`lsp-status ${companionStatus.listening ? "ready" : companionError ? "error" : "missing"}`} onClick={() => setSettingsPage("judge")} title={companionError || (companionStatus.listening ? `Competitive Companion · port ${companionStatus.port}` : "Competitive Companion")}><span />CC {companionStatus.listening ? t("companionListening") : companionError ? t("companionPortInUse") : t("companionOff")}</button>
          <button className={`lsp-status ${clangdStatus}`} onClick={() => setSettingsPage("language-server")} title={clangdInfo?.path || "Configure clangd"}><span />{language === "python" ? "python basic" : clangdStatus === "ready" ? "clangd ready" : clangdStatus === "connecting" ? "clangd…" : "clangd missing"}</button>
        </span>
        <div className="panel-chips" role="toolbar" aria-label="panels" title={t("chipHint")}>
          {PANEL_IDS.filter((id) => id !== "editor").map((id) => (
            <button key={id} className={`panel-chip ${chipActive(id) ? "active" : ""}`}
              aria-pressed={chipActive(id)} data-panel={id}
              onClick={() => togglePanel(id)}
            ><Icon name={id === "tests" ? "flask" : id === "problem" ? "globe" : "files"} size={13} />{chipLabel(id)}</button>
          ))}
        </div>
        <button className="status-settings" onClick={openSettings} aria-label="settings" title={t("preferences")}><Icon name="settings" size={15} /></button>
        {(activeTab ? language : defaultLanguage) === "cpp" && <select className={`status-language status-profile ${compileProfile}`} value={compileProfile} onChange={(event) => setCompileProfile(event.target.value === "debug" ? "debug" : "release")} aria-label={t("compileProfile")} title={`${t("compileProfile")}: ${profileFlags[compileProfile]}`}><option value="release">Release</option><option value="debug">Debug</option></select>}
        <select className="status-language" value={activeTab ? language : defaultLanguage} onChange={(event) => {
          const next = event.target.value as Language;
          if (activeTab) void changeActiveLanguage(next);
          else setDefaultLanguage(next);
        }} aria-label="Select language" title={activeTab ? "language of the open file" : t("defaultLanguage")}><option value="cpp">C++</option><option value="python">Python 3</option></select>
      </footer>
    </main>
  );
}

export default App;
