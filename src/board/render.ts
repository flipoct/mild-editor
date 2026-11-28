import katex from "katex";
import "katex/dist/katex.min.css";
import { getStroke } from "perfect-freehand";
import { aabb, box, centreOf, fillShade, frameOf, handlesOf, intersects, isLine, richParts, strokeShade, textSizes, type Assets, type Box, type Element, type PenElement, type TextElement, type View } from "./model";

/**
 * Drawing a board on screen (canvas.ts decides what): a canvas for everything but writing, a
 * layer of HTML over it for writing and formulas (KaTeX lays them out, and only a browser can
 * measure them), and a canvas over both for what is being done — the selection's frame and
 * handles, a shape being dragged out, the marquee, the eraser.
 *
 * So writing is always over pictures, pen lines and shapes, whatever their order.
 */

/** What the renderer draws, as the canvas has it now. */
export type Scene = {
  elements(): readonly Element[];
  assets(): Assets;
  view: View;
  dark(): boolean;
  grid: boolean;
  /** The selection to frame, if any is shown. */
  framed(): readonly Element[];
  /** Elements the eraser has passed over, shown faint until it lets go. */
  erasing: ReadonlySet<string>;
  /** A shape being dragged out, not on the board yet. */
  draft: Element | null;
  /** The pen line this view is drawing now, outlined as it goes. */
  liveId: string | null;
  marquee: Box | null;
  /** Writing being edited, hidden under its editor. */
  editingId: string | null;
  /** The eraser's circle, in screen pixels. */
  eraser: { x: number; y: number; radius: number } | null;
};

/** How writing looks, on screen and in an exported picture alike. */
export const TEXT_CSS = `
.board-t, .board-editor, .board-preview {
  font-family: "Pretendard Variable", Pretendard, "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif;
  line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; letter-spacing: 0;
}
.board-t { position: absolute; margin: 0; transform-origin: center; }
.board-t .katex-display, .board-preview .katex-display { margin: 0.25em 0; }
`;

if (typeof document !== "undefined" && !document.getElementById("board-text-css")) {
  const style = document.createElement("style");
  style.id = "board-text-css";
  style.textContent = TEXT_CSS;
  document.head.append(style);
}

const escape = (text: string) => text.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!);

/** Writing as HTML: its formulas laid out by KaTeX, everything else as text. */
export const renderRich = (text: string) => richParts(text).map((part) => {
  if (part.kind === "text") return escape(part.value);
  try {
    return katex.renderToString(part.value, { displayMode: part.kind === "display", throwOnError: false, strict: false, output: "html", trust: false, maxSize: 50, maxExpand: 500 });
  } catch {
    return escape(part.kind === "display" ? `$$${part.value}$$` : `$${part.value}$`);
  }
}).join("");

export const styleText = (node: HTMLElement, element: TextElement, dark: boolean) => {
  const style = node.style;
  style.left = `${element.x}px`;
  style.top = `${element.y}px`;
  style.fontSize = `${element.fontSize}px`;
  style.color = strokeShade(element.color, dark);
  style.width = element.wrap ? `${element.wrap}px` : "max-content";
  style.transform = element.angle ? `rotate(${element.angle}rad)` : "";
};

// ── Pen lines ──

const outlines = new WeakMap<number[], { size: number; hl: boolean; path: Path2D }>();
const ease = (t: number) => Math.sin((t * Math.PI) / 2);

const penPath = (element: PenElement, live: boolean) => {
  const known = live ? null : outlines.get(element.points);
  if (known && known.size === element.size && known.hl === Boolean(element.hl)) return known.path;
  const triples: [number, number, number][] = [];
  for (let index = 0; index < element.points.length; index += 3) triples.push([element.points[index], element.points[index + 1], element.points[index + 2]]);
  const outline = getStroke(triples, element.hl
    ? { size: element.size, thinning: 0, smoothing: 0.5, streamline: 0.45, simulatePressure: false, last: !live }
    : { size: element.size * 1.9, thinning: 0.6, smoothing: 0.5, streamline: 0.5, easing: ease, simulatePressure: !element.pressure, last: !live });
  const path = new Path2D();
  if (outline.length > 1) {
    path.moveTo(outline[0][0], outline[0][1]);
    for (let index = 1; index < outline.length; index += 1) {
      const a = outline[index];
      const b = outline[(index + 1) % outline.length];
      path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    }
    path.closePath();
  }
  if (!live) outlines.set(element.points, { size: element.size, hl: Boolean(element.hl), path });
  return path;
};

// ── Pictures ──

