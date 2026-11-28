import { cleanElement, cleanPoints, isAssetData, isAssetId, isElementId, MOST_ELEMENTS, type Assets, type Element } from "./model.ts";

/**
 * What the editor and a tablet drawing on one of its boards say to each other (src-tauri/src/
 * pad.rs carries it; src/board/pads.ts is the editor's end, src/pad/main.ts the tablet's).
 * JSON, one message a frame.
 *
 * Each end keeps what it last told the other (`Sent`) and after any change says only the
 * difference (`changes`): elements that are new or changed whole, the points a pen line grew
 * by, the elements that went, the order when it is not what the other end would make of the
 * rest, and pictures the other end has not had. What one end heard from the other counts as
 * told, so nothing goes back where it came from.
 */

export type Change =
  | { t: "put"; element: Element }
  | { t: "pts"; id: string; pts: number[] }
  | { t: "del"; ids: string[] }
  | { t: "order"; ids: string[] }
  | { t: "asset"; id: string; data: string };

export type ToPad =
  | { t: "state"; name: string; elements: Element[] }
  /** The board went away on the editor's side: deleted, or the pairing was closed. */
  | { t: "bye" }
  | Change;

export type FromPad = { t: "hello" } | Change;

const ids = (value: unknown): string[] | null => Array.isArray(value) && value.length <= MOST_ELEMENTS && value.every(isElementId) ? value as string[] : null;

const readChange = (message: Record<string, unknown>): Change | null => {
  switch (message.t) {
    case "put": { const element = cleanElement(message.element); return element ? { t: "put", element } : null; }
    case "pts": { const pts = cleanPoints(message.pts); return isElementId(message.id) && pts?.length ? { t: "pts", id: message.id, pts } : null; }
    case "del": { const list = ids(message.ids); return list ? { t: "del", ids: list } : null; }
    case "order": { const list = ids(message.ids); return list ? { t: "order", ids: list } : null; }
    case "asset": return isAssetId(message.id) && isAssetData(message.data) ? { t: "asset", id: message.id, data: message.data } : null;
    default: return null;
  }
};

const parse = (text: string): Record<string, unknown> | null => {
  try {
    const raw: unknown = JSON.parse(text);
    return raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  } catch { return null; }
};

/** A tablet's message, or null for anything else. A tablet is a browser on the network, so nothing it says is taken as it comes. */
export const readFromPad = (text: string): FromPad | null => {
  const message = parse(text);
  if (!message) return null;
  return message.t === "hello" ? { t: "hello" } : readChange(message);
};

/** The editor's message, or null; the tablet checks too, so a bug on one end shows as nothing drawn rather than a broken page. */
export const readToPad = (text: string): ToPad | null => {
  const message = parse(text);
  if (!message) return null;
  if (message.t === "state") {
    const elements = Array.isArray(message.elements) ? message.elements.slice(0, MOST_ELEMENTS).map(cleanElement).filter((element): element is Element => element !== null) : [];
    return { t: "state", name: typeof message.name === "string" ? message.name.slice(0, 200) : "", elements };
  }
  if (message.t === "bye") return { t: "bye" };
  return readChange(message);
};

/** What the other end has, as this end last told it or heard from it. */
export type Sent = { elements: Map<string, Element>; order: string[]; assets: Set<string> };
export const newSent = (): Sent => ({ elements: new Map(), order: [], assets: new Set() });

const same = (a: Element, b: Element) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Whether `next` is `before` with more points, and nothing else changed. */
const grown = (before: Element, next: Element) => {
  if (before.type !== "pen" || next.type !== "pen" || next.points.length <= before.points.length) return false;
  for (let index = 0; index < before.points.length; index += 1) if (before.points[index] !== next.points[index]) return false;
  return JSON.stringify({ ...before, points: 0 }) === JSON.stringify({ ...next, points: 0 });
};

