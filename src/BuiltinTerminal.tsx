/**
 * The built-in terminal: xterm.js on the shell the backend runs on a pseudo-terminal.
 *
 * xterm.js is loaded the first time the terminal is shown, so an editor that never opens
 * it never pays for it. The terminal itself lives outside React: one instance, kept for the
 * whole session and moved into whichever element shows it, so hiding the panel, switching
 * its tab or moving it in the layout keeps the scrollback and the running shell.
 */
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { terminalKeyIsEditors as keyIsEditors, type TerminalKey } from "./workbench";

export type TerminalLook = { fontFamily: string; fontSize: number };
type OutputEvent = { sessionId: string; data: string };
type ExitEvent = { sessionId: string; code: number | null };

const isMac = /mac/i.test(navigator.platform || navigator.userAgent);

/** Keys typed into the terminal that belong to the editor; see `terminalKeyIsEditors` in workbench.ts. */
export const terminalKeyIsEditors = (event: TerminalKey) => keyIsEditors(event, isMac);

/** Whether a key event was typed into the terminal, where the editor's shortcuts stand aside. */
export const typedInTerminal = (event: Event) => event.target instanceof Element && Boolean(event.target.closest(".builtin-terminal"));

/** The terminal's colours from the theme's own tokens, so all seven themes reach it. */
const themeFromPage = () => {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: token("--bg-editor", "#1e1e1e"),
    foreground: token("--text", "#d4d4d4"),
    cursor: token("--accent", "#d4d4d4"),
    cursorAccent: token("--bg-editor", "#1e1e1e"),
    selectionBackground: token("--selection", "#264f78"),
  };
};

type Listener = (status: TerminalStatus) => void;
export type TerminalStatus = { running: boolean; shell: string; exitCode: number | null; error: string };

