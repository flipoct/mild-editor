/**
 * A quick check of the pure naming rules, run with
 * `node --experimental-strip-types src/fileNaming.check.ts`.
 */
import { findStressCompanion, fuzzyMatch, stressCompanionName } from "./fileNaming.ts";

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

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
if (failed) throw new Error(`${failed} naming checks failed`);
