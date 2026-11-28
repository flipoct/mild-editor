/**
 * A drawing board: what is on it, as data. Nothing here draws or listens; the canvas
 * (canvas.ts), the board's document (boardDoc.ts) and the tablet page (src/pad) all build on
 * these, and `board.check.ts` checks them without a browser.
 *
 * A board is a list of elements, the later over the earlier — except that writing (`text`) is
 * always drawn over everything else. One board unit is one CSS pixel at 100 %; the board has no
 * edges, and every view pans and zooms over it on its own.
 *
 * - `pen`: a hand-drawn line. `points` is flat, three numbers a point — x and y from the
 *   element's (x, y), and the pen's pressure. `hl` makes it a highlighter.
 * - `text`: writing, where `$…$` and `$$…$$` are formulas (KaTeX). Its size is measured where
 *   it is shown (`textSizes`), since only a browser knows how wide letters are.
 * - `image`: a picture, kept beside the elements in the board's `assets` by content id.
 * - `rect`, `ellipse`: a box, with an outline and maybe a fill.
 * - `line`, `arrow`: from (x, y) to (x2, y2).
 *
 * Everything but lines may be turned (`angle`, radians, about its box's centre).
 */

// ── Colours ──────────────────────────────────────────────────────────────────────────────────

/** Colours by name: each view picks the shade that reads on its own background. */
export const COLORS = ["ink", "gray", "red", "orange", "yellow", "green", "blue", "violet", "pink"] as const;
export type Color = (typeof COLORS)[number];
export type Fill = Color | "none";

/** Each colour as a line and as a fill, on a light board and on a dark one. */
export const PALETTE: Record<Color, { stroke: [light: string, dark: string]; fill: [light: string, dark: string] }> = {
  ink: { stroke: ["#1e1e1e", "#e9e9e6"], fill: ["#e9ecef", "#3a3a38"] },
  gray: { stroke: ["#868e96", "#9aa2aa"], fill: ["#dee2e6", "#4a4d50"] },
  red: { stroke: ["#e03131", "#ff8787"], fill: ["#ffc9c9", "#6b2a2a"] },
  orange: { stroke: ["#f08c00", "#ffb84d"], fill: ["#ffe8b3", "#6b4a14"] },
  yellow: { stroke: ["#f5c211", "#ffe066"], fill: ["#fff3bf", "#665a1a"] },
  green: { stroke: ["#2f9e44", "#69db7c"], fill: ["#b2f2bb", "#1f5230"] },
  blue: { stroke: ["#1971c2", "#74b8f7"], fill: ["#a5d8ff", "#1c4268"] },
  violet: { stroke: ["#7048e8", "#a994f8"], fill: ["#d0bfff", "#3f2f7a"] },
  pink: { stroke: ["#c2255c", "#f783ac"], fill: ["#fcc2d7", "#662640"] },
};

export const strokeShade = (color: Color, dark: boolean) => PALETTE[color].stroke[dark ? 1 : 0];
export const fillShade = (color: Color, dark: boolean) => PALETTE[color].fill[dark ? 1 : 0];

/** Sizes on offer for each kind of thing drawn, in board units. */
export const SIZES = { pen: [2, 4, 8], highlighter: [12, 20, 32], shape: [2, 4, 8], text: [16, 24, 36, 56] } as const;

// ── Elements ─────────────────────────────────────────────────────────────────────────────────

type Base = { id: string; angle: number };
export type PenElement = Base & { type: "pen"; x: number; y: number; color: Color; size: number; hl?: true; pressure?: true; points: number[] };
export type TextElement = Base & { type: "text"; x: number; y: number; color: Color; text: string; fontSize: number; wrap: number | null };
export type ImageElement = Base & { type: "image"; x: number; y: number; w: number; h: number; asset: string };
export type BoxElement = Base & { type: "rect" | "ellipse"; x: number; y: number; w: number; h: number; color: Color; size: number; fill: Fill };
export type LineElement = Base & { type: "line" | "arrow"; x: number; y: number; x2: number; y2: number; color: Color; size: number };
export type Element = PenElement | TextElement | ImageElement | BoxElement | LineElement;
export type ElementType = Element["type"];
export const TYPES: readonly ElementType[] = ["pen", "text", "image", "rect", "ellipse", "line", "arrow"];

