import "../board/board.css";
import { BoardCanvas, type BoardSource } from "../board/canvas.ts";
import type { Assets, Element } from "../board/model.ts";
import { applyChange, changes, heard, newSent, readToPad, type FromPad } from "../board/padProtocol.ts";
import { mountBoardUi } from "../board/ui.ts";
import { boardWords } from "../board/words.ts";
import "./pad.css";

/**
 * The tablet's page (pad.html): one board of the editor that served it, drawn on with a pen or
 * a finger, with every tool the editor has. It talks to that editor only (src-tauri/src/pad.rs,
 * src/board/pads.ts) — the token in the address says which board — and keeps a copy of the
 * board that the editor keeps up to date. What is drawn here is shown at once and sent as it
 * is drawn.
 */

const korean = /^ko\b/i.test(navigator.language);
const words = boardWords(korean);
const status = {
  connecting: korean ? "연결하는 중…" : "Connecting…",
  connected: korean ? "연결됨" : "Connected",
  lost: korean ? "연결이 끊겨 다시 연결하는 중…" : "Connection lost, reconnecting…",
  closed: korean ? "연결이 끝났습니다. 컴퓨터에서 QR 코드를 다시 여세요." : "Disconnected. Open the QR code on the computer again.",
  noToken: korean ? "QR 코드로 열어 주세요." : "Open this page from the QR code.",
};

const token = location.hash.slice(1);
const line = document.getElementById("status")!;
const say = (text: string, tone: "" | "ok" | "warn" = "") => {
  line.textContent = text;
  line.className = tone;
  // "Connected" is only news for a moment.
  if (tone === "ok") window.setTimeout(() => { if (line.textContent === text) line.classList.add("quiet"); }, 1500);
};

// ── The board as this page has it ──

let elements: readonly Element[] = [];
let assets: Assets = {};
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());
/** What the editor has, as this page told it or heard from it. */
let sent = newSent();
let socket: WebSocket | null = null;
let sending = 0;

const send = (message: FromPad) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
/** Tells the editor what changed here, once a frame: a line being drawn changes every move. */
const tell = () => {
  if (sending) return;
  sending = requestAnimationFrame(() => {
    sending = 0;
    if (socket?.readyState === WebSocket.OPEN) changes(sent, elements, assets).forEach(send);
  });
};
const local = (next: readonly Element[]) => { elements = next; changed(); tell(); };

const source: BoardSource = {
  elements: () => elements,
  assets: () => assets,
  subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  begin: (element) => local([...elements, element]),
  extend: (id, points) => local(elements.map((element) => element.id === id && element.type === "pen" ? { ...element, points: [...element.points, ...points] } : element)),
  end: () => undefined,
  commit: (next) => local(next),
  putAsset: (id, data) => { if (assets[id] !== data) { assets = { ...assets, [id]: data }; changed(); } },
};

const receive = (text: string) => {
  const message = readToPad(text);
  if (!message) return;
  if (message.t === "state") {
    elements = message.elements;
    sent = newSent();
    sent.elements = new Map(elements.map((element) => [element.id, element]));
    sent.order = elements.map((element) => element.id);
    // The editor sends the pictures it shows next; the ones this page already has it keeps.
    sent.assets = new Set(Object.keys(assets));
    if (message.name) document.title = `${message.name} · Mild Editor`;
  } else if (message.t === "bye") {
    closed = true;
    socket?.close();
    say(status.closed, "warn");
    return;
  } else {
    heard(sent, message);
    if (message.t === "asset") assets = { ...assets, [message.id]: message.data };
    else elements = applyChange(elements, message);
  }
  changed();
};

// ── The connection ──

let closed = false;
let attempt = 0;
const connect = () => {
  if (closed) return;
  say(attempt ? status.lost : status.connecting, attempt ? "warn" : "");
  const next = new WebSocket(`ws://${location.host}/ws?t=${encodeURIComponent(token)}`);
  socket = next;
  next.onopen = () => {
    attempt = 0;
    say(status.connected, "ok");
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

// ── The board ──

const root = document.getElementById("pad")!;
const stage = document.getElementById("stage")!;
const dark = matchMedia("(prefers-color-scheme: dark)");
const theme = () => root.classList.toggle("board-dark", dark.matches);
theme();
let ui: ReturnType<typeof mountBoardUi> | null = null;
const board = new BoardCanvas(stage, source, { dark: () => dark.matches, words, scope: root, toast: (message) => ui?.toast(message) });
board.setTool("pen");
// For checking the page by hand while it is developed: the board and what it holds.
if (import.meta.env.DEV) Object.assign(window, { __board: board, __source: source });
ui =mountBoardUi(root, board, words, {
  name: () => document.title.split(" · ")[0] || "board",
  savePng: (blob, name) => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  },
});
dark.addEventListener("change", () => { theme(); board.redraw(); ui?.refresh(); });

if (token && /^[A-Za-z0-9]{16,}$/.test(token)) connect();
else say(status.noToken, "warn");
