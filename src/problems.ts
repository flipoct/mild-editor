import { outputsMatch } from "./judge";
import { explorerParent, fileKey, normalizedExplorerPath } from "./fileNaming";
import { checkerStatus, type CheckerVerdict } from "./workbench";
import type { CompanionProblem, ContestState, ExplorerSelection, ImportedAtCoderProblem, Language, NativeRunResult, ProblemSource, ProblemTab, SavedTest, Status, TestCase, WorkspaceFileResult } from "./types";

/** ICPC scoring: twenty minutes on the clock for each rejected try before the one that solved it. */
export const CONTEST_PENALTY_MINUTES = 20;

export const templates: Record<Language, string> = {
  cpp: `#include <iostream>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n\n    \${cursor}int a, b;\n    cin >> a >> b;\n    cout << a + b << '\\n';\n    return 0;\n}\n`,
  python: `import sys\n\n\ndef solve():\n    \${cursor}a, b = map(int, sys.stdin.readline().split())\n    print(a + b)\n\n\nif __name__ == "__main__":\n    solve()\n`,
};



export const verdictLabels: Record<Status, string> = {
  idle: "", running: "…", ac: "AC", wa: "WA", tle: "TLE", mle: "MLE", re: "RE", ce: "CE", stopped: "—",
};

/** Turns one runner result into a verdict. Only a clean exit can still be judged against the expected output. */
export const judge = (result: NativeRunResult, expected: string, tolerance: number, checker?: CheckerVerdict): Status => {
  if (result.verdict === "limit") return "re";
  if (result.verdict !== "ok") return result.verdict;
  if (checker) return checkerStatus(checker);
  return outputsMatch(expected, result.stdout, tolerance) ? "ac" : "wa";
};

export const finalVerdicts: Status[] = ["ac", "wa", "tle", "mle", "re", "ce", "stopped"];

export const formatMemory = (kb: number) => kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(2)} GB` : kb >= 10 * 1024 ? `${Math.round(kb / 1024)} MB` : `${(kb / 1024).toFixed(1)} MB`;


export const contestStorageKey = (workspace: string | null) => `mild-contest:${workspace ?? ""}`;

export const loadContest = (workspace: string | null): ContestState | null => {
  try {
    const stored = JSON.parse(localStorage.getItem(contestStorageKey(workspace)) || "null") as ContestState | null;
    return stored && Number.isFinite(stored.startedAt) && stored.durationMin > 0 ? { ...stored, solved: stored.solved || {} } : null;
  } catch { return null; }
};

export const formatClock = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${Math.floor(total / 3600)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
};

export const isAccepted = (status: string | undefined) => status === "AC" || status === "OK";

/** The judge is still working on it: `WJ`, `TESTING`, or AtCoder's running count `12/34`. */
export const isPendingVerdict = (status: string) => /^(WJ|WR|JUDGING|TESTING|IN QUEUE)$/i.test(status.trim()) || /^\d+\s*\/\s*\d+/.test(status.trim());

export const VERDICT_NOTICE_MS = 15_000;


export const DEFAULT_TIME_LIMIT_MS = 2000;

/** An unoptimised, instrumented build is several times slower, so a Debug run gets this much more time. */
export const DEBUG_TIME_FACTOR = 3;

export const visibleWhitespace = (value: string) => value.replace(/ /g, "·").replace(/\t/g, "⇥");

export const combinedRunOutput = (output: string, error: string) => error
  ? `${output}${output && !output.endsWith("\n") ? "\n" : ""}${error.replace(/^\s+/, "")}`
  : output;

export const languageFromFilename = (filename: string): Language | null => /\.(cpp|cc|cxx)$/i.test(filename) ? "cpp" : /\.py$/i.test(filename) ? "python" : null;

export const filenameForLanguage = (filename: string, language: Language) => filename.replace(/\.(cpp|cc|cxx|py)$/i, language === "cpp" ? ".cpp" : ".py");

export const inferredSourceUrl = (source: ProblemSource | undefined, filename: string) => {
  const problemId = filename.replace(/\.[^.]+$/, "");
  return source === "doj" && /^\d+$/.test(problemId) ? `https://doj.kr/ko/problems/${problemId}` : undefined;
};