/**
 * What the other end, which has `sent`, still needs to have `elements` and `assets`; `sent` is
 * brought up to date. Pictures come before the elements that show them.
 */
export const changes = (sent: Sent, elements: readonly Element[], assets: Assets): Change[] => {
  const out: Change[] = [];
  for (const element of elements) {
    if (element.type === "image" && !sent.assets.has(element.asset) && assets[element.asset]) {
      out.push({ t: "asset", id: element.asset, data: assets[element.asset] });
      sent.assets.add(element.asset);
    }
  }
  const present = new Set<string>();
  const added: string[] = [];
  for (const element of elements) {
    present.add(element.id);
    const had = sent.elements.get(element.id);
    if (!had) {
      out.push({ t: "put", element });
      added.push(element.id);
    } else if (!same(had, element)) {
      if (grown(had, element)) out.push({ t: "pts", id: element.id, pts: (element as { points: number[] }).points.slice((had as { points: number[] }).points.length) });
      else out.push({ t: "put", element });
    }
    sent.elements.set(element.id, element);
  }
  const gone = [...sent.elements.keys()].filter((id) => !present.has(id));
  if (gone.length) {
    out.push({ t: "del", ids: gone });
    gone.forEach((id) => sent.elements.delete(id));
  }
  // The other end puts a new element last; the order is only said when that is not where it goes.
  const expected = [...sent.order.filter((id) => present.has(id)), ...added];
  const order = elements.map((element) => element.id);
  if (expected.length !== order.length || expected.some((id, index) => id !== order[index])) out.push({ t: "order", ids: order });
  sent.order = order;
  return out;
};

/** Notes what the other end said, as if this end had told it. */
export const heard = (sent: Sent, change: Change) => {
  switch (change.t) {
    case "put":
      if (!sent.elements.has(change.element.id)) sent.order = [...sent.order, change.element.id];
      sent.elements.set(change.element.id, change.element);
      break;
    case "pts": {
      const had = sent.elements.get(change.id);
      if (had?.type === "pen") sent.elements.set(change.id, { ...had, points: [...had.points, ...change.pts] });
      break;
    }
    case "del": {
      const gone = new Set(change.ids);
      change.ids.forEach((id) => sent.elements.delete(id));
      sent.order = sent.order.filter((id) => !gone.has(id));
      break;
    }
    case "order":
      sent.order = change.ids.filter((id) => sent.elements.has(id));
      break;
    case "asset":
      sent.assets.add(change.id);
      break;
  }
};

/** The elements after a change the other end made: puts, growth, removals and the order; pictures are kept apart. */
export const applyChange = (elements: readonly Element[], change: Change): readonly Element[] => {
  switch (change.t) {
    case "put": {
      const at = elements.findIndex((element) => element.id === change.element.id);
      return at < 0 ? [...elements, change.element] : elements.map((element, index) => index === at ? change.element : element);
    }
    case "pts":
      return elements.map((element) => element.id === change.id && element.type === "pen" ? { ...element, points: [...element.points, ...change.pts] } : element);
    case "del": {
      const gone = new Set(change.ids);
      return elements.filter((element) => !gone.has(element.id));
    }
    case "order": {
      const byId = new Map(elements.map((element) => [element.id, element]));
      const ordered = change.ids.map((id) => byId.get(id)).filter((element): element is Element => element !== undefined);
      const named = new Set(change.ids);
      // Anything the other end did not know of yet keeps its place at the end.
      return [...ordered, ...elements.filter((element) => !named.has(element.id))];
    }
    default:
      return elements;
  }
};

/** The whole board for a tablet that has just come, with `sent` set to it — pictures follow as changes. */
export const fullState = (sent: Sent, name: string, elements: readonly Element[]): ToPad => {
  sent.elements = new Map(elements.map((element) => [element.id, element]));
  sent.order = elements.map((element) => element.id);
  sent.assets = new Set();
  return { t: "state", name, elements: [...elements] };
};
