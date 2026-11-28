import {
  aabb, assetId, box, boundsOf, clampScale, cleanElement, erased, farEnough, fitView, frameOf, handlesOf, hit, intersects, isAssetData, isAssetId, isLine,
  moveElement, newId, reorder, resizeOne, restore, rotate, similarity, SIZES, snapAngle, snapshotOf, MOST_ASSET, zoomAt,
  type Assets, type Box, type Color, type Element, type Fill, type Frame, type PenElement, type Point, type Snapshot, type TextElement, type View,
} from "./model";
import { BoardRenderer, renderRich, styleText, type Scene } from "./render";
import type { BoardWords } from "./words";

/**
 * Drawing on a board in a page, with a mouse, a pen or fingers — the same code in the editor
 * and on a tablet (src/pad), so a board looks and behaves alike on both.
 *
 * The canvas owns nothing: it draws what its `BoardSource` holds and turns a hand's movements
 * into changes of it. A change is the whole list of elements it should become (`commit`); a
 * pen line being drawn is sent a few points at a time instead (`begin`, `extend`, `end`), so
 * that others see it as it is drawn. Each view has its own pan, zoom, selection and undo — and
 * undo takes back only what was done here, so it is right in a room where others draw too.
 *
 * - Two fingers pan and pinch in any tool. A finger that started a line and is joined by a
 *   second one was the start of a pinch, so its line is taken back.
 * - Once a pen has been seen, fingers only pan and pinch (unless "draw with fingers" is on): a
 *   hand resting on a tablet while writing with a stylus does not draw. A pen's eraser button
 *   erases.
 * - The middle button, or space held down, pans with the mouse; the wheel scrolls, and zooms
 *   with Ctrl/⌘ (which is also what a trackpad pinch sends).
 */

export type BoardSource = {
  elements(): readonly Element[];
  assets(): Assets;
  /** Called after every change to the board; returns the way to stop. */
  subscribe(listener: () => void): () => void;
  begin(element: PenElement): void;
  extend(id: string, points: number[]): void;
  end(id: string): void;
  commit(next: readonly Element[]): void;
  putAsset(id: string, data: string): void;
};

export type Tool = "select" | "hand" | "pen" | "highlighter" | "eraser" | "text" | "rect" | "ellipse" | "arrow" | "line";
export const SHAPES: readonly Tool[] = ["rect", "ellipse", "arrow", "line"];

export type StyleKind = "pen" | "highlighter" | "shape" | "text";
export type Style = {
  pen: { color: Color; size: number };
  highlighter: { color: Color; size: number };
  shape: { color: Color; fill: Fill; size: number };
  text: { color: Color; fontSize: number };
};
const DEFAULT_STYLE: Style = {
  pen: { color: "ink", size: 4 },
  highlighter: { color: "yellow", size: 20 },
  shape: { color: "ink", fill: "none", size: 2 },
  text: { color: "ink", fontSize: 24 },
};

export const kindOf = (element: Element): StyleKind | "image" =>
  element.type === "pen" ? element.hl ? "highlighter" : "pen" : element.type === "text" ? "text" : element.type === "image" ? "image" : "shape";
export const TOOL_KIND: Partial<Record<Tool, StyleKind>> = { pen: "pen", highlighter: "highlighter", text: "text", rect: "shape", ellipse: "shape", arrow: "shape", line: "shape" };

const remember = <T,>(key: string, fallback: T): T => {
  try {
    const value = localStorage.getItem(`mild-board-${key}`);
    return value == null ? fallback : JSON.parse(value) as T;
  } catch { return fallback; }
};
const keep = (key: string, value: unknown) => {
  try { localStorage.setItem(`mild-board-${key}`, JSON.stringify(value)); } catch { /* still works, only forgets */ }
};

type Options = {
  /** Whether the board is drawn dark, now: the background and every colour follow it. */
  dark: () => boolean;
  words: BoardWords;
  /** Where the keyboard, copy and paste count as the board's: the board's part of the page. */
  scope: HTMLElement;
  /** A short message for whoever is drawing. */
  toast?: (message: string) => void;
};

type Action = {
  pointer?: number;
  pinch?: boolean;
  move(event: PointerEvent, sx: number, sy: number): void;
  up(event: PointerEvent, sx: number, sy: number): void;
  cancel(): void;
};

type Entry = { before: Snapshot; after: Snapshot; reorder: boolean };

const CLIP_TYPE = "application/x-mild-board";
const ERASER = 10;
const round = (value: number, places = 10) => Math.round(value * places) / places;
const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
const snapshotKey = (snapshot: Snapshot) => JSON.stringify([...snapshot]);

const TOOL_KEYS: Record<string, Tool> = {
  v: "select", 1: "select", h: "hand", p: "pen", 2: "pen", m: "highlighter", 3: "highlighter", e: "eraser", 4: "eraser",
  t: "text", 5: "text", r: "rect", 6: "rect", o: "ellipse", 7: "ellipse", a: "arrow", 8: "arrow", l: "line", 9: "line",
};

export class BoardCanvas implements Scene {
  tool: Tool = "select";
  toolLock = false;
  style: Style;
  grid: boolean = remember("grid", true);
  fingerDraw: boolean = remember("finger", false);
  view: View = { x: 0, y: 0, scale: 1 };
  selection = new Set<string>();
  erasing = new Set<string>();
  draft: Element | null = null;
  liveId: string | null = null;
  marquee: Box | null = null;
  editingId: string | null = null;
  eraser: { x: number; y: number; radius: number } | null = null;
  readonly stage: HTMLElement;
  readonly renderer: BoardRenderer;
  private readonly source: BoardSource;
  private readonly options: Options;
  private readonly stopFollowing: () => void;
  private listeners = new Set<() => void>();
  private action: Action | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private penSeen = false;
  private spaceHeld = false;
  private lastClick = { at: 0, x: 0, y: 0 };
  private pointer = { x: 0, y: 0, inside: false };
  private fitted = false;
  /** The view is fitted to the board once its first content arrives (a file read, a tablet's first state), unless somebody moved it first. */
  private fitOnArrival = true;
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private gesture: { before: Snapshot; reorder: boolean } | null = null;
  private editor: { area: HTMLTextAreaElement; preview: HTMLDivElement; element: TextElement; isNew: boolean } | null = null;
  private lastCopy: { text: string; elements: Element[]; assets: Assets } | null = null;