export const templateSources: ProblemSource[] = ["other", "atcoder", "codeforces", "doj"];

export const templateStorageKey = (source: ProblemSource, language: Language) => `mild-template-${source}-${language}`;

export const storedTemplate = (language: Language, source: ProblemSource = "other") => localStorage.getItem(templateStorageKey(source, language)) || localStorage.getItem(`mild-template-${language}`) || templates[language];

export const loadTemplateDrafts = () => Object.fromEntries(templateSources.flatMap((source) => (["cpp", "python"] as Language[]).map((language) => [templateStorageKey(source, language), storedTemplate(language, source)])));

/**
 * A DOJ page that lists a contest's problems: the contest itself (`/contests/<slug>`), or a
 * category (`/categories/<path…>`), which with `?virtual=<key>` is a virtual contest. The
 * same test as `is_doj_listing` in import.rs.
 */
const isDojListing = (url: URL) => {
  const parts = url.pathname.split("/").filter(Boolean);
  return !parts.includes("problems") && (parts.includes("contests") || parts.includes("categories"));
};

export const isContestImportUrl = (rawUrl: string) => {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.endsWith("atcoder.jp")) return url.pathname.includes("/contests/") && !url.pathname.includes("/tasks/");
    // A DOJ contest problem is `/problems/<id>?contest=<key>`: the contest is in the query, not the path.
    if (url.hostname.endsWith("doj.kr")) return isDojListing(url);
    return url.hostname.endsWith("codeforces.com") && url.pathname.includes("/contest/") && !url.pathname.includes("/problem/");
  } catch { return false; }
};

/**
 * Leads the error of an import the backend could not make without a browser (see
 * `NEEDS_BROWSER` in import.rs): Cloudflare's check in front of Codeforces, or a page shown
 * to a logged-in participant only. What follows it is the reason, in English.
 */
export const NEEDS_BROWSER = "needs-browser: ";

/**
 * Pages the bundled Competitive Companion has no parser for although the built-in importer
 * reads them: a DOJ contest, or the category page a virtual contest runs on (the extension's
 * DOJ parser knows a problem page only). Asking the extension there ends in "found no
 * problem" and nothing imported.
 */
export const companionCannotParse = (rawUrl: string) => {
  try {
    const url = new URL(rawUrl);
    return url.hostname.replace(/^www\./, "") === "doj.kr" && (/\/contests\/[^/]+\/?$/.test(url.pathname) || (isDojListing(url) && url.pathname.includes("/categories/")));
  } catch { return false; }
};

/** Whether the problem browser is on the page that was asked for; a judge may add or drop the query on the way. */
export const isSamePage = (left: string, right: string) => {
  try {
    const [a, b] = [new URL(left), new URL(right)];
    const path = (url: URL) => url.pathname.replace(/\/+$/, "");
    return a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "") && path(a) === path(b);
  } catch { return false; }
};

export const defaultFilename = (index: number, language: Language = "cpp") => `${index < 26 ? String.fromCharCode(65 + index) : `problem${index + 1}`}.${language === "cpp" ? "cpp" : "py"}`;

/** Whether `entry` can go into `target` ("" is the root): not where it already is, and no folder into itself. */
export const canMoveInto = (entry: NonNullable<ExplorerSelection>, target: string) => {
  const targetKey = fileKey(normalizedExplorerPath(target));
  if (entry.kind === "file") return fileKey(explorerParent(entry.filename)) !== targetKey;
  const key = fileKey(entry.path);
  return fileKey(explorerParent(entry.path)) !== targetKey && targetKey !== key && !targetKey.startsWith(`${key}/`);
};

export const nextDefaultFilename = (filenames: Iterable<string>, language: Language = "cpp") => {
  const occupied = new Set(Array.from(filenames, fileKey));
  for (let index = 0; ; index += 1) {
    const candidate = defaultFilename(index, language);
    if (!occupied.has(fileKey(candidate))) return candidate;
  }
};