/** Pictures by asset id, each a `data:` URL. */
export type Assets = Record<string, string>;
export type Board = { elements: Element[]; assets: Assets };

/** At most this much on one board, so a pasted or broken file cannot take the editor down. */
export const MOST_ELEMENTS = 20_000;
/** Points of one pen line (three numbers each). */
export const MOST_POINTS = 40_000;
export const MOST_TEXT = 20_000;
/** One picture, as its `data:` URL. */
export const MOST_ASSET = 8 * 1024 * 1024;
const FAR = 1e7;

const isColor = (value: unknown): value is Color => typeof value === "string" && (COLORS as readonly string[]).includes(value);
const color = (value: unknown, fallback: Color = "ink"): Color => isColor(value) ? value : value === "purple" ? "violet" : fallback;
const fill = (value: unknown): Fill => value === "none" || value == null ? "none" : color(value, "gray");

/** An element id: short, and made only of what any id this editor makes is made of. */
export const isElementId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value);
/** A picture's id: its content's hash (`assetId`). */
export const isAssetId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9]{8,64}$/.test(value);
/** A picture as it may be kept: a raster image as a `data:` URL, nothing that could run. */
export const isAssetData = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MOST_ASSET && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(value);

export const newId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, (byte) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[byte & 63]).join("");
};

/**
 * A picture's id from its bytes. Not a cryptographic hash — a tablet's page is not a secure
 * context and has no `crypto.subtle` — but two different pictures do not meet by accident.
 */
export const assetId = (bytes: Uint8Array) => {
  let a = 0xdeadbeef ^ bytes.length;
  let b = 0x41c6ce57 ^ bytes.length;
  for (let index = 0; index < bytes.length; index += 1) {
    a = Math.imul(a ^ bytes[index], 2654435761);
    b = Math.imul(b ^ bytes[index], 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (b >>> 0).toString(16).padStart(8, "0") + (a >>> 0).toString(16).padStart(8, "0") + bytes.length.toString(36);
};

const round = (value: number, places = 10) => Math.round(value * places) / places;
const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= FAR ? value : null;
const clamp = (value: unknown, low: number, high: number, fallback: number) => {
  const known = num(value);
  return known === null ? fallback : Math.min(high, Math.max(low, known));
};
const angleOf = (value: unknown) => {
  const known = num(value);
  return known === null ? 0 : round(known % (Math.PI * 2), 10_000);
};

/** Pen points as they may be kept: whole triples of finite numbers within reach, at most `MOST_POINTS`. */
export const cleanPoints = (value: unknown): number[] | null => {
  if (!Array.isArray(value) || value.length % 3) return null;
  const points: number[] = [];
  for (let index = 0; index < Math.min(value.length, MOST_POINTS * 3); index += 3) {
    const x = num(value[index]);
    const y = num(value[index + 1]);
    const pressure = num(value[index + 2]);
    if (x === null || y === null || pressure === null) return null;
    points.push(round(x), round(y), round(Math.min(1, Math.max(0, pressure)), 100));
  }
  return points;
};

/** An element as it may be kept, or null for anything that is not one. Everything on a board came from somebody else's file, tablet or room. */
export const cleanElement = (value: unknown): Element | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!isElementId(raw.id)) return null;
  const x = num(raw.x);
  const y = num(raw.y);
  if (x === null || y === null) return null;
  const id = raw.id;
  switch (raw.type) {
    case "pen": {
      const points = cleanPoints(raw.points);
      if (!points?.length) return null;
      const pen: PenElement = { id, type: "pen", x: round(x), y: round(y), angle: angleOf(raw.angle), color: color(raw.color, raw.hl ? "yellow" : "ink"), size: clamp(raw.size, 0.5, 128, 4), points };
      if (raw.hl === true) pen.hl = true;
      if (raw.pressure === true) pen.pressure = true;
      return pen;
    }
    case "text": {
      if (typeof raw.text !== "string" || !raw.text) return null;
      const wrap = raw.wrap == null ? null : clamp(raw.wrap, 8, 100_000, 400);
      return { id, type: "text", x: round(x), y: round(y), angle: angleOf(raw.angle), color: color(raw.color), text: raw.text.slice(0, MOST_TEXT), fontSize: clamp(raw.fontSize, 4, 800, 24), wrap: wrap === null ? null : round(wrap) };
    }
    case "image": {
      const w = num(raw.w);
      const h = num(raw.h);
      if (!isAssetId(raw.asset) || w === null || h === null || w <= 0 || h <= 0) return null;
      return { id, type: "image", x: round(x), y: round(y), w: round(w), h: round(h), angle: angleOf(raw.angle), asset: raw.asset };
    }
    case "rect":
    case "ellipse": {
      const w = num(raw.w);
      const h = num(raw.h);
      if (w === null || h === null || w < 0 || h < 0) return null;
      return { id, type: raw.type, x: round(x), y: round(y), w: round(w), h: round(h), angle: angleOf(raw.angle), color: color(raw.color), size: clamp(raw.size, 0.5, 128, 2), fill: fill(raw.fill) };
    }
    case "line":
    case "arrow": {
      const x2 = num(raw.x2);
      const y2 = num(raw.y2);
      if (x2 === null || y2 === null) return null;
      return { id, type: raw.type, x: round(x), y: round(y), x2: round(x2), y2: round(y2), angle: 0, color: color(raw.color), size: clamp(raw.size, 0.5, 128, 2) };
    }
    default:
      return null;
  }
};