  constructor(stage: HTMLElement, source: BoardSource, options: Options) {
    this.stage = stage;
    this.source = source;
    this.options = options;
    const saved = remember<Partial<Style>>("style", {});
    this.style = {
      pen: { ...DEFAULT_STYLE.pen, ...saved.pen },
      highlighter: { ...DEFAULT_STYLE.highlighter, ...saved.highlighter },
      shape: { ...DEFAULT_STYLE.shape, ...saved.shape },
      text: { ...DEFAULT_STYLE.text, ...saved.text },
    };
    stage.classList.add("board-stage-live", "tool-select");
    this.renderer = new BoardRenderer(stage, this, () => this.sized());
    this.stopFollowing = source.subscribe(() => this.boardChanged());
    stage.addEventListener("pointerdown", this.down);
    stage.addEventListener("pointermove", this.moved);
    stage.addEventListener("pointerup", this.up);
    stage.addEventListener("pointercancel", this.up);
    stage.addEventListener("pointerleave", this.leave);
    stage.addEventListener("wheel", this.wheel, { passive: false });
    stage.addEventListener("contextmenu", this.noMenu);
    stage.addEventListener("dragover", this.dragOver);
    stage.addEventListener("drop", this.drop);
    options.scope.addEventListener("keydown", this.keyDown);
    options.scope.addEventListener("keyup", this.keyUp);
    window.addEventListener("blur", this.releaseSpace);
    document.addEventListener("copy", this.copy);
    document.addEventListener("cut", this.copy);
    document.addEventListener("paste", this.paste);
    this.sized();
  }

  destroy() {
    this.commitEdit();
    this.cancelAction();
    this.stopFollowing();
    this.renderer.destroy();
    this.stage.removeEventListener("pointerdown", this.down);
    this.stage.removeEventListener("pointermove", this.moved);
    this.stage.removeEventListener("pointerup", this.up);
    this.stage.removeEventListener("pointercancel", this.up);
    this.stage.removeEventListener("pointerleave", this.leave);
    this.stage.removeEventListener("wheel", this.wheel);
    this.stage.removeEventListener("contextmenu", this.noMenu);
    this.stage.removeEventListener("dragover", this.dragOver);
    this.stage.removeEventListener("drop", this.drop);
    this.options.scope.removeEventListener("keydown", this.keyDown);
    this.options.scope.removeEventListener("keyup", this.keyUp);
    window.removeEventListener("blur", this.releaseSpace);
    document.removeEventListener("copy", this.copy);
    document.removeEventListener("cut", this.copy);
    document.removeEventListener("paste", this.paste);
    this.listeners.clear();
  }

  // ── What the toolbar follows ──

  /** Calls `listener` when the tool, the selection, the style, the zoom or what can be undone changes. */
  listen(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private told = false;
  private tell() {
    if (this.told) return;
    this.told = true;
    queueMicrotask(() => { this.told = false; this.listeners.forEach((listener) => listener()); });
  }

  elements() { return this.source.elements(); }
  assets() { return this.source.assets(); }
  dark() { return this.options.dark(); }
  framed() { return this.tool === "select" && !this.editingId ? this.selected() : []; }
  selected() { return this.source.elements().filter((element) => this.selection.has(element.id)); }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }
  get isEditing() { return this.editor !== null; }

  /** The theme changed: everything is drawn again in the new shades. */
  redraw() { this.renderer.invalidate(); }

  private boardChanged() {
    if (this.fitOnArrival && this.source.elements().length) {
      this.fitOnArrival = false;
      if (this.fitted) this.fit(false);
    }
    // What somebody else took away is not selected any more.
    if (this.selection.size) {
      const present = new Set(this.source.elements().map((element) => element.id));
      const kept = [...this.selection].filter((id) => present.has(id));
      if (kept.length !== this.selection.size) { this.selection = new Set(kept); this.tell(); }
    }
    this.renderer.invalidate();
  }

  private sized() {
    // The first time the board has a size, it opens on what is drawn on it.
    if (!this.fitted && this.renderer.width > 0 && this.renderer.height > 0) {
      this.fitted = true;
      const waiting = this.fitOnArrival && !this.source.elements().length;
      this.fit(false);
      this.fitOnArrival = waiting;
    }
  }

  setTool(tool: Tool) {
    if (this.tool === tool) return;
    this.commitEdit();
    this.tool = tool;
    if (tool !== "select") this.setSelection([]);
    this.stage.className = this.stage.className.replace(/\btool-\S+/g, "").trim() + ` tool-${tool}`;
    this.stage.style.cursor = "";
    this.eraser = null;
    this.renderer.invalidate(false);
    this.tell();
  }

  toggleLock() { this.toolLock = !this.toolLock; this.tell(); }

  setGrid(on: boolean) { this.grid = on; keep("grid", on); this.renderer.invalidate(); this.tell(); }
  setFingerDraw(on: boolean) { this.fingerDraw = on; keep("finger", on); this.tell(); }

  private setSelection(ids: Iterable<string>) {
    const next = new Set(ids);
    if (next.size === this.selection.size && [...next].every((id) => this.selection.has(id))) return;
    this.selection = next;
    this.renderer.invalidate(false);
    this.tell();
  }

  // ── The view ──

  private setView(view: View) {
    this.fitOnArrival = false;
    this.view = view;
    this.renderer.invalidate();
    this.tell();
  }

  toBoard(sx: number, sy: number): Point { return [this.view.x + sx / this.view.scale, this.view.y + sy / this.view.scale]; }

  /** Shows everything on the board — or what is selected, with `selectedOnly`. */
  fit(selectedOnly = true) {
    const elements = selectedOnly && this.selection.size ? this.selected() : this.source.elements();
    this.setView(fitView(boundsOf(elements), this.renderer.width, this.renderer.height));
  }

  zoom(factor: number) { this.setView(zoomAt(this.view, factor, this.renderer.width / 2, this.renderer.height / 2)); }
  zoomReset() { this.zoom(1 / this.view.scale); }

  // ── Changing the board, and taking it back ──

