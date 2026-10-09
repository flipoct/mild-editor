/**
 * Pure rules behind the test panel heading, checkers and the command palette, kept apart from the component so
 * they can be checked without a browser (`src/workbench.check.ts`).
 */

// --- The panel heading ------------------------------------------------------------------

/** The statuses a finished test can carry; `ac` is the only passing one. */
const FAILED = new Set(["wa", "tle", "mle", "re", "ce"]);

/**
 * What the panel heading shows once tests have verdicts: how many passed out of all of them,
 * and the slowest time among those judged. It is green only when every test passed; a test
 * added or edited since the run keeps it amber rather than letting the run look clean.
 */
export type TestSummary = { passed: number; judged: number; total: number; slowestMs: number | null; tone: "pass" | "fail" | "partial" | "idle" };
export const summarizeTests = (tests: { status: string; timeMs?: number }[]): TestSummary => {
  const judged = tests.filter((test) => test.status === "ac" || FAILED.has(test.status));
  const passed = judged.filter((test) => test.status === "ac").length;
  const times = judged.map((test) => test.timeMs).filter((value): value is number => typeof value === "number");
  return {
    passed,
    judged: judged.length,
    total: tests.length,
    slowestMs: times.length ? Math.max(...times) : null,
    tone: !judged.length ? "idle" : passed < judged.length ? "fail" : passed === tests.length ? "pass" : "partial",
  };
};

// --- The checker a problem may carry ----------------------------------------------------

export type CheckerVerdict = { accepted: boolean; failed: boolean; message: string };

/**
 * The test's status once the checker has spoken. A checker that could not decide (it
 * crashed, timed out, or exited with testlib's fail code) is the checker's fault, so the
 * test shows an error rather than a wrong answer.
 */
export const checkerStatus = (checker: CheckerVerdict): "ac" | "wa" | "re" =>
  checker.accepted ? "ac" : checker.failed ? "re" : "wa";

/** Auto save is on unless it was turned off: only a stored "0" means off. */
export const autoSaveEnabled = (stored: string | null) => stored !== "0";


/**
 * The file a new checker starts from. It runs as it is — accepting the expected tokens in the
 * same order, which is what the plain comparison does — so the only thing to write is the
 * problem's own rule, and the comment says how the editor calls it.
 */
export const checkerStarter = (language: "cpp" | "python", title: string) => language === "cpp"
  ? `// Checker for ${title}: decides whether a solution's output is an accepted answer.
//
// Mild Editor runs it after every test the solution passes cleanly, as
//     checker <input file> <output file> <answer file>
// (the order testlib uses). Exit 0 to accept, any other code to reject; whatever it prints is
// shown with the verdict. Exit 3 when the checker itself cannot decide.
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
using namespace std;

static vector<string> tokens(const char* path) {
    ifstream file(path);
    vector<string> result;
    for (string token; file >> token;) result.push_back(token);
    return result;
}

int main(int argc, char* argv[]) {
    if (argc < 4) {
        cout << "usage: checker <input> <output> <answer>\\n";
        return 3;
    }
    vector<string> input = tokens(argv[1]);
    vector<string> output = tokens(argv[2]);
    vector<string> answer = tokens(argv[3]);

    // Replace this with the problem's rule, e.g. check that \`output\` is a valid order of the
    // vertices in \`input\` and as short as \`answer\`.
    if (output != answer) {
        cout << "expected " << answer.size() << " tokens matching the answer";
        return 1;
    }
    return 0;
}
`
  : `# Checker for ${title}: decides whether a solution's output is an accepted answer.
#
# Mild Editor runs it after every test the solution passes cleanly, as
#     python checker.py <input file> <output file> <answer file>
# (the order testlib uses). Exit 0 to accept, any other code to reject; whatever it prints is
# shown with the verdict. Exit 3 when the checker itself cannot decide.
import sys

if len(sys.argv) < 4:
    print("usage: checker <input> <output> <answer>")
    sys.exit(3)

with open(sys.argv[1]) as file:
    data = file.read().split()
with open(sys.argv[2]) as file:
    output = file.read().split()
with open(sys.argv[3]) as file:
    answer = file.read().split()

# Replace this with the problem's rule, e.g. check that \`output\` is a valid order of the
# vertices in \`data\` and as short as \`answer\`.
if output != answer:
    print(f"expected {len(answer)} tokens matching the answer")
    sys.exit(1)
`;

// --- The command palette ---------------------------------------------------------------

export type PaletteCommand = {
  id: string;
  label: string;
  /** Other words someone might type for it, in either language. */
  keywords?: string;
  /** The shortcut as the reader should press it, already spelled for the platform. */
  shortcut?: string;
  /** A command that cannot run right now stays listed but greyed, so it can still be found. */
  disabled?: boolean;
};

/**
 * Matches a command's label the way a palette is typed into: each character either carries on
 * from the one before or starts a word, so `rft` finds "Run failed tests" while letters picked
 * out of the middle of unrelated words do not. Spaces in the query are ignored.
 */
export const matchLabel = (label: string, query: string): { score: number; positions: number[] } | null => {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (!needle) return { score: 0, positions: [] };
  const haystack = label.toLowerCase();
  const wordStart = (index: number) => index === 0 || /[\s:/().,·-]/.test(haystack[index - 1]);
  const positions: number[] = [];
  let at = 0;
  let score = 0;
  for (const character of needle) {
    const previous = positions.at(-1);
    let found = -1;
    if (previous !== undefined && haystack[previous + 1] === character) found = previous + 1;
    else {
      for (let index = at; index < haystack.length; index += 1) {
        if (haystack[index] === character && wordStart(index)) { found = index; break; }
      }
    }
    if (found < 0) return null;
    score += found === (previous ?? -2) + 1 ? 5 : wordStart(found) ? 3 : 1;
    positions.push(found);
    at = found + 1;
  }
  // The earlier the match starts and the shorter the label, the likelier it is the one meant.
  return { score: score - positions[0] * 0.1 - haystack.length * 0.02, positions };
};