/**
 * A stroke of a board from before there were elements (`{ id, ink, width, points }`, two
 * numbers a point, from the board's origin) as the pen line it was.
 */
export const fromStroke = (value: unknown): PenElement | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!isElementId(raw.id) || !Array.isArray(raw.points) || raw.points.length % 2 || !raw.points.length) return null;
  const points: number[] = [];
  for (let index = 0; index < Math.min(raw.points.length, MOST_POINTS * 2); index += 2) points.push(raw.points[index], raw.points[index + 1], 0.5);
  const clean = cleanPoints(points);
  return clean ? { id: raw.id, type: "pen", x: 0, y: 0, angle: 0, color: color(raw.ink), size: clamp(raw.width, 0.5, 64, 4), points: clean } : null;
};

const cleanAll = (list: unknown[], clean: (value: unknown) => Element | null) => {
  const seen = new Set<string>();
  return list.slice(0, MOST_ELEMENTS).map(clean).filter((element): element is Element => {
    if (!element || seen.has(element.id)) return false;
    seen.add(element.id);
    return true;
  });
};

/** The elements and pictures of a `.board` file — of either version — or an empty board for one that is not a board at all. */
export const parseBoard = (text: string): Board => {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { elements: [], assets: {} }; }
  if (!raw || typeof raw !== "object") return { elements: [], assets: {} };
  const file = raw as { elements?: unknown; strokes?: unknown; assets?: unknown };
  const elements = Array.isArray(file.elements) ? cleanAll(file.elements, cleanElement) : Array.isArray(file.strokes) ? cleanAll(file.strokes, fromStroke) : [];
  const assets: Assets = {};
  if (file.assets && typeof file.assets === "object") {
    for (const [id, data] of Object.entries(file.assets as Record<string, unknown>)) if (isAssetId(id) && isAssetData(data)) assets[id] = data;
  }
  return { elements, assets };
};

/** The pictures the elements show, out of `assets`. */
export const usedAssets = (elements: readonly Element[], assets: Assets): Assets => {
  const used: Assets = {};
  for (const element of elements) if (element.type === "image" && assets[element.asset]) used[element.asset] = assets[element.asset];
  return used;
};

/** A board as its file: one element a line and one picture a line, so a diff of two versions stays readable. */
export const serializeBoard = (elements: readonly Element[], assets: Assets = {}) => {
  const lines = elements.map((element) => JSON.stringify(element));
  const pictures = Object.entries(usedAssets(elements, assets)).map(([id, data]) => `${JSON.stringify(id)}:${JSON.stringify(data)}`);
  const list = (items: string[]) => items.length ? `\n${items.join(",\n")}\n` : "";
  return `{"version":2,"elements":[${list(lines)}],"assets":{${list(pictures)}}}\n`;
};

