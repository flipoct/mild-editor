/**
 * A quick check of where a submission goes for each judge, run with
 * `node --experimental-strip-types src/submit.check.ts`.
 */
import { pickLanguageOption, submitTarget } from "./submit.ts";

let failed = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed += 1; console.log("FAIL", label, "\n  got ", got, "\n  want", want); }
  else console.log("ok   ", label, "->", JSON.stringify(got));
};

// --- DOJ: the problem's IDE page --------------------------------------------------------
eq("practice problem", submitTarget("https://doj.kr/ko/problems/1"),
  { judge: "doj", url: "https://doj.kr/ko/problems/1/ide", problemSlug: "1" });
eq("contest problem keeps its contest", submitTarget("https://doj.kr/ko/problems/421?contest=cmt7b6o9w00063827xfnbigsa"),
  { judge: "doj", url: "https://doj.kr/ko/problems/421/ide?contest=cmt7b6o9w00063827xfnbigsa", problemSlug: "421" });
eq("virtual contest problem keeps its category and key", submitTarget("https://doj.kr/ko/problems/550?category=school%2Fsju%2Fsjupc2026&virtual=cmvirtualkey000000000000x"),
  { judge: "doj", url: "https://doj.kr/ko/problems/550/ide?category=school%2Fsju%2Fsjupc2026&virtual=cmvirtualkey000000000000x", problemSlug: "550" });
eq("a virtual contest's page is not a problem", submitTarget("https://doj.kr/ko/categories/school/sju/sjupc2026?virtual=cmvirtualkey000000000000x"), null);
eq("imported from the IDE page itself", submitTarget("https://doj.kr/en/problems/7/ide"),
  { judge: "doj", url: "https://doj.kr/en/problems/7/ide", problemSlug: "7" });
eq("trailing slash", submitTarget("https://www.doj.kr/ko/problems/12/"),
  { judge: "doj", url: "https://www.doj.kr/ko/problems/12/ide", problemSlug: "12" });
eq("not a problem", submitTarget("https://doj.kr/ko/contests/aislop"), null);

// --- the other judges are unchanged -----------------------------------------------------
eq("atcoder", submitTarget("https://atcoder.jp/contests/abc400/tasks/abc400_a"),
  { judge: "atcoder", url: "https://atcoder.jp/contests/abc400/submit?taskScreenName=abc400_a", taskScreenName: "abc400_a" });
eq("codeforces contest", submitTarget("https://codeforces.com/contest/2000/problem/b"),
  { judge: "codeforces", url: "https://codeforces.com/contest/2000/submit", problemIndex: "B" });

// --- DOJ's language list ----------------------------------------------------------------
const dojOptions = (selected: string) => [
  ["cpp17", "C++17"], ["cpp20", "C++20"], ["python3", "Python 3"], ["pypy3", "PyPy 3"], ["java21", "Java 21"],
].map(([value, text]) => ({ value, text, selected: value === selected }));
eq("c++: newest standard", pickLanguageOption(dojOptions("java21"), "cpp"), "cpp20");
eq("c++: keeps the one chosen", pickLanguageOption(dojOptions("cpp17"), "cpp"), "cpp17");
eq("python: pypy", pickLanguageOption(dojOptions("cpp17"), "python"), "pypy3");

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log("\nall passed");
