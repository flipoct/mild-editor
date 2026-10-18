import { cleanPoints, cleanStroke, isStrokeId, type Stroke } from "./model.ts";

/**
 * What the editor and a tablet drawing on one of its boards say to each other (src/pad.rs
 * carries it; src/board/pads.ts is the editor's end, src/pad/main.ts the tablet's). JSON, one
 * message a frame.
 *
 * The editor keeps, for each tablet, how much of every stroke it has sent, and after any change
 * sends only the difference: new strokes, the points a stroke grew by, the strokes that went.
 * What the tablet drew itself counts as sent, so nothing comes back to it twice.
 */

export type ToPad =
  | { t: "state"; name: string; strokes: Stroke[] }
  | { t: "add"; stroke: Stroke }
  | { t: "pts"; id: string; pts: number[] }
  | { t: "del"; ids: string[] }
  /** The board went away on the editor's side: deleted, or the pairing was closed. */
  | { t: "bye" };

export type FromPad =
  | { t: "hello" }
  | { t: "begin"; stroke: Stroke }
  | { t: "pts"; id: string; pts: number[] }
  | { t: "end"; id: string }
  | { t: "erase"; ids: string[] };

const ids = (value: unknown): string[] | null => Array.isArray(value) && value.length <= 20_000 && value.every(isStrokeId) ? value as string[] : null;

/** A tablet's message, or null for anything else. A tablet is a browser on the network, so nothing it says is taken as it comes. */
export const readFromPad = (text: string): FromPad | null => {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const message = raw as Record<string, unknown>;
  switch (message.t) {
    case "hello": return { t: "hello" };
    case "begin": { const stroke = cleanStroke(message.stroke); return stroke && stroke.points.length ? { t: "begin", stroke } : null; }
    case "pts": { const pts = cleanPoints(message.pts); return isStrokeId(message.id) && pts && pts.length ? { t: "pts", id: message.id, pts } : null; }
    case "end": return isStrokeId(message.id) ? { t: "end", id: message.id } : null;
    case "erase": { const list = ids(message.ids); return list ? { t: "erase", ids: list } : null; }
    default: return null;
  }
};

/** The editor's message, or null; the tablet checks too, so a bug on one end shows as nothing drawn rather than a broken page. */
export const readToPad = (text: string): ToPad | null => {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const message = raw as Record<string, unknown>;
  switch (message.t) {
    case "state": return { t: "state", name: typeof message.name === "string" ? message.name.slice(0, 200) : "", strokes: Array.isArray(message.strokes) ? message.strokes.map(cleanStroke).filter((stroke): stroke is Stroke => stroke !== null) : [] };
    case "add": { const stroke = cleanStroke(message.stroke); return stroke ? { t: "add", stroke } : null; }
    case "pts": { const pts = cleanPoints(message.pts); return isStrokeId(message.id) && pts ? { t: "pts", id: message.id, pts } : null; }
    case "del": { const list = ids(message.ids); return list ? { t: "del", ids: list } : null; }
    case "bye": return { t: "bye" };
    default: return null;
  }
};

/** How much of each stroke a tablet has, by id: the number of point coordinates sent. */
export type Sent = Map<string, number>;

/**
 * What a tablet that has `sent` still needs to see `strokes`, and `sent` brought up to date.
 * New strokes go whole, grown ones by their new points, and gone ones by id.
 */
export const catchUp = (sent: Sent, strokes: readonly Stroke[]): ToPad[] => {
  const messages: ToPad[] = [];
  const present = new Set<string>();
  for (const stroke of strokes) {
    present.add(stroke.id);
    const had = sent.get(stroke.id);
    if (had === undefined) {
      messages.push({ t: "add", stroke });
      sent.set(stroke.id, stroke.points.length);
    } else if (stroke.points.length > had) {
      messages.push({ t: "pts", id: stroke.id, pts: stroke.points.slice(had) });
      sent.set(stroke.id, stroke.points.length);
    }
  }
  const gone = [...sent.keys()].filter((id) => !present.has(id));
  if (gone.length) {
    messages.push({ t: "del", ids: gone });
    gone.forEach((id) => sent.delete(id));
  }
  return messages;
};

/** The whole board for a tablet that has just come, with `sent` set to all of it. */
export const fullState = (sent: Sent, name: string, strokes: readonly Stroke[]): ToPad => {
  sent.clear();
  strokes.forEach((stroke) => sent.set(stroke.id, stroke.points.length));
  return { t: "state", name, strokes: [...strokes] };
};