export const EMPTY_BOARD = serializeBoard([]);

// ── Geometry ─────────────────────────────────────────────────────────────────────────────────

export type Box = { x: number; y: number; w: number; h: number };
export type Point = [number, number];

/** Each piece of writing's size where it was last shown, by id: only a browser can measure it. */
export const textSizes = new Map<string, { w: number; h: number }>();

export const isLine = (element: Element): element is LineElement => element.type === "line" || element.type === "arrow";

const penBounds = new WeakMap<number[], Box>();
/** The box of a pen line's points, from its (x, y). */
export const pointsBox = (points: number[]): Box => {
  const known = penBounds.get(points);
  if (known) return known;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let index = 0; index < points.length; index += 3) {
    left = Math.min(left, points[index]);
    right = Math.max(right, points[index]);
    top = Math.min(top, points[index + 1]);
    bottom = Math.max(bottom, points[index + 1]);
  }
  const box = left === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: left, y: top, w: right - left, h: bottom - top };
  penBounds.set(points, box);
  return box;
};

/** The element's box before it is turned. */
export const box = (element: Element): Box => {
  switch (element.type) {
    case "line":
    case "arrow":
      return { x: Math.min(element.x, element.x2), y: Math.min(element.y, element.y2), w: Math.abs(element.x2 - element.x), h: Math.abs(element.y2 - element.y) };
    case "text": {
      const size = textSizes.get(element.id);
      return { x: element.x, y: element.y, w: size ? size.w : element.wrap ?? element.fontSize * Math.max(1, Math.min(40, element.text.length)) * 0.55, h: size ? size.h : element.fontSize * 1.45 };
    }
    case "pen": {
      const inner = pointsBox(element.points);
      return { x: element.x + inner.x, y: element.y + inner.y, w: inner.w, h: inner.h };
    }
    default:
      return { x: element.x, y: element.y, w: element.w, h: element.h };
  }
};

export const rotate = (point: Point, centre: Point, angle: number): Point => {
  if (!angle) return [point[0], point[1]];
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const dx = point[0] - centre[0];
  const dy = point[1] - centre[1];
  return [centre[0] + dx * cos - dy * sin, centre[1] + dx * sin + dy * cos];
};
export const centreOf = (b: Box): Point => [b.x + b.w / 2, b.y + b.h / 2];

/** The upright box the element fits in, turned as it is. */
export const aabb = (element: Element, b = box(element)): Box => {
  if (!element.angle || isLine(element)) return b;
  const centre = centreOf(b);
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const corner of [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]] as Point[]) {
    const [x, y] = rotate(corner, centre, element.angle);
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
};

export const union = (boxes: Iterable<Box>): Box | null => {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const b of boxes) {
    left = Math.min(left, b.x); top = Math.min(top, b.y); right = Math.max(right, b.x + b.w); bottom = Math.max(bottom, b.y + b.h);
  }
  return left === Infinity ? null : { x: left, y: top, w: right - left, h: bottom - top };
};

/** The box everything fits in, line widths counted; null for an empty board. */
export const boundsOf = (elements: readonly Element[]) => union(elements.map((element) => {
  const b = aabb(element);
  const half = "size" in element ? element.size / 2 : 0;
  return { x: b.x - half, y: b.y - half, w: b.w + half * 2, h: b.h + half * 2 };
}));

export const intersects = (a: Box, b: Box) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

export const toSegment = (p: Point, a: Point, b: Point) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

/** How wide a pen line is drawn, about, for touching it. */
const reachOf = (element: Element) => element.type === "pen" ? (element.hl ? element.size : element.size * 0.95) / 2 : "size" in element ? element.size / 2 : 0;

