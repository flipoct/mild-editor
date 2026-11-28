import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./monaco";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import ProblemWindow from "./ProblemWindow";
import { IS_TAURI } from "./platform";

// The same bundle serves the separate problem window (see src-tauri/src/browser.rs) and the
// board window (src-tauri/src/boards.rs); the window's label picks the page. `?window=problem`
// or `?window=board` does the same in a plain browser.
const windowKind = (() => {
  try {
    if (IS_TAURI) return getCurrentWindow().label;
  } catch { /* not a Tauri window */ }
  return new URLSearchParams(window.location.search).get("window") ?? "main";
})();
const isProblemWindow = windowKind === "problem";
// The board brings KaTeX and its fonts: loaded only by the window that shows it.
const BoardWindow = lazy(() => import("./board/BoardWindow"));

// Development only: keep the last runtime errors where a probe script can read them
// (see start_debug_probe in src-tauri/src/lib.rs); the webview has no devtools console
// once Chromium is embedded.
if (import.meta.env.DEV) {
  const errors: string[] = ((window as unknown as { __errors?: string[] }).__errors = []);
  const record = (kind: string, value: unknown) => {
    errors.push(`${kind}: ${value instanceof Error ? value.stack || value.message : String(value)}`.slice(0, 4000));
    if (errors.length > 20) errors.shift();
  };
  window.addEventListener("error", (event) => record("error", event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => record("rejection", event.reason));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      {isProblemWindow ? <ProblemWindow /> : windowKind === "board" ? <Suspense fallback={null}><BoardWindow /></Suspense> : <App />}
    </ErrorBoundary>
  </StrictMode>,
);
