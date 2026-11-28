import * as Y from "yjs";
import { cleanElement, fromStroke, isAssetData, isAssetId, MOST_ELEMENTS, MOST_POINTS, type Assets, type Board, type Element } from "./model.ts";

/**
 * A board as a Yjs document, so that it can be drawn on by several people at once — in a
 * room, a board's map sits in the room's document beside the files (collabStore.ts); alone,
 * it has a document of its own.
 *
 * Under `root`, `elements` is a Y.Array of elements in drawing order, each a Y.Map of its
 * fields. A pen line's `points` is a Y.Array of numbers, so that a line being drawn reaches
 * everyone a few points at a time rather than once it is finished. `assets` maps a picture's
 * id to its `data:` URL. A board written by an editor from before there were elements has a
 * `strokes` list instead; it is read as pen lines, and anything done to one moves it over.
 *
 * What comes out of `elements()` is what the canvas draws: plain objects, rebuilt only for the
 * elements that changed, and checked — a teammate's document is only as sound as their copy.
 * Any change is `commit`ted as the whole list it should become; only the difference is written.
 */
export class BoardDoc {
  readonly root: Y.Map<unknown>;
  private cache: Element[] | null = null;
  private assetCache: Assets | null = null;
  private copies = new WeakMap<Y.Map<unknown>, Element | null>();
  private listeners = new Set<(origin: unknown) => void>();

  constructor(root: Y.Map<unknown>) {
    this.root = root;
    root.observeDeep(this.changed);
  }