/** Whether the board point `p` touches the element, `tolerance` board units counted. */
export const hit = (element: Element, p: Point, tolerance: number): boolean => {
  if (isLine(element)) return toSegment(p, [element.x, element.y], [element.x2, element.y2]) <= tolerance + reachOf(element);
  const b = box(element);
  const local = rotate(p, centreOf(b), -element.angle);
  const margin = tolerance + reachOf(element);
  if (local[0] < b.x - margin || local[0] > b.x + b.w + margin || local[1] < b.y - margin || local[1] > b.y + b.h + margin) return false;
  switch (element.type) {
    case "pen": {
      const q: Point = [local[0] - element.x, local[1] - element.y];
      const points = element.points;
      if (points.length === 3) return Math.hypot(q[0] - points[0], q[1] - points[1]) <= margin;
      for (let index = 3; index < points.length; index += 3) {
        if (toSegment(q, [points[index - 3], points[index - 2]], [points[index], points[index + 1]]) <= margin) return true;
      }
      return false;
    }
    case "rect":
      if (element.fill !== "none") return true;
      return local[0] < b.x + margin || local[0] > b.x + b.w - margin || local[1] < b.y + margin || local[1] > b.y + b.h - margin;
    case "ellipse": {
      const rx = b.w / 2 || 1e-6;
      const ry = b.h / 2 || 1e-6;
      const n = Math.sqrt(((local[0] - b.x - rx) / rx) ** 2 + ((local[1] - b.y - ry) / ry) ** 2);
      if (element.fill !== "none") return n <= 1 + margin / Math.min(rx, ry);
      return Math.abs(n - 1) * Math.min(rx, ry) <= margin;
    }
    default:
      return true;
  }
};

/** What an eraser dragged from `from` to `to` passes over: every element but pictures (written on, not rubbed out). */
export const erased = (elements: readonly Element[], from: Point, to: Point, radius: number): string[] => {
  const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / Math.max(0.5, radius / 2)));
  return elements.filter((element) => {
    if (element.type === "image") return false;
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      if (hit(element, [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t], radius)) return true;
    }
    return false;
  }).map((element) => element.id);
};

export const moveElement = <T extends Element>(element: T, dx: number, dy: number): T => isLine(element)
  ? { ...element, x: round(element.x + dx, 100), y: round(element.y + dy, 100), x2: round(element.x2 + dx, 100), y2: round(element.y2 + dy, 100) }
  : { ...element, x: round(element.x + dx, 100), y: round(element.y + dy, 100) };

/** A pen line moved into the box at (x, y) and stretched by (sx, sy) from the box `from` it was in. */
const refitPen = (element: PenElement, from: Box, x: number, y: number, sx: number, sy: number): PenElement => {
  if (sx === 1 && sy === 1) return { ...element, x: round(element.x + x - from.x, 100), y: round(element.y + y - from.y, 100) };
  const inner = pointsBox(element.points);
  const points = element.points.slice();
  for (let index = 0; index < points.length; index += 3) {
    points[index] = round((points[index] - inner.x) * sx);
    points[index + 1] = round((points[index + 1] - inner.y) * sy);
  }
  return { ...element, x: round(x, 100), y: round(y, 100), points };
};

/**
 * The element moved, scaled evenly by `scale` and turned by `turn` as the map `move` takes its
 * points; `from` is its box when the change began (writing is measured again on the way).
 */
export const similarity = (element: Element, from: Box, move: (point: Point) => Point, scale: number, turn: number): Element => {
  if (isLine(element)) {
    const [x, y] = move([element.x, element.y]);
    const [x2, y2] = move([element.x2, element.y2]);
    return { ...element, x, y, x2, y2 };
  }
  const centre = move(centreOf(from));
  const w = from.w * scale;
  const h = from.h * scale;
  const angle = element.angle + turn;
  const left = centre[0] - w / 2;
  const top = centre[1] - h / 2;
  switch (element.type) {
    case "text": return { ...element, x: left, y: top, angle, fontSize: element.fontSize * scale, wrap: element.wrap ? element.wrap * scale : null };
    case "pen": return { ...refitPen(element, from, left, top, scale, scale), angle };
    default: return { ...element, x: left, y: top, w, h, angle };
  }
};

