import { boundsOf, erased, farEnough, fitView, INK_SHADES, newStrokeId, zoomAt, type Ink, type Stroke, type View } from "./model";

/**
 * Drawing on a board in a <canvas>, with a mouse, a pen or fingers — the same code in the
 * editor and on a tablet (src/pad), so a board looks and behaves alike on both.
 *
 * The canvas owns nothing: it draws what its `BoardSource` holds, and turns a hand's
 * movements into calls on it. Each view has its own pan and zoom.
 *
 * - The pen tool draws with the primary button, a pen, or one finger; the eraser rubs out
 *   whole strokes it passes over; the hand pans.
 * - Two fingers pan and pinch in any tool. A finger that started a line and is joined by a
 *   second one was the start of a pinch, so its line is taken back.
 * - Once a pen has been seen, fingers only pan and pinch: a hand resting on a tablet while
 *   writing with a stylus does not draw.
 * - The middle button, or space held down, pans with the mouse; the wheel scrolls, and zooms
 *   with Ctrl/⌘ (which is also what a trackpad pinch sends).
 */

export type BoardSource = {
  strokes(): readonly Stroke[];
  /** Called after every change to the strokes; returns the way to stop. */
  subscribe(listener: () => void): () => void;
  begin(stroke: Stroke): void;
  extend(id: string, points: number[]): void;
  end(id: string): void;
  erase(ids: string[]): void;
};

export type Tool = "pen" | "eraser" | "hand";

type Options = {
  /** Whether the board is drawn dark, now: the background and every ink follow it. */
  dark: () => boolean;
  /** Told whenever the zoom changes, for a percentage shown beside the board. */
  onZoom?: (scale: number) => void;
};

/** The eraser's reach, in screen pixels. */
const ERASER = 12;

export class BoardCanvas {
  tool: Tool = "pen";
  ink: Ink = "ink";
  width = 4;
  private view: View = { x: 0, y: 0, scale: 1 };
  private readonly canvas: HTMLCanvasElement;
  private readonly source: BoardSource;
  private readonly options: Options;
  private readonly context: CanvasRenderingContext2D;
  private frame = 0;
  private stopFollowing: () => void;
  private resizing: ResizeObserver;
  /** Pointers down on the board now, where they were last. */
  private pointers = new Map<number, { x: number; y: number; type: string }>();
  private drawing: { pointer: number; id: string; lastX: number; lastY: number; queued: number[]; points: number } | null = null;
  private erasing: { pointer: number; x: number; y: number } | null = null;
  private panning: { pointer: number; x: number; y: number } | null = null;
  private pinch: { distance: number; x: number; y: number } | null = null;
  private penSeen = false;
  private spaceHeld = false;
  private hover: { x: number; y: number } | null = null;
  private fitted = false;

  constructor(canvas: HTMLCanvasElement, source: BoardSource, options: Options) {
    this.canvas = canvas;
    this.source = source;
    this.options = options;
    this.context = canvas.getContext("2d")!;
    this.stopFollowing = source.subscribe(() => this.redraw());
    this.resizing = new ResizeObserver(() => this.resize());
    this.resizing.observe(canvas);
    canvas.addEventListener("pointerdown", this.down);
    canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerup", this.up);
    canvas.addEventListener("pointercancel", this.up);
    canvas.addEventListener("pointerleave", this.leave);
    canvas.addEventListener("wheel", this.wheel, { passive: false });
    canvas.addEventListener("contextmenu", this.noMenu);
    window.addEventListener("keydown", this.key);
    window.addEventListener("keyup", this.key);
    this.resize();
  }

  destroy() {
    this.flush();
    cancelAnimationFrame(this.frame);
    this.stopFollowing();
    this.resizing.disconnect();
    this.canvas.removeEventListener("pointerdown", this.down);
    this.canvas.removeEventListener("pointermove", this.move);
    this.canvas.removeEventListener("pointerup", this.up);
    this.canvas.removeEventListener("pointercancel", this.up);
    this.canvas.removeEventListener("pointerleave", this.leave);
    this.canvas.removeEventListener("wheel", this.wheel);
    this.canvas.removeEventListener("contextmenu", this.noMenu);
    window.removeEventListener("keydown", this.key);
    window.removeEventListener("keyup", this.key);
  }

  setTool(tool: Tool) { this.tool = tool; this.redraw(); }

  /** Shows everything on the board. */
  fit() {
    const { width, height } = this.size();
    this.setView(fitView(boundsOf(this.source.strokes()), width, height));
  }

