import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMac } from "./platform";

/** What the backend reports about the embedded browser (`browser_status`, `browser-status`). */
export type BrowserStatus = { available: boolean; error?: string | null; open: boolean; visible: boolean; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean };

export const IDLE_BROWSER_STATUS: BrowserStatus = { available: false, open: false, visible: false, url: "", title: "", loading: false, canGoBack: false, canGoForward: false };

/** Event the app window listens for when the import button here is pressed. */
export const PROBLEM_WINDOW_IMPORT_EVENT = "problem-window-import";

const messages = {
  en: {
    import: "import",
    importHint: "Import this problem or contest into the editor",
    hint: "Open a file imported from a judge, or type a URL. Extensions installed in Settings → problem browser run here.",
    unavailable: "The problem browser is not available:",
    close: "hide this window",
    minimize: "Minimize window", maximize: "Maximize window", name: "problem",
  },
  ko: {
    import: "가져오기",
    importHint: "이 문제 또는 대회를 에디터로 가져오기",
    hint: "저지에서 가져온 파일을 열거나 URL을 입력하세요. 설정 → 문제 브라우저에서 설치한 확장이 여기서 실행됩니다.",
    unavailable: "문제 브라우저를 사용할 수 없습니다:",
    close: "이 창 숨기기",
    minimize: "창 최소화", maximize: "창 최대화", name: "문제",
  },
};

/** Settings the app window keeps in localStorage that this page follows. */
const readPreferences = () => ({
  locale: localStorage.getItem("mild-ui-locale") === "ko" ? "ko" as const : "en" as const,
  theme: localStorage.getItem("mild-ui-theme") || "pastel",
  zoom: Math.min(200, Math.max(50, Number(localStorage.getItem("mild-ui-zoom")) || 100)),
});

/**
 * The problem browser in a window of its own. The page is the same host the panel is:
 * a toolbar over a `.problem-host` whose rectangle the native view is placed over. The
 * backend hands it the URL to open (`problem_window_take_url`, then the
 * `problem-window-navigate` event) and the app window acts on its import button.
 */
