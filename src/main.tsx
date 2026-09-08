import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./monaco";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";

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
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
