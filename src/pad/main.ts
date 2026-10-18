import { BoardCanvas, type BoardSource, type Tool } from "../board/canvas.ts";
import { INK_SHADES, INKS, WIDTHS, type Ink, type Stroke } from "../board/model.ts";
import { readToPad, type FromPad } from "../board/padProtocol.ts";
import "./pad.css";

/**
 * The tablet's page (pad.html): one board of the editor that served it, drawn on with a pen or
 * a finger. It talks to that editor only (src-tauri/src/pad.rs, src/board/pads.ts) — the token
 * in the address says which board — and keeps a copy of the board that the editor keeps up to
 * date. What is drawn here is shown at once and sent as it is drawn.
 */

const korean = /^ko\b/i.test(navigator.language);
const words = {
  connecting: korean ? "연결하는 중…" : "Connecting…",
  connected: korean ? "연결됨" : "Connected",
  lost: korean ? "연결이 끊겨 다시 연결하는 중…" : "Connection lost, reconnecting…",
  closed: korean ? "연결이 끝났습니다. 컴퓨터에서 QR 코드를 다시 여세요." : "Disconnected. Open the QR code on the computer again.",
  noToken: korean ? "QR 코드로 열어 주세요." : "Open this page from the QR code.",
  pen: korean ? "펜" : "Pen", eraser: korean ? "지우개" : "Eraser", hand: korean ? "이동" : "Move",
  undo: korean ? "내 마지막 획 지우기" : "Undo my last stroke", fit: korean ? "전체 보기" : "Show everything",
};

const token = location.hash.slice(1);
const status = document.getElementById("status")!;
const say = (text: string, tone: "" | "ok" | "warn" = "") => {
  status.textContent = text;
  status.className = tone;
  // "Connected" is only news for a moment.
  if (tone === "ok") window.setTimeout(() => { if (status.textContent === text) status.classList.add("quiet"); }, 1500);
};

// ── The board as this page has it ──

let strokes: Stroke[] = [];
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());
/** What this page drew, newest last, for undo. */
const mine: string[] = [];
let socket: WebSocket | null = null;
const send = (message: FromPad) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };

const source: BoardSource = {
  strokes: () => strokes,
  subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  begin: (stroke) => {
    strokes = [...strokes, stroke];
    mine.push(stroke.id);
    send({ t: "begin", stroke });
    changed();
  },
  extend: (id, points) => {
    strokes = strokes.map((stroke) => stroke.id === id ? { ...stroke, points: [...stroke.points, ...points] } : stroke);
    send({ t: "pts", id, pts: points });
    changed();
  },
  end: (id) => send({ t: "end", id }),
  erase: (ids) => {
    const gone = new Set(ids);
    strokes = strokes.filter((stroke) => !gone.has(stroke.id));
    send({ t: "erase", ids });
    changed();
  },
};

const receive = (text: string) => {
  const message = readToPad(text);
  if (!message) return;
  if (message.t === "state") {
    strokes = message.strokes;
    document.title = message.name ? `${message.name} · Mild Editor` : document.title;
  } else if (message.t === "add") {
    const known = strokes.findIndex((stroke) => stroke.id === message.stroke.id);
    strokes = known < 0 ? [...strokes, message.stroke] : strokes.map((stroke, index) => index === known ? message.stroke : stroke);
  } else if (message.t === "pts") {
    strokes = strokes.map((stroke) => stroke.id === message.id ? { ...stroke, points: [...stroke.points, ...message.pts] } : stroke);
  } else if (message.t === "del") {
    const gone = new Set(message.ids);
    strokes = strokes.filter((stroke) => !gone.has(stroke.id));
  } else if (message.t === "bye") {
    closed = true;
    socket?.close();
    say(words.closed, "warn");
    return;
  }
  changed();
};

// ── The connection ──

let closed = false;
let attempt = 0;
const connect = () => {
  if (closed) return;
  say(attempt ? words.lost : words.connecting, attempt ? "warn" : "");
  const next = new WebSocket(`ws://${location.host}/ws?t=${encodeURIComponent(token)}`);
  socket = next;
  next.onopen = () => {
    attempt = 0;
    say(words.connected, "ok");
    next.send(JSON.stringify({ t: "hello" } satisfies FromPad));
  };
  next.onmessage = (event) => { if (typeof event.data === "string") receive(event.data); };
  next.onclose = () => {
    if (socket !== next || closed) return;
    attempt += 1;
    // A refused pairing never comes back; anything else is retried, more slowly each time.
    window.setTimeout(connect, Math.min(10_000, 500 * 2 ** Math.min(attempt, 5)));
  };
};

