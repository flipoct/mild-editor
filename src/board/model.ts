/**
 * A drawing board: what is on it, as data. Nothing here draws or listens; the canvas
 * (canvas.ts), the board's document (boardDoc.ts) and the tablet page (src/pad) all build on
 * these, and `model.check.ts` checks them without a browser.
 *
 * A board is a list of strokes, the later over the earlier. A stroke is a pen line: a colour,
 * a width and its points, flat (`[x0, y0, x1, y1, …]`), in board units — one unit is one CSS
 * pixel at 100 %. The board has no edges; every view pans and zooms over it on its own.
 */

/** Pen colours by name: each view picks the shade that reads on its own background. */
export const INKS = ["ink", "red", "blue", "green", "orange", "purple"] as const;
export type Ink = (typeof INKS)[number];

/** The shade of each ink on a light board and on a dark one. */
export const INK_SHADES: Record<Ink, { light: string; dark: string }> = {
  ink: { light: "#1f2328", dark: "#eceae4" },
  red: { light: "#d1242f", dark: "#ff7b72" },
  blue: { light: "#0969da", dark: "#6cb6ff" },
  green: { light: "#1a7f37", dark: "#56d364" },
  orange: { light: "#bc4c00", dark: "#ffa657" },
  purple: { light: "#8250df", dark: "#d2a8ff" },
};

/** Pen widths on offer, in board units. */
export const WIDTHS = [2, 4, 9] as const;

export type Stroke = { id: string; ink: Ink; width: number; points: number[] };

/** At most this much on one board, so a pasted or broken file cannot take the editor down. */
export const MOST_STROKES = 20_000;
export const MOST_POINTS = 40_000;
const FAR = 1e7;

const isInk = (value: unknown): value is Ink => typeof value === "string" && (INKS as readonly string[]).includes(value);

/** A stroke id: short, and made only of what any id this editor makes is made of. */
export const isStrokeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value);

export const newStrokeId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, (byte) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[byte & 63]).join("");
};

/** Points as they may be kept: finite numbers within reach, whole pairs, at most `MOST_POINTS` pairs, rounded to a tenth. */
export const cleanPoints = (value: unknown): number[] | null => {
  if (!Array.isArray(value) || value.length % 2) return null;
  const points: number[] = [];
  for (const number of value.slice(0, MOST_POINTS * 2)) {
    if (typeof number !== "number" || !Number.isFinite(number) || Math.abs(number) > FAR) return null;
    points.push(Math.round(number * 10) / 10);
  }
  return points;
};

export const cleanWidth = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.min(64, Math.max(0.5, value)) : 4;

/** A stroke as it may be kept, or null for anything that is not one. Everything on a board came from somebody else's file or tablet. */
export const cleanStroke = (value: unknown): Stroke | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const points = cleanPoints(raw.points);
  if (!isStrokeId(raw.id) || !points) return null;
  return { id: raw.id, ink: isInk(raw.ink) ? raw.ink : "ink", width: cleanWidth(raw.width), points };
};

/** The strokes of a `.board` file, or an empty board for one that is not a board at all. */
export const parseBoard = (text: string): Stroke[] => {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return []; }
  const strokes = raw && typeof raw === "object" && Array.isArray((raw as { strokes?: unknown }).strokes) ? (raw as { strokes: unknown[] }).strokes : [];
  const seen = new Set<string>();
  return strokes.slice(0, MOST_STROKES).map(cleanStroke).filter((stroke): stroke is Stroke => {
    if (!stroke || seen.has(stroke.id)) return false;
    seen.add(stroke.id);
    return true;
  });
};

/** A board as its file: one stroke a line, so a diff of two versions stays readable. */
export const serializeBoard = (strokes: readonly Stroke[]) =>
  `{"version":1,"strokes":[${strokes.length ? "\n" : ""}${strokes.map((stroke) => JSON.stringify({ id: stroke.id, ink: stroke.ink, width: stroke.width, points: stroke.points })).join(",\n")}${strokes.length ? "\n" : ""}]}\n`;