export const companionSource = (url: string): ProblemSource =>
  /atcoder\.jp/i.test(url) ? "atcoder" : /codeforces\.com/i.test(url) ? "codeforces" : /doj\.kr/i.test(url) ? "doj" : "other";

/** `"A. Theatre Square"` and `"A - Sum"` both become `A.cpp`, matching what the URL importer produces. */
export const companionFilename = (problem: CompanionProblem, source: ProblemSource) => {
  if (source === "doj") {
    const problemId = /\/problems\/(\d+)/.exec(problem.url)?.[1];
    if (problemId) return `${problemId}.cpp`;
  }
  const letter = /^([A-Za-z][0-9]?)\s*[.)\-–—]/.exec(problem.name.trim())?.[1];
  if (letter) return `${letter.toUpperCase()}.cpp`;
  const slug = problem.name.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${slug || "problem"}.cpp`;
};

export const companionToImported = (problem: CompanionProblem): ImportedAtCoderProblem => {
  const source = companionSource(problem.url);
  return {
    title: problem.name,
    contest: problem.group,
    suggestedFilename: companionFilename(problem, source),
    tests: problem.tests.map((test, index) => ({ name: `test ${index + 1}`, input: test.input, expected: test.output })),
    source,
    sourceUrl: problem.url,
    limits: problem.timeLimit || problem.memoryLimit ? { timeLimitMs: problem.timeLimit || undefined, memoryLimitMb: problem.memoryLimit || undefined } : undefined,
  };
};

/**
 * Stands in a dropdown for the file that does not exist yet. Nothing is written while the
 * dialog is only being looked at: the file is created when the search is started, and only
 * for a role still left on this.
 */
export const STRESS_CREATE = "\u0000create";

/** Per problem, not per workspace: each one has a generator and a reference of its own. */
export const stressChoiceKey = (workspace: string | null) => `mild-stress:${workspace ?? ""}`;

export const blankTest = (): TestCase => ({ id: 1, name: "test 1", input: "", expected: "", output: "", error: "", status: "idle", open: true });

/** Saved tests as the panel shows them: numbered, not yet run, the first one unfolded. */
export const hydrateTests = (saved: SavedTest[]): TestCase[] => saved.length
  ? saved.map((test, index) => ({ ...test, name: test.name.replace(/^sample\s+/i, "test "), id: index + 1, output: "", error: "", status: "idle", open: index === 0 }))
  : [blankTest()];

/** A file of the workspace as a tab. Only its own language has code yet; the other starts from the template. */
export const makeTab = (file: WorkspaceFileResult): ProblemTab => ({
  id: crypto.randomUUID(), title: file.title, filename: file.filename, language: file.language,
  codes: { cpp: storedTemplate("cpp", file.source || "other"), python: storedTemplate("python", file.source || "other"), [file.language]: file.code },
  tests: hydrateTests(file.tests),
  source: file.source || "other", sourceUrl: file.sourceUrl || inferredSourceUrl(file.source, file.filename), judgeStatus: file.judgeStatus, limits: file.limits, modifiedAt: file.modifiedAt, order: file.order, submissions: file.submissions,
});

/** What `save_workspace` is sent for one tab. */
export const savedProblem = (tab: ProblemTab) => ({
  filename: tab.filename, title: tab.title, language: tab.language, code: tab.codes[tab.language],
  tests: tab.tests.map(({ name, input, expected }) => ({ name, input, expected })),
  source: tab.source, sourceUrl: tab.sourceUrl, judgeStatus: tab.judgeStatus, limits: tab.limits, modifiedAt: tab.modifiedAt,
});

/** The contest board knows a problem by its path; a rename or a move keeps its solve time. */
export const rekeyContest = (contest: ContestState, rekey: (key: string) => string): ContestState => ({
  ...contest,
  solved: Object.fromEntries(Object.entries(contest.solved).map(([key, time]) => [rekey(key), time])),
  excluded: contest.excluded?.map(rekey),
  acceptedBefore: contest.acceptedBefore && Object.fromEntries(Object.entries(contest.acceptedBefore).map(([key, url]) => [rekey(key), url])),
});
