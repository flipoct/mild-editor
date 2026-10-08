import type { StressRole } from "./fileNaming";
import type { CheckerVerdict } from "./workbench";

export type Language = "cpp" | "python";

/** Competitive-programming verdicts. `ac`/`wa` come from comparing streams, the rest from the runner. */
export type Status = "idle" | "running" | "ac" | "wa" | "tle" | "mle" | "re" | "ce" | "stopped";

export type Verdict = "ok" | "ce" | "re" | "tle" | "mle" | "limit" | "stopped";

/** A problem's own limits, as its judge states them. Either may be unknown. */
export type ProblemLimits = { timeLimitMs?: number; memoryLimitMb?: number };

export type CompileProfile = "release" | "debug";

export type UiTheme = "pastel" | "midnight" | "latte" | "sakura" | "blossom" | "nord" | "tokyo";

export type ProblemSource = "atcoder" | "codeforces" | "doj" | "other";

export type UiLocale = "en" | "ko";

export type WallpaperLayout = "cover" | "contain" | "stretch" | "original" | "tile" | "custom";

export type ExplorerSort = "modified" | "problem" | "name" | "custom";

export type EditorFont = string;

export type EditorFontOption = { id: string; label: string; family: string; path?: string };


export type TestCase = {
  id: number;
  name: string;
  input: string;
  expected: string;
  output: string;
  error: string;
  status: Status;
  open: boolean;
  timeMs?: number;
  memoryKb?: number;
  /** What the problem's checker said about the last run, when it has one. */
  checkerMessage?: string;
};


export type NativeRunResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timeMs: number;
  memoryKb?: number | null;
  verdict: Verdict;
};


export type PanelMode = "tests" | "interactive" | "terminal";

/** The four workspace panels. Their left-to-right order is the user's to arrange. */
export type PanelId = "tests" | "editor" | "problem" | "explorer";

export type PanelWeights = Partial<Record<PanelId, { width?: number; height?: number }>>;


/** An unpacked Chrome extension under the app profile, as listed by `browser_extensions_list`. */
export type BrowserExtension = { id: string; name: string; version: string; path: string; pending: boolean; builtin: boolean };

/** Where the problem browser lives: a panel in the workspace, or a window of its own. */
export type ProblemBrowserMode = "panel" | "window";

export type InteractiveEntry = { id: number; kind: "stdout" | "stderr" | "input" | "info"; text: string };

export type InteractiveOutputEvent = { sessionId: string; stream: "stdout" | "stderr"; text: string };

export type InteractiveExitEvent = { sessionId: string; code: number | null; timeMs: number; stopped: boolean };

export type TestResultEvent = { runId: string; index: number; result: NativeRunResult; checker?: CheckerVerdict };


export type ProblemTab = {
  id: string;
  title: string;
  filename: string;
  language: Language;
  codes: Record<Language, string>;
  tests: TestCase[];
  dirty?: boolean;
  source?: ProblemSource;
  sourceUrl?: string;
  judgeStatus?: string;
  submissionUrl?: string;
  limits?: ProblemLimits;
  modifiedAt?: number;
  /** Where the file sits in its folder when the explorer is sorted by hand. */
  order?: number;
  /** Every verdict the judge has reported for this problem, oldest first. */
  submissions?: SubmissionRecord[];
};


/** A test case as the workspace file keeps it. */
export type SavedTest = { name: string; input: string; expected: string };


export type LoadedWorkspace = {
  folderPath: string;
  panelMode?: PanelMode;
  problems: WorkspaceFileResult[];
};


export type ImportedAtCoderProblem = {
  title: string;
  suggestedFilename: string;
  tests: SavedTest[];
  source: ProblemSource;
  sourceUrl: string;
  /** Contest name, when the importer knows one; only Competitive Companion sends it. */
  contest?: string;
  limits?: ProblemLimits;
};


export type CodeSnippet = {
  id: string;
  name: string;
  language: Language;
  code: string;
};


export type ImportCollision = { existing: ProblemTab; imported: ImportedAtCoderProblem[]; contestImport: boolean };


/**
 * What the explorer knows of a file: the facts a row shows or is sorted by, and nothing of
 * its code or tests, so typing in the editor leaves every one of these as it was.
 * `modifiedAt` is only filled in while the explorer is sorted by it.
 */
