/**
 * A quick check of the pure naming rules, run with
 * `node --experimental-strip-types src/fileNaming.check.ts`.
 */
import { fileForProblemPage, findStressCompanion, fuzzyMatch, sameProblem, sourceOfUrl, stressCompanionName } from "./fileNaming.ts";

let failed = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed += 1; console.log("FAIL", label, "\n  got ", got, "\n  want", want); }
  else console.log("ok   ", label, "->", JSON.stringify(got));
};

// --- naming the helpers after the problem -------------------------------------------
eq("brute beside a root file", stressCompanionName("A_Sum.cpp", "reference", "cpp"), "A_Sum_bruteforce.cpp");
eq("generator in python", stressCompanionName("A_Sum.py", "generator", "python"), "A_Sum_generator.py");
eq("keeps the problem's folder", stressCompanionName("atcoder/ABC474/B_Exit_Order.cpp", "generator", "cpp"), "atcoder/ABC474/B_Exit_Order_generator.cpp");
eq("non-ascii names", stressCompanionName("5_5_레몬_경로.cpp", "reference", "cpp"), "5_5_레몬_경로_bruteforce.cpp");
eq("opened on a helper resolves back to the pair", stressCompanionName("A_Sum_bruteforce.cpp", "generator", "cpp"), "A_Sum_generator.cpp");

// --- finding one that is already there ----------------------------------------------
const files = [
  { filename: "atcoder/ABC474/B_Exit_Order.cpp" },
  { filename: "atcoder/ABC474/B_Exit_Order_generator.py" },  // written in another language
  { filename: "atcoder/ABC474/B_Exit_Order_BruteForce.cc" }, // another case and extension
  { filename: "other/B_Exit_Order_generator.cpp" },          // right name, wrong folder
];
const solution = "atcoder/ABC474/B_Exit_Order.cpp";
eq("finds a .py generator", findStressCompanion(files, solution, "generator")?.filename, "atcoder/ABC474/B_Exit_Order_generator.py");
eq("finds a .cc brute whatever its case", findStressCompanion(files, solution, "reference")?.filename, "atcoder/ABC474/B_Exit_Order_BruteForce.cc");
eq("does not reach into another folder", findStressCompanion(files, "C_Other.cpp", "generator"), undefined);
eq("no helper yet", findStressCompanion([files[0]], solution, "generator"), undefined);

// --- quick open ----------------------------------------------------------------------
eq("no match", fuzzyMatch("A_Sum.cpp", "zzz"), null);
eq("marks the characters it caught", fuzzyMatch("A_Sum.cpp", "sum")?.positions, [2, 3, 4]);
const rank = (query: string, paths: string[]) => paths
  .map((path) => ({ path, score: fuzzyMatch(path, query)?.score ?? -Infinity }))
  .sort((left, right) => right.score - left.score)[0].path;
eq("the filename beats a folder that also matches", rank("sum", ["sums/other/B_Exit.cpp", "atcoder/A_Sum.cpp"]), "atcoder/A_Sum.cpp");
eq("a whole word beats scattered letters", rank("abc", ["a_b_c_other.cpp", "abc474.cpp"]), "abc474.cpp");
eq("shorter wins when equal", rank("b", ["b.cpp", "b_something_long_here.cpp"]), "b.cpp");

// --- a problem page opened in the browser finds its file -------------------------------------
const saved = [
  { filename: "AtCoder/abc300/A.py", source: "atcoder", sourceUrl: "https://atcoder.jp/contests/abc300/tasks/abc300_a" },
  { filename: "Codeforces/B.cpp", source: "codeforces", sourceUrl: "https://codeforces.com/problemset/problem/1900/B" },
  { filename: "DOJ/1234.py", source: "doj", sourceUrl: "https://doj.kr/ko/problems/1234" },
  { filename: "scratch.py" },
];
eq("judge by host", [sourceOfUrl("https://atcoder.jp/x"), sourceOfUrl("https://www.codeforces.com/x"), sourceOfUrl("https://doj.kr/x"), sourceOfUrl("https://example.org"), sourceOfUrl("nonsense")], ["atcoder", "codeforces", "doj", "other", "other"]);
eq("the same task page", fileForProblemPage(saved, "https://atcoder.jp/contests/abc300/tasks/abc300_a?lang=en")?.filename, "AtCoder/abc300/A.py");
eq("a Codeforces problem under its contest address", fileForProblemPage(saved, "https://codeforces.com/contest/1900/problem/B")?.filename, "Codeforces/B.cpp");
eq("a DOJ problem from inside a contest", fileForProblemPage(saved, "https://doj.kr/ko/contests/77/problems/1234")?.filename, "DOJ/1234.py");
eq("another problem of the contest is not it", fileForProblemPage(saved, "https://atcoder.jp/contests/abc300/tasks/abc300_b"), undefined);
eq("the contest's own page is no problem", fileForProblemPage(saved, "https://atcoder.jp/contests/abc300"), undefined);
eq("nor its submissions", fileForProblemPage(saved, "https://atcoder.jp/contests/abc300/submissions/me"), undefined);
eq("a DOJ contest whose number is some problem's", fileForProblemPage([{ filename: "x.py", source: "doj", sourceUrl: "https://doj.kr/ko/problems/77" }], "https://doj.kr/ko/contests/77"), undefined);
eq("a page elsewhere", fileForProblemPage(saved, "https://example.org/problems/1234"), undefined);
eq("same problem, other address", sameProblem("codeforces", "https://codeforces.com/problemset/problem/1900/B", "https://codeforces.com/contest/1900/problem/b"), true);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
if (failed) throw new Error(`${failed} naming checks failed`);
