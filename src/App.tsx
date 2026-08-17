import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
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
type UiLocale = "en" | "ko";
type WallpaperLayout = "cover" | "contain" | "stretch" | "original" | "tile" | "custom";
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
  sourceUrl?: string;
  judgeStatus?: string;
  submissionUrl?: string;
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
    sourceUrl?: string;
    judgeStatus?: string;
    modifiedAt: number;
  }>;
};

type ImportedAtCoderProblem = {
  title: string;
  suggestedFilename: string;
  tests: LoadedProblem["tests"];
  source: ProblemSource;
  sourceUrl: string;
};

type CodeSnippet = {
  id: string;
  name: string;
  language: Language;
  code: string;
};

type ImportCollision = { existing: ProblemTab; imported: ImportedAtCoderProblem[] };

type ExplorerMenu = { file: ProblemTab; x: number; y: number };
type WorkspaceFileResult = { filename: string; title: string; language: Language; code: string; tests: LoadedProblem["tests"]; source?: ProblemSource; sourceUrl?: string; judgeStatus?: string; modifiedAt: number };

type SubmissionStatusResult = { sourceUrl: string; status?: string; submissionUrl?: string };
type BackgroundImageFile = { bytes: number[]; mime: string };

const templates: Record<Language, string> = {
  cpp: `#include <iostream>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n\n    \${cursor}int a, b;\n    cin >> a >> b;\n    cout << a + b << '\\n';\n    return 0;\n}\n`,
  python: `import sys\n\n\ndef solve():\n    \${cursor}a, b = map(int, sys.stdin.readline().split())\n    print(a + b)\n\n\nif __name__ == "__main__":\n    solve()\n`,
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
const storedBoundedNumber = (key: string, fallback: number, minimum: number, maximum: number) => {
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  const value = Number(stored);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
};
const wallpaperLayouts: WallpaperLayout[] = ["cover", "contain", "stretch", "original", "tile", "custom"];
const storedWallpaperLayout = (): WallpaperLayout => {
  const stored = localStorage.getItem("mild-wallpaper-layout") as WallpaperLayout | null;
  return stored && wallpaperLayouts.includes(stored) ? stored : "cover";
};

const normalize = (value: string) => value.replace(/\r\n/g, "\n").trimEnd();
const combinedRunOutput = (output: string, error: string) => error
  ? `${output}${output && !output.endsWith("\n") ? "\n" : ""}${error.replace(/^\s+/, "")}`
  : output;
const fileKey = (filename: string) => filename.trim().toLocaleLowerCase();
const languageFromFilename = (filename: string): Language | null => /\.(cpp|cc|cxx)$/i.test(filename) ? "cpp" : /\.py$/i.test(filename) ? "python" : null;
const filenameForLanguage = (filename: string, language: Language) => filename.replace(/\.(cpp|cc|cxx|py)$/i, language === "cpp" ? ".cpp" : ".py");
const inferredSourceUrl = (source: ProblemSource | undefined, filename: string) => {
  const problemId = filename.replace(/\.[^.]+$/, "");
  return source === "doj" && /^\d+$/.test(problemId) ? `https://doj.kr/ko/problems/${problemId}` : undefined;
};
const templateSources: ProblemSource[] = ["other", "atcoder", "codeforces", "doj"];
const templateStorageKey = (source: ProblemSource, language: Language) => `mild-template-${source}-${language}`;
const storedTemplate = (language: Language, source: ProblemSource = "other") => localStorage.getItem(templateStorageKey(source, language)) || localStorage.getItem(`mild-template-${language}`) || templates[language];
const loadTemplateDrafts = () => Object.fromEntries(templateSources.flatMap((source) => (["cpp", "python"] as Language[]).map((language) => [templateStorageKey(source, language), storedTemplate(language, source)])));
const renderTemplateWithCursor = (template: string, context: { source: ProblemSource; filename: string; title: string }) => {
  const now = new Date();
  const values: Record<string, string> = {
    timestamp: now.toISOString(),
    date: now.toISOString().slice(0, 10),
    time: now.toTimeString().slice(0, 8),
    filename: context.filename,
    title: context.title,
    platform: context.source,
  };
  const rendered = template.replace(/\$\{(timestamp|date|time|filename|title|platform)\}/g, (_, key: string) => values[key]);
  const cursorOffset = rendered.indexOf("${cursor}");
  return {
    code: rendered.replaceAll("${cursor}", ""),
    cursorOffset: cursorOffset >= 0 ? cursorOffset : undefined,
  };
};
const renderTemplate = (template: string, context: { source: ProblemSource; filename: string; title: string }) => renderTemplateWithCursor(template, context).code;
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
const themeIconCache = new Map<UiTheme, Uint8Array>();
const createThemeWindowIcon = async (theme: UiTheme) => {
  const cached = themeIconCache.get(theme);
  if (cached) return cached;

  const mark = document.createElement("span");
  mark.className = "welcome-mark";
  mark.textContent = "m";
  mark.style.position = "fixed";
  mark.style.visibility = "hidden";
  mark.style.pointerEvents = "none";
  document.body.appendChild(mark);
  const markStyle = getComputedStyle(mark);
  const sourceSize = Number.parseFloat(markStyle.width);
  const sourceRadius = Number.parseFloat(markStyle.borderRadius);
  const sourceBorderWidth = Number.parseFloat(markStyle.borderTopWidth);
  const sourceFontSize = Number.parseFloat(markStyle.fontSize);
  const background = markStyle.backgroundColor;
  const foreground = markStyle.color;
  const font = `${markStyle.fontStyle} ${markStyle.fontWeight} ${sourceFontSize}px ${markStyle.fontFamily}`;
  mark.remove();

  const canvas = document.createElement("canvas");
  const size = 128;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");

  const scale = size / sourceSize;
  const borderWidth = sourceBorderWidth * scale;
  const inset = borderWidth / 2;
  const radius = sourceRadius * scale;
  context.beginPath();
  context.moveTo(inset + radius, inset);
  context.lineTo(size - inset - radius, inset);
  context.quadraticCurveTo(size - inset, inset, size - inset, inset + radius);
  context.lineTo(size - inset, size - inset - radius);
  context.quadraticCurveTo(size - inset, size - inset, size - inset - radius, size - inset);
  context.lineTo(inset + radius, size - inset);
  context.quadraticCurveTo(inset, size - inset, inset, size - inset - radius);
  context.lineTo(inset, inset + radius);
  context.quadraticCurveTo(inset, inset, inset + radius, inset);
  context.closePath();
  context.fillStyle = background;
  context.fill();
  context.lineWidth = borderWidth;
  context.strokeStyle = foreground;
  context.stroke();

  context.fillStyle = foreground;
  context.font = font.replace(`${sourceFontSize}px`, `${sourceFontSize * scale}px`);
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  const metrics = context.measureText("m");
  const baseline = size / 2 + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
  context.fillText("m", size / 2, baseline);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not create the theme icon.")), "image/png");
  });
  const icon = new Uint8Array(await blob.arrayBuffer());
  themeIconCache.set(theme, icon);
  return icon;
};
let completionsRegistered = false;
let snippetCompletionSource: CodeSnippet[] = [];
const APP_VERSION = "1.2.2";