/** The one terminal of the window, outside React so it outlives any element showing it. */
class TerminalHost {
  readonly element: HTMLDivElement;
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private loading: Promise<void> | null = null;
  private sessionId = "";
  private status: TerminalStatus = { running: false, shell: "", exitCode: null, error: "" };
  private listeners = new Set<Listener>();
  private look: TerminalLook = { fontFamily: "monospace", fontSize: 13 };
  private cwd: string | null = null;
  private labels = { exited: "exited with", ended: "ended", again: "press Enter for a new shell" };

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "builtin-terminal-surface";
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.status);
    return () => { this.listeners.delete(listener); };
  }

  private report(patch: Partial<TerminalStatus>) {
    this.status = { ...this.status, ...patch };
    this.listeners.forEach((listener) => listener(this.status));
  }

  /** Loads xterm.js and builds the terminal, once; later calls wait for the same load. */
  load() {
    this.loading ??= (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css")]);
      const term = new Terminal({
        fontFamily: this.look.fontFamily,
        fontSize: this.look.fontSize,
        theme: themeFromPage(),
        cursorBlink: true,
        scrollback: 5000,
        allowProposedApi: false,
        macOptionIsMeta: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(this.element);
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;
        if (terminalKeyIsEditors(event)) return false;
        // Windows and Linux: Ctrl+C copies when there is a selection, as in other terminals,
        // and Ctrl+V pastes instead of sending ^V; without a selection Ctrl+C still interrupts.
        if (!isMac && event.ctrlKey && !event.altKey && event.key.toLowerCase() === "c" && term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection());
          term.clearSelection();
          return false;
        }
        if (!isMac && event.ctrlKey && !event.altKey && event.key.toLowerCase() === "v") return false;
        return true;
      });
      term.onData((data) => {
        if (this.sessionId) void invoke("terminal_write", { sessionId: this.sessionId, data }).catch(() => undefined);
        // After the shell has ended, Enter starts a new one where the last one started.
        else if (data.includes("\r") && this.status.exitCode !== null) void this.start(this.cwd);
      });
      term.onResize(({ cols, rows }) => {
        if (this.sessionId) void invoke("terminal_resize", { sessionId: this.sessionId, cols, rows }).catch(() => undefined);
      });
      await listen<OutputEvent>("terminal-output", (event) => {
        if (event.payload.sessionId === this.sessionId) term.write(event.payload.data);
      });
      await listen<ExitEvent>("terminal-exit", (event) => {
        if (event.payload.sessionId !== this.sessionId) return;
        this.sessionId = "";
        const ended = event.payload.code === null ? this.labels.ended : `${this.labels.exited} ${event.payload.code}`;
        term.write(`\r\n\x1b[2m[${ended} — ${this.labels.again}]\x1b[0m\r\n`);
        this.report({ running: false, exitCode: event.payload.code ?? -1 });
      });
      this.term = term;
      this.fit = fit;
    })();
    return this.loading;
  }

  /** Sizes the terminal to its element; nothing to do while that element is hidden. */
  fitNow() {
    if (!this.term || !this.fit || !this.element.isConnected || !this.element.clientWidth || !this.element.clientHeight) return;
    try { this.fit.fit(); } catch { /* not laid out yet */ }
  }

  /** Starts a shell in `cwd`, ending one that is running. */
  async start(cwd: string | null) {
    await this.load();
    this.cwd = cwd;
    const term = this.term!;
    this.fitNow();
    try {
      const started = await invoke<{ sessionId: string; shell: string }>("terminal_start", { request: { cwd, cols: term.cols, rows: term.rows } });
      this.sessionId = started.sessionId;
      this.report({ running: true, shell: started.shell, exitCode: null, error: "" });
    } catch (error) {
      this.sessionId = "";
      this.report({ running: false, error: String(error) });
    }
  }

  /** Starts a shell unless one is already running. */
  async ensureStarted(cwd: string | null) {
    if (this.sessionId) return;
    if (this.status.exitCode !== null || this.status.error) return;
    await this.start(cwd);
  }

  stop() {
    this.sessionId = "";
    void invoke("terminal_stop").catch(() => undefined);
    this.report({ running: false, exitCode: null });
  }

  clear() { this.term?.clear(); }
  setLabels(labels: { exited: string; ended: string; again: string }) { this.labels = labels; }
  focus() { this.term?.focus(); }

  setLook(look: TerminalLook) {
    this.look = look;
    if (!this.term) return;
    this.term.options.fontFamily = look.fontFamily;
    this.term.options.fontSize = look.fontSize;
    this.term.options.theme = themeFromPage();
    this.fitNow();
  }
}

let host: TerminalHost | null = null;
/** The window's terminal, made on first use. */
export const terminalHost = () => (host ??= new TerminalHost());

/** The terminal's state, for the buttons around it. */
export const useTerminalStatus = (onChange: Listener) => {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => terminalHost().subscribe((status) => latest.current(status)), []);
};

/**
 * Shows the window's terminal in this element. The shell starts the first time it becomes
 * visible, in `cwd`; after that it keeps running whether the element is shown or not.
 */
export function BuiltinTerminal({ visible, cwd, look, themeKey }: { visible: boolean; cwd: string | null; look: TerminalLook; themeKey: string }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const shared = terminalHost();
    element.appendChild(shared.element);
    const observer = new ResizeObserver(() => shared.fitNow());
    observer.observe(element);
    return () => { observer.disconnect(); shared.element.remove(); };
  }, []);
  useEffect(() => {
    if (!visible) return;
    const shared = terminalHost();
    void shared.ensureStarted(cwd).then(() => { shared.fitNow(); shared.focus(); });
  }, [visible]);
  // The theme's CSS variables are switched by the app's own effect, which runs after this
  // component's; a task queued now runs after both, and — unlike an animation frame — also
  // while the window is not being drawn.
  useEffect(() => {
    const timer = window.setTimeout(() => terminalHost().setLook(look), 0);
    return () => window.clearTimeout(timer);
  }, [look.fontFamily, look.fontSize, themeKey]);
  return <div className="builtin-terminal" ref={container} />;
}
