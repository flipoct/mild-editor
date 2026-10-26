/**
 * A quick check of how outputs are compared, run with
 * `node --experimental-strip-types src/judge.check.ts`.
 */
import { diffLines, diffView, normalize, outputsMatch } from "./judge.ts";

let failed = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed += 1; console.log("FAIL", label, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); }
  else console.log("ok   ", label);
};

// --- what judges ignore ---------------------------------------------------------------------
eq("a space after the last number of each line", outputsMatch("1 2 3\n4 5\n", "1 2 3 \n4 5 \n", 0), true);
eq("the same, with a float tolerance on", outputsMatch("1.5 2\n3\n", "1.5 2 \n3 \n", 1e-6), true);
eq("Windows line endings", outputsMatch("1\n2\n", "1\r\n2\r\n", 0), true);
eq("old Mac line endings", outputsMatch("1\n2\n", "1\r2\r", 0), true);
eq("blank lines at the end", outputsMatch("yes\n", "yes\n\n\n", 0), true);
eq("tabs at the end of a line", outputsMatch("a\n", "a\t\n", 0), true);

// --- what still counts -----------------------------------------------------------------------
eq("a missing number", outputsMatch("1 2 3\n", "1 2\n", 0), false);
eq("spacing inside a line", outputsMatch("1 2\n", "1  2\n", 0), false);
eq("leading spaces", outputsMatch("x\n", " x\n", 0), false);
eq("a blank line in the middle", outputsMatch("1\n2\n", "1\n\n2\n", 0), false);
eq("numbers out of tolerance", outputsMatch("0.5\n", "0.6\n", 1e-6), false);
eq("numbers in tolerance", outputsMatch("0.5\n", "0.5000001\n", 1e-6), true);

// --- the diff --------------------------------------------------------------------------------
eq("trailing spaces are no difference in the diff either", diffLines("1 2\n", "1 2 \n", 0).every((row) => row.same), true);
eq("inner spacing is still flagged as whitespace-only", diffLines("1 2\n", "1  2\n", 0)[0].whitespaceOnly, true);
const runaway = Array.from({ length: 200_000 }, (_, index) => String(index)).join("\n");
const view = diffView("0\n1\n2\n", runaway, 0);
eq("a runaway output draws only a window of rows", [view.rows.length, view.above, view.below], [400, 0, 199_600]);
const late = diffView(runaway, runaway.replace("\n150000\n", "\nx\n"), 0);
eq("the window starts just before the first difference", [late.rows[0].line, late.rows.find((row) => !row.same)?.line, late.above, late.below], [149_981, 150_001, 149_980, 49_620]);
eq("a short diff is drawn whole", diffView("1\n2\n", "1\n3\n", 0), { rows: diffLines("1\n2\n", "1\n3\n", 0), above: 0, below: 0 });
eq("normalize keeps inner blank lines", normalize("a \r\n\r\nb  \n\n"), "a\n\nb");

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
