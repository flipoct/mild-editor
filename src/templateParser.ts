export type TemplateContext = {
  source: string;
  filename: string;
  title: string;
  url?: string;
  now?: Date;
};

export const renderTemplateWithCursor = (template: string, context: TemplateContext) => {
  const now = context.now || new Date();
  const values: Record<string, string> = {
    timestamp: now.toISOString(),
    createdAt: now.toISOString(),
    date: now.toISOString().slice(0, 10),
    time: now.toTimeString().slice(0, 8),
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