  /** Begins a change that may take many steps (a drag), undone as one. */
  private startGesture(reorderToo = false) {
    if (!this.gesture) this.gesture = { before: new Map(), reorder: reorderToo };
  }

  /** Notes how the elements `ids` are before the gesture changes them. */
  private touch(ids: Iterable<string>, current = this.source.elements()) {
    const gesture = this.gesture;
    if (!gesture) return;
    const fresh = [...ids].filter((id) => !gesture.before.has(id));
    if (fresh.length) snapshotOf(current, fresh).forEach((state, id) => gesture.before.set(id, state));
  }

  /** Makes the board `next`, noting for undo what this changes. */
  private change(next: readonly Element[]) {
    const current = this.source.elements();
    if (this.gesture) {
      const before = new Map(current.map((element) => [element.id, element]));
      const changed: string[] = [];
      for (const element of next) if (before.get(element.id) !== element) changed.push(element.id);
      const staying = new Set(next.map((element) => element.id));
      for (const element of current) if (!staying.has(element.id)) changed.push(element.id);
      this.touch(changed, current);
    }
    this.source.commit(next);
  }

  private endGesture() {
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture?.before.size) return;
    const after = snapshotOf(this.source.elements(), gesture.before.keys());
    if (snapshotKey(after) === snapshotKey(gesture.before)) return;
    this.undoStack.push({ before: gesture.before, after, reorder: gesture.reorder });
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    this.tell();
  }

  /** Puts back what the gesture changed, as if it had not begun. */
  private abortGesture() {
    const gesture = this.gesture;
    this.gesture = null;
    if (gesture?.before.size) this.source.commit(restore(this.source.elements(), gesture.before, gesture.reorder));
  }

  private apply(next: readonly Element[], reorderToo = false) {
    this.startGesture(reorderToo);
    this.change(next);
    this.endGesture();
  }

  undo() {
    if (this.gesture || this.action) return;
    this.commitEdit();
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.source.commit(restore(this.source.elements(), entry.before, entry.reorder));
    this.redoStack.push(entry);
    this.tell();
  }

  redo() {
    if (this.gesture || this.action) return;
    this.commitEdit();
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.source.commit(restore(this.source.elements(), entry.after, entry.reorder));
    this.undoStack.push(entry);
    this.tell();
  }

  // ── Commands ──

  deleteSelection() {
    if (!this.selection.size) return;
    const gone = this.selection;
    this.apply(this.source.elements().filter((element) => !gone.has(element.id)));
    this.setSelection([]);
  }

  duplicateSelection() {
    const picked = this.selected();
    if (!picked.length) return;
    const step = 16 / this.view.scale;
    const copies = picked.map((element) => ({ ...moveElement(element, step, step), id: newId() }));
    this.apply([...this.source.elements(), ...copies]);
    this.setSelection(copies.map((element) => element.id));
  }

  reorderSelection(how: "front" | "back" | "forward" | "backward") {
    if (!this.selection.size) return;
    const current = this.source.elements();
    const next = reorder(current, this.selection, how);
    if (next.every((element, index) => element === current[index])) return;
    this.startGesture(true);
    this.touch(next.map((element) => element.id), current);
    this.change(next);
    this.endGesture();
  }

  /** Takes everything off the board — for everyone, in a room — as one step that undo brings back. */
  clearAll() {
    this.commitEdit();
    this.apply([]);
    this.setSelection([]);
  }

  selectAll() {
    this.setTool("select");
    this.setSelection(this.source.elements().map((element) => element.id));
  }

  nudge(dx: number, dy: number) {
    if (!this.selection.size) return;
    this.apply(this.source.elements().map((element) => this.selection.has(element.id) ? moveElement(element, dx, dy) : element));
  }

  /** Sets a style for what is selected and for what is drawn next. */
  setProp(prop: "color" | "fill" | "size" | "fontSize", value: string | number) {
    const picked = this.selected();
    const kinds = new Set<StyleKind>(picked.length ? picked.map(kindOf).filter((kind): kind is StyleKind => kind !== "image") : TOOL_KIND[this.tool] ? [TOOL_KIND[this.tool]!] : []);
    if (picked.length) {
      this.apply(this.source.elements().map((element) => {
        if (!this.selection.has(element.id)) return element;
        const kind = kindOf(element);
        if (prop === "color" && kind !== "image") return { ...element, color: value as Color } as Element;
        if (prop === "fill" && (element.type === "rect" || element.type === "ellipse")) return { ...element, fill: value as Fill };
        if (prop === "size" && kind !== "image" && kind !== "text") return { ...element, size: SIZES[kind][value as number] } as Element;
        if (prop === "fontSize" && element.type === "text") return { ...element, fontSize: value as number };
        return element;
      }));
    }
    for (const kind of kinds) {
      const style = this.style[kind] as Record<string, unknown>;
      if (prop === "size" && kind !== "text") style.size = SIZES[kind][value as number];
      else if (prop in style) style[prop] = value;
    }
    keep("style", this.style);
    this.tell();
  }

  // ── Finding things under the pointer ──

  private tolerance(event: { pointerType: string }) { return (event.pointerType === "touch" ? 14 : 6) / this.view.scale; }

  /** What is under `p`, the topmost first: writing is over everything else. */
  private hitTest(p: Point, tolerance: number) {
    const elements = this.source.elements();
    for (let index = elements.length - 1; index >= 0; index -= 1) if (elements[index].type === "text" && hit(elements[index], p, tolerance)) return elements[index];
    for (let index = elements.length - 1; index >= 0; index -= 1) if (elements[index].type !== "text" && hit(elements[index], p, tolerance)) return elements[index];
    return null;
  }

  private hitHandle(sx: number, sy: number, pointerType: string) {
    if (this.tool !== "select" || !this.selection.size) return null;
    const frame = frameOf(this.selected());
    if (!frame) return null;
    const reach = pointerType === "touch" ? 20 : 9;
    let best: { id: string; frame: Frame } | null = null;
    let nearest = reach;
    for (const handle of handlesOf(frame, this.view.scale)) {
      const distance = Math.hypot((handle.x - this.view.x) * this.view.scale - sx, (handle.y - this.view.y) * this.view.scale - sy);
      if (distance <= nearest) { best = { id: handle.id, frame }; nearest = distance; }
    }
    return best;
  }

  // ── Actions: one press, from down to up ──

  private panAction(sx0: number, sy0: number): Action {
    const from = { ...this.view };
    this.stage.classList.add("panning");
    const done = () => this.stage.classList.remove("panning");
    return {
      move: (_, sx, sy) => this.setView({ ...from, x: from.x - (sx - sx0) / from.scale, y: from.y - (sy - sy0) / from.scale }),
      up: done,
      cancel: done,
    };
  }

  private pinchAction(): Action {
    const ids = [...this.touches.keys()].slice(0, 2);
    const a = this.touches.get(ids[0])!;
    const b = this.touches.get(ids[1])!;
    const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const from = { ...this.view };
    const anchor = this.toBoard((a.x + b.x) / 2, (a.y + b.y) / 2);
    return {
      pinch: true,
      move: () => {
        const p = this.touches.get(ids[0]);
        const q = this.touches.get(ids[1]);
        if (!p || !q) return;
        const scale = clampScale(from.scale * Math.hypot(p.x - q.x, p.y - q.y) / distance);
        this.setView({ x: anchor[0] - (p.x + q.x) / 2 / scale, y: anchor[1] - (p.y + q.y) / 2 / scale, scale });
      },
      up: () => undefined,
      cancel: () => undefined,
    };
  }

  private newText(p: Point) {
    const style = this.style.text;
    this.openEditor({ id: newId(), type: "text", x: p[0], y: p[1] - style.fontSize * 0.72, angle: 0, text: "", fontSize: style.fontSize, color: style.color, wrap: null }, true);
  }

  private registerClick(sx: number, sy: number, element: Element | null, p: Point) {
    const now = performance.now();
    const double = now - this.lastClick.at < 400 && Math.hypot(sx - this.lastClick.x, sy - this.lastClick.y) < 24;
    this.lastClick = double ? { at: 0, x: 0, y: 0 } : { at: now, x: sx, y: sy };
    if (!double) return;
    if (element?.type === "text") this.openEditor(element, false);
    else if (!element) this.newText(p);
  }

  private moveAction(p0: Point, sx0: number, sy0: number, first: PointerEvent, clicked: Element | null): Action {
    let originals: Map<string, Element> | null = null;
    const threshold = first.pointerType === "touch" ? 8 : 4;
    return {
      move: (event, sx, sy) => {
        if (!originals) {
          if (Math.hypot(sx - sx0, sy - sy0) < threshold) return;
          this.startGesture();
          if (event.altKey) {
            // Alt+drag: a copy is dragged, the original stays.
            const copies = this.selected().map((element) => ({ ...element, id: newId() }));
            this.change([...this.source.elements(), ...copies]);
            this.setSelection(copies.map((element) => element.id));
          }
          originals = new Map(this.selected().map((element) => [element.id, element]));
        }
        const p = this.toBoard(sx, sy);
        let dx = p[0] - p0[0];
        let dy = p[1] - p0[1];
        if (event.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        const known = originals;
        this.change(this.source.elements().map((element) => known.has(element.id) ? moveElement(known.get(element.id)!, dx, dy) : element));
      },
      up: (_, sx, sy) => {
        if (originals) { this.endGesture(); return; }
        if (!first.shiftKey && clicked && this.selection.size > 1) this.setSelection([clicked.id]);
        this.registerClick(sx, sy, clicked, p0);
      },
      cancel: () => this.abortGesture(),
    };
  }

  private marqueeAction(p0: Point, sx0: number, sy0: number, additive: boolean): Action {
    const kept = additive ? [...this.selection] : [];
    let moved = false;
    const clear = () => { this.marquee = null; this.renderer.invalidate(false); };
    return {
      move: (_, sx, sy) => {
        if (!moved && Math.hypot(sx - sx0, sy - sy0) < 4) return;
        moved = true;
        const p = this.toBoard(sx, sy);
        const marquee = { x: Math.min(p0[0], p[0]), y: Math.min(p0[1], p[1]), w: Math.abs(p[0] - p0[0]), h: Math.abs(p[1] - p0[1]) };
        this.marquee = marquee;
        const ids = new Set(kept);
        for (const element of this.source.elements()) if (intersects(aabb(element), marquee)) ids.add(element.id);
        this.setSelection(ids);
        this.renderer.invalidate(false);
      },
      up: (_, sx, sy) => { clear(); if (!moved) this.registerClick(sx, sy, null, p0); },
      cancel: clear,
    };
  }

  private transformAction(handle: { id: string; frame: Frame }, p0: Point): Action {
    const frame = handle.frame;
    const originals = this.selected().map((element) => ({ element, from: box(element) }));
    const centre: Point = [frame.x + frame.w / 2, frame.y + frame.h / 2];
    // A handle sits a little off the frame: the difference between where it was taken and the true corner is kept out.
    const corner = handlesOf(frame, this.view.scale, 0).find((item) => item.id === handle.id);
    const offset = corner ? [p0[0] - corner.x, p0[1] - corner.y] : [0, 0];
    const angle0 = Math.atan2(p0[1] - centre[1], p0[0] - centre[0]);
    const map = (change: (element: Element, from: Box) => Element) => {
      this.startGesture();
      const changed = new Map(originals.map(({ element, from }) => [element.id, change(element, from)]));
      this.change(this.source.elements().map((element) => changed.get(element.id) ?? element));
    };
    return {
      move: (event, sx, sy) => {
        const pointer = this.toBoard(sx, sy);
        const p: Point = [pointer[0] - offset[0], pointer[1] - offset[1]];
        if (handle.id === "rot") {
          let turn = Math.atan2(pointer[1] - centre[1], pointer[0] - centre[0]) - angle0;
          if (event.shiftKey) turn = Math.round((frame.angle + turn) / (Math.PI / 12)) * (Math.PI / 12) - frame.angle;
          map((element, from) => frame.single ? isLine(element) ? similarity(element, from, (q) => rotate(q, centre, turn), 1, 0) : { ...element, angle: element.angle + turn } : similarity(element, from, (q) => rotate(q, centre, turn), 1, turn));
        } else if (handle.id === "p1" || handle.id === "p2") {
          map((element) => {
            if (!isLine(element)) return element;
            const first = handle.id === "p1";
            const q = event.shiftKey ? snapAngle(first ? [element.x2, element.y2] : [element.x, element.y], p) : p;
            return first ? { ...element, x: q[0], y: q[1] } : { ...element, x2: q[0], y2: q[1] };
          });
        } else if (frame.single) {
          // Pictures keep their proportions unless Shift says otherwise; everything else the other way round.
          const keepAspect = frame.single.type === "image" ? !event.shiftKey : event.shiftKey;
          map((element, from) => resizeOne(element, from, handle.id, p, keepAspect));
        } else {
          const ax = handle.id.includes("w") ? frame.x + frame.w : frame.x;
          const ay = handle.id.includes("n") ? frame.y + frame.h : frame.y;
          const scale = Math.max(0.02, Math.abs(p[0] - ax) / (frame.w || 1), Math.abs(p[1] - ay) / (frame.h || 1));
          map((element, from) => similarity(element, from, (q) => [ax + (q[0] - ax) * scale, ay + (q[1] - ay) * scale], scale, 0));
        }
      },
      up: () => this.endGesture(),
      cancel: () => this.abortGesture(),
    };
  }

  private startSelect(event: PointerEvent, sx: number, sy: number): Action {
    const p = this.toBoard(sx, sy);
    const handle = this.hitHandle(sx, sy, event.pointerType);
    if (handle) return this.transformAction(handle, p);
    const element = this.hitTest(p, this.tolerance(event));
    if (element) {
      if (event.shiftKey) {
        const next = new Set(this.selection);
        if (next.has(element.id)) next.delete(element.id); else next.add(element.id);
        this.setSelection(next);
        if (!next.has(element.id)) return { move: () => undefined, up: () => undefined, cancel: () => undefined };
      } else if (!this.selection.has(element.id)) {
        this.setSelection([element.id]);
      }
      return this.moveAction(p, sx, sy, event, element);
    }
    // An empty spot inside the frame of several moves them all.
    if (this.selection.size > 1 && !event.shiftKey) {
      const frame = boundsOf(this.selected());
      if (frame && p[0] >= frame.x && p[0] <= frame.x + frame.w && p[1] >= frame.y && p[1] <= frame.y + frame.h) return this.moveAction(p, sx, sy, event, null);
    }
    if (!event.shiftKey) this.setSelection([]);
    return this.marqueeAction(p, sx, sy, event.shiftKey);
  }

  private drawAction(event: PointerEvent, sx: number, sy: number, highlight: boolean): Action {
    const style = highlight ? this.style.highlighter : this.style.pen;
    const real = event.pointerType === "pen";
    const id = newId();
    const [x0, y0] = this.toBoard(sx, sy).map((value) => round(value));
    const origin: Point = [x0, y0];
    let last: Point = origin;
    let queued: number[] = [];
    let frame = 0;
    const pressure = (sample: PointerEvent) => real ? round(sample.pressure || 0.5, 100) : 0.5;
    const pen: PenElement = { id, type: "pen", x: x0, y: y0, angle: 0, color: style.color, size: style.size, points: [0, 0, pressure(event)] };
    if (highlight) pen.hl = true;
    if (real) pen.pressure = true;
    this.liveId = id;
    this.source.begin(pen);
    const flush = () => {
      frame = 0;
      if (queued.length) { this.source.extend(id, queued); queued = []; }
    };
    const finish = () => { cancelAnimationFrame(frame); flush(); this.liveId = null; };
    return {
      move: (moved) => {
        // Every sample the hardware took since the last event, not only the last one.
        const samples = typeof moved.getCoalescedEvents === "function" ? moved.getCoalescedEvents() : [];
        const box = this.stage.getBoundingClientRect();
        for (const sample of samples.length ? samples : [moved]) {
          const point = this.toBoard(sample.clientX - box.left, sample.clientY - box.top);
          if (!farEnough(last[0], last[1], point[0], point[1], this.view.scale)) continue;
          queued.push(round(point[0] - origin[0]), round(point[1] - origin[1]), pressure(sample));
          last = point;
        }
        if (queued.length && !frame) frame = requestAnimationFrame(flush);
      },
      up: () => {
        finish();
        this.source.end(id);
        const drawn = this.source.elements().find((element) => element.id === id);
        if (drawn) {
          this.undoStack.push({ before: new Map([[id, null]]), after: snapshotOf(this.source.elements(), [id]), reorder: false });
          if (this.undoStack.length > 300) this.undoStack.shift();
          this.redoStack = [];
          this.tell();
        }
        this.renderer.invalidate();
      },
      cancel: () => {
        finish();
        this.source.end(id);
        this.source.commit(this.source.elements().filter((element) => element.id !== id));
      },
    };
  }

  /** Rubs out what the eraser passes over: shown faint while it moves, gone when it lets go. */
  private eraseAction(p0: Point, event: PointerEvent, sx: number, sy: number): Action {
    let previous = p0;
    const radius = (event.pointerType === "touch" ? 14 : ERASER) / this.view.scale;
    const mark = (p: Point) => {
      let changed = false;
      for (const id of erased(this.source.elements(), previous, p, radius)) if (!this.erasing.has(id)) { this.erasing.add(id); changed = true; }
      previous = p;
      if (changed) this.renderer.invalidate();
    };
    this.eraser = { x: sx, y: sy, radius: radius * this.view.scale };
    mark(p0);
    const clear = () => { this.erasing = new Set(); this.renderer.invalidate(); };
    return {
      move: (_, x, y) => { this.eraser = { x, y, radius: radius * this.view.scale }; mark(this.toBoard(x, y)); this.renderer.invalidate(false); },
      up: () => {
        const gone = this.erasing;
        clear();
        if (gone.size) this.apply(this.source.elements().filter((element) => !gone.has(element.id)));
      },
      cancel: clear,
    };
  }

  private shapeAction(type: "rect" | "ellipse" | "line" | "arrow", p0: Point): Action {
    const style = this.style.shape;
    const id = newId();
    const make = (p: Point, square: boolean): Element => {
      if (type === "line" || type === "arrow") {
        const q = square ? snapAngle(p0, p) : p;
        return { id, type, x: p0[0], y: p0[1], x2: q[0], y2: q[1], angle: 0, color: style.color, size: style.size };
      }
      let w = p[0] - p0[0];
      let h = p[1] - p0[1];
      if (square) { const side = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * side; h = Math.sign(h || 1) * side; }
      return { id, type, x: Math.min(p0[0], p0[0] + w), y: Math.min(p0[1], p0[1] + h), w: Math.abs(w), h: Math.abs(h), angle: 0, color: style.color, size: style.size, fill: style.fill };
    };
    const clear = () => { this.draft = null; this.renderer.invalidate(false); };
    return {
      move: (event, sx, sy) => { this.draft = make(this.toBoard(sx, sy), event.shiftKey); this.renderer.invalidate(false); },
      up: () => {
        const element = this.draft;
        clear();
        if (!element) return;
        const b = box(element);
        if (Math.max(b.w, b.h) * this.view.scale < 4) return;
        this.apply([...this.source.elements(), element]);
        if (!this.toolLock) { this.setTool("select"); this.setSelection([element.id]); }
      },
      cancel: clear,
    };
  }

  private textAction(p: Point, tolerance: number): Action {
    return {
      move: () => undefined,
      up: () => {
        const element = this.hitTest(p, tolerance);
        if (element?.type === "text") this.openEditor(element, false); else this.newText(p);
      },
      cancel: () => undefined,
    };
  }

  private startTool(tool: Tool, event: PointerEvent, sx: number, sy: number): Action | null {
    const p = this.toBoard(sx, sy);
    switch (tool) {
      case "select": return this.startSelect(event, sx, sy);
      case "pen": return this.drawAction(event, sx, sy, false);
      case "highlighter": return this.drawAction(event, sx, sy, true);
      case "eraser": return this.eraseAction(p, event, sx, sy);
      case "text": return this.textAction(p, this.tolerance(event));
      case "rect": case "ellipse": case "line": case "arrow": return this.shapeAction(tool, p);
      default: return null;
    }
  }

  private cancelAction() {
    if (!this.action) return false;
    const action = this.action;
    this.action = null;
    action.cancel();
    return true;
  }

  // ── Pointer events ──

  private at(event: { clientX: number; clientY: number }): [number, number] {
    const box = this.stage.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  }

  private down = (event: PointerEvent) => {
    this.fitOnArrival = false;
    if ((event.target as HTMLElement | null)?.closest(".board-editor")) return;
    if (this.editor) { this.commitEdit(); event.preventDefault(); return; }
    const [sx, sy] = this.at(event);
    this.pointer = { x: sx, y: sy, inside: true };
    // The board's part of the page has the keyboard from now on.
    if (!this.options.scope.contains(document.activeElement)) this.options.scope.focus({ preventScroll: true });
    // Refused for a pointer the browser no longer counts as down; the action goes on without it.
    try { this.stage.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
    event.preventDefault();
    if (event.pointerType === "touch") {
      this.touches.set(event.pointerId, { x: sx, y: sy });
      if (this.touches.size === 2) { this.cancelAction(); this.action = this.pinchAction(); return; }
      if (this.touches.size > 2) return;
      // While a pen is in use, a finger only moves the view.
      if (this.penSeen && !this.fingerDraw && this.tool !== "select") {
        this.action = this.panAction(sx, sy);
        this.action.pointer = event.pointerId;
        return;
      }
    }
    if (event.pointerType === "pen") this.penSeen = true;
    if (this.action) return;
    if (event.button === 1 || (event.button === 0 && (this.spaceHeld || this.tool === "hand"))) this.action = this.panAction(sx, sy);
    else if (event.button === 0) this.action = this.startTool(event.pointerType === "pen" && (event.buttons & 32) ? "eraser" : this.tool, event, sx, sy);
    if (this.action) this.action.pointer = event.pointerId;
  };

  private hoverCursor(sx: number, sy: number) {
    if (this.tool !== "select" || this.spaceHeld) return "";
    const handle = this.hitHandle(sx, sy, "mouse");
    if (handle) {
      if (handle.id === "rot") return "grab";
      if (handle.id === "p1" || handle.id === "p2") return "crosshair";
      const turn = Math.round((handle.frame.angle / Math.PI) * 4);
      const index = ({ n: 0, ne: 1, e: 2, se: 3, s: 4, sw: 5, w: 6, nw: 7 } as Record<string, number>)[handle.id];
      return ["ns-resize", "nesw-resize", "ew-resize", "nwse-resize"][(((index + turn) % 4) + 4) % 4];
    }
    return this.hitTest(this.toBoard(sx, sy), 6 / this.view.scale) ? "move" : "";
  }

  private moved = (event: PointerEvent) => {
    const [sx, sy] = this.at(event);
    this.pointer = { x: sx, y: sy, inside: true };
    if (event.pointerType === "touch" && this.touches.has(event.pointerId)) this.touches.set(event.pointerId, { x: sx, y: sy });
    if (this.action) {
      if (this.action.pinch || this.action.pointer === event.pointerId) this.action.move(event, sx, sy);
      return;
    }
    if (this.tool === "eraser" && event.pointerType !== "touch") {
      this.eraser = { x: sx, y: sy, radius: ERASER };
      this.renderer.invalidate(false);
    } else if (event.pointerType === "mouse" && !this.editor) {
      this.stage.style.cursor = this.hoverCursor(sx, sy);
    }
  };

  private up = (event: PointerEvent) => {
    const [sx, sy] = this.at(event);
    const wasTouch = this.touches.delete(event.pointerId);
    const action = this.action;
    if (!action) return;
    if (action.pinch) {
      if (wasTouch && this.touches.size < 2) this.action = null;
      return;
    }
    if (action.pointer !== event.pointerId) return;
    this.action = null;
    if (this.tool !== "eraser" || event.pointerType === "touch") this.eraser = null;
    if (event.type === "pointercancel") action.cancel(); else action.up(event, sx, sy);
    this.renderer.invalidate(false);
  };

  private leave = () => {
    this.pointer.inside = false;
    if (this.eraser && !this.action) { this.eraser = null; this.renderer.invalidate(false); }
  };

  private wheel = (event: WheelEvent) => {
    event.preventDefault();
    const [sx, sy] = this.at(event);
    let dx = event.deltaX;
    let dy = event.deltaY;
    // Lines rather than pixels, from some mice.
    if (event.deltaMode === 1) { dx *= 33; dy *= 33; }
    if (event.ctrlKey || event.metaKey) {
      // A trackpad pinch sends many small steps, a mouse wheel one large one.
      const speed = Math.abs(dy) < 40 ? 0.012 : 0.0022;
      this.setView(zoomAt(this.view, Math.exp(-Math.max(-120, Math.min(120, dy)) * speed), sx, sy));
    } else {
      this.setView({ ...this.view, x: this.view.x + dx / this.view.scale, y: this.view.y + dy / this.view.scale });
    }
  };

  private noMenu = (event: Event) => event.preventDefault();

  // ── The keyboard ──

  private mine(target: EventTarget | null) {
    return target instanceof Node && (this.options.scope.contains(target) || target === document.body);
  }

  private keyDown = (event: KeyboardEvent) => {
    if (isTyping(event.target) || !this.mine(event.target)) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const mod = event.ctrlKey || event.metaKey;
    const handled = () => { event.preventDefault(); event.stopPropagation(); };
    if (event.code === "Space" && !mod) {
      if (!this.spaceHeld) { this.spaceHeld = true; this.stage.classList.add("space"); this.stage.style.cursor = ""; }
      handled();
      return;
    }
    if (mod) {
      if (event.altKey) return;
      if (event.code === "KeyZ") { if (event.shiftKey) this.redo(); else this.undo(); }
      else if (event.code === "KeyY") this.redo();
      else if (event.code === "KeyA") this.selectAll();
      else if (event.code === "KeyD") this.duplicateSelection();
      else if (event.code === "BracketRight") this.reorderSelection(event.shiftKey ? "front" : "forward");
      else if (event.code === "BracketLeft") this.reorderSelection(event.shiftKey ? "back" : "backward");
      else if (event.code === "Digit0") this.zoomReset();
      else if (event.code === "Equal" || event.code === "NumpadAdd") this.zoom(1.25);
      else if (event.code === "Minus" || event.code === "NumpadSubtract") this.zoom(0.8);
      else return;
      handled();
      return;
    }
    if (event.altKey) return;
    if (event.shiftKey && event.code === "Digit1") { this.fit(); handled(); return; }
    if (key === "Delete" || key === "Backspace") { if (this.selection.size) { this.deleteSelection(); handled(); } return; }
    if (key === "Escape") {
      if (this.cancelAction()) { handled(); return; }
      if (this.selection.size) { this.setSelection([]); handled(); }
      else if (this.tool !== "select") { this.setTool("select"); handled(); }
      return;
    }
    if (key === "Enter") {
      const picked = this.selected();
      if (picked.length === 1 && picked[0].type === "text") { this.openEditor(picked[0], false); handled(); }
      return;
    }
    if (key.startsWith("Arrow")) {
      if (!this.selection.size) return;
      const step = (event.shiftKey ? 10 : 1) / this.view.scale;
      this.nudge(key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0, key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0);
      handled();
      return;
    }
    if (key === "q") { this.toggleLock(); handled(); return; }
    if (!event.shiftKey && TOOL_KEYS[key]) { this.setTool(TOOL_KEYS[key]); handled(); }
  };

  private keyUp = (event: KeyboardEvent) => { if (event.code === "Space") this.releaseSpace(); };
  private releaseSpace = () => { this.spaceHeld = false; this.stage.classList.remove("space"); };

  // ── Writing ──

  private placePreview() {
    const editor = this.editor;
    if (!editor) return;
    const text = editor.area.value;
    const show = text.includes("$");
    editor.preview.hidden = !show;
    if (!show) return;
    editor.preview.innerHTML = renderRich(text);
    editor.preview.style.left = `${editor.element.x}px`;
    editor.preview.style.top = `${editor.element.y + editor.area.offsetHeight + editor.element.fontSize * 0.5}px`;
    editor.preview.style.fontSize = `${editor.element.fontSize}px`;
  }

  openEditor(element: TextElement, isNew: boolean) {
    this.commitEdit();
    const area = document.createElement("textarea");
    area.className = `board-editor${element.wrap ? " wrap" : ""}`;
    area.value = element.text;
    area.spellcheck = false;
    area.rows = 1;
    area.setAttribute("aria-label", this.options.words.editText);
    styleText(area, element, this.dark());
    if (!element.wrap) area.style.width = "";
    const preview = document.createElement("div");
    preview.className = "board-preview";
    preview.hidden = true;
    this.renderer.layer.append(area, preview);
    this.editor = { area, preview, element, isNew };
    this.editingId = isNew ? null : element.id;
    const grow = () => {
      area.style.height = "auto";
      area.style.height = `${area.scrollHeight}px`;
      if (!element.wrap) { area.style.width = "auto"; area.style.width = `${Math.max(element.fontSize, area.scrollWidth + 2)}px`; }
      this.placePreview();
    };
    area.addEventListener("input", grow);
    area.addEventListener("blur", () => this.commitEdit());
    area.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) {
        event.preventDefault();
        this.commitEdit();
        this.options.scope.focus({ preventScroll: true });
      }
    });
    area.focus({ preventScroll: true });
    area.setSelectionRange(area.value.length, area.value.length);
    grow();
    this.renderer.invalidate();
    this.tell();
  }

  commitEdit() {
    const editor = this.editor;
    if (!editor) return;
    // Cleared first: taking the editor away blurs it, which comes back here.
    this.editor = null;
    const { area, preview, element, isNew } = editor;
    const text = area.value.replace(/\s+$/, "");
    area.remove();
    preview.remove();
    this.editingId = null;
    const current = this.source.elements();
    if (isNew) {
      if (text) this.apply([...current, { ...element, text }]);
    } else if (!text) {
      this.apply(current.filter((item) => item.id !== element.id));
    } else if (text !== element.text) {
      this.apply(current.map((item) => item.id === element.id && item.type === "text" ? { ...item, text } : item));
    }
    if (this.tool === "text" && !this.toolLock) this.setTool("select");
    if (text && this.tool === "select") this.setSelection([element.id]);
    this.renderer.invalidate();
    this.tell();
  }

  // ── Copy, paste, pictures ──

  /** Where pasted things go: under the pointer when it is over the board, or the middle of the view. */
  private anchor(): Point {
    return this.pointer.inside ? this.toBoard(this.pointer.x, this.pointer.y) : this.toBoard(this.renderer.width / 2, this.renderer.height / 2);
  }

  private copy = (event: ClipboardEvent) => {
    if (isTyping(event.target) || !this.mine(event.target) || !this.selection.size || !event.clipboardData) return;
    const elements = this.selected();
    const assets: Assets = {};
    const all = this.source.assets();
    for (const element of elements) if (element.type === "image" && all[element.asset]) assets[element.asset] = all[element.asset];
    const text = elements.filter((element): element is TextElement => element.type === "text").map((element) => element.text).join("\n\n") || " ";
    event.clipboardData.setData(CLIP_TYPE, JSON.stringify({ board: 2, elements, assets }));
    event.clipboardData.setData("text/plain", text);
    this.lastCopy = { text, elements, assets };
    event.preventDefault();
    if (event.type === "cut") this.deleteSelection();
  };

  /** Puts elements (already checked) on the board around `at`, with the pictures they show. */
  pasteElements(checked: readonly Element[], assets: Assets, at = this.anchor()) {
    if (!checked.length) return;
    for (const [id, data] of Object.entries(assets)) if (isAssetId(id) && isAssetData(data)) this.source.putAsset(id, data);
    const bounds = boundsOf(checked)!;
    const dx = at[0] - (bounds.x + bounds.w / 2);
    const dy = at[1] - (bounds.y + bounds.h / 2);
    const moved = checked.map((element) => ({ ...moveElement(element, dx, dy), id: newId() }));
    this.setTool("select");
    this.apply([...this.source.elements(), ...moved]);
    this.setSelection(moved.map((element) => element.id));
  }

  pasteText(text: string, at = this.anchor()) {
    const style = this.style.text;
    const lines = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "").slice(0, 20_000);
    if (!lines) return;
    const element: TextElement = { id: newId(), type: "text", x: at[0], y: at[1], angle: 0, text: lines, fontSize: style.fontSize, color: style.color, wrap: lines.split("\n").some((line) => line.length > 60) ? style.fontSize * 28 : null };
    this.setTool("select");
    this.apply([...this.source.elements(), element]);
    this.setSelection([element.id]);
  }

  private paste = (event: ClipboardEvent) => {
    if (isTyping(event.target) || !this.mine(event.target) || !event.clipboardData) return;
    const data = event.clipboardData;
    event.preventDefault();
    const raw = data.getData(CLIP_TYPE);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { elements?: unknown[]; assets?: unknown };
        if (Array.isArray(parsed.elements)) { this.pasteChecked(parsed.elements, parsed.assets ?? {}); return; }
      } catch { /* taken as text below */ }
    }
    const images = [...data.files].filter((file) => file.type.startsWith("image/"));
    if (images.length) { void this.insertImages(images); return; }
    const text = data.getData("text/plain");
    if (this.lastCopy && text === this.lastCopy.text) { this.pasteChecked(this.lastCopy.elements, this.lastCopy.assets); return; }
    if (text.trim()) this.pasteText(text);
  };

  /** Pastes elements from a clipboard, each checked as a file's would be. */
  private pasteChecked(list: unknown[], assets: unknown) {
    const elements = list.slice(0, 5000).map(cleanElement).filter((element): element is Element => element !== null);
    this.pasteElements(elements, assets && typeof assets === "object" ? assets as Assets : {});
  }

  private dragOver = (event: DragEvent) => {
    if (event.dataTransfer && [...event.dataTransfer.types].includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }
  };

  private drop = (event: DragEvent) => {
    const images = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    event.preventDefault();
    const [sx, sy] = this.at(event);
    void this.insertImages(images, this.toBoard(sx, sy));
  };

  /** Asks for pictures from this device (a tablet offers its camera too) and puts them in the middle of the view. */
  pickImages() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = () => { if (input.files?.length) void this.insertImages([...input.files], this.toBoard(this.renderer.width / 2, this.renderer.height / 2)); };
    input.click();
  }

  async insertImages(files: Blob[], at = this.anchor()) {
    const made: Element[] = [];
    let [cx, cy] = at;
    for (const file of files) {
      try {
        const { data, width, height } = await readPicture(file);
        const id = assetId(new TextEncoder().encode(data));
        this.source.putAsset(id, data);
        // As large as it is, but no more than 60 % of the view.
        const k = Math.min(1, (this.renderer.width * 0.6) / this.view.scale / width, (this.renderer.height * 0.6) / this.view.scale / height);
        const w = width * k;
        const h = height * k;
        made.push({ id: newId(), type: "image", x: round(cx - w / 2), y: round(cy - h / 2), w: round(w), h: round(h), angle: 0, asset: id });
        cx += 24 / this.view.scale;
        cy += 24 / this.view.scale;
      } catch (error) {
        this.options.toast?.(error instanceof Error && error.message === "too-big" ? this.options.words.imageTooBig : this.options.words.imageFailed);
      }
    }
    if (!made.length) return;
    this.setTool("select");
    this.apply([...this.source.elements(), ...made]);
    this.setSelection(made.map((element) => element.id));
  }
}

/** The longest side a picture is kept at; a larger one is scaled down when it is put on a board. */
const LONGEST = 2400;
const KEPT_AS_IS = /^image\/(png|jpeg|webp|gif)$/;

const asDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

/**
 * A picture as a board keeps it: a raster image as a `data:` URL, no larger than it needs to
 * be. A large photo, or anything that is not PNG, JPEG, WebP or GIF (an SVG, say, which could
 * carry script), is drawn again at most `LONGEST` pixels across.
 */
export const readPicture = async (file: Blob): Promise<{ data: string; width: number; height: number }> => {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const width = image.naturalWidth || 300;
    const height = image.naturalHeight || 200;
    if (KEPT_AS_IS.test(file.type) && Math.max(width, height) <= LONGEST && file.size <= 1.5 * 1024 * 1024) {
      return { data: await asDataUrl(file), width, height };
    }
    const k = Math.min(1, LONGEST / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * k));
    canvas.height = Math.max(1, Math.round(height * k));
    canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
    if (!blob) throw new Error("unreadable");
    const data = await asDataUrl(blob);
    if (data.length > MOST_ASSET) throw new Error("too-big");
    return { data, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
};