  /** Zooms about the middle of the view. */
  zoom(factor: number) {
    const { width, height } = this.size();
    this.setView(zoomAt(this.view, factor, width / 2, height / 2));
  }

  /** The theme changed: everything is drawn again in the new shades. */
  redraw() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.paint());
  }

  private setView(view: View) {
    this.view = view;
    this.options.onZoom?.(view.scale);
    this.redraw();
  }

  private size() {
    return { width: this.canvas.clientWidth, height: this.canvas.clientHeight };
  }

  private resize() {
    const ratio = window.devicePixelRatio || 1;
    const { width, height } = this.size();
    this.canvas.width = Math.max(1, Math.round(width * ratio));
    this.canvas.height = Math.max(1, Math.round(height * ratio));
    // The first time the board has a size, it opens on what is drawn on it.
    if (!this.fitted && width > 0 && height > 0) {
      this.fitted = true;
      this.fit();
    }
    this.paint();
  }

  private toBoard(event: { clientX: number; clientY: number }) {
    const box = this.canvas.getBoundingClientRect();
    const sx = event.clientX - box.left;
    const sy = event.clientY - box.top;
    return { sx, sy, x: this.view.x + sx / this.view.scale, y: this.view.y + sy / this.view.scale };
  }

  private paint() {
    const { context, canvas, view } = this;
    const ratio = window.devicePixelRatio || 1;
    const dark = this.options.dark();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = dark ? "#1c1e22" : "#fbfaf6";
    context.fillRect(0, 0, canvas.width, canvas.height);
    // A dot every 40 units, to tell panning from nothing happening; left out when it would be a haze.
    const step = 40 * view.scale;
    if (step >= 14) {
      context.fillStyle = dark ? "rgba(255,255,255,.09)" : "rgba(0,0,0,.08)";
      const startX = (-view.x * view.scale) % step;
      const startY = (-view.y * view.scale) % step;
      const dot = Math.max(1, ratio);
      for (let x = startX < 0 ? startX + step : startX; x < canvas.width / ratio; x += step) {
        for (let y = startY < 0 ? startY + step : startY; y < canvas.height / ratio; y += step) context.fillRect(x * ratio - dot / 2, y * ratio - dot / 2, dot, dot);
      }
    }
    context.setTransform(ratio * view.scale, 0, 0, ratio * view.scale, -view.x * view.scale * ratio, -view.y * view.scale * ratio);
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const stroke of this.source.strokes()) {
      context.strokeStyle = INK_SHADES[stroke.ink][dark ? "dark" : "light"];
      context.lineWidth = stroke.width;
      const points = stroke.points;
      context.beginPath();
      context.moveTo(points[0], points[1]);
      if (points.length === 2) context.lineTo(points[0] + 0.01, points[1]);
      // Through the middles of the segments, so a line drawn by hand comes out round.
      for (let index = 2; index < points.length - 2; index += 2) {
        context.quadraticCurveTo(points[index], points[index + 1], (points[index] + points[index + 2]) / 2, (points[index + 1] + points[index + 3]) / 2);
      }
      if (points.length > 2) context.lineTo(points[points.length - 2], points[points.length - 1]);
      context.stroke();
    }
    if (this.tool === "eraser" && this.hover) {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.strokeStyle = dark ? "rgba(255,255,255,.55)" : "rgba(0,0,0,.45)";
      context.lineWidth = 1;
      context.beginPath();
      context.arc(this.hover.x, this.hover.y, ERASER, 0, Math.PI * 2);
      context.stroke();
    }
  }

  /** Sends the points a stroke gathered since the last frame. */
  private flush() {
    const drawing = this.drawing;
    if (drawing?.queued.length) {
      this.source.extend(drawing.id, drawing.queued);
      drawing.queued = [];
    }
  }

  private queueFlush() {
    requestAnimationFrame(() => this.flush());
  }

  private startPinch() {
    const [a, b] = [...this.pointers.values()];
    this.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  private down = (event: PointerEvent) => {
    if (event.pointerType === "pen") this.penSeen = true;
    const at = this.toBoard(event);
    this.pointers.set(event.pointerId, { x: at.sx, y: at.sy, type: event.pointerType });
    // Refused for a pointer the browser no longer counts as down; the stroke goes on without it.
    try { this.canvas.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
    event.preventDefault();
    const touches = [...this.pointers.values()].filter((pointer) => pointer.type === "touch");
    if (event.pointerType === "touch" && touches.length >= 2) {
      // The first finger was the start of a pinch, not of a line.
      if (this.drawing) {
        const taken = this.drawing.id;
        this.drawing = null;
        this.source.erase([taken]);
      }
      this.erasing = null;
      this.panning = null;
      this.startPinch();
      return;
    }
    const pans = event.button === 1 || this.tool === "hand" || this.spaceHeld || (event.pointerType === "touch" && this.penSeen);
    if (pans) {
      this.panning = { pointer: event.pointerId, x: at.sx, y: at.sy };
      return;
    }
    if (event.button !== 0 || this.drawing || this.erasing) return;
    if (this.tool === "eraser") {
      this.erasing = { pointer: event.pointerId, x: at.x, y: at.y };
      this.rub(at.x, at.y);
      return;
    }
    const id = newStrokeId();
    this.drawing = { pointer: event.pointerId, id, lastX: at.x, lastY: at.y, queued: [], points: 1 };
    this.source.begin({ id, ink: this.ink, width: this.width, points: [round(at.x), round(at.y)] });
  };

  private move = (event: PointerEvent) => {
    const at = this.toBoard(event);
    this.hover = { x: at.sx, y: at.sy };
    const pointer = this.pointers.get(event.pointerId);
    if (pointer) { pointer.x = at.sx; pointer.y = at.sy; }
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const x = (a.x + b.x) / 2;
      const y = (a.y + b.y) / 2;
      let view = zoomAt(this.view, distance / Math.max(1, this.pinch.distance), x, y);
      view = { ...view, x: view.x - (x - this.pinch.x) / view.scale, y: view.y - (y - this.pinch.y) / view.scale };
      this.pinch = { distance, x, y };
      this.setView(view);
      return;
    }
    if (this.panning?.pointer === event.pointerId) {
      this.setView({ ...this.view, x: this.view.x - (at.sx - this.panning.x) / this.view.scale, y: this.view.y - (at.sy - this.panning.y) / this.view.scale });
      this.panning = { pointer: event.pointerId, x: at.sx, y: at.sy };
      return;
    }
    if (this.erasing?.pointer === event.pointerId) {
      this.rub(at.x, at.y);
      return;
    }
    const drawing = this.drawing;
    if (drawing?.pointer === event.pointerId) {
      // Every sample the hardware took since the last event, not only the last one.
      const samples = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
      for (const sample of samples.length ? samples : [event]) {
        const point = this.toBoard(sample);
        if (!farEnough(drawing.lastX, drawing.lastY, point.x, point.y, this.view.scale)) continue;
        drawing.queued.push(round(point.x), round(point.y));
        drawing.lastX = point.x;
        drawing.lastY = point.y;
        drawing.points += 1;
      }
      if (drawing.queued.length) this.queueFlush();
      return;
    }
    if (this.tool === "eraser") this.redraw();
  };

  private up = (event: PointerEvent) => {
    this.pointers.delete(event.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }
    if (this.panning?.pointer === event.pointerId) this.panning = null;
    if (this.erasing?.pointer === event.pointerId) this.erasing = null;
    const drawing = this.drawing;
    if (drawing?.pointer === event.pointerId) {
      this.flush();
      this.drawing = null;
      this.source.end(drawing.id);
    }
  };

  private leave = () => {
    this.hover = null;
    if (this.tool === "eraser") this.redraw();
  };

  /** Rubs out what the eraser passed over since it was last here. */
  private rub(x: number, y: number) {
    const erasing = this.erasing;
    if (!erasing) return;
    const ids = erased(this.source.strokes(), erasing.x, erasing.y, x, y, ERASER / this.view.scale);
    erasing.x = x;
    erasing.y = y;
    if (ids.length) this.source.erase(ids);
    this.redraw();
  }

  private wheel = (event: WheelEvent) => {
    event.preventDefault();
    const at = this.toBoard(event);
    // Lines rather than pixels, from some mice.
    const unit = event.deltaMode === 1 ? 16 : 1;
    if (event.ctrlKey || event.metaKey) {
      this.setView(zoomAt(this.view, Math.exp(-event.deltaY * unit * 0.01), at.sx, at.sy));
    } else {
      this.setView({ ...this.view, x: this.view.x + event.deltaX * unit / this.view.scale, y: this.view.y + event.deltaY * unit / this.view.scale });
    }
  };

  private key = (event: KeyboardEvent) => {
    if (event.code !== "Space") return;
    const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
    if (!typing) this.spaceHeld = event.type === "keydown";
  };

  private noMenu = (event: Event) => event.preventDefault();
}

const round = (value: number) => Math.round(value * 10) / 10;