export const EMPTY_BOARD = serializeBoard([]);

/** The distance from (x, y) to the segment from (ax, ay) to (bx, by). */
const toSegment = (x: number, y: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
};

/** Whether an eraser of `radius` at (x, y) touches the stroke's line, its width counted. */
export const touches = (stroke: Stroke, x: number, y: number, radius: number) => {
  const reach = radius + stroke.width / 2;
  const points = stroke.points;
  if (points.length === 2) return Math.hypot(x - points[0], y - points[1]) <= reach;
  for (let index = 2; index < points.length; index += 2) {
    if (toSegment(x, y, points[index - 2], points[index - 1], points[index], points[index + 1]) <= reach) return true;
  }
  return false;
};

/** What an eraser dragged from (fromX, fromY) to (x, y) rubs out: every stroke it passed over. */
export const erased = (strokes: readonly Stroke[], fromX: number, fromY: number, x: number, y: number, radius: number): string[] => {
  const steps = Math.max(1, Math.ceil(Math.hypot(x - fromX, y - fromY) / Math.max(1, radius / 2)));
  return strokes.filter((stroke) => {
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      if (touches(stroke, fromX + (x - fromX) * t, fromY + (y - fromY) * t, radius)) return true;
    }
    return false;
  }).map((stroke) => stroke.id);
};

export type Bounds = { left: number; top: number; right: number; bottom: number };

/** The box every stroke fits in, widths counted; null for an empty board. */
export const boundsOf = (strokes: readonly Stroke[]): Bounds | null => {
  let bounds: Bounds | null = null;
  for (const stroke of strokes) {
    const half = stroke.width / 2;
    for (let index = 0; index < stroke.points.length; index += 2) {
      const x = stroke.points[index];
      const y = stroke.points[index + 1];
      if (!bounds) bounds = { left: x - half, top: y - half, right: x + half, bottom: y + half };
      else {
        bounds.left = Math.min(bounds.left, x - half);
        bounds.top = Math.min(bounds.top, y - half);
        bounds.right = Math.max(bounds.right, x + half);
        bounds.bottom = Math.max(bounds.bottom, y + half);
      }
    }
  }
  return bounds;
};

export type View = { x: number; y: number; scale: number };

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;
export const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** The view that shows all of `bounds` in a `width` × `height` screen, with a margin, never zoomed past 100 %. */
export const fitView = (bounds: Bounds | null, width: number, height: number, margin = 32): View => {
  if (!bounds || width <= 0 || height <= 0) return { x: 0, y: 0, scale: 1 };
  const contentWidth = Math.max(1, bounds.right - bounds.left);
  const contentHeight = Math.max(1, bounds.bottom - bounds.top);
  const scale = clampScale(Math.min(1, (width - margin * 2) / contentWidth, (height - margin * 2) / contentHeight));
  // Centred: the board point at the screen's top left.
  return { x: (bounds.left + bounds.right) / 2 - width / 2 / scale, y: (bounds.top + bounds.bottom) / 2 - height / 2 / scale, scale };
};

/** The view after zooming by `factor` about the screen point (sx, sy), which stays where it is. */
export const zoomAt = (view: View, factor: number, sx: number, sy: number): View => {
  const scale = clampScale(view.scale * factor);
  const boardX = view.x + sx / view.scale;
  const boardY = view.y + sy / view.scale;
  return { x: boardX - sx / scale, y: boardY - sy / scale, scale };
};

/**
 * Whether a point just under the pen is worth keeping: at least `spacing` screen pixels from
 * the last one kept, so a slow hand does not pile up points nobody can see.
 */
export const farEnough = (lastX: number, lastY: number, x: number, y: number, scale: number, spacing = 1.2) =>
  Math.hypot(x - lastX, y - lastY) * scale >= spacing;