export default function ProblemWindow() {
  const [preferences, setPreferences] = useState(readPreferences);
  const [status, setStatus] = useState<BrowserStatus>(IDLE_BROWSER_STATUS);
  const [urlDraft, setUrlDraft] = useState("");
  const urlEditingRef = useRef(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(preferences.zoom);
  zoomRef.current = preferences.zoom;
  const t = (key: keyof typeof messages.en) => messages[preferences.locale][key];

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
  }, [preferences.theme]);
  useEffect(() => {
    // The macOS title bar counter-scales with this, as in the app window.
    document.documentElement.style.setProperty("--ui-zoom-inverse", String(100 / preferences.zoom));
    void getCurrentWebview().setZoom(preferences.zoom / 100).catch(() => undefined);
  }, [preferences.zoom]);

  useEffect(() => {
    void invoke<BrowserStatus>("browser_status").then(setStatus).catch(() => undefined);
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<BrowserStatus>("browser-status", (event) => setStatus(event.payload))
      .then((stop) => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!urlEditingRef.current) setUrlDraft(status.url);
  }, [status.url]);

  const hostBounds = () => {
    const host = hostRef.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, scale: zoomRef.current / 100 };
  };

  const openUrl = (raw: string) => {
    const typed = raw.trim();
    if (!typed) return;
    const url = /^[a-z]+:\/\//i.test(typed) ? typed : `https://${typed}`;
    const bounds = hostBounds();
    if (!bounds) return;
    invoke("browser_open", { url, bounds }).catch((error) => console.error(error));
  };
  const openUrlRef = useRef(openUrl);
  openUrlRef.current = openUrl;

  // The rectangle the view is placed over, kept current as the window is resized.
  useEffect(() => {
    const host = hostRef.current;
    if (!status.available || !host) return;
    const report = () => {
      const bounds = hostBounds();
      if (bounds && bounds.width > 0 && bounds.height > 0) void invoke("browser_set_bounds", { bounds }).catch(() => undefined);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(host);
    window.addEventListener("resize", report);
    return () => { observer.disconnect(); window.removeEventListener("resize", report); };
  }, [status.available, preferences.zoom]);

  // The URL the app window opened this window for, then any it sends afterwards while
  // the browser is not up yet (once it is, the backend navigates it directly).
  useEffect(() => {
    if (!status.available) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void invoke<string | null>("problem_window_take_url").then((url) => { if (url && !disposed) openUrlRef.current(url); }).catch(() => undefined);
    void listen<string>("problem-window-navigate", (event) => openUrlRef.current(event.payload))
      .then((stop) => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); };
  }, [status.available]);

  // Ctrl+W / ⌘W in the toolbar hides the window, as it does with the view focused (the
  // backend forwards that one to the app window). The browser keys work here as well,
  // except in the URL field, where the arrows edit text.
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const primary = isMac ? event.metaKey : event.ctrlKey;
      if (primary && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "w") {
        event.preventDefault();
        void invoke("problem_window_hide").catch(() => undefined);
        return;
      }
      const inField = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      const history = (primary || event.altKey) && !inField;
      const action = history && event.key === "ArrowLeft" ? "back"
        : history && event.key === "ArrowRight" ? "forward"
          : event.key === "F5" || (primary && event.key.toLowerCase() === "r") ? "reload"
            : null;
      if (action) {
        event.preventDefault();
        void invoke("browser_go", { action }).catch(() => undefined);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const hide = () => void invoke("problem_window_hide").catch(() => undefined);

  return (
    <div className="problem-window" aria-label="Problem browser">
      {/* The app window's own title bar, so the two windows match: undecorated, drag region, same controls. */}
      <div className="window-titlebar" data-tauri-drag-region>
        <div className="titlebar-identity" data-tauri-drag-region>
          <span className="titlebar-logo" aria-hidden="true">m</span>
          <span className="titlebar-name" data-tauri-drag-region>mild editor</span>
          <span className="titlebar-separator" data-tauri-drag-region>·</span>
          <span className="titlebar-file" data-tauri-drag-region>{status.title ? `${t("name")} / ${status.title}` : t("name")}</span>
        </div>
        {!isMac && <div className="window-controls">
          <button onClick={() => void getCurrentWindow().minimize()} aria-label={t("minimize")}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 8.5h8v1H2z" /></svg></button>
          <button onClick={() => void getCurrentWindow().toggleMaximize()} aria-label={t("maximize")}><svg viewBox="0 0 12 12" aria-hidden="true"><path fillRule="evenodd" d="M2 2h8v8H2V2Zm1 1v6h6V3H3Z" /></svg></button>
          <button className="window-close" onClick={hide} aria-label={t("close")}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 3.2.7-.7L6 5.3l2.8-2.8.7.7L6.7 6l2.8 2.8-.7.7L6 6.7 3.2 9.5l-.7-.7L5.3 6 2.5 3.2Z" /></svg></button>
        </div>}
      </div>
      <div className="problem-toolbar">
        <button onClick={() => void invoke("browser_go", { action: "back" })} disabled={!status.canGoBack} aria-label="back" title="back">‹</button>
        <button onClick={() => void invoke("browser_go", { action: "forward" })} disabled={!status.canGoForward} aria-label="forward" title="forward">›</button>
        <button onClick={() => void invoke("browser_go", { action: status.loading ? "stop" : "reload" })} disabled={!status.open} aria-label={status.loading ? "stop" : "reload"} title={status.loading ? "stop" : "reload"}>{status.loading ? "×" : "↻"}</button>
        <input className="problem-url" value={urlDraft} placeholder="https://" spellCheck={false}
          onFocus={() => { urlEditingRef.current = true; }}
          onBlur={() => { urlEditingRef.current = false; setUrlDraft(status.url); }}
          onChange={(event) => setUrlDraft(event.target.value)}
          onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter") { event.preventDefault(); openUrl(urlDraft); event.currentTarget.blur(); } }}
          aria-label="problem URL" />
        <button className="problem-import" onClick={() => void emit(PROBLEM_WINDOW_IMPORT_EVENT)} disabled={!status.open || !status.url || status.loading} title={t("importHint")}>{t("import")}</button>
        <button onClick={hide} aria-label={t("close")} title={t("close")}>×</button>
      </div>
      {status.available
        ? <div className="problem-host" ref={hostRef}>{!status.open && <p className="problem-hint">{t("hint")}</p>}</div>
        : <div className="problem-host problem-unavailable"><p className="problem-hint"><strong>{t("unavailable")}</strong><br />{status.error || "CEF is not initialised"}</p></div>}
    </div>
  );
}