/** One (maybe turned) element resized by the handle `handle` dragged to `p`; `from` is its box when the drag began. */
export const resizeOne = (element: Element, from: Box, handle: string, p: Point, keepAspect: boolean): Element => {
  const centre = centreOf(from);
  const local = rotate(p, centre, -element.angle);
  const least = element.type === "text" ? 8 : 2;
  let left = from.x;
  let top = from.y;
  let right = from.x + from.w;
  let bottom = from.y + from.h;
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  if (west) left = Math.min(local[0], right - least);
  if (east) right = Math.max(local[0], left + least);
  if (north) top = Math.min(local[1], bottom - least);
  if (south) bottom = Math.max(local[1], top + least);
  let w = right - left;
  let h = bottom - top;
  const corner = handle.length === 2;
  if (corner && (keepAspect || element.type === "text") && from.w > 1e-6 && from.h > 1e-6) {
    const scale = Math.max(w / from.w, h / from.h);
    w = from.w * scale;
    h = from.h * scale;
    if (west) left = right - w; else right = left + w;
    if (north) top = bottom - h; else bottom = top + h;
  }
  const moved = rotate([left + w / 2, top + h / 2], centre, element.angle);
  const x = moved[0] - w / 2;
  const y = moved[1] - h / 2;
  switch (element.type) {
    case "text": {
      if (corner) {
        const scale = w / from.w;
        return { ...element, x, y, fontSize: element.fontSize * scale, wrap: element.wrap ? element.wrap * scale : null };
      }
      // A side handle sets where the writing wraps.
      return { ...element, x, y, wrap: w };
    }
    case "pen": return refitPen(element, from, x, y, from.w > 1e-6 ? w / from.w : 1, from.h > 1e-6 ? h / from.h : 1);
    case "line":
    case "arrow": return element;
    default: return { ...element, x, y, w, h };
  }
};

/** What a selection is framed by: one element's own (turned) box, or for several the upright box round them all. */
export type Frame = Box & { angle: number; single: Element | null };
export const frameOf = (elements: readonly Element[]): Frame | null => {
  if (!elements.length) return null;
  if (elements.length === 1) {
    const only = elements[0];
    return { ...box(only), angle: isLine(only) ? 0 : only.angle, single: only };
  }
  return { ...union(elements.map((element) => aabb(element)))!, angle: 0, single: null };
};

export type Handle = { id: string; x: number; y: number };
/** The frame's handles, in board units; `pad` screen pixels out from the frame at zoom `scale`. */
export const handlesOf = (frame: Frame, scale: number, pad = 5): Handle[] => {
  const only = frame.single;
  if (only && isLine(only)) return [{ id: "p1", x: only.x, y: only.y }, { id: "p2", x: only.x2, y: only.y2 }];
  const margin = pad / scale;
  const left = frame.x - margin;
  const top = frame.y - margin;
  const right = frame.x + frame.w + margin;
  const bottom = frame.y + frame.h + margin;
  const cx = frame.x + frame.w / 2;
  const cy = frame.y + frame.h / 2;
  const handles: [string, number, number][] = [["nw", left, top], ["ne", right, top], ["se", right, bottom], ["sw", left, bottom]];
  if (only) {
    if (frame.h * scale > 44) handles.push(["e", right, cy], ["w", left, cy]);
    if (frame.w * scale > 44 && only.type !== "text") handles.push(["n", cx, top], ["s", cx, bottom]);
  }
  handles.push(["rot", cx, top - (pad ? 24 / scale : 0)]);
  return handles.map(([id, x, y]) => {
    const [hx, hy] = rotate([x, y], [cx, cy], frame.angle);
    return { id, x: hx, y: hy };
  });
};

/** Where `to` ends up when its angle from `from` is held to steps of 15°. */
export const snapAngle = (from: Point, to: Point): Point => {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const angle = Math.round(Math.atan2(to[1] - from[1], to[0] - from[0]) / (Math.PI / 12)) * (Math.PI / 12);
  return [from[0] + length * Math.cos(angle), from[1] + length * Math.sin(angle)];
};

/** The order after bringing the selected elements to the front or back, or one step either way. */
export const reorder = (elements: readonly Element[], selected: ReadonlySet<string>, how: "front" | "back" | "forward" | "backward"): Element[] => {
  if (how === "front") return [...elements.filter((element) => !selected.has(element.id)), ...elements.filter((element) => selected.has(element.id))];
  if (how === "back") return [...elements.filter((element) => selected.has(element.id)), ...elements.filter((element) => !selected.has(element.id))];
  const list = elements.slice();
  const picked = (index: number) => selected.has(list[index].id);
  if (how === "forward") {
    for (let index = list.length - 2; index >= 0; index -= 1) if (picked(index) && !picked(index + 1)) [list[index], list[index + 1]] = [list[index + 1], list[index]];
  } else {
    for (let index = 1; index < list.length; index += 1) if (picked(index) && !picked(index - 1)) [list[index], list[index - 1]] = [list[index - 1], list[index]];
  }
  return list;
};

