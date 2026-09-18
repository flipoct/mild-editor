/**
 * Comparing a program's output with the expected output.
 *
 * Lines are compared exactly, as before. With a tolerance set, a line that differs is given a
 * second chance: token by token, and a pair of tokens passes when both are decimals within
 * the tolerance, absolutely or relatively — the rule judges state as "an absolute or relative
 * error of at most 1e-6". Integers never take that path, so `7` against `9` stays wrong and a
 * problem without decimals is judged exactly as it was.
 */

export type DiffRow = { line: number; expected: string | null; actual: string | null; same: boolean; whitespaceOnly: boolean };

export const DEFAULT_FLOAT_TOLERANCE = 1e-6;

export const normalize = (value: string) => value.replace(/\r\n/g, "\n").trimEnd();

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/** A decimal point or an exponent: what tells `0.5` from the integer `5`. */
const DECIMAL = /[.eE]/;

const tokensMatch = (expected: string, actual: string, tolerance: number) => {
  if (expected === actual) return true;
  if (!NUMBER.test(expected) || !NUMBER.test(actual)) return false;
  // The expected output decides whether the answer is a real number at all.
  if (!DECIMAL.test(expected)) return false;
  const want = Number(expected);
  const got = Number(actual);
  if (!Number.isFinite(want) || !Number.isFinite(got)) return false;
  const error = Math.abs(want - got);
  return error <= tolerance || error <= tolerance * Math.abs(want);
};

/** `tolerance` of 0 or less means exact comparison. */
export const linesMatch = (expected: string, actual: string, tolerance: number) => {
  if (expected === actual) return true;
  if (!(tolerance > 0)) return false;
  // Spacing stays as strict as it always was; only the numbers get the leeway.
  if (expected.replace(/\S+/g, "x") !== actual.replace(/\S+/g, "x")) return false;
  const want = expected.trim().split(/\s+/);
  const got = actual.trim().split(/\s+/);
  return want.length === got.length && want.every((token, index) => tokensMatch(token, got[index], tolerance));
};

export const outputsMatch = (expected: string, actual: string, tolerance: number) => {
  const want = normalize(expected);
  const got = normalize(actual);
  if (want === got) return true;
  if (!(tolerance > 0)) return false;
  const left = want.split("\n");
  const right = got.split("\n");
  return left.length === right.length && left.every((line, index) => linesMatch(line, right[index], tolerance));
};

export const diffLines = (expected: string, actual: string, tolerance: number): DiffRow[] => {
  const left = normalize(expected).split("\n");
  const right = normalize(actual).split("\n");
  const rows: DiffRow[] = [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const expectedLine = index < left.length ? left[index] : null;
    const actualLine = index < right.length ? right[index] : null;
    const same = expectedLine !== null && actualLine !== null && linesMatch(expectedLine, actualLine, tolerance);
    rows.push({
      line: index + 1,
      expected: expectedLine,
      actual: actualLine,
      same,
      // The classic contest trap: identical tokens, different spacing.
      whitespaceOnly: !same && (expectedLine ?? "").replace(/\s+/g, "") === (actualLine ?? "").replace(/\s+/g, ""),
    });
  }
  return rows;
};

/** Splits a flags field the way a shell would split plain words; quotes keep a space inside one flag. */
export const splitFlags = (value: string): string[] => {
  const flags: string[] = [];
  for (const match of value.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const flag = match[1] ?? match[2] ?? match[3];
    if (flag) flags.push(flag);
  }
  return flags;
};
