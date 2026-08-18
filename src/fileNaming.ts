export type SourceLanguage = "cpp" | "python";

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
