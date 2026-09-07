export type TemplateContext = {
  source: string;
  filename: string;
  title: string;
  url?: string;
  now?: Date;
};

const pad = (value: number) => String(value).padStart(2, "0");

/** `2026-09-06`, read off the machine's own clock rather than UTC. */
const localDate = (now: Date) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

const localTime = (now: Date) => `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

/** `+09:00` for KST. getTimezoneOffset counts the other way, hence the negation. */
const utcOffset = (now: Date) => {
  const minutes = -now.getTimezoneOffset();
  return `${minutes < 0 ? "-" : "+"}${pad(Math.trunc(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
};

export const renderTemplateWithCursor = (template: string, context: TemplateContext) => {
  const now = context.now || new Date();
  // A file header records when the author wrote it, so every one of these is local
  // time. `toISOString` is UTC, which put the stamp nine hours behind in Korea and,
  // between midnight and 09:00, dated the file to the previous day while the
  // separate `time` value already read local — the two disagreed inside one header.
  const localTimestamp = `${localDate(now)}T${localTime(now)}${utcOffset(now)}`;
  const values: Record<string, string> = {
    timestamp: localTimestamp,
    createdAt: localTimestamp,
    date: localDate(now),
    time: localTime(now),
    filename: context.filename,
    title: context.title,
    url: context.url || "",
    platform: context.source,
  };
  const rendered = template
    .replace(/\$\{(timestamp|createdAt|date|time|filename|title|url|platform)\}/g, (_, key: string) => values[key])
    .replace(/\[\[(timestamp|createdAt|date|time|filename|title|url|platform)\]\]/g, (_, key: string) => values[key]);
  const cursorOffsets = [rendered.indexOf("${cursor}"), rendered.indexOf("[[cursor]]")].filter((offset) => offset >= 0);
  const cursorOffset = cursorOffsets.length ? Math.min(...cursorOffsets) : -1;
  return {
    code: rendered.replaceAll("${cursor}", "").replaceAll("[[cursor]]", ""),
    cursorOffset: cursorOffset >= 0 ? cursorOffset : undefined,
  };
};