const messages = {
  en: {
    appearance: "appearance", template: "template", snippets: "snippets", judge: "online judges", languageServer: "language server",
    preferences: "preferences", interfaceLanguage: "interface language", english: "English", korean: "Korean",
    templateHelp: "Templates are saved separately for each judge and language. Variables: ${timestamp}, ${date}, ${time}, ${filename}, ${title}, ${platform}. Put ${cursor} where the editor cursor should start.",
    local: "local / other", saveTemplate: "save template", applyEditor: "apply to editor", reset: "reset",
    judgeHelp: "Enter your public judge handles. Imported problems refresh their latest submission result automatically every 20 seconds.",
    refreshNow: "refresh now", refreshing: "refreshing…", aclPath: "AtCoder Library include folder", chooseFolder: "choose folder", aclHelp: "Select the folder that contains the atcoder directory. It is passed to both g++ and clangd.",
    newWorkspace: "new workspace", openWorkspace: "open workspace", import: "import", open: "open", save: "save", new: "new",
    testCases: "test cases", input: "input", expected: "expected", output: "output", useOutput: "use output", runToSee: "run to see output",
    sort: "sort", show: "show", latestModified: "latest modified", problemNumber: "problem number", name: "name", allSources: "all sources", noFiles: "no matching files",
    welcomeTagline: "lightweight competitive programming editor", welcomeBody: "Code, test, save. Built for contest flow.",
    appearanceHelp: "Themes update the full interface and Monaco Editor. Add a local programming font if it is not detected.", editorFont: "editor font", addFont: "add font file", remove: "remove",
    backgroundImage: "background image", chooseBackground: "choose image", clearBackground: "remove image", acrylicOpacity: "panel opacity", acrylicBlur: "background blur", backgroundHelp: "The image stays on your device. Panels and the editor become translucent while a background is selected.", noBackground: "no image selected",
    wallpaperLayout: "image layout", wallpaperCover: "fill", wallpaperContain: "fit", wallpaperStretch: "stretch", wallpaperOriginal: "original size", wallpaperTile: "tile", wallpaperCustom: "custom size", wallpaperScale: "image size", wallpaperPositionX: "horizontal position", wallpaperPositionY: "vertical position", resetWallpaperLayout: "reset layout",
    importSamples: "import samples", onlineProblem: "Online judge problem", importHelp: "A contest URL imports its listed problems. A supported problem URL imports one problem with sample test cases.", cancel: "cancel",
    snippetsHelp: "Create a named snippet, choose its language, and insert it from the title bar or by typing snippet::name and pressing Tab or Enter.",
  },
  ko: {
    appearance: "화면", template: "템플릿", snippets: "코드 스니펫", judge: "온라인 저지", languageServer: "언어 서버",
    preferences: "설정", interfaceLanguage: "인터페이스 언어", english: "영어", korean: "한국어",
    templateHelp: "템플릿은 사이트와 언어별로 저장됩니다. 변수: ${timestamp}, ${date}, ${time}, ${filename}, ${title}, ${platform}. 새 파일의 시작 커서 위치에는 ${cursor}를 넣으세요.",
    local: "로컬 / 기타", saveTemplate: "템플릿 저장", applyEditor: "에디터에 적용", reset: "초기화",
    judgeHelp: "각 사이트의 공개 사용자 이름을 입력하세요. 가져온 문제의 최신 제출 결과를 20초마다 자동으로 갱신합니다.",
    refreshNow: "지금 갱신", refreshing: "갱신 중…", aclPath: "AtCoder Library include 폴더", chooseFolder: "폴더 선택", aclHelp: "atcoder 폴더가 들어 있는 상위 폴더를 선택하세요. g++와 clangd에 함께 적용됩니다.",
    newWorkspace: "새 워크스페이스", openWorkspace: "워크스페이스 열기", import: "가져오기", open: "열기", save: "저장", new: "새로 만들기",
    testCases: "테스트 케이스", input: "입력", expected: "예상 출력", output: "실행 결과", useOutput: "결과 사용", runToSee: "실행하면 결과가 표시됩니다",
    sort: "정렬", show: "필터", latestModified: "최근 수정순", problemNumber: "문제 번호순", name: "이름순", allSources: "모든 사이트", noFiles: "조건에 맞는 파일이 없습니다",
    welcomeTagline: "가벼운 경쟁적 프로그래밍 에디터", welcomeBody: "작성하고, 테스트하고, 저장하세요. 대회 흐름에 맞춰 만들었습니다.",
    appearanceHelp: "테마는 전체 UI와 Monaco Editor에 함께 적용됩니다. 감지되지 않는 프로그래밍 폰트는 로컬 파일로 추가할 수 있습니다.", editorFont: "에디터 폰트", addFont: "폰트 파일 추가", remove: "제거",
    backgroundImage: "배경 이미지", chooseBackground: "이미지 선택", clearBackground: "이미지 제거", acrylicOpacity: "패널 불투명도", acrylicBlur: "배경 블러", backgroundHelp: "이미지는 기기에만 저장됩니다. 배경을 선택하면 패널과 에디터가 반투명하게 바뀝니다.", noBackground: "선택된 이미지 없음",
    wallpaperLayout: "이미지 배치", wallpaperCover: "채우기", wallpaperContain: "맞춤", wallpaperStretch: "늘이기", wallpaperOriginal: "원본 크기", wallpaperTile: "바둑판식", wallpaperCustom: "사용자 지정", wallpaperScale: "이미지 크기", wallpaperPositionX: "가로 위치", wallpaperPositionY: "세로 위치", resetWallpaperLayout: "배치 초기화",
    importSamples: "예제 가져오기", onlineProblem: "온라인 저지 문제", importHelp: "대회 URL은 문제 목록 전체를, 지원되는 문제 URL은 해당 문제와 예제 테스트 케이스를 가져옵니다.", cancel: "취소",
    snippetsHelp: "이름과 언어를 정해 스니펫을 만든 뒤 제목 표시줄에서 삽입하거나 snippet::이름을 입력하고 Tab 또는 Enter를 누르세요.",
  },
} as const;

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
  const [templateSource, setTemplateSource] = useState<ProblemSource>("other");
  const [draftTemplates, setDraftTemplates] = useState<Record<string, string>>(loadTemplateDrafts);
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
  const [selectedExplorerFilename, setSelectedExplorerFilename] = useState("");
  const [renameFile, setRenameFile] = useState<ProblemTab | null>(null);
  const [renameValue, setRenameValue] = useState("");
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
  const [importCollision, setImportCollision] = useState<ImportCollision | null>(null);
  const [atCoderUrl, setAtCoderUrl] = useState("");
  const [importingAtCoder, setImportingAtCoder] = useState(false);
  const [settingsPage, setSettingsPage] = useState<"appearance" | "template" | "snippets" | "judge" | "language-server">("template");
  const [uiLocale, setUiLocale] = useState<UiLocale>(() => (localStorage.getItem("mild-ui-locale") as UiLocale) || "en");
  const [atcoderHandle, setAtcoderHandle] = useState(() => localStorage.getItem("mild-atcoder-handle") || "");
  const [codeforcesHandle, setCodeforcesHandle] = useState(() => localStorage.getItem("mild-codeforces-handle") || "");
  const [dojHandle, setDojHandle] = useState(() => localStorage.getItem("mild-doj-handle") || "");
  const [atcoderLibraryPath, setAtcoderLibraryPath] = useState(() => localStorage.getItem("mild-atcoder-library-path") || "");
  const [refreshingJudge, setRefreshingJudge] = useState(false);
  const [uiTheme, setUiTheme] = useState<UiTheme>(() => (localStorage.getItem("mild-ui-theme") as UiTheme) || "pastel");
  const [backgroundImagePath, setBackgroundImagePath] = useState(() => "__TAURI_INTERNALS__" in window ? localStorage.getItem("mild-background-image") || "" : "");
  const [backgroundImageUrl, setBackgroundImageUrl] = useState("");
  const [backgroundImageError, setBackgroundImageError] = useState("");
  const [acrylicOpacity, setAcrylicOpacity] = useState(() => storedBoundedNumber("mild-acrylic-opacity", 82, 0, 100));
  const [acrylicBlur, setAcrylicBlur] = useState(() => storedBoundedNumber("mild-acrylic-blur", 14, 0, 32));
  const [wallpaperLayout, setWallpaperLayout] = useState<WallpaperLayout>(storedWallpaperLayout);
  const [wallpaperScale, setWallpaperScale] = useState(() => storedBoundedNumber("mild-wallpaper-scale", 100, 25, 300));
  const [wallpaperPositionX, setWallpaperPositionX] = useState(() => storedBoundedNumber("mild-wallpaper-position-x", 50, 0, 100));
  const [wallpaperPositionY, setWallpaperPositionY] = useState(() => storedBoundedNumber("mild-wallpaper-position-y", 50, 0, 100));
  const [editorFont, setEditorFont] = useState<EditorFont>(() => (localStorage.getItem("mild-editor-font") as EditorFont) || "cascadia");
  const [systemFonts, setSystemFonts] = useState<EditorFontOption[]>([]);
  const [customFonts, setCustomFonts] = useState<EditorFontOption[]>(loadCustomFonts);
  const [snippets, setSnippets] = useState<CodeSnippet[]>(loadSnippets);
  const [snippetDraft, setSnippetDraft] = useState<CodeSnippet>(() => ({ id: crypto.randomUUID(), name: "", language: "cpp", code: "" }));
  const [insertSnippetId, setInsertSnippetId] = useState("");
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const templateEditorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const snippetEditorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const backgroundImageInputRef = useRef<HTMLInputElement | null>(null);
  const browserBackgroundUrlRef = useRef("");
  const pendingTemplateCursorRef = useRef<{ tabId: string; language: Language; offset: number } | null>(null);
  const runRef = useRef<() => void>(() => {});
  const hasUnsavedChangesRef = useRef(false);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  const diagnosticDecorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const clangdClientRef = useRef<ClangdClient | null>(null);
  const [clangdPath, setClangdPath] = useState(() => localStorage.getItem("mild-clangd-path") || "");
  const [clangdStatus, setClangdStatus] = useState<"idle" | "connecting" | "ready" | "missing" | "error">("idle");
  const [clangdInfo, setClangdInfo] = useState<ClangdInfo | null>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0];
  const t = (key: keyof typeof messages.en) => messages[uiLocale][key];
  const monacoTheme = `mild-${uiTheme}`;
  const fontOptions = useMemo(() => [...systemFonts, ...customFonts], [customFonts, systemFonts]);
  const selectedFont = fontOptions.find((font) => font.id === editorFont) || fontOptions[0] || knownEditorFonts.at(-1)!;
  const editorFontFamily = selectedFont.family;
  const wallpaperSize = wallpaperLayout === "cover" ? "cover"
    : wallpaperLayout === "contain" ? "contain"
      : wallpaperLayout === "stretch" ? "100% 100%"
        : wallpaperLayout === "original" ? "auto"
          : `${wallpaperScale}% auto`;
  const wallpaperRepeat = wallpaperLayout === "tile" ? "repeat" : "no-repeat";
  const wallpaperPosition = `${wallpaperPositionX}% ${wallpaperPositionY}%`;
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
  const judgeProblemKey = useMemo(() => [...new Set([...savedFiles, ...tabs].map((file) => file.sourceUrl).filter(Boolean))].sort().join("|"), [savedFiles, tabs]);
  const hasFileStatusError = !["not saved", "saving…", "saved", "loaded", "modified", "project created", "ready", "submission results updated", "no matching submissions found", "test cases imported", "source updated"].includes(fileStatus);

  useEffect(() => {
    hasUnsavedChangesRef.current = tabs.some((tab) => tab.dirty) || fileStatus === "modified";
  }, [fileStatus, tabs]);

  useEffect(() => {
    setTabs((items) => items.map((tab) => tab.id === activeTabId ? { ...tab, language, codes, tests } : tab));
  }, [activeTabId, codes, language, tests]);

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
    snippetCompletionSource = snippets;
  }, [snippets]);

  useEffect(() => {
    document.documentElement.dataset.theme = uiTheme;
    localStorage.setItem("mild-ui-theme", uiTheme);
  }, [uiTheme]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
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

  useEffect(() => {
    localStorage.setItem("mild-editor-font", editorFont);
  }, [editorFont]);

  useEffect(() => {
    localStorage.setItem("mild-background-image", backgroundImagePath);
    setBackgroundImageError("");
    if (!backgroundImagePath) {
      setBackgroundImageUrl("");
      return;
    }
    if (!("__TAURI_INTERNALS__" in window)) return;
    let cancelled = false;
    let objectUrl = "";
    void invoke<BackgroundImageFile>("read_image_file", { request: { path: backgroundImagePath } })
      .then((image) => {
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(image.bytes)], { type: image.mime }));
        if (cancelled) URL.revokeObjectURL(objectUrl);
        else setBackgroundImageUrl(objectUrl);
      })
      .catch((error) => {
        if (!cancelled) {
          setBackgroundImageUrl("");
          setBackgroundImageError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [backgroundImagePath]);

  useEffect(() => {
    localStorage.setItem("mild-acrylic-opacity", String(acrylicOpacity));
    localStorage.setItem("mild-acrylic-blur", String(acrylicBlur));
  }, [acrylicBlur, acrylicOpacity]);

  useEffect(() => {
    localStorage.setItem("mild-wallpaper-layout", wallpaperLayout);
    localStorage.setItem("mild-wallpaper-scale", String(wallpaperScale));
    localStorage.setItem("mild-wallpaper-position-x", String(wallpaperPositionX));
    localStorage.setItem("mild-wallpaper-position-y", String(wallpaperPositionY));
  }, [wallpaperLayout, wallpaperPositionX, wallpaperPositionY, wallpaperScale]);

  useEffect(() => () => {
    if (browserBackgroundUrlRef.current) URL.revokeObjectURL(browserBackgroundUrlRef.current);
  }, []);

  useEffect(() => {
    localStorage.setItem("mild-explorer-sort", explorerSort);
    localStorage.setItem("mild-explorer-source", explorerSource);
  }, [explorerSort, explorerSource]);

  useEffect(() => {
    localStorage.setItem("mild-ui-locale", uiLocale);
    document.documentElement.lang = uiLocale;
  }, [uiLocale]);

  useEffect(() => {
    localStorage.setItem("mild-atcoder-handle", atcoderHandle.trim());
    localStorage.setItem("mild-codeforces-handle", codeforcesHandle.trim());
    localStorage.setItem("mild-doj-handle", dojHandle.trim());
  }, [atcoderHandle, codeforcesHandle, dojHandle]);

  useEffect(() => {
    localStorage.setItem("mild-atcoder-library-path", atcoderLibraryPath.trim());
  }, [atcoderLibraryPath]);

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
    setSelectedExplorerFilename(file.filename);
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
    codes: { cpp: storedTemplate("cpp", file.source || "other"), python: storedTemplate("python", file.source || "other"), [file.language]: file.code },
    tests: hydrateTests(file.tests),
    source: file.source || "other", sourceUrl: file.sourceUrl || inferredSourceUrl(file.source, file.filename), judgeStatus: file.judgeStatus, modifiedAt: file.modifiedAt,
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
      setSelectedExplorerFilename((selected) => fileKey(selected) === fileKey(file.filename) ? "" : selected);
      closeProblem(file.id);
      setDeleteConfirmFile(null);
      return;
    }
    try {
      await invoke("delete_workspace_file", { request: { folderPath: workspacePath, filename: file.filename } });
      const index = tabs.findIndex((tab) => fileKey(tab.filename) === fileKey(file.filename));
      const remainingTabs = tabs.filter((tab) => fileKey(tab.filename) !== fileKey(file.filename));
      setSavedFiles((items) => items.filter((tab) => fileKey(tab.filename) !== fileKey(file.filename)));
      setSelectedExplorerFilename((selected) => fileKey(selected) === fileKey(file.filename) ? "" : selected);
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
      setSelectedExplorerFilename((selected) => fileKey(selected) === fileKey(original.filename) ? result.filename : selected);
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
      setFileStatus(error instanceof Error ? error.message : String(error));
    }
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
      setTabs([]);
      setSavedFiles([]);
      setActiveTabId("");
      setSelectedExplorerFilename("");
      clearDiagnostics();
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
        problems: persistedTabs.map((tab) => ({ filename: tab.filename, title: tab.title, language: tab.language, code: tab.codes[tab.language], tests: tab.tests.map(({ name, input, expected }) => ({ name, input, expected })), source: tab.source, sourceUrl: tab.sourceUrl, judgeStatus: tab.judgeStatus, modifiedAt: tab.modifiedAt })),
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
    const fileLanguage = languageFromFilename(filename) || "cpp";
    const title = filename.replace(/\.[^.]+$/, "");
    const renderedCpp = renderTemplateWithCursor(storedTemplate("cpp", "other"), { source: "other", filename, title });
    const renderedPython = renderTemplateWithCursor(storedTemplate("python", "other"), { source: "other", filename, title });
    const tab: ProblemTab = {
      id: crypto.randomUUID(),
      title,
      filename,
      language: fileLanguage,
      codes: {
        cpp: renderedCpp.code,
        python: renderedPython.code,
      },
      tests: [{ id: 1, name: "test 1", input: "", expected: "", output: "", error: "", status: "idle", open: true }],
      source: "other",
      modifiedAt: Date.now(),
    };
    const cursorOffset = fileLanguage === "cpp" ? renderedCpp.cursorOffset : renderedPython.cursorOffset;
    if (cursorOffset !== undefined) pendingTemplateCursorRef.current = { tabId: tab.id, language: fileLanguage, offset: cursorOffset };
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
      setBlankFilename(defaultFilename(savedFiles.length + tabs.length));
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
    const monacoChrome = (panel: string, field: string, border: string, selected: string, accent: string) => ({
      "focusBorder": accent,
      "editorWidget.background": panel,
      "editorWidget.border": border,
      "editorHoverWidget.background": panel,
      "editorHoverWidget.border": border,
      "editorSuggestWidget.background": panel,
      "editorSuggestWidget.border": border,
      "editorSuggestWidget.selectedBackground": selected,
      "editorSuggestWidget.highlightForeground": accent,
      "input.background": field,
      "input.border": border,
      "list.hoverBackground": selected,
      "list.activeSelectionBackground": selected,
      "list.highlightForeground": accent,
      "scrollbarSlider.background": `${border}88`,
      "scrollbarSlider.hoverBackground": border,
    });
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
        ...monacoChrome("#292a26", "#232420", "#41423c", "#30312d", "#dec58e"),
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
      colors: { ...monacoChrome("#181825", "#11111b", "#45475a", "#313244", "#cba6f7"), "editor.background": "#1e1e2e", "editor.foreground": "#cdd6f4", "editorLineNumber.foreground": "#585b70", "editorLineNumber.activeForeground": "#bac2de", "editorCursor.foreground": "#f5e0dc", "editor.selectionBackground": "#585b7088", "editor.lineHighlightBackground": "#252536", "editorIndentGuide.background1": "#313244", "editorIndentGuide.activeBackground1": "#585b70" },
    });
    monaco.editor.defineTheme("mild-latte", {
      base: "vs",
      inherit: true,
      rules: [{ token: "comment", foreground: "9893a5", fontStyle: "italic" }, { token: "keyword", foreground: "907aa9" }, { token: "string", foreground: "286983" }, { token: "number", foreground: "d7827e" }, { token: "type", foreground: "56949f" }],
      colors: { ...monacoChrome("#fffaf3", "#faf4ed", "#dfdad9", "#f2e9e1", "#907aa9"), "editor.background": "#faf4ed", "editor.foreground": "#575279", "editorLineNumber.foreground": "#9893a5", "editorLineNumber.activeForeground": "#575279", "editorCursor.foreground": "#b4637a", "editor.selectionBackground": "#dfdad9aa", "editor.lineHighlightBackground": "#f2e9e1", "editorIndentGuide.background1": "#dfdad9", "editorIndentGuide.activeBackground1": "#cecacd" },
    });
    monaco.editor.defineTheme("mild-sakura", {
      base: "vs-dark", inherit: true,
      rules: [{ token: "comment", foreground: "6272a4", fontStyle: "italic" }, { token: "keyword", foreground: "ff79c6" }, { token: "string", foreground: "f1fa8c" }, { token: "number", foreground: "bd93f9" }, { token: "type", foreground: "8be9fd", fontStyle: "italic" }, { token: "identifier.function", foreground: "50fa7b" }, { token: "predefined", foreground: "8be9fd" }],
      colors: { ...monacoChrome("#21222c", "#191a21", "#44475a", "#343746", "#bd93f9"), "editor.background": "#282a36", "editor.foreground": "#f8f8f2", "editorLineNumber.foreground": "#6272a4", "editorLineNumber.activeForeground": "#f8f8f2", "editorCursor.foreground": "#f8f8f0", "editor.selectionBackground": "#44475a", "editor.lineHighlightBackground": "#2f3240", "editorIndentGuide.background1": "#3b3e4d", "editorIndentGuide.activeBackground1": "#6272a4", "editorBracketMatch.background": "#bd93f922", "editorBracketMatch.border": "#bd93f9" },
    });
    monaco.editor.defineTheme("mild-blossom", {
      base: "vs-dark", inherit: true,
      rules: [{ token: "comment", foreground: "928374", fontStyle: "italic" }, { token: "keyword", foreground: "fb4934" }, { token: "string", foreground: "b8bb26" }, { token: "number", foreground: "d3869b" }, { token: "type", foreground: "fabd2f" }, { token: "identifier.function", foreground: "b8bb26" }, { token: "predefined", foreground: "8ec07c" }],
      colors: { ...monacoChrome("#32302f", "#242321", "#504945", "#3c3836", "#fabd2f"), "editor.background": "#282828", "editor.foreground": "#ebdbb2", "editorLineNumber.foreground": "#665c54", "editorLineNumber.activeForeground": "#ebdbb2", "editorCursor.foreground": "#fabd2f", "editor.selectionBackground": "#665c54", "editor.lineHighlightBackground": "#32302f", "editorIndentGuide.background1": "#3c3836", "editorIndentGuide.activeBackground1": "#7c6f64", "editorBracketMatch.background": "#fabd2f22", "editorBracketMatch.border": "#fabd2f" },
    });
    monaco.editor.defineTheme("mild-nord", {
      base: "vs-dark", inherit: true,
      rules: [{ token: "comment", foreground: "616e88", fontStyle: "italic" }, { token: "keyword", foreground: "b48ead" }, { token: "string", foreground: "a3be8c" }, { token: "number", foreground: "d08770" }, { token: "type", foreground: "88c0d0" }],
      colors: { ...monacoChrome("#343b49", "#292e38", "#4c566a", "#3b4252", "#88c0d0"), "editor.background": "#2e3440", "editor.foreground": "#d8dee9", "editorLineNumber.foreground": "#4c566a", "editorLineNumber.activeForeground": "#d8dee9", "editorCursor.foreground": "#88c0d0", "editor.selectionBackground": "#434c5eaa", "editor.lineHighlightBackground": "#343b49", "editorIndentGuide.background1": "#3b4252", "editorIndentGuide.activeBackground1": "#616e88" },
    });
    monaco.editor.defineTheme("mild-tokyo", {
      base: "vs-dark", inherit: true,
      rules: [{ token: "comment", foreground: "565f89", fontStyle: "italic" }, { token: "keyword", foreground: "bb9af7" }, { token: "string", foreground: "9ece6a" }, { token: "number", foreground: "ff9e64" }, { token: "type", foreground: "7dcfff" }],
      colors: { ...monacoChrome("#202230", "#161720", "#3b4261", "#292e42", "#7aa2f7"), "editor.background": "#1a1b26", "editor.foreground": "#c0caf5", "editorLineNumber.foreground": "#3b4261", "editorLineNumber.activeForeground": "#a9b1d6", "editorCursor.foreground": "#7aa2f7", "editor.selectionBackground": "#33467c88", "editor.lineHighlightBackground": "#202230", "editorIndentGuide.background1": "#292e42", "editorIndentGuide.activeBackground1": "#515c7e" },
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
    editor.updateOptions({ stickyScroll: { enabled: false } });
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
      const info = await client.start(clangdPath || null, workspacePath, activeTab?.filename || "A.cpp", codes.cpp, atcoderLibraryPath || null);
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

  const chooseBackgroundImage = async () => {
    if (!("__TAURI_INTERNALS__" in window)) {
      backgroundImageInputRef.current?.click();
      return;
    }
    try {
      const path = await open({ multiple: false, directory: false, title: t("chooseBackground"), filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }] });
      if (!path || Array.isArray(path)) return;
      setBackgroundImagePath(path);
    } catch (error) {
      setBackgroundImageError(error instanceof Error ? error.message : String(error));
    }
  };

  const chooseBrowserBackgroundImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 40 * 1024 * 1024) {
      setBackgroundImageError("Background images must be 40 MB or smaller.");
      return;
    }
    if (browserBackgroundUrlRef.current) URL.revokeObjectURL(browserBackgroundUrlRef.current);
    const objectUrl = URL.createObjectURL(file);
    browserBackgroundUrlRef.current = objectUrl;
    setBackgroundImageError("");
    setBackgroundImagePath(file.name);
    setBackgroundImageUrl(objectUrl);
  };

  const clearBackgroundImage = () => {
    if (browserBackgroundUrlRef.current) {
      URL.revokeObjectURL(browserBackgroundUrlRef.current);
      browserBackgroundUrlRef.current = "";
    }
    setBackgroundImageUrl("");
    setBackgroundImagePath("");
    setBackgroundImageError("");
  };

  const removeEditorFont = () => {
    const next = customFonts.filter((font) => font.id !== editorFont);
    setCustomFonts(next);
    localStorage.setItem("mild-custom-fonts", JSON.stringify(next));
    setEditorFont(systemFonts[0]?.id || "consolas");
  };

  const saveTemplates = () => {
    Object.entries(draftTemplates).forEach(([key, value]) => localStorage.setItem(key, value));
    setSettingsOpen(false);
  };

  const setTemplateCursor = () => {
    const editor = templateEditorRef.current;
    const model = editor?.getModel();
    const position = editor?.getPosition();
    if (!editor || !model || !position) return;
    const key = templateStorageKey(templateSource, templateLanguage);
    const source = draftTemplates[key] || "";
    const rawOffset = model.getOffsetAt(position);
    const offset = source.slice(0, rawOffset).replaceAll("${cursor}", "").length;
    const clean = source.replaceAll("${cursor}", "");
    const next = `${clean.slice(0, offset)}${"${cursor}"}${clean.slice(offset)}`;
    setDraftTemplates((current) => ({ ...current, [key]: next }));
    window.requestAnimationFrame(() => {
      const nextModel = templateEditorRef.current?.getModel();
      if (!nextModel) return;
      templateEditorRef.current?.setPosition(nextModel.getPositionAt(offset + "${cursor}".length));
      templateEditorRef.current?.focus();
    });
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

  const setSnippetCursor = () => {
    const editor = snippetEditorRef.current;
    const model = editor?.getModel();
    const position = editor?.getPosition();
    if (!editor || !model || !position) return;
    const marker = "${0}";
    const rawOffset = model.getOffsetAt(position);
    const offset = snippetDraft.code.slice(0, rawOffset).replaceAll(marker, "").length;
    const clean = snippetDraft.code.replaceAll(marker, "");
    const next = `${clean.slice(0, offset)}${marker}${clean.slice(offset)}`;
    setSnippetDraft((current) => ({ ...current, code: next }));
    window.requestAnimationFrame(() => {
      const nextModel = snippetEditorRef.current?.getModel();
      if (!nextModel) return;
      snippetEditorRef.current?.setPosition(nextModel.getPositionAt(offset + marker.length));
      snippetEditorRef.current?.focus();
    });
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
    if (!snippet || !editor) return;
    editor.trigger("mild-snippet", "editor.action.insertSnippet", { snippet: snippet.code });
    editor.focus();
    setInsertSnippetId("");
  };

  const applyTemplate = () => {
    clearDiagnostics();
    const key = templateStorageKey(templateSource, templateLanguage);
    if (!activeTab) return;
    const rendered = renderTemplateWithCursor(draftTemplates[key], { source: templateSource, filename: activeTab.filename, title: activeTab.title });
    if (rendered.cursorOffset !== undefined) pendingTemplateCursorRef.current = { tabId: activeTab.id, language: templateLanguage, offset: rendered.cursorOffset };
    setCodes((current) => ({ ...current, [templateLanguage]: rendered.code }));
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
            sourceUrl: tab.sourceUrl,
            judgeStatus: tab.judgeStatus,
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
        codes: { cpp: storedTemplate("cpp", problem.source || "other"), python: storedTemplate("python", problem.source || "other"), [problem.language]: problem.code },
        tests: hydrateTests(problem.tests),
        source: problem.source || "other", sourceUrl: problem.sourceUrl || inferredSourceUrl(problem.source, problem.filename), judgeStatus: problem.judgeStatus, modifiedAt: problem.modifiedAt,
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
        codes: { cpp: storedTemplate("cpp", problem.source || "other"), python: storedTemplate("python", problem.source || "other"), [problem.language]: problem.code },
        tests: hydrateTests(problem.tests),
        source: problem.source || "other", sourceUrl: problem.sourceUrl || inferredSourceUrl(problem.source, problem.filename), judgeStatus: problem.judgeStatus, modifiedAt: problem.modifiedAt,
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
    const importedCursorOffsets = new Map<string, number>();
    const importedTabs = imported.map((problem): ProblemTab => {
      const filename = mexFilename(problem.suggestedFilename, used);
      used.add(fileKey(filename));
      const renderedCpp = renderTemplateWithCursor(storedTemplate("cpp", problem.source), { source: problem.source, filename, title: problem.title });
      const renderedPython = renderTemplateWithCursor(storedTemplate("python", problem.source), { source: problem.source, filename, title: problem.title });
      const id = crypto.randomUUID();
      if (renderedCpp.cursorOffset !== undefined) importedCursorOffsets.set(id, renderedCpp.cursorOffset);
      return {
        id, title: problem.title, filename, language: "cpp",
        codes: {
          cpp: renderedCpp.code,
          python: renderedPython.code,
        },
        tests: hydrateTests(problem.tests),
        source: problem.source,
        sourceUrl: problem.sourceUrl,
        modifiedAt: Date.now(),
      };
    });
    if (!importedTabs.length) throw new Error("No problems were imported.");
    const firstCursorOffset = importedCursorOffsets.get(importedTabs[0].id);
    if (firstCursorOffset !== undefined) pendingTemplateCursorRef.current = { tabId: importedTabs[0].id, language: "cpp", offset: firstCursorOffset };
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
        if (activeTab && fileKey(activeTab.filename) === fileKey(testcaseImportTarget.filename)) setTests(nextTests);
        setAtCoderOpen(false);
        setTestcaseImportTarget(null);
        setAtCoderUrl("");
        setFileStatus("test cases imported");
        return;
      }
      await addImportedProblems(imported);
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setImportingAtCoder(false);
    }
  };

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
        return result?.status ? { ...file, judgeStatus: result.status, submissionUrl: result.submissionUrl || file.submissionUrl } : file;
      };
      setTabs((items) => items.map(update));
      setSavedFiles((items) => items.map(update));
      if (!silent) setFileStatus(results.some((result) => result.status) ? "submission results updated" : "no matching submissions found");
    } catch (error) {
      if (!silent) setFileStatus(error instanceof Error ? error.message : String(error));
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

  const chooseAtcoderLibrary = async () => {
    const path = await open({ directory: true, multiple: false, title: "Choose the AtCoder Library include folder" });
    if (path && !Array.isArray(path)) setAtcoderLibraryPath(path);
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
          atcoderLibraryPath: atcoderLibraryPath || null,
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
      if (event.key === "F2" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const focusedInExplorer = document.activeElement instanceof Element && Boolean(document.activeElement.closest(".explorer-file"));
        const selected = explorerFiles.find((file) => fileKey(file.filename) === fileKey(selectedExplorerFilename));
        if (focusedInExplorer && selected && workspacePath && !renameFile) {
          event.preventDefault();
          setRenameValue(selected.filename);
          setRenameFile(selected);
          setExplorerMenu(null);
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
      else if (sourceFile) setSourceFile(null);
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
  }, [appCloseConfirm, atCoderOpen, blankFilenameOpen, closeConfirmTabId, deleteConfirmFile, explorerMenu, hasFileStatusError, importCollision, renameFile, settingsOpen, sourceFile]);

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
      } else if (sourceFile) {
        event.preventDefault();
        void updateProblemSource();
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
  }, [appCloseConfirm, atCoderOpen, atCoderUrl, blankFilenameOpen, closeConfirmTabId, deleteConfirmFile, hasFileStatusError, importCollision, renameFile, sourceFile, sourceUrlValue, sourceValue]);

  const summary = useMemo(() => {
    const passed = tests.filter((test) => test.status === "passed").length;
    return running ? "running tests…" : tests.some((test) => test.status !== "idle") ? `${passed} / ${tests.length} passed` : "ready";
  }, [running, tests]);

  return (
    <main
      className="app-shell"
      data-wallpaper={backgroundImageUrl ? "image" : undefined}
      style={{
        "--wallpaper-image": backgroundImageUrl ? `url(${backgroundImageUrl})` : "none",
        "--wallpaper-size": wallpaperSize,
        "--wallpaper-repeat": wallpaperRepeat,
        "--wallpaper-position": wallpaperPosition,
        "--acrylic-opacity": `${acrylicOpacity}%`,
        "--acrylic-blur": `${acrylicBlur}px`,
      } as CSSProperties}
    >
      <div className="window-titlebar" data-tauri-drag-region>
        <div className="titlebar-identity" data-tauri-drag-region>
          <span className="titlebar-logo" aria-hidden="true">m</span>
          <span className="titlebar-name" data-tauri-drag-region>mild editor</span>
          <span className="titlebar-separator" data-tauri-drag-region>·</span>
          <span className="titlebar-file" data-tauri-drag-region>{workspacePath ? `${workspacePath.split(/[\\/]/).at(-1)}${activeTab ? ` / ${activeTab.filename}` : ""}` : "no workspace"}</span>
        </div>
        <div className="titlebar-tools">
          <div className="file-actions">
            <button onClick={newProblem}>{t("new")}</button>
            <button onClick={() => void openProblem()}>{t("open")}</button>
            <button onClick={() => void saveProblem()}>{t("save")}</button>
            <button className="atcoder-button" onClick={beginImport}>{t("import")}</button>
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
              <span>{t("testCases")}</span>
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
                      <label>{t("input")}<textarea value={test.input} onChange={(event) => updateTest(test.id, { input: event.target.value, status: "idle" })} spellCheck={false} /></label>
                      <label><span className="field-label">{t("expected")}<button className="accept-output" onClick={() => updateTest(test.id, { expected: test.output, status: "idle" })} disabled={test.timeMs === undefined || Boolean(test.error)}>{t("useOutput")}</button></span><textarea value={test.expected} onChange={(event) => updateTest(test.id, { expected: event.target.value, status: "idle" })} spellCheck={false} /></label>
                      <label>{t("output")}<textarea value={combinedRunOutput(test.output, test.error)} readOnly className={test.error ? "has-error" : ""} placeholder={t("runToSee")} /></label>
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
            <div className="welcome-mark">m</div>
            <p className="eyebrow">{t("welcomeTagline")}</p>
            <h1>mild editor</h1>
            <p>{t("welcomeBody")}</p>
            <div className="welcome-actions"><button className="primary-button" onClick={newProblem}>{t("newWorkspace")} <kbd>Ctrl+N</kbd></button><button className="subtle-button" onClick={() => void openProblem()}>{t("openWorkspace")} <kbd>Ctrl+O</kbd></button></div>
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
            <label title="sort files"><span>{t("sort")}</span><select value={explorerSort} onChange={(event) => setExplorerSort(event.target.value as ExplorerSort)} aria-label="Explorer sort order"><option value="modified">{t("latestModified")}</option><option value="problem">{t("problemNumber")}</option><option value="name">{t("name")}</option></select></label>
            <label title="filter by source"><span>{t("show")}</span><select value={explorerSource} onChange={(event) => setExplorerSource(event.target.value as ProblemSource | "all")} aria-label="Explorer source filter"><option value="all">{t("allSources")}</option><option value="atcoder">AtCoder</option><option value="codeforces">Codeforces</option><option value="doj">DOJ</option><option value="other">{t("local")}</option></select></label>
          </div>
          <div className="explorer-files">
            {!explorerFiles.length && <div className="explorer-empty">{t("noFiles")}</div>}
            {explorerFiles.map((tab) => {
              const openIndex = tabs.findIndex((item) => fileKey(item.filename) === fileKey(tab.filename));
              return (
              <div className="explorer-file-row" key={tab.id}>
                <button
                  className={`explorer-file ${fileKey(tab.filename) === fileKey(selectedExplorerFilename || activeTab?.filename || "") ? "active" : ""}`}
                  onClick={() => openSavedFile(tab)}
                  onFocus={() => setSelectedExplorerFilename(tab.filename)}
                  onContextMenu={(event) => { if (!workspacePath) return; event.preventDefault(); setSelectedExplorerFilename(tab.filename); setExplorerMenu({ file: tab, x: event.clientX, y: event.clientY }); }}
                  title={`${tab.filename}${openIndex >= 0 && openIndex < 9 ? ` (Ctrl+${openIndex + 1})` : ""}`}
                >
                  <span className={`file-icon ${tab.language}`}>{tab.language === "cpp" ? "C++" : "Py"}</span>
                  <span className="explorer-file-name">{tab.filename}</span>
                  {tab.judgeStatus && <span className={`judge-badge ${tab.judgeStatus === "AC" || tab.judgeStatus === "OK" ? "accepted" : ""}`} title={tab.submissionUrl || "latest submission result"}>{tab.judgeStatus}</span>}
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
        <button role="menuitem" onClick={() => { beginTestcaseImport(explorerMenu.file); setExplorerMenu(null); }}>import test cases</button>
        <button role="menuitem" onClick={() => { void openFileLocation(explorerMenu.file); setExplorerMenu(null); }}>open file location</button>
        <button role="menuitem" onClick={() => { void duplicateWorkspaceFile(explorerMenu.file); setExplorerMenu(null); }}>duplicate file</button>
        <button role="menuitem" onClick={() => { beginSourceEdit(explorerMenu.file); setExplorerMenu(null); }}>set problem source</button>
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

      {sourceFile && <div className="modal-backdrop close-confirm" role="presentation">
        <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="source-file-title">
          <span className="eyebrow">problem classification</span>
          <h2 id="source-file-title">Set source for {sourceFile.filename}</h2>
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
          <footer className="settings-footer"><span className="footer-spacer" /><button className="subtle-button" onClick={() => setSourceFile(null)}>cancel</button><button className="primary-button" onClick={() => void updateProblemSource()}>save</button></footer>
        </section>
      </div>}

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
          <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <header className="settings-header">
              <div><span className="eyebrow">{t("preferences")}</span><h2 id="settings-title">{settingsPage === "appearance" ? t("appearance") : settingsPage === "template" ? t("template") : settingsPage === "snippets" ? t("snippets") : settingsPage === "judge" ? t("judge") : t("languageServer")}</h2></div>
              <button className="modal-close" onClick={() => setSettingsOpen(false)} aria-label="Close settings">×</button>
            </header>
            <div className="settings-pages">
              <button className={settingsPage === "appearance" ? "active" : ""} onClick={() => setSettingsPage("appearance")}>{t("appearance")}</button>
              <button className={settingsPage === "template" ? "active" : ""} onClick={() => setSettingsPage("template")}>{t("template")}</button>
              <button className={settingsPage === "snippets" ? "active" : ""} onClick={() => setSettingsPage("snippets")}>{t("snippets")}</button>
              <button className={settingsPage === "judge" ? "active" : ""} onClick={() => setSettingsPage("judge")}>{t("judge")}</button>
              <button className={settingsPage === "language-server" ? "active" : ""} onClick={() => setSettingsPage("language-server")}>{t("languageServer")}</button>
            </div>
            {settingsPage === "appearance" ? <div className="appearance-settings">
              <div className="appearance-group"><label>{t("interfaceLanguage")}<select value={uiLocale} onChange={(event) => setUiLocale(event.target.value as UiLocale)}><option value="en">{t("english")}</option><option value="ko">{t("korean")}</option></select></label></div>
              <p className="settings-help">{t("appearanceHelp")}</p>
              <div className="appearance-group"><span>theme</span><div className="theme-options">
                <button className={`theme-option pastel ${uiTheme === "pastel" ? "active" : ""}`} onClick={() => setUiTheme("pastel")}><i /><strong>pastel dusk</strong><small>muted Sublime-inspired</small></button>
                <button className={`theme-option midnight ${uiTheme === "midnight" ? "active" : ""}`} onClick={() => setUiTheme("midnight")}><i /><strong>Catppuccin Mocha</strong><small>soft pastel dark</small></button>
                <button className={`theme-option latte ${uiTheme === "latte" ? "active" : ""}`} onClick={() => setUiTheme("latte")}><i /><strong>Rosé Pine Dawn</strong><small>warm, quiet light</small></button>
                <button className={`theme-option sakura ${uiTheme === "sakura" ? "active" : ""}`} onClick={() => setUiTheme("sakura")}><i /><strong>Dracula</strong><small>purple, pink and cyan</small></button>
                <button className={`theme-option blossom ${uiTheme === "blossom" ? "active" : ""}`} onClick={() => setUiTheme("blossom")}><i /><strong>Gruvbox Dark</strong><small>warm retro contrast</small></button>
                <button className={`theme-option nord ${uiTheme === "nord" ? "active" : ""}`} onClick={() => setUiTheme("nord")}><i /><strong>Nord</strong><small>calm arctic blue</small></button>
                <button className={`theme-option tokyo ${uiTheme === "tokyo" ? "active" : ""}`} onClick={() => setUiTheme("tokyo")}><i /><strong>Tokyo Night</strong><small>electric city blue</small></button>
              </div></div>
              <div className="appearance-group wallpaper-settings">
                <span>{t("backgroundImage")}</span>
                <p className="settings-help">{t("backgroundHelp")}</p>
                <div className="wallpaper-picker">
                  <input ref={backgroundImageInputRef} className="wallpaper-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" onChange={chooseBrowserBackgroundImage} tabIndex={-1} />
                  <div className={`wallpaper-preview ${backgroundImageUrl ? "has-image" : ""}`} style={backgroundImageUrl ? { backgroundImage: `url(${backgroundImageUrl})`, backgroundPosition: wallpaperPosition, backgroundRepeat: wallpaperRepeat, backgroundSize: wallpaperSize } : undefined}><span>{backgroundImageUrl ? backgroundImagePath.split(/[\\/]/).at(-1) : t("noBackground")}</span></div>
                  <div className="font-actions"><button className="subtle-button" onClick={() => void chooseBackgroundImage()}>{t("chooseBackground")}</button>{backgroundImagePath && <button className="danger-button" onClick={clearBackgroundImage}>{t("clearBackground")}</button>}</div>
                </div>
                {backgroundImageError && <p className="wallpaper-error">{backgroundImageError}</p>}
                <label className="wallpaper-layout-select"><span>{t("wallpaperLayout")}</span><select value={wallpaperLayout} onChange={(event) => setWallpaperLayout(event.target.value as WallpaperLayout)}><option value="cover">{t("wallpaperCover")}</option><option value="contain">{t("wallpaperContain")}</option><option value="stretch">{t("wallpaperStretch")}</option><option value="original">{t("wallpaperOriginal")}</option><option value="tile">{t("wallpaperTile")}</option><option value="custom">{t("wallpaperCustom")}</option></select></label>
                {(wallpaperLayout === "custom" || wallpaperLayout === "tile") && <label className="appearance-range"><span>{t("wallpaperScale")}</span><input type="range" min="25" max="300" step="5" value={wallpaperScale} onChange={(event) => setWallpaperScale(Number(event.target.value))} /><output>{wallpaperScale}%</output></label>}
                <label className="appearance-range"><span>{t("wallpaperPositionX")}</span><input type="range" min="0" max="100" value={wallpaperPositionX} onChange={(event) => setWallpaperPositionX(Number(event.target.value))} /><output>{wallpaperPositionX}%</output></label>
                <label className="appearance-range"><span>{t("wallpaperPositionY")}</span><input type="range" min="0" max="100" value={wallpaperPositionY} onChange={(event) => setWallpaperPositionY(Number(event.target.value))} /><output>{wallpaperPositionY}%</output></label>
                <div className="wallpaper-layout-actions"><button className="subtle-button" onClick={() => { setWallpaperLayout("cover"); setWallpaperScale(100); setWallpaperPositionX(50); setWallpaperPositionY(50); }}>{t("resetWallpaperLayout")}</button></div>
                <label className="appearance-range"><span>{t("acrylicOpacity")}</span><input type="range" min="0" max="100" value={acrylicOpacity} onChange={(event) => setAcrylicOpacity(Number(event.target.value))} /><output>{acrylicOpacity}%</output></label>
                <label className="appearance-range"><span>{t("acrylicBlur")}</span><input type="range" min="0" max="32" value={acrylicBlur} onChange={(event) => setAcrylicBlur(Number(event.target.value))} /><output>{acrylicBlur}px</output></label>
              </div>
              <div className="appearance-group"><label>{t("editorFont")}<select value={selectedFont.id} onChange={(event) => setEditorFont(event.target.value)}>{fontOptions.map((font) => <option value={font.id} key={font.id}>{font.label}</option>)}</select></label><div className="font-actions"><button className="subtle-button" onClick={() => void addEditorFont()}>{t("addFont")}</button>{selectedFont.path && <button className="danger-button" onClick={removeEditorFont}>{t("remove")}</button>}</div><pre style={{ fontFamily: editorFontFamily }}>int main() {'{'} return 0; {'}'}</pre></div>
            </div> : settingsPage === "template" ? <>
              <div className="template-tabs" role="tablist" aria-label="Template language">
                <button className={templateLanguage === "cpp" ? "active" : ""} onClick={() => setTemplateLanguage("cpp")}>C++</button>
                <button className={templateLanguage === "python" ? "active" : ""} onClick={() => setTemplateLanguage("python")}>Python</button>
              </div>
              <div className="template-tabs template-source-tabs" role="tablist" aria-label="Template site">
                {templateSources.map((source) => <button key={source} className={templateSource === source ? "active" : ""} onClick={() => setTemplateSource(source)}>{source === "other" ? t("local") : source === "atcoder" ? "AtCoder" : source === "codeforces" ? "Codeforces" : "DOJ"}</button>)}
              </div>
              <p className="settings-help">{t("templateHelp")}</p>
              <div className="template-monaco"><Editor beforeMount={beforeMount} onMount={(editor) => { templateEditorRef.current = editor; }} height="100%" language={templateLanguage === "cpp" ? "cpp" : "python"} value={draftTemplates[templateStorageKey(templateSource, templateLanguage)]} onChange={(code) => setDraftTemplates((current) => ({ ...current, [templateStorageKey(templateSource, templateLanguage)]: code || "" }))} theme={monacoTheme} options={{ minimap: { enabled: false }, fontFamily: editorFontFamily, fontSize: 12, lineNumbers: "on", scrollBeyondLastLine: false, automaticLayout: true, tabSize: 4, padding: { top: 10, bottom: 10 } }} /></div>
              <footer className="settings-footer">
                <button className="subtle-button" onClick={() => setDraftTemplates((current) => ({ ...current, [templateStorageKey(templateSource, templateLanguage)]: templates[templateLanguage] }))}>{t("reset")}</button>
                <button className="subtle-button" onClick={setTemplateCursor}>set cursor here</button>
                <span className="footer-spacer" />
                <button className="subtle-button" onClick={applyTemplate}>{t("applyEditor")}</button>
                <button className="primary-button" onClick={saveTemplates}>{t("saveTemplate")}</button>
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
                  <span>{t("snippetsHelp")}</span>
                  <span>Monaco placeholders are supported: <code>{"${1:value}"}</code> selects the first editable field and <code>{"${0}"}</code> sets the final cursor position. Snippets are stored locally on this device.</span>
                </div>
                <div className="snippet-meta">
                  <input value={snippetDraft.name} onChange={(event) => setSnippetDraft((current) => ({ ...current, name: event.target.value }))} placeholder="snippet name" aria-label="Snippet name" />
                  <select value={snippetDraft.language} onChange={(event) => setSnippetDraft((current) => ({ ...current, language: event.target.value as Language }))} aria-label="Snippet language"><option value="cpp">C++</option><option value="python">Python</option></select>
                </div>
                <div className="snippet-monaco"><Editor beforeMount={beforeMount} onMount={(editor) => { snippetEditorRef.current = editor; }} height="100%" language={snippetDraft.language === "cpp" ? "cpp" : "python"} value={snippetDraft.code} onChange={(code) => setSnippetDraft((current) => ({ ...current, code: code || "" }))} theme={monacoTheme} options={{ minimap: { enabled: false }, fontFamily: editorFontFamily, fontSize: 12, lineNumbers: "on", scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, padding: { top: 10, bottom: 10 } }} /></div>
                <footer className="settings-footer"><button className="subtle-button" onClick={setSnippetCursor}>set cursor here</button><span className="footer-spacer" /><button className="primary-button" onClick={saveSnippet} disabled={!snippetDraft.name.trim() || !snippetDraft.code.trim()}>save snippet</button></footer>
              </div>
            </div> : settingsPage === "judge" ? <div className="language-server-settings judge-settings">
              <p className="settings-help">{t("judgeHelp")}</p>
              <label className="clangd-path-label">AtCoder handle<input value={atcoderHandle} onChange={(event) => setAtcoderHandle(event.target.value)} placeholder="tourist" spellCheck={false} /></label>
              <label className="clangd-path-label">Codeforces handle<input value={codeforcesHandle} onChange={(event) => setCodeforcesHandle(event.target.value)} placeholder="tourist" spellCheck={false} /></label>
              <label className="clangd-path-label">DOJ handle<input value={dojHandle} onChange={(event) => setDojHandle(event.target.value)} placeholder="username" spellCheck={false} /></label>
              <footer className="settings-footer"><span className="footer-spacer" /><button className="primary-button" disabled={refreshingJudge} onClick={() => void refreshSubmissionStatuses()}>{refreshingJudge ? t("refreshing") : t("refreshNow")}</button></footer>
            </div> : <div className="language-server-settings">
              <div className={`lsp-state ${clangdStatus}`}><span className="lsp-dot" /><div><strong>{clangdStatus === "ready" ? "clangd connected" : clangdStatus === "connecting" ? "connecting…" : clangdStatus === "missing" ? "clangd not found" : clangdStatus === "error" ? "connection failed" : "clangd idle"}</strong><small>{clangdInfo?.version || "C++ semantic completion, diagnostics, hover and signature help"}</small></div></div>
              <label className="clangd-path-label">clangd executable path<input value={clangdPath} onChange={(event) => setClangdPath(event.target.value)} placeholder="Auto-detect from PATH, or C:\\Program Files\\LLVM\\bin\\clangd.exe" spellCheck={false} /></label>
              <p className="settings-help">Leave the path empty to search PATH automatically. If LLVM clangd is unavailable, Mild Editor keeps using its built-in lightweight completions.</p>
              <label className="clangd-path-label">{t("aclPath")}<span className="path-picker"><input value={atcoderLibraryPath} onChange={(event) => setAtcoderLibraryPath(event.target.value)} placeholder="C:\\library\\ac-library" spellCheck={false} /><button className="subtle-button" onClick={() => void chooseAtcoderLibrary()}>{t("chooseFolder")}</button></span></label>
              <p className="settings-help">{t("aclHelp")}</p>
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
              <div><span className="eyebrow">{t("importSamples")}</span><h2 id="atcoder-title">{testcaseImportTarget ? `Import test cases · ${testcaseImportTarget.filename}` : t("onlineProblem")}</h2></div>
              <button className="modal-close" onClick={cancelProblemImport} aria-label="Close problem import">×</button>
            </header>
            <p className="settings-help">{testcaseImportTarget ? "Replace only this file's test cases. Its code and filename stay unchanged." : t("importHelp")}</p>
            <input className="atcoder-url" value={atCoderUrl} onChange={(event) => setAtCoderUrl(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void importAtCoderProblem(); } }} placeholder="AtCoder, Codeforces, or doj.kr problem URL" autoFocus />
            <footer className="settings-footer">
              <span className="footer-spacer" />
              <button className="subtle-button" onClick={cancelProblemImport}>{newFileImportPending ? (uiLocale === "ko" ? "빈 파일 만들기" : "create blank file") : t("cancel")}</button>
              <button className="primary-button" onClick={() => void importAtCoderProblem()} disabled={importingAtCoder || !atCoderUrl.trim()}>{importingAtCoder ? (uiLocale === "ko" ? "가져오는 중…" : "importing…") : t("importSamples")}</button>
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