export type Pictures = {
  /** The picture for an asset, loading it the first time: "broken" when it cannot be shown. */
  get(id: string): HTMLImageElement | "loading" | "broken";
  /** Resolves once every one of `ids` has loaded or failed. */
  ready(ids: string[]): Promise<void>;
};

export const pictures = (assets: () => Assets, loaded: () => void): Pictures => {
  const known = new Map<string, { data: string; image: HTMLImageElement; state: "loading" | "ok" | "broken" }>();
  const entry = (id: string) => {
    const data = assets()[id];
    let item = known.get(id);
    if (item && (item.data === data || !data)) return item;
    if (!data) return null;
    const image = new Image();
    const made = { data, image, state: "loading" as "loading" | "ok" | "broken" };
    image.onload = () => { made.state = "ok"; loaded(); };
    image.onerror = () => { made.state = "broken"; loaded(); };
    image.src = data;
    known.set(id, made);
    item = made;
    return item;
  };
  return {
    get: (id) => {
      const item = entry(id);
      return !item ? "broken" : item.state === "ok" ? item.image : item.state;
    },
    ready: async (ids) => {
      await Promise.all(ids.map((id) => {
        const item = entry(id);
        if (!item || item.state !== "loading") return undefined;
        return new Promise<void>((resolve) => {
          item.image.addEventListener("load", () => resolve(), { once: true });
          item.image.addEventListener("error", () => resolve(), { once: true });
        });
      }));
    },
  };
};

/** Draws one element that is not writing: on screen, and in an exported picture. */
export const drawElement = (context: CanvasRenderingContext2D, element: Element, dark: boolean, images: Pictures, options: { live?: boolean; faint?: boolean } = {}) => {
  if (element.type === "text") return;
  const b = box(element);
  context.save();
  if (element.angle && !isLine(element)) {
    const [cx, cy] = centreOf(b);
    context.translate(cx, cy);
    context.rotate(element.angle);
    context.translate(-cx, -cy);
  }
  let alpha = element.type === "pen" && element.hl ? 0.38 : 1;
  if (options.faint) alpha *= 0.22;
  context.globalAlpha = alpha;
  context.lineCap = "round";
  context.lineJoin = "round";
  switch (element.type) {
    case "pen":
      context.translate(element.x, element.y);
      context.fillStyle = strokeShade(element.color, dark);
      context.fill(penPath(element, Boolean(options.live)));
      break;
    case "image": {
      const image = images.get(element.asset);
      if (typeof image !== "string") {
        context.imageSmoothingQuality = "high";
        context.drawImage(image, b.x, b.y, b.w, b.h);
      } else {
        context.fillStyle = fillShade("gray", dark);
        context.fillRect(b.x, b.y, b.w, b.h);
        if (image === "broken") {
          context.strokeStyle = strokeShade("gray", dark);
          context.lineWidth = 2;
          context.beginPath();
          context.moveTo(b.x, b.y); context.lineTo(b.x + b.w, b.y + b.h);
          context.moveTo(b.x + b.w, b.y); context.lineTo(b.x, b.y + b.h);
          context.stroke();
        }
      }
      break;
    }
    case "rect":
    case "ellipse":
      context.beginPath();
      if (element.type === "rect") context.roundRect(b.x, b.y, b.w, b.h, Math.min(10, Math.min(b.w, b.h) * 0.15));
      else context.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      if (element.fill !== "none") { context.fillStyle = fillShade(element.fill, dark); context.fill(); }
      context.strokeStyle = strokeShade(element.color, dark);
      context.lineWidth = element.size;
      context.stroke();
      break;
    case "line":
    case "arrow": {
      context.strokeStyle = strokeShade(element.color, dark);
      context.lineWidth = element.size;
      context.beginPath();
      context.moveTo(element.x, element.y);
      context.lineTo(element.x2, element.y2);
      if (element.type === "arrow") {
        const length = Math.hypot(element.x2 - element.x, element.y2 - element.y);
        const head = Math.min(10 + element.size * 3, length * 0.5);
        const angle = Math.atan2(element.y2 - element.y, element.x2 - element.x);
        for (const side of [-0.45, 0.45]) {
          context.moveTo(element.x2, element.y2);
          context.lineTo(element.x2 - head * Math.cos(angle + side), element.y2 - head * Math.sin(angle + side));
        }
      }
      context.stroke();
      break;
    }
  }
  context.restore();
};

export const canvasShade = (dark: boolean) => dark ? "#1c1e22" : "#fbfaf6";
const accentShade = (dark: boolean) => dark ? "#7c9cff" : "#3d63dd";

