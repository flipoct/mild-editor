import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useState } from "react";
import { explorerBasename } from "../fileNaming";
import { messages } from "../i18n";
import { AppLogo, Icon } from "../icons";
import { isMac } from "../platform";
import { BoardPanel, type BoardConnection, type TabletLink } from "./BoardPanel";
import type { BoardSource } from "./canvas";
import type { Assets, Element } from "./model";
import { applyChange, changes, heard, newSent, readToPad, type FromPad } from "./padProtocol";
import { FROM_WINDOW_EVENT, INFO_EVENT, PAD_EVENT, type FromWindow, type PadToWindow, type WindowInfo } from "./windowProtocol";

/**
 * The drawing board in a window of its own (src-tauri/src/boards.rs makes it), beside the
 * code instead of over it. The app window holds the board (windowLink.ts): this page keeps a
 * copy that the app window brings up to date, and sends what is drawn here as it is drawn —
 * the way a tablet does, over Tauri events. Everything else, from the board list to a
 * tablet's pairing, is the app window's too; this page shows it and asks for it.
 */

const tell = (message: FromWindow) => void emitTo("main", FROM_WINDOW_EVENT, message).catch(() => undefined);

/** Settings the app window keeps in localStorage that this page follows. */
const readPreferences = () => ({
  locale: localStorage.getItem("mild-ui-locale") === "ko" ? "ko" as const : "en" as const,
  theme: localStorage.getItem("mild-ui-theme") || "pastel",
  style: localStorage.getItem("mild-ui-style") || "mild",
  zoom: Math.min(200, Math.max(50, Number(localStorage.getItem("mild-ui-zoom")) || 100)),
});

const EMPTY_INFO: WindowInfo = { path: null, boards: [], workspacePath: null, shared: false, pairing: null, pairError: "" };

/** The board at `path`, as a copy the app window keeps up to date and hears every change to. */
const connectRemote = (path: string): BoardConnection => {
  let elements: readonly Element[] = [];
  let assets: Assets = {};
  let sent = newSent();
  let ready = false;
  let gone = false;
  let frame = 0;
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((listener) => listener());
  const send = (message: FromPad) => tell({ kind: "pad", path, text: JSON.stringify(message) });
  /** Tells the app window what changed here, once a frame: a line being drawn changes every move. */
  const flush = () => {
    if (frame || !ready) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!gone) changes(sent, elements, assets).forEach(send);
    });
  };
  const local = (next: readonly Element[]) => { elements = next; changed(); flush(); };
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
  const stop = getCurrentWebviewWindow().listen<PadToWindow>(PAD_EVENT, ({ payload }) => {
    if (gone || payload?.path !== path) return;
    const message = readToPad(payload.text);
    if (!message) return;
    if (message.t === "state") {
      elements = message.elements;
      sent = newSent();
      sent.elements = new Map(elements.map((element) => [element.id, element]));
      sent.order = elements.map((element) => element.id);
      sent.assets = new Set(Object.keys(assets));
      ready = true;
    } else if (message.t === "bye") {
      return;
    } else {
      heard(sent, message);
      if (message.t === "asset") assets = { ...assets, [message.id]: message.data };
      else elements = applyChange(elements, message);
    }
    changed();
  });
  // Asked for once this page is listening, so the whole board does not pass it by.
  void stop.then(() => { if (!gone) tell({ kind: "hello", path }); });
  return {
    source,
    release: () => {
      gone = true;
      cancelAnimationFrame(frame);
      void stop.then((unlisten) => unlisten());
      tell({ kind: "bye", path });
    },
  };
};

const hide = () => void invoke("board_window_hide").catch(() => undefined);

export default function BoardWindow() {
  const [preferences, setPreferences] = useState(readPreferences);
  const [info, setInfo] = useState<WindowInfo>(EMPTY_INFO);
  const t = useMemo(() => (key: keyof typeof messages.en) => messages[preferences.locale][key], [preferences.locale]);

  // Theme, language and zoom are the app window's settings; localStorage is shared, and
  // `storage` fires here when the app window changes one of them.
  useEffect(() => {
    document.documentElement.dataset.platform = isMac ? "mac" : "other";
    const sync = () => setPreferences(readPreferences());
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
    document.documentElement.dataset.style = preferences.style;
  }, [preferences.theme, preferences.style]);
  useEffect(() => {
    document.documentElement.style.setProperty("--ui-zoom-inverse", String(100 / preferences.zoom));
    void getCurrentWebview().setZoom(preferences.zoom / 100).catch(() => undefined);
  }, [preferences.zoom]);
  useEffect(() => { document.title = info.path ? `${explorerBasename(info.path)} · ${t("boardWindowName")}` : t("boardWindowName"); }, [info.path, t]);

  useEffect(() => {
    const stop = getCurrentWebviewWindow().listen<WindowInfo>(INFO_EVENT, ({ payload }) => setInfo(payload));
    void stop.then(() => tell({ kind: "ready" }));
    return () => { void stop.then((unlisten) => unlisten()); };
  }, []);

  // Ctrl+W / ⌘W hides the window, as its close button does.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((isMac ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "w") {
        event.preventDefault();
        hide();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const path = info.path;
  const tablet: TabletLink = {
    view: info.pairing,
    error: info.pairError,
    start: () => { if (path) tell({ kind: "pair", path }); },
    away: () => { if (path) tell({ kind: "away", path }); },
    stop: () => { if (path) tell({ kind: "unpair", path }); },
  };

  return <div className="board-window">
    {/* The app window's own title bar, so the windows match: undecorated, drag region, same controls. */}
    <div className="window-titlebar" data-tauri-drag-region>
      <div className="titlebar-identity" data-tauri-drag-region>
        <span className="titlebar-logo"><AppLogo icon={localStorage.getItem("mild-app-icon") || ""} /></span>
        <span className="titlebar-name" data-tauri-drag-region>Mild Editor</span>
        <span className="titlebar-file" data-tauri-drag-region><span className="crumb">{t("boardWindowName")}</span>{path && <><Icon name="chevronRight" size={10} /><span className="crumb current">{explorerBasename(path)}</span></>}</span>
      </div>
      {!isMac && <div className="window-controls">
        <button onClick={() => void getCurrentWindow().minimize()} aria-label="minimize"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 8.5h8v1H2z" /></svg></button>
        <button onClick={() => void getCurrentWindow().toggleMaximize()} aria-label="maximize"><svg viewBox="0 0 12 12" aria-hidden="true"><path fillRule="evenodd" d="M2 2h8v8H2V2Zm1 1v6h6V3H3Z" /></svg></button>
        <button className="window-close" onClick={hide} aria-label={t("boardWindowHide")}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 3.2.7-.7L6 5.3l2.8-2.8.7.7L6.7 6l2.8 2.8-.7.7L6 6.7 3.2 9.5l-.7-.7L5.3 6 2.5 3.2Z" /></svg></button>
      </div>}
    </div>
    <div className="board-window-body">
      {path
        ? <BoardPanel key={path} t={t} path={path} themeKey={`${preferences.theme}/${preferences.style}`} korean={preferences.locale === "ko"}
          boards={info.boards} workspacePath={info.workspacePath} connect={connectRemote} shared={info.shared} tablet={tablet}
          placement={{ label: t("boardDock"), icon: "download", onToggle: () => tell({ kind: "dock" }) }}
          closeLabel={t("boardWindowHide")}
          onOpen={(next) => tell({ kind: "open", path: next })} onNew={() => tell({ kind: "new" })} onClose={hide} />
        : <p className="board-window-empty">{t("boardWindowEmpty")}</p>}
    </div>
  </div>;
}