// ── Writing ──────────────────────────────────────────────────────────────────────────────────

export type RichPart = { kind: "text" | "math" | "display"; value: string };
/** Writing cut into plain text and formulas: `$…$` in a line, `$$…$$` on its own; `\$` is a dollar sign. */
export const richParts = (text: string): RichPart[] => {
  const pattern = /\\\$|\$\$([\s\S]+?)\$\$|\$((?:\\[\s\S]|[^$\\\n])+?)\$/g;
  const parts: RichPart[] = [];
  let plain = "";
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    plain += text.slice(last, match.index);
    last = pattern.lastIndex;
    if (match[0] === "\\$") { plain += "$"; continue; }
    if (plain) parts.push({ kind: "text", value: plain });
    plain = "";
    const display = match[1] != null;
    parts.push({ kind: display ? "display" : "math", value: (display ? match[1] : match[2]).trim() });
    // A formula on its own already ends its line.
    if (display && text[last] === "\n") last += 1;
  }
  plain += text.slice(last);
  if (plain) parts.push({ kind: "text", value: plain });
  return parts;
};

// ── The view ─────────────────────────────────────────────────────────────────────────────────

/** A view of the board: the board point at the screen's top left, and the zoom. */
export type View = { x: number; y: number; scale: number };

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 16;
export const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** The view that shows all of `bounds` in a `width` × `height` screen, with a margin, never zoomed past 100 %. */
export const fitView = (bounds: Box | null, width: number, height: number, margin = 48): View => {
  if (!bounds || width <= 0 || height <= 0) return { x: -width / 2, y: -height / 2, scale: 1 };
  const scale = clampScale(Math.min(1, (width - margin * 2) / Math.max(1, bounds.w), (height - margin * 2) / Math.max(1, bounds.h)));
  return { x: bounds.x + bounds.w / 2 - width / 2 / scale, y: bounds.y + bounds.h / 2 - height / 2 / scale, scale };
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
export const farEnough = (lastX: number, lastY: number, x: number, y: number, scale: number, spacing = 0.7) =>
  Math.hypot(x - lastX, y - lastY) * scale >= spacing;

// ── Undo ─────────────────────────────────────────────────────────────────────────────────────

/** Some elements as they were, and where in the order: null for one that was not there. */
export type Snapshot = Map<string, { element: Element; index: number } | null>;

export const snapshotOf = (elements: readonly Element[], ids: Iterable<string>): Snapshot => {
  const at = new Map(elements.map((element, index) => [element.id, index]));
  const snapshot: Snapshot = new Map();
  for (const id of ids) {
    const index = at.get(id);
    snapshot.set(id, index === undefined ? null : { element: elements[index], index });
  }
  return snapshot;
};

/**
 * The board with the snapshot's elements put back as they were, and everything else — what
 * somebody else drew meanwhile — as it is. Elements that come back go to where they were;
 * with `reorder`, so do the others of the snapshot.
 */
export const restore = (elements: readonly Element[], snapshot: Snapshot, reorderToo: boolean): Element[] => {
  const gone = new Set<string>();
  const back: { element: Element; index: number }[] = [];
  const replaced = new Map<string, Element>();
  const present = new Set(elements.map((element) => element.id));
  for (const [id, state] of snapshot) {
    if (!state) gone.add(id);
    else if (!present.has(id) || reorderToo) { gone.add(id); back.push(state); }
    else replaced.set(id, state.element);
  }
  const list = elements.filter((element) => !gone.has(element.id)).map((element) => replaced.get(element.id) ?? element);
  back.sort((a, b) => a.index - b.index).forEach((state) => list.splice(Math.min(state.index, list.length), 0, state.element));
  return list;
};
