import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./monaco";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import ProblemWindow from "./ProblemWindow";

// The same bundle serves the separate problem window (see src-tauri/src/browser.rs); the
// window's label picks the page. `?window=problem` does the same in a plain browser.
const isProblemWindow = (() => {
  try {
    if ("__TAURI_INTERNALS__" in window) return getCurrentWindow().label === "problem";
  } catch { /* not a Tauri window */ }
  return new URLSearchParams(window.location.search).get("window") === "problem";
})();

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
      {isProblemWindow ? <ProblemWindow /> : <App />}
    </ErrorBoundary>
  </StrictMode>,
);
