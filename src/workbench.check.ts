/**
 * A quick check of the test-panel and palette rules, run with
 * `node --experimental-strip-types src/workbench.check.ts`.
 */
import { isHelperFile, findStressCompanion, stressCompanionName, stressStem } from "./fileNaming.ts";
import { autoSaveEnabled, checkerStarter, checkerStatus, matchCommands, matchLabel, summarizeTests, terminalKeyIsEditors, verdictAccepted, verdictView } from "./workbench.ts";

let failed = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed += 1; console.log("FAIL", label, "\n  got ", got, "\n  want", want); }
  else console.log("ok   ", label, "->", JSON.stringify(got));
};

const tests = [
  { id: 1, status: "ac", timeMs: 12 },
  { id: 4, status: "wa", timeMs: 30 },
  { id: 7, status: "idle" },
  { id: 9, status: "tle", timeMs: 2000 },
  { id: 11, status: "stopped" },
];

// --- the heading summary -----------------------------------------------------------------
eq("judged tests only, out of all", summarizeTests(tests), { passed: 1, judged: 3, total: 5, slowestMs: 2000, tone: "fail" });
eq("tests added since the run keep it amber", summarizeTests([{ status: "ac", timeMs: 5 }, { status: "idle" }, { status: "idle" }]), { passed: 1, judged: 1, total: 3, slowestMs: 5, tone: "partial" });
eq("every test passed", summarizeTests([{ status: "ac", timeMs: 5 }, { status: "ac", timeMs: 9 }]).tone, "pass");
eq("an edited test keeps it from reading clean", summarizeTests([{ status: "ac" }, { status: "ac" }, { status: "idle" }]).tone, "partial");
eq("nothing run yet", summarizeTests([{ status: "idle" }, { status: "running" }]), { passed: 0, judged: 0, total: 2, slowestMs: null, tone: "idle" });
eq("a compile error counts against", summarizeTests([{ status: "ce" }]).tone, "fail");

// --- the checker helper ------------------------------------------------------------------
eq("checker named after the problem", stressCompanionName("Codeforces/Round 1/B_Paths.cpp", "checker", "cpp"), "Codeforces/Round 1/B_Paths_checker.cpp");
eq("checker in python", stressCompanionName("A.py", "checker", "python"), "A_checker.py");
eq("a checker resolves back to its problem", stressStem("B_Paths_checker.cpp"), "B_Paths");
eq("a checker is a helper", isHelperFile("x/B_Paths_checker.py"), true);
eq("so are the search helpers", [isHelperFile("A_generator.cpp"), isHelperFile("A_bruteforce.py")], [true, true]);
eq("a problem is not", [isHelperFile("A_Sum.cpp"), isHelperFile("checkers.cpp"), isHelperFile("A_checker_v2.cpp")], [false, false, false]);
const files = [{ filename: "dir/B_Paths.cpp" }, { filename: "dir/B_Paths_checker.py" }, { filename: "B_Paths_checker.cpp" }];
eq("the checker beside the problem, in any language", findStressCompanion(files, "dir/B_Paths.cpp", "checker")?.filename, "dir/B_Paths_checker.py");
eq("not one from another folder", findStressCompanion(files, "other/B_Paths.cpp", "checker"), undefined);
for (const language of ["cpp", "python"] as const) {
  const starter = checkerStarter(language, "B Paths");
  eq(`${language} starter names the problem and the contract`, [starter.includes("B Paths"), starter.includes("<input file> <output file> <answer file>"), starter.includes("Exit 3")], [true, true, true]);
}

// --- the palette ---------------------------------------------------------------------------
const commands = [
  { id: "run", label: "Run tests", keywords: "execute 실행 테스트", shortcut: "Ctrl+Enter" },
  { id: "failed", label: "Run the interactive panel", keywords: "rerun", disabled: true },
  { id: "submit", label: "Submit", keywords: "제출 judge" },
  { id: "theme-nord", label: "Theme: Nord", keywords: "colour color 테마" },
];
eq("nothing typed keeps the written order", matchCommands(commands, "").map((row) => row.command.id), ["run", "failed", "submit", "theme-nord"]);
eq("label matches rank first", matchCommands(commands, "run").map((row) => row.command.id), ["run", "failed"]);
eq("a keyword finds it in the other language", matchCommands(commands, "제출").map((row) => row.command.id), ["submit"]);
eq("keyword hits carry no highlight", matchCommands(commands, "테마")[0]?.positions, []);
eq("label highlight positions", matchCommands(commands, "sub")[0]?.positions, [0, 1, 2]);
eq("no match, no rows", matchCommands(commands, "zzz"), []);
eq("scattered letters do not match keywords", matchCommands([{ id: "contest", label: "Open the contest board", keywords: "contest timer board" }, { id: "nord", label: "Theme: Nord" }], "nord").map((row) => row.command.id), ["nord"]);
eq("a keyword word does", matchCommands([{ id: "contest", label: "컨테스트 보드 열기", keywords: "contest timer board" }], "timer").map((row) => row.command.id), ["contest"]);
eq("disabled sinks below an equal enabled match", matchCommands([{ id: "a", label: "Stop", disabled: true }, { id: "b", label: "Stop" }], "stop").map((row) => row.command.id), ["b", "a"]);

