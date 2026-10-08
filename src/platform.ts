/** False in the plain browser preview (`npm run dev:web`), where there is no backend to call. */
export const IS_TAURI = "__TAURI_INTERNALS__" in window;

const platformHint = (): string => {
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return data?.platform || navigator.platform || navigator.userAgent;
};

/** Development only: `?platform=mac` previews the macOS layout in the browser preview on another system. */
const previewPlatform = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("platform") : null;

export const isMac = /mac/i.test(previewPlatform || platformHint());

/** Prefix used when spelling a modifier shortcut out for the reader. */
export const modLabel = isMac ? "⌘" : "Ctrl+";

/** `accel("N")` renders as `⌘N` on macOS and `Ctrl+N` elsewhere. */
export const accel = (key: string) => `${modLabel}${key}`;

/** What a failed backend call or a thrown value has to say, as text for the status line. */
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