/** The prefix that turns quick open into the command palette, as in VS Code. */
export const COMMAND_PREFIX = ">";

/**
 * Commands matching `query`, best first. The label is matched loosely, as file names are,
 * and is what gets highlighted; a keyword has to contain the query, and lists the command
 * below the label hits.
 * With nothing typed the given order stands, which is the order the commands were written in.
 */
export const matchCommands = <T extends PaletteCommand>(commands: T[], query: string) => {
  const needle = query.trim();
  return commands
    .map((command, order) => {
      const byLabel = matchLabel(command.label, needle);
      // Keywords are a bag of words, where scattered letters match nearly anything, so a
      // keyword has to contain what was typed outright.
      const byKeyword = !byLabel && needle && command.keywords?.toLowerCase().includes(needle.toLowerCase());
      const match = byLabel ?? (byKeyword ? { score: needle.length, positions: [] as number[] } : null);
      return match && { command, positions: match.positions, score: match.score - (command.disabled ? 50 : 0), order };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((left, right) => needle ? right.score - left.score || left.order - right.order : left.order - right.order);
};

// --- The built-in terminal ------------------------------------------------------------------

export type TerminalKey = Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "code" | "key">;

/**
 * Keys typed into the terminal that belong to the editor instead: on macOS every ⌘
 * shortcut (the shell uses Control), and everywhere the two that reach the terminal
 * itself — Ctrl+` and the command palette. Everything else is the shell's: Ctrl+P, Ctrl+N,
 * Ctrl+W and Ctrl+R mean history and line editing there, not the editor's commands.
 */
export const terminalKeyIsEditors = (event: TerminalKey, mac: boolean) =>
  (mac && event.metaKey)
  || (event.ctrlKey && !event.altKey && event.code === "Backquote")
  || ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "p");

// --- Judge verdicts as they are shown -------------------------------------------------------

export type VerdictTone = "accepted" | "partial" | "rejected" | "pending";

/** `SCORE 94/100`, the way a judge with partial scoring reports a submission. */
const scoreOf = (status: string) => {
  const match = /^SCORE\s+(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/i.exec(status.trim());
  return match ? { got: Number(match[1]), max: Number(match[2]), text: `${match[1]}/${match[2]}` } : null;
};

/** Accepted, including a full score. */
export const verdictAccepted = (status: string | undefined) => {
  if (!status) return false;
  const score = scoreOf(status);
  return score ? score.max > 0 && score.got >= score.max : status === "AC" || status === "OK";
};

/**
 * A verdict as the editor shows it. A score reads like any other verdict: the full score is
 * AC and nothing is WA, while anything between is PAC with the score kept beside it, since
 * that number is what tells one partial answer from another.
 */
export const verdictView = (status: string | undefined): { text: string; tone: VerdictTone; title: string } => {
  const raw = (status ?? "").trim();
  const score = scoreOf(raw);
  if (score) {
    if (score.max > 0 && score.got >= score.max) return { text: "AC", tone: "accepted", title: score.text };
    if (score.got <= 0) return { text: "WA", tone: "rejected", title: score.text };
    return { text: `PAC ${score.text}`, tone: "partial", title: score.text };
  }
  if (raw === "AC" || raw === "OK") return { text: raw, tone: "accepted", title: raw };
  // Still being judged: WJ, TESTING, or AtCoder's running count 12/34.
  if (/^(WJ|WR|JUDGING|TESTING|IN QUEUE)$/i.test(raw) || /^\d+\s*\/\s*\d+/.test(raw)) return { text: raw, tone: "pending", title: raw };
  return { text: raw, tone: "rejected", title: raw };
};

// --- Contest mode for a contest just imported ----------------------------------------------

export type ContestSchedule = { startMs: number; endMs: number; windowMinutes?: number | null };
export type ContestPlan = { startedAt: number; durationMin: number } | { skip: "unknown" | "upcoming" | "ended" };

/**
 * How contest mode starts for a contest imported at `now`. A running contest keeps the judge's
 * own clock, so the time left is the contest's; one taken in personal windows starts its window
 * now, but never past the contest's end. A contest that is over is practice, and one not yet
 * begun has nothing to import, so neither starts the clock.
 */
export const contestPlan = (schedule: ContestSchedule | null, now: number): ContestPlan => {
  if (!schedule) return { skip: "unknown" };
  if (now >= schedule.endMs) return { skip: "ended" };
  if (now < schedule.startMs) return { skip: "upcoming" };
  if (schedule.windowMinutes) {
    const left = Math.floor((schedule.endMs - now) / 60_000);
    return { startedAt: now, durationMin: Math.max(1, Math.min(schedule.windowMinutes, left)) };
  }
  return { startedAt: schedule.startMs, durationMin: Math.max(1, Math.round((schedule.endMs - schedule.startMs) / 60_000)) };
};

/** The one folder every imported file went into, or null when they are spread or at the workspace root. */
export const commonFolder = (filenames: string[]) => {
  const parents = new Set(filenames.map((name) => name.replace(/\\/g, "/").split("/").slice(0, -1).join("/")));
  const [only] = parents;
  return parents.size === 1 && only ? only : null;
};

