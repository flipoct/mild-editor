export type SourceLanguage = "cpp" | "python";

/** A workspace path, always forward slashes and with no leading or trailing one. */
export const normalizedExplorerPath = (path: string) => path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
export const explorerBasename = (path: string) => normalizedExplorerPath(path).split("/").at(-1) || path;
export const explorerParent = (path: string) => normalizedExplorerPath(path).split("/").slice(0, -1).join("/");

export const fileKey = (filename: string) => filename.trim().normalize("NFC").toLocaleLowerCase();

const splitFilename = (filename: string) => {
  const dot = filename.lastIndexOf(".");
  return dot > 0
    ? { stem: filename.slice(0, dot), extension: filename.slice(dot) }
    : { stem: filename, extension: "" };
};

/** Allocate the smallest available browser-style suffix in one extension family. */
export const mexFilename = (requested: string, occupied: Iterable<string>) => {
  const clean = requested.trim();
  const used = new Set(Array.from(occupied, fileKey));
  if (!used.has(fileKey(clean))) return clean;

  const { stem, extension } = splitFilename(clean);
  const base = stem.replace(/ \([1-9]\d*\)$/, "");
  for (let number = 1; ; number += 1) {
    const candidate = `${base} (${number})${extension}`;
    if (!used.has(fileKey(candidate))) return candidate;
  }
};

const safeWords = (value: string) => value.match(/[\p{L}\p{N}]+/gu) || [];

const safeStem = (value: string) => {
  const joined = safeWords(value).join("_").replace(/^_+|_+$/g, "");
  const stem = joined || "problem";
  // Windows device names are invalid even when an extension is present.
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem) ? `_${stem}` : stem;
};

/** CPH-style readable name: problem index + sanitized title words. */
export const importedFilename = (
  title: string,
  suggestedFilename: string,
  language: SourceLanguage,
) => {
  const extension = language === "python" ? ".py" : ".cpp";
  const suggestedStem = splitFilename(suggestedFilename).stem;
  const index = safeStem(suggestedStem);
  const escapedIndex = suggestedStem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const titleWithoutIndex = title
    .replace(new RegExp(`^\\s*${escapedIndex}\\s*(?:[.:-]|\\s+-\\s+)\\s*`, "iu"), "")
    .trim();
  const titleStem = safeStem(titleWithoutIndex);
  const combined = titleStem === "problem" || fileKey(titleStem) === fileKey(index)
    ? index
    : `${index}_${titleStem}`;
  // Leave ample room for Windows paths and the MEX suffix.
  return `${combined.slice(0, 96).replace(/_+$/g, "") || "problem"}${extension}`;
};

export const problemIdentity = (source: string | undefined, rawUrl: string | undefined) => {
  if (!rawUrl) return "";
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    if (source === "codeforces") {
      const contestAt = parts.indexOf("contest");
      const problemsetAt = parts.indexOf("problemset");
      if (contestAt >= 0 && parts[contestAt + 1] && parts[contestAt + 3]) return `codeforces:${parts[contestAt + 1]}:${parts[contestAt + 3].toUpperCase()}`;
      if (problemsetAt >= 0 && parts[problemsetAt + 2] && parts[problemsetAt + 3]) return `codeforces:${parts[problemsetAt + 2]}:${parts[problemsetAt + 3].toUpperCase()}`;
    }
    if (source === "atcoder") {
      const tasksAt = parts.indexOf("tasks");
      if (tasksAt >= 0 && parts[tasksAt + 1]) return `atcoder:${parts[tasksAt + 1].toLocaleLowerCase()}`;
    }
    if (source === "doj") {
      const id = [...parts].reverse().find((part) => /^\d+$/.test(part));
      if (id) return `doj:${id}`;
    }
    url.search = "";
    url.hash = "";
    return `${source || "other"}:${url.toString().replace(/\/$/, "").toLocaleLowerCase()}`;
  } catch {
    return `${source || "other"}:${rawUrl.trim().replace(/\/$/, "").toLocaleLowerCase()}`;
  }
};

/**
 * Folder layout for imports, used when "file imports into folders" is on.
 *
 * A single problem goes straight into its judge's folder; a contest gets a folder of its
 * own inside it, so `Codeforces/Codeforces Round 1117 (Div. 2)/A_Watermelon.py` sits beside
 * `Codeforces/B_Spreadsheets.py`.
 */
const platformFolders: Record<string, string> = {
  atcoder: "AtCoder",
  codeforces: "Codeforces",
  doj: "DOJ",
};

export const platformFolder = (source: string | undefined) => platformFolders[source || ""] || "Other";

