import * as Y from "yjs";
import { cleanPoints, cleanWidth, INKS, isStrokeId, MOST_POINTS, MOST_STROKES, type Ink, type Stroke } from "./model.ts";

/**
 * A board as a Yjs document, so that it can be drawn on by several people at once — in a
 * room, a board's map sits in the room's document beside the files (collabStore.ts); alone,
 * it has a document of its own.
 *
 * Under `root`, `strokes` is a Y.Array of strokes in drawing order. Each stroke is a Y.Map —
 * `id`, `ink`, `width`, and `points`, a Y.Array of numbers — so that a stroke being drawn
 * reaches everyone a few points at a time rather than once it is finished. Erasing removes
 * whole strokes; clearing removes them all.
 *
 * What comes out of `strokes()` is what the canvas draws: plain arrays, rebuilt only for the
 * strokes that changed, and checked — a teammate's document is only as sound as their copy.
 */
export class BoardDoc {
  readonly root: Y.Map<unknown>;
  private cache: Stroke[] | null = null;
  /** Each stroke's last plain copy, and how many numbers of its points it had then. */
  private copies = new WeakMap<Y.Map<unknown>, { length: number; stroke: Stroke | null }>();

  private listeners = new Set<(origin: unknown) => void>();

  constructor(root: Y.Map<unknown>) {
    this.root = root;
    root.observeDeep(this.changed);
  }

  private changed = (_: unknown, transaction: Y.Transaction) => {
    this.cache = null;
    this.listeners.forEach((listener) => listener(transaction.origin));
  };

  /** Stops following the document; the board is not drawn from this any more. */
  destroy() {
    this.root.unobserveDeep(this.changed);
    this.listeners.clear();
  }

  private list(): Y.Array<Y.Map<unknown>> | null {
    const list = this.root.get("strokes");
    return list instanceof Y.Array ? list as Y.Array<Y.Map<unknown>> : null;
  }

  /**
   * The list of strokes, made the first time something is drawn when it is not there. A
   * board in a room has it from the start (collabStore.ts): made by two members at once,
   * only one of the two lists would be kept.
   */
  private ensureList(): Y.Array<Y.Map<unknown>> {
    const known = this.list();
    if (known) return known;
    const list = new Y.Array<Y.Map<unknown>>();
    this.root.set("strokes", list);
    return list;
  }

  private transact(work: () => void, origin: unknown) {
    const doc = this.root.doc;
    if (doc) doc.transact(work, origin); else work();
  }

  private copy(map: Y.Map<unknown>): Stroke | null {
    const points = map.get("points");
    if (!(points instanceof Y.Array)) return null;
    const length = Math.min(points.length, MOST_POINTS * 2);
    const known = this.copies.get(map);
    if (known && known.length === length) return known.stroke;
    let stroke: Stroke | null = null;
    const id = map.get("id");
    const ink = map.get("ink");
    if (isStrokeId(id)) {
      // Points only ever grow while a stroke is drawn: the copy takes the new ones on.
      const growing = known?.stroke && known.length < length;
      const added = cleanPoints(points.slice(growing ? known!.length : 0, length - (length % 2)));
      if (added) {
        stroke = {
          id,
          ink: typeof ink === "string" && (INKS as readonly string[]).includes(ink) ? ink as Ink : "ink",
          width: cleanWidth(map.get("width")),
          points: growing ? [...known!.stroke!.points, ...added] : added,
        };
      }
    }
    this.copies.set(map, { length: length - (length % 2), stroke });
    return stroke;
  }

  /** The strokes, earliest first. The same array until something changes. */
  strokes(): readonly Stroke[] {
    if (this.cache) return this.cache;
    const list = this.list();
    const strokes: Stroke[] = [];
    const seen = new Set<string>();
    list?.forEach((map) => {
      if (strokes.length >= MOST_STROKES || !(map instanceof Y.Map)) return;
      const stroke = this.copy(map);
      if (stroke && stroke.points.length && !seen.has(stroke.id)) {
        seen.add(stroke.id);
        strokes.push(stroke);
      }
    });
    return this.cache = strokes;
  }

  /** Starts a stroke, with whatever points it has so far. */
  add(stroke: Stroke, origin: unknown = null) {
    this.transact(() => {
      const map = new Y.Map<unknown>();
      const points = new Y.Array<number>();
      points.push(stroke.points);
      map.set("id", stroke.id);
      map.set("ink", stroke.ink);
      map.set("width", stroke.width);
      map.set("points", points);
      this.ensureList().push([map]);
    }, origin);
  }

  private find(id: string): Y.Map<unknown> | null {
    const list = this.list();
    if (!list) return null;
    // A stroke being drawn is nearly always the last one.
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const map = list.get(index);
      if (map instanceof Y.Map && map.get("id") === id) return map;
    }
    return null;
  }

  /** More points for a stroke being drawn. */
  extend(id: string, points: number[], origin: unknown = null) {
    const map = this.find(id);
    const list = map?.get("points");
    if (!(list instanceof Y.Array) || points.length % 2 || list.length + points.length > MOST_POINTS * 2) return;
    this.transact(() => list.push(points), origin);
  }

  remove(ids: readonly string[], origin: unknown = null) {
    const list = this.list();
    if (!list || !ids.length) return;
    const gone = new Set(ids);
    this.transact(() => {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const map = list.get(index);
        if (map instanceof Y.Map && gone.has(map.get("id") as string)) list.delete(index, 1);
      }
    }, origin);
  }

  clear(origin: unknown = null) {
    const list = this.list();
    if (list?.length) this.transact(() => list.delete(0, list.length), origin);
  }

  /** Replaces everything with `strokes`, as a file read from disk says. */
  replace(strokes: readonly Stroke[], origin: unknown = null) {
    this.transact(() => {
      this.clear(origin);
      strokes.forEach((stroke) => this.add(stroke, origin));
    }, origin);
  }

  /** Calls `listener` after every change to the board, whoever made it, with the transaction's origin. */
  observe(listener: (origin: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