export class BoardRenderer {
  readonly scene: HTMLCanvasElement;
  readonly layer: HTMLDivElement;
  readonly overlay: HTMLCanvasElement;
  readonly images: Pictures;
  private readonly stage: HTMLElement;
  private readonly state: Scene;
  private readonly sceneContext: CanvasRenderingContext2D;
  private readonly overlayContext: CanvasRenderingContext2D;
  private ratio = 1;
  width = 0;
  height = 0;
  private sceneDirty = true;
  private frame = 0;
  private nodes = new Map<string, { node: HTMLDivElement; element: TextElement | null; dark: boolean; order: number }>();
  private resizing: ResizeObserver;

  constructor(stage: HTMLElement, state: Scene, onResize: () => void) {
    this.stage = stage;
    this.state = state;
    this.scene = document.createElement("canvas");
    this.scene.className = "board-scene";
    this.layer = document.createElement("div");
    this.layer.className = "board-textlayer";
    this.overlay = document.createElement("canvas");
    this.overlay.className = "board-overlay";
    stage.append(this.scene, this.layer, this.overlay);
    this.sceneContext = this.scene.getContext("2d")!;
    this.overlayContext = this.overlay.getContext("2d")!;
    this.images = pictures(() => state.assets(), () => this.invalidate());
    this.resizing = new ResizeObserver(() => { this.resize(); onResize(); });
    this.resizing.observe(stage);
    document.fonts?.addEventListener("loadingdone", this.remeasure);
    this.resize();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.resizing.disconnect();
    document.fonts?.removeEventListener("loadingdone", this.remeasure);
    this.scene.remove();
    this.layer.remove();
    this.overlay.remove();
    for (const id of this.nodes.keys()) textSizes.delete(id);
  }

  /** Draws again on the next frame; the overlay only, unless `sceneToo`. */
  invalidate(sceneToo = true) {
    if (sceneToo) this.sceneDirty = true;
    if (!this.frame) this.frame = requestAnimationFrame(() => this.paint());
  }

  /** Draws now, writing measured again: for an export, or a check. */
  flush() {
    cancelAnimationFrame(this.frame);
    this.sceneDirty = true;
    this.paint();
  }

  textNode(id: string) { return this.nodes.get(id)?.node ?? null; }

  private remeasure = () => {
    for (const [id, item] of this.nodes) textSizes.set(id, { w: item.node.offsetWidth, h: item.node.offsetHeight });
    this.invalidate();
  };

  private resize() {
    this.ratio = window.devicePixelRatio || 1;
    this.width = this.stage.clientWidth;
    this.height = this.stage.clientHeight;
    for (const canvas of [this.scene, this.overlay]) {
      canvas.width = Math.max(1, Math.round(this.width * this.ratio));
      canvas.height = Math.max(1, Math.round(this.height * this.ratio));
    }
    this.flush();
  }

  private paint() {
    this.frame = 0;
    if (this.sceneDirty) {
      this.sceneDirty = false;
      this.syncText();
      this.drawScene();
    }
    this.drawOverlay();
  }

  private drawGrid(dark: boolean) {
    const { view } = this.state;
    const context = this.sceneContext;
    let spacing = 24;
    while (spacing * view.scale < 16) spacing *= 2;
    while (spacing * view.scale > 48) spacing /= 2;
    const step = spacing * view.scale;
    const dot = Math.max(1, Math.round(this.ratio));
    context.fillStyle = dark ? "rgba(255,255,255,.1)" : "rgba(0,0,0,.11)";
    context.beginPath();
    const startX = ((-view.x * view.scale) % step + step) % step;
    const startY = ((-view.y * view.scale) % step + step) % step;
    for (let y = startY; y < this.height; y += step) {
      for (let x = startX; x < this.width; x += step) context.rect(Math.round(x * this.ratio) - dot / 2, Math.round(y * this.ratio) - dot / 2, dot, dot);
    }
    context.fill();
  }

  private toScreen(context: CanvasRenderingContext2D) {
    const { view } = this.state;
    const k = this.ratio * view.scale;
    context.setTransform(k, 0, 0, k, -view.x * k, -view.y * k);
  }

  private drawScene() {
    const context = this.sceneContext;
    const dark = this.state.dark();
    const { view } = this.state;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = canvasShade(dark);
    context.fillRect(0, 0, this.scene.width, this.scene.height);
    if (this.state.grid) this.drawGrid(dark);
    this.toScreen(context);
    const seen: Box = { x: view.x, y: view.y, w: this.width / view.scale, h: this.height / view.scale };
    for (const element of this.state.elements()) {
      if (element.type === "text") continue;
      const b = aabb(element);
      const margin = ("size" in element ? element.size : 0) + 2;
      if (!intersects({ x: b.x - margin, y: b.y - margin, w: b.w + margin * 2, h: b.h + margin * 2 }, seen)) continue;
      drawElement(context, element, dark, this.images, { live: element.id === this.state.liveId, faint: this.state.erasing.has(element.id) });
    }
  }