/** Trim what a folder name may not hold, on any of the three platforms. */
const safeFolderName = (value: string) =>
  value
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Windows drops a trailing dot or space, which would not match what was asked for.
    .replace(/[.\s]+$/g, "")
    .slice(0, 64)
    .trim();

/** The contest id in a problem URL, for imports that arrive without a contest name. */
const contestFromUrl = (source: string | undefined, rawUrl: string) => {
  try {
    const parts = new URL(rawUrl).pathname.split("/").filter(Boolean);
    if (source === "atcoder") {
      const at = parts.indexOf("contests");
      return at >= 0 ? parts[at + 1] || "" : "";
    }
    if (source === "codeforces") {
      const at = parts.indexOf("contest");
      return at >= 0 ? parts[at + 1] || "" : "";
    }
    return "";
  } catch {
    return "";
  }
};

/**
 * `group` is what Competitive Companion sends, e.g. "Codeforces - Codeforces Round 1117
 * (Div. 2)". The judge's own name in front of it is dropped: the folder already sits inside
 * that judge's folder.
 */
export const contestFolder = (source: string | undefined, sourceUrl: string, group?: string) => {
  const named = (group || "").split(" - ").slice(1).join(" - ").trim() || (group || "").trim();
  return safeFolderName(named || contestFromUrl(source, sourceUrl));
};

/**
 * Where an imported problem is filed. Empty for the flat layout, so callers can prefix
 * unconditionally.
 */
export const importFolder = (
  organize: boolean,
  contestImport: boolean,
  problem: { source?: string; sourceUrl: string; contest?: string },
) => {
  if (!organize) return "";
  const platform = platformFolder(problem.source);
  const contest = contestImport ? contestFolder(problem.source, problem.sourceUrl, problem.contest) : "";
  return contest ? `${platform}/${contest}/` : `${platform}/`;
};

/** Which of the two helpers a counterexample search needs. */
export type StressRole = "generator" | "reference";

/**
 * The two helpers are named after the problem they belong to, so they sit beside it in the
 * explorer and are obvious a month later: `B_Exit_Order_generator.cpp` next to
 * `B_Exit_Order.cpp`. Opening the dialog on a helper resolves back to the problem's pair
 * rather than naming a helper after a helper.
 */
export const STRESS_SUFFIX: Record<StressRole, string> = { generator: "_generator", reference: "_bruteforce" };
export const stressStem = (filename: string) => explorerBasename(filename).replace(/\.[^.]+$/, "").replace(/_(generator|bruteforce)$/i, "");
export const stressCompanionName = (solution: string, role: StressRole, language: SourceLanguage) => {
  const parent = explorerParent(solution);
  const leaf = `${stressStem(solution)}${STRESS_SUFFIX[role]}${language === "python" ? ".py" : ".cpp"}`;
  return parent ? `${parent}/${leaf}` : leaf;
};

/** An existing helper for this problem, whatever extension it was written in. */
export const findStressCompanion = <T extends { filename: string }>(files: T[], solution: string, role: StressRole) => {
  const parent = fileKey(explorerParent(solution));
  const wanted = fileKey(`${stressStem(solution)}${STRESS_SUFFIX[role]}`);
  return files.find((file) => fileKey(explorerParent(file.filename)) === parent
    && fileKey(explorerBasename(file.filename).replace(/\.[^.]+$/, "")) === wanted);
};

/**
 * Scores `query` against a path the way a quick-open field is expected to: every typed
 * character has to appear in order, and a run of them landing together, or on the start of
 * the basename, scores better than the same characters scattered. Returns the matched
 * positions so the row can show what the typing caught, or null when it does not match.
 */
export const fuzzyMatch = (path: string, query: string): { score: number; positions: number[] } | null => {
  if (!query) return { score: 0, positions: [] };
  const haystack = path.toLowerCase();
  const needle = query.toLowerCase().replace(/\s+/g, "");
  const positions: number[] = [];
  let at = 0;
  let score = 0;
  let run = 0;
  // Everything after the last separator is the filename, which is what people type.
  const basenameStart = haystack.lastIndexOf("/") + 1;
  for (const character of needle) {
    const found = haystack.indexOf(character, at);
    if (found < 0) return null;
    run = found === at && positions.length ? run + 1 : 0;
    score += 1 + run * 4;
    if (found === basenameStart) score += 12;
    else if (found >= basenameStart) score += 3;
    if (found > 0 && /[^a-z0-9]/.test(haystack[found - 1])) score += 6;
    positions.push(found);
    at = found + 1;
  }
  // A short path that matched is likelier to be the one meant than a long one.
  return { score: score - haystack.length * 0.05, positions };
};
