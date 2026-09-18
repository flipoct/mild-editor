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