  private changed = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
    for (const event of events) {
      const target = event.target;
      // An element's own fields, or its points, changed: its copy is made again.
      const element = target instanceof Y.Map ? target : target.parent instanceof Y.Map ? target.parent : null;
      if (element && element !== this.root) this.copies.delete(element as Y.Map<unknown>);
      if (target === this.root.get("assets") || target === this.root) this.assetCache = null;
    }
    this.cache = null;
    this.listeners.forEach((listener) => listener(transaction.origin));
  };

  /** Stops following the document; the board is not drawn from this any more. */
  destroy() {
    this.root.unobserveDeep(this.changed);
    this.listeners.clear();
  }

  private list(name: "elements" | "strokes" = "elements"): Y.Array<Y.Map<unknown>> | null {
    const list = this.root.get(name);
    return list instanceof Y.Array ? list as Y.Array<Y.Map<unknown>> : null;
  }

  /**
   * The list of elements, made the first time something is drawn when it is not there. A
   * board in a room has it from the start (collabStore.ts): made by two members at once,
   * only one of the two lists would be kept.
   */
  private ensureList(): Y.Array<Y.Map<unknown>> {
    const known = this.list();
    if (known) return known;
    const list = new Y.Array<Y.Map<unknown>>();
    this.root.set("elements", list);
    return list;
  }

  private transact(work: () => void, origin: unknown) {
    const doc = this.root.doc;
    if (doc) doc.transact(work, origin); else work();
  }

  private copy(map: Y.Map<unknown>, legacy: boolean): Element | null {
    if (this.copies.has(map)) return this.copies.get(map)!;
    const raw: Record<string, unknown> = {};
    map.forEach((value, key) => {
      raw[key] = value instanceof Y.Array ? value.slice(0, MOST_POINTS * 3) : value;
    });
    const element = legacy ? fromStroke(raw) : cleanElement(raw);
    this.copies.set(map, element);
    return element;
  }

  /** The elements, earliest first. The same array until something changes. */
  elements(): readonly Element[] {
    if (this.cache) return this.cache;
    const elements: Element[] = [];
    const seen = new Set<string>();
    const take = (list: Y.Array<Y.Map<unknown>> | null, legacy: boolean) => list?.forEach((map) => {
      if (elements.length >= MOST_ELEMENTS || !(map instanceof Y.Map)) return;
      const element = this.copy(map, legacy);
      if (element && !seen.has(element.id)) {
        seen.add(element.id);
        elements.push(element);
      }
    });
    take(this.list("strokes"), true);
    take(this.list(), false);
    return this.cache = elements;
  }

  /** The pictures, by id. */
  assets(): Assets {
    if (this.assetCache) return this.assetCache;
    const assets: Assets = {};
    const map = this.root.get("assets");
    if (map instanceof Y.Map) map.forEach((data, id) => { if (isAssetId(id) && isAssetData(data)) assets[id] = data; });
    return this.assetCache = assets;
  }

  putAsset(id: string, data: string, origin: unknown = null) {
    if (!isAssetId(id) || !isAssetData(data)) return;
    this.transact(() => {
      let map = this.root.get("assets");
      if (!(map instanceof Y.Map)) { map = new Y.Map<string>(); this.root.set("assets", map); }
      const assets = map as Y.Map<string>;
      if (assets.get(id) !== data) assets.set(id, data);
    }, origin);
  }

  private static fill(map: Y.Map<unknown>, element: Element, before: Element | null) {
    // A map not in the document yet cannot be read: everything is simply set.
    if (!map.doc) {
      for (const [key, value] of Object.entries(element)) {
        if (key !== "points") { map.set(key, value); continue; }
        const list = new Y.Array<number>();
        list.push(value as number[]);
        map.set("points", list);
      }
      return;
    }
    for (const [key, value] of Object.entries(element)) {
      if (key === "points") {
        const points = value as number[];
        const known = map.get("points");
        const old = before?.type === "pen" ? before.points : null;
        // A line being drawn only grows: its new points are added, the rest is not sent again.
        if (known instanceof Y.Array && old && points.length > old.length && old.every((number, index) => points[index] === number)) known.push(points.slice(old.length));
        else if (!(known instanceof Y.Array) || !old || old.length !== points.length || old.some((number, index) => points[index] !== number)) {
          const list = new Y.Array<number>();
          list.push(points);
          map.set("points", list);
        }
      } else if (map.get(key) !== value) {
        map.set(key, value);
      }
    }
    for (const key of [...map.keys()]) if (!(key in element)) map.delete(key);
  }

  private static mapOf(element: Element) {
    const map = new Y.Map<unknown>();
    BoardDoc.fill(map, element, null);
    return map;
  }

  /** Starts a pen line, with whatever points it has so far. */
  add(element: Element, origin: unknown = null) {
    this.transact(() => this.ensureList().push([BoardDoc.mapOf(element)]), origin);
  }

  private find(id: string): Y.Map<unknown> | null {
    const list = this.list();
    if (!list) return null;
    // A line being drawn is nearly always the last one.
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const map = list.get(index);
      if (map instanceof Y.Map && map.get("id") === id) return map;
    }
    return null;
  }

  /** More points for a pen line being drawn. */
  extend(id: string, points: number[], origin: unknown = null) {
    const list = this.find(id)?.get("points");
    if (!(list instanceof Y.Array) || points.length % 3 || list.length + points.length > MOST_POINTS * 3) return;
    this.transact(() => list.push(points), origin);
  }

  /** Makes the board `next`: what is gone is taken out, what changed is written, what is new is put in its place. */
  commit(next: readonly Element[], origin: unknown = null) {
    const nextAt = new Map(next.map((element, index) => [element.id, index]));
    const current = new Map(this.elements().map((element) => [element.id, element]));
    /** Old strokes left as they were, where they are. */
    const unmoved = new Set<string>();
    this.transact(() => {
      const legacy = this.list("strokes");
      if (legacy) {
        // Anything done to an old stroke moves it over to the elements.
        for (let index = legacy.length - 1; index >= 0; index -= 1) {
          const id = legacy.get(index)?.get("id") as string;
          if (!nextAt.has(id) || next[nextAt.get(id)!] !== current.get(id)) { legacy.delete(index, 1); current.delete(id); }
          else unmoved.add(id);
        }
      }
      const list = this.ensureList();
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const map = list.get(index);
        const id = map instanceof Y.Map ? map.get("id") as string : "";
        if (!(map instanceof Y.Map) || !nextAt.has(id)) list.delete(index, 1);
      }
      // What stays, in its order: the longest run already in `next`'s order keeps its place, the rest is moved.
      const order = list.toArray().map((map) => nextAt.get(map.get("id") as string) ?? -1);
      const keep = longestRising(order);
      for (let index = list.length - 1; index >= 0; index -= 1) if (!keep.has(index)) list.delete(index, 1);
      let at = 0;
      next.forEach((element) => {
        if (unmoved.has(element.id)) return;
        const map = at < list.length ? list.get(at) : null;
        if (map && map.get("id") === element.id) {
          const before = current.get(element.id) ?? null;
          if (before !== element) BoardDoc.fill(map, element, before);
        } else {
          list.insert(at, [BoardDoc.mapOf(element)]);
        }
        at += 1;
      });
    }, origin);
  }

  clear(origin: unknown = null) {
    this.commit([], origin);
  }

  /** Replaces everything with `board`, as a file read from disk says. */
  replace(board: Board, origin: unknown = null) {
    this.transact(() => {
      this.commit(board.elements, origin);
      for (const [id, data] of Object.entries(board.assets)) this.putAsset(id, data, origin);
    }, origin);
  }

  /** Calls `listener` after every change to the board, whoever made it, with the transaction's origin. */
  observe(listener: (origin: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** The indices of a longest strictly rising run in `values` (negative ones never count). */
const longestRising = (values: number[]): Set<number> => {
  const tails: number[] = [];
  const before = new Array<number>(values.length).fill(-1);
  values.forEach((value, index) => {
    if (value < 0) return;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[tails[middle]] < value) low = middle + 1; else high = middle;
    }
    if (low > 0) before[index] = tails[low - 1];
    tails[low] = index;
  });
  const keep = new Set<number>();
  for (let index = tails.length ? tails[tails.length - 1] : -1; index >= 0; index = before[index]) keep.add(index);
  return keep;
};