// ── The tools ──

const dark = matchMedia("(prefers-color-scheme: dark)");
const canvas = document.getElementById("board") as HTMLCanvasElement;
const board = new BoardCanvas(canvas, source, { dark: () => dark.matches });
dark.addEventListener("change", () => board.redraw());

const icon = (path: string) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"/></svg>`;
const ICONS = {
  pen: "m10.6 2.6 2.8 2.8-7.6 7.6-3.5.7.7-3.5ZM9.2 4l2.8 2.8",
  eraser: "m6.4 13.2 7-7a1.2 1.2 0 0 0 0-1.7L11.5 2.6a1.2 1.2 0 0 0-1.7 0l-7 7a1.2 1.2 0 0 0 0 1.7l1.9 1.9ZM6.4 13.2h7M5.6 6.8l3.6 3.6",
  hand: "M5.6 8.4V3.6a1 1 0 0 1 2 0v4M7.6 7.6V2.8a1 1 0 0 1 2 0v4.8M9.6 7.6V3.6a1 1 0 0 1 2 0v5.6c0 2.6-1.8 4.6-4.4 4.6-1.6 0-2.6-.8-3.6-2.2L2 9.4a1 1 0 0 1 1.6-1.2l2 1.6",
  undo: "M5.4 6.2H10a3.2 3.2 0 0 1 0 6.4H6.4M7.6 3.6 5 6.2l2.6 2.6",
  fit: "M2.6 6V2.6H6M10 2.6h3.4V6M13.4 10v3.4H10M6 13.4H2.6V10",
};

const tools = document.getElementById("tools")!;
const buttons = { tool: new Map<Tool, HTMLButtonElement>(), ink: new Map<Ink, HTMLButtonElement>(), width: new Map<number, HTMLButtonElement>() };
const button = (label: string, html: string, onPress: () => void) => {
  const element = document.createElement("button");
  element.type = "button";
  element.title = label;
  element.setAttribute("aria-label", label);
  element.innerHTML = html;
  element.addEventListener("click", onPress);
  tools.append(element);
  return element;
};
const separator = () => { const element = document.createElement("span"); element.className = "sep"; tools.append(element); };

const refresh = () => {
  buttons.tool.forEach((element, tool) => element.classList.toggle("active", board.tool === tool));
  buttons.ink.forEach((element, ink) => {
    element.classList.toggle("active", board.ink === ink);
    element.style.setProperty("--ink", INK_SHADES[ink][dark.matches ? "dark" : "light"]);
  });
  buttons.width.forEach((element, width) => element.classList.toggle("active", board.width === width));
};
dark.addEventListener("change", refresh);

const pick = (tool: Tool) => { board.setTool(tool); refresh(); };
buttons.tool.set("pen", button(words.pen, icon(ICONS.pen), () => pick("pen")));
buttons.tool.set("eraser", button(words.eraser, icon(ICONS.eraser), () => pick("eraser")));
buttons.tool.set("hand", button(words.hand, icon(ICONS.hand), () => pick("hand")));
separator();
for (const ink of INKS) {
  const element = button(ink, "", () => { board.ink = ink; pick("pen"); });
  element.className = "ink";
  buttons.ink.set(ink, element);
}
separator();
for (const width of WIDTHS) {
  const element = button(`${width}`, `<i style="width:${width + 4}px;height:${width + 4}px"></i>`, () => { board.width = width; pick("pen"); });
  element.className = "width";
  buttons.width.set(width, element);
}
separator();
button(words.undo, icon(ICONS.undo), () => {
  // The newest stroke of this page's that is still on the board.
  while (mine.length) {
    const id = mine.pop()!;
    if (strokes.some((stroke) => stroke.id === id)) { source.erase([id]); break; }
  }
});
button(words.fit, icon(ICONS.fit), () => board.fit());
board.width = WIDTHS[1];
refresh();

if (token && /^[A-Za-z0-9]{16,}$/.test(token)) connect();
else say(words.noToken, "warn");