  private syncText() {
    const { view } = this.state;
    const dark = this.state.dark();
    this.layer.style.transform = `translate(${-view.x * view.scale}px, ${-view.y * view.scale}px) scale(${view.scale})`;
    const seen = new Set<string>();
    const measure: { id: string; node: HTMLDivElement }[] = [];
    let order = 0;
    for (const element of this.state.elements()) {
      if (element.type !== "text") continue;
      seen.add(element.id);
      let item = this.nodes.get(element.id);
      if (!item) {
        const node = document.createElement("div");
        node.className = "board-t";
        this.layer.append(node);
        item = { node, element: null, dark, order: -1 };
        this.nodes.set(element.id, item);
      }
      if (item.element !== element || item.dark !== dark) {
        if (!item.element || item.element.text !== element.text) item.node.innerHTML = renderRich(element.text);
        styleText(item.node, element, dark);
        item.element = element;
        item.dark = dark;
        measure.push({ id: element.id, node: item.node });
      }
      if (item.order !== order) { item.node.style.zIndex = String(order); item.order = order; }
      order += 1;
      item.node.style.visibility = this.state.editingId === element.id ? "hidden" : "";
      item.node.classList.toggle("erasing", this.state.erasing.has(element.id));
    }
    for (const [id, item] of this.nodes) {
      if (seen.has(id)) continue;
      item.node.remove();
      this.nodes.delete(id);
      textSizes.delete(id);
    }
    for (const { id, node } of measure) textSizes.set(id, { w: node.offsetWidth, h: node.offsetHeight });
  }

  private drawOverlay() {
    const context = this.overlayContext;
    const { view } = this.state;
    const dark = this.state.dark();
    const accent = accentShade(dark);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (this.state.draft) {
      this.toScreen(context);
      drawElement(context, this.state.draft, dark, this.images, { live: true });
    }
    context.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    const screen = (x: number, y: number): [number, number] => [(x - view.x) * view.scale, (y - view.y) * view.scale];

    const framed = this.state.framed();
    if (framed.length) {
      context.strokeStyle = accent;
      context.lineWidth = 1;
      const outline = (frame: NonNullable<ReturnType<typeof frameOf>>, pad: number) => {
        const corners = handlesOf({ ...frame, single: null }, view.scale, pad).slice(0, 4).map((handle) => screen(handle.x, handle.y));
        context.beginPath();
        corners.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
        context.closePath();
        context.stroke();
      };
      const frame = frameOf(framed)!;
      if (framed.length > 1) {
        context.globalAlpha = 0.55;
        for (const element of framed) if (!isLine(element)) outline(frameOf([element])!, 2);
        context.globalAlpha = 1;
        context.setLineDash([5, 4]);
        outline(frame, 5);
        context.setLineDash([]);
      } else if (!isLine(framed[0])) {
        outline(frame, 5);
      }
      context.fillStyle = canvasShade(dark);
      context.lineWidth = 1.5;
      for (const handle of handlesOf(frame, view.scale)) {
        const [x, y] = screen(handle.x, handle.y);
        context.beginPath();
        if (handle.id === "rot" || handle.id === "p1" || handle.id === "p2") context.arc(x, y, 5, 0, Math.PI * 2);
        else context.roundRect(x - 4.5, y - 4.5, 9, 9, 2);
        context.fill();
        context.stroke();
      }
    }

    const marquee = this.state.marquee;
    if (marquee) {
      const [x, y] = screen(marquee.x, marquee.y);
      context.fillStyle = accent;
      context.globalAlpha = 0.08;
      context.fillRect(x, y, marquee.w * view.scale, marquee.h * view.scale);
      context.globalAlpha = 1;
      context.strokeStyle = accent;
      context.lineWidth = 1;
      context.strokeRect(x + 0.5, y + 0.5, marquee.w * view.scale, marquee.h * view.scale);
    }

    const eraser = this.state.eraser;
    if (eraser) {
      context.strokeStyle = dark ? "rgba(255,255,255,.55)" : "rgba(0,0,0,.45)";
      context.lineWidth = 1;
      context.beginPath();
      context.arc(eraser.x, eraser.y, eraser.radius, 0, Math.PI * 2);
      context.stroke();
    }
  }
}