export type ExplorerFile = Pick<ProblemTab, "id" | "title" | "filename" | "language" | "source" | "judgeStatus" | "submissionUrl" | "modifiedAt" | "order">;

/** The context menu: the file (by name) or folder it was opened on, neither for the empty space, and where the pointer was. */
export type ExplorerMenu = { file?: string; directory?: string; x: number; y: number };

/** Explorer row the menu bar acts on. Files and folders share one slot. */
export type ExplorerSelection = { kind: "file"; filename: string } | { kind: "directory"; path: string } | null;

/**
 * Where a dragged row would land. `into` puts it in a folder and leaves the order to the
 * chosen sort; `between` is a slot among the files a folder shows, which also arranges
 * them by hand. `line` is the rectangle the insertion mark is drawn on, in client pixels.
 */
export type ExplorerDropTarget =
  | { kind: "into"; directory: string }
  | { kind: "between"; directory: string; index: number; line: { x: number; width: number; y: number } };

/** Explorer row whose name is being edited in place. */
export type ExplorerRename = { kind: "file"; filename: string } | { kind: "directory"; path: string };

export type ExplorerTreeNode = { kind: "directory"; name: string; path: string; children: ExplorerTreeNode[] } | { kind: "file"; file: ExplorerFile };

export type WorkspaceFileResult = { filename: string; title: string; language: Language; code: string; tests: SavedTest[]; source?: ProblemSource; sourceUrl?: string; judgeStatus?: string; limits?: ProblemLimits; modifiedAt: number; order?: number; submissions?: SubmissionRecord[] };


/** One submission as a judge reported it; `at` is its time in seconds, 0 when unknown. */
export type SubmissionRecord = { status: string; url?: string; at: number };

/** `sessionUrl`: the page that has this problem's verdict when only the logged-in user is shown it (a running DOJ contest); see `session_pages` in submissions.rs. */
export type SubmissionStatusResult = { sourceUrl: string; status?: string; submissionUrl?: string; submittedAt?: number; submissions?: SubmissionRecord[]; sessionUrl?: string };

export type BackgroundImageFile = { bytes: number[]; mime: string };


export type CompanionProblem = {
  name: string;
  group?: string;
  url: string;
  tests: Array<{ input: string; output: string }>;
  timeLimit?: number;
  memoryLimit?: number;
  batch?: { id: string; size: number };
};

export type CompanionStatus = { listening: boolean; port: number | null };

export type ClangdStatus = "idle" | "connecting" | "ready" | "missing" | "error";

export type SettingsPage = "appearance" | "template" | "snippets" | "judge" | "build" | "language-server" | "updates" | "browser";


/** A timed practice or a live round: a countdown, and when each problem of the folder was solved. */
export type ContestState = {
  startedAt: number;
  durationMin: number;
  folder: string;
  solved: Record<string, number>;
  /** Files of the folder left out of this contest (file keys); anything else in it, or imported into it later, takes part. */
  excluded?: string[];
  /** Problems already accepted when the clock started, with the submission that was (file key → its URL, "" when unknown): only a newer one counts as solved in the contest. */
  acceptedBefore?: Record<string, string>;
};

export type VerdictNotice = { id: number; filename: string; status: string; submissionUrl?: string };

/**
 * The pair of files a counterexample search uses, remembered per problem so the dialog
 * comes back to the generator and reference that were picked for it.
 */
export type StressChoice = Record<StressRole, string>;

export type StressOutcome =
  /** `reason` is what the problem's checker said, when a checker decided. */
  | { kind: "mismatch"; rounds: number; input: string; expected: string; actual: string; reason?: string }
  | { kind: "passed"; rounds: number }
  | { kind: "compileError"; program: string; message: string }
  | { kind: "crashed"; rounds: number; program: string; input: string; message: string }
  | { kind: "stopped"; rounds: number };


/** What the Rust `check_update` command reports. */
export type AvailableUpdate = { version: string; currentVersion: string; notes: string | null };

export type UpdatePhase = "idle" | "unavailable" | "checking" | "up-to-date" | "available" | "downloading" | "installing" | "installed" | "error";

export type UpdateStatus = { phase: UpdatePhase; version?: string; notes?: string; received?: number; total?: number; error?: string };