eq("word starts", matchLabel("Run failed tests", "rft")?.positions, [0, 4, 11]);
eq("a run of letters", matchLabel("Theme: Nord", "nor")?.positions, [7, 8, 9]);
eq("not from the middle of words", matchLabel("Open the contest board", "nord"), null);
eq("korean word starts", matchLabel("저지에 제출", "제출")?.positions, [4, 5]);
eq("korean particles do not start a word", matchLabel("실패한 테스트만 다시 실행", "만"), null);
eq("spaces in the query are ignored", matchLabel("Run all tests", "run all")?.positions, [0, 1, 2, 4, 5, 6]);
const ranked = matchCommands([{ id: "refresh", label: "제출 결과 새로고침" }, { id: "submit", label: "저지에 제출" }], "제출").map((row) => row.command.id);
eq("both submit commands found", ranked.length, 2);
// --- what a checker's answer makes of a test --------------------------------------------
eq("accepted", checkerStatus({ accepted: true, failed: false, message: "" }), "ac");
eq("rejected", checkerStatus({ accepted: false, failed: false, message: "wrong set" }), "wa");
eq("a checker that failed is not a wrong answer", checkerStatus({ accepted: false, failed: true, message: "" }), "re");

// --- auto save is on unless turned off -----------------------------------------------------
eq("nothing stored yet", autoSaveEnabled(null), true);
eq("turned on", autoSaveEnabled("1"), true);
eq("turned off", autoSaveEnabled("0"), false);

// --- keys in the terminal ------------------------------------------------------------------
const press = (key: string, code: string, modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}) =>
  ({ key, code, ctrlKey: Boolean(modifiers.ctrl), metaKey: Boolean(modifiers.meta), shiftKey: Boolean(modifiers.shift), altKey: Boolean(modifiers.alt) });
for (const mac of [true, false]) {
  const where = mac ? "macOS" : "Windows";
  eq(`${where}: Ctrl+P is the shell's history`, terminalKeyIsEditors(press("p", "KeyP", { ctrl: true }), mac), false);
  eq(`${where}: Ctrl+W deletes a word in the shell`, terminalKeyIsEditors(press("w", "KeyW", { ctrl: true }), mac), false);
  eq(`${where}: Ctrl+R searches the shell's history`, terminalKeyIsEditors(press("r", "KeyR", { ctrl: true }), mac), false);
  eq(`${where}: Ctrl+\` toggles the terminal`, terminalKeyIsEditors(press("`", "Backquote", { ctrl: true }), mac), true);
  eq(`${where}: Ctrl+\` on a Korean layout (₩)`, terminalKeyIsEditors(press("₩", "Backquote", { ctrl: true }), mac), true);
  eq(`${where}: the palette`, terminalKeyIsEditors(press("P", "KeyP", { ctrl: !mac, meta: mac, shift: true }), mac), true);
  eq(`${where}: plain typing`, terminalKeyIsEditors(press("a", "KeyA"), mac), false);
}
eq("macOS: every ⌘ shortcut is the editor's", terminalKeyIsEditors(press("w", "KeyW", { meta: true }), true), true);
eq("Windows: the Windows key is not", terminalKeyIsEditors(press("w", "KeyW", { meta: true }), false), false);

// --- verdicts as shown ------------------------------------------------------------------------
eq("partial score is PAC with the score", verdictView("SCORE 94/100"), { text: "PAC 94/100", tone: "partial", title: "94/100" });
eq("full score is AC", verdictView("SCORE 100/100").text, "AC");
eq("zero is WA", verdictView("SCORE 0/100"), { text: "WA", tone: "rejected", title: "0/100" });
eq("decimal scores", verdictView("SCORE 12.5/50").text, "PAC 12.5/50");
eq("plain verdicts stay", [verdictView("AC").tone, verdictView("WA").text, verdictView("TLE").tone], ["accepted", "WA", "rejected"]);
eq("still judging", [verdictView("WJ").tone, verdictView("3/12").tone], ["pending", "pending"]);
eq("a full score counts as solved", [verdictAccepted("SCORE 100/100"), verdictAccepted("SCORE 94/100"), verdictAccepted("AC"), verdictAccepted(undefined)], [true, false, true, false]);

console.log(failed ? `\n${failed} failed` : "\nall passed");
if (failed) process.exit(1);
