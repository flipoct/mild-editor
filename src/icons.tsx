import type { ReactNode } from "react";

/** One stroke icon set for the whole interface: 16px grid, 1.4px round strokes, currentColor. */
const paths = {
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  play: <path d="M5 3.2v9.6L12.8 8Z" fill="currentColor" stroke="none" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />,
  chevronRight: <path d="m6 3.5 4.5 4.5L6 12.5" />,
  chevronDown: <path d="m3.5 6 4.5 4.5L12.5 6" />,
  arrowLeft: <path d="M13 8H3m4-4.5L2.5 8 7 12.5" />,
  arrowRight: <path d="M3 8h10M9 3.5 13.5 8 9 12.5" />,
  reload: <path d="M13 3v3.5H9.5M13 6.5A5.2 5.2 0 1 0 13.2 9" />,
  file: <path d="M4 1.8h5l3.2 3.2v9.2H4ZM9 1.8V5h3.2" />,
  filePlus: <path d="M4 1.8h5l3.2 3.2v9.2H4ZM9 1.8V5h3.2M8.1 7.3v4M6.1 9.3h4" />,
  folder: <path d="M1.8 3.2h4.4l1.4 1.6h6.6v8H1.8Z" />,
  folderOpen: <path d="M1.8 12.8V3.2h4.4l1.4 1.6h5.6v2M1.8 12.8l2-5.9h10.6l-2 5.9Z" />,
  folderPlus: <path d="M1.8 3.2h4.4l1.4 1.6h6.6v8H1.8ZM8 6.8v4M6 8.8h4" />,
  save: <path d="M2.5 2.5h8.6l2.4 2.4v8.6h-11ZM5 2.5v3.3h5V2.5M5 13.5V9.3h6v4.2" />,
  download: <path d="M8 2.2v8M4.6 7 8 10.4 11.4 7M2.8 13.2h10.4" />,
  settings: <path d="M2.5 4.5h4.2m3.6 0h3.2M2.5 11.5h2.2m3.6 0h5.2M8.5 3v3M6.5 10v3" />,
  grip: <path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01" strokeWidth="1.9" />,
  flask: <path d="M6.2 1.8h3.6M6.8 1.8v4.4L3 12.6a1 1 0 0 0 .9 1.6h8.2a1 1 0 0 0 .9-1.6L9.2 6.2V1.8M4.9 9.8h6.2" />,
  globe: <path d="M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8ZM1.8 8h12.4M8 1.8c-3.2 3.4-3.2 9 0 12.4M8 1.8c3.2 3.4 3.2 9 0 12.4" />,
  files: <path d="M5.2 4.2V1.8h5l3 3v7h-2.4M2.8 4.2h5l3 3v7h-8ZM7.8 4.2v3h3" />,
  snippet: <path d="M5.5 4 1.8 8l3.7 4M10.5 4l3.7 4-3.7 4" />,
  clock: <path d="M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8ZM8 4.6V8l2.3 1.5" />,
  chip: <path d="M4 4h8v8H4ZM6.4 6.4h3.2v3.2H6.4ZM6 1.8V4m4-2.2V4M6 12v2.2m4-2.2v2.2M1.8 6H4m-2.2 4H4m8-4h2.2M12 10h2.2" />,
  timer: <path d="M8 4.2a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM6.4 1.8h3.2M8 1.8v2.4M8 6.6v2.6l1.6 1" />,
  send: <path d="M14 2 7.2 8.8M14 2 9.6 14l-2.4-5.2L2 6.4Z" />,
  trophy: <path d="M5 2.2h6v4a3 3 0 0 1-6 0ZM5 3.4H2.6c0 2 .8 3.2 2.6 3.4M11 3.4h2.4c0 2-.8 3.2-2.6 3.4M8 9.2v2.6M5.4 13.8h5.2M6.2 11.8h3.6" />,
  upload: <path d="M8 10.4v-8M4.6 5.6 8 2.2l3.4 3.4M2.8 13.2h10.4" />,
  braces: <path d="M6.4 2.4c-1.5 0-1.5 1.1-1.5 2.5s-.3 2.2-1.4 2.2v1.8c1.1 0 1.4.8 1.4 2.2s0 2.5 1.5 2.5M9.6 2.4c1.5 0 1.5 1.1 1.5 2.5s.3 2.2 1.4 2.2v1.8c-1.1 0-1.4.8-1.4 2.2s0 2.5-1.5 2.5" />,
  refresh: <path d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8M13.6 2.2v3.2h-3.2" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

/** C++ logo, Simple Icons, CC0 1.0. */
const CPP_LOGO = "M22.394 6c-.167-.29-.398-.543-.652-.69L12.926.22c-.509-.294-1.34-.294-1.848 0L2.26 5.31c-.508.293-.923 1.013-.923 1.6v10.18c0 .294.104.62.271.91.167.29.398.543.652.69l8.816 5.09c.508.293 1.34.293 1.848 0l8.816-5.09c.254-.147.485-.4.652-.69.167-.29.27-.616.27-.91V6.91c.003-.294-.1-.62-.268-.91zM12 19.11c-3.92 0-7.109-3.19-7.109-7.11 0-3.92 3.19-7.11 7.11-7.11a7.133 7.133 0 016.156 3.553l-3.076 1.78a3.567 3.567 0 00-3.08-1.78A3.56 3.56 0 008.444 12 3.56 3.56 0 0012 15.555a3.57 3.57 0 003.08-1.778l3.078 1.78A7.135 7.135 0 0112 19.11zm7.11-6.715h-.79v.79h-.79v-.79h-.79v-.79h.79v-.79h.79v.79h.79zm2.962 0h-.79v.79h-.79v-.79h-.79v-.79h.79v-.79h.79v.79h.79z";
/** Python logo, Simple Icons, CC0 1.0. */
const PYTHON_LOGO = "M14.25.18l.9.2.73.26.59.3.45.32.34.34.25.34.16.33.1.3.04.26.02.2-.01.13V8.5l-.05.63-.13.55-.21.46-.26.38-.3.31-.33.25-.35.19-.35.14-.33.1-.3.07-.26.04-.21.02H8.77l-.69.05-.59.14-.5.22-.41.27-.33.32-.27.35-.2.36-.15.37-.1.35-.07.32-.04.27-.02.21v3.06H3.17l-.21-.03-.28-.07-.32-.12-.35-.18-.36-.26-.36-.36-.35-.46-.32-.59-.28-.73-.21-.88-.14-1.05-.05-1.23.06-1.22.16-1.04.24-.87.32-.71.36-.57.4-.44.42-.33.42-.24.4-.16.36-.1.32-.05.24-.01h.16l.06.01h8.16v-.83H6.18l-.01-2.75-.02-.37.05-.34.11-.31.17-.28.25-.26.31-.23.38-.2.44-.18.51-.15.58-.12.64-.1.71-.06.77-.04.84-.02 1.27.05zm-6.3 1.98l-.23.33-.08.41.08.41.23.34.33.22.41.09.41-.09.33-.22.23-.34.08-.41-.08-.41-.23-.33-.33-.22-.41-.09-.41.09zm13.09 3.95l.28.06.32.12.35.18.36.27.36.35.35.47.32.59.28.73.21.88.14 1.04.05 1.23-.06 1.23-.16 1.04-.24.86-.32.71-.36.57-.4.45-.42.33-.42.24-.4.16-.36.09-.32.05-.24.02-.16-.01h-8.22v.82h5.84l.01 2.76.02.36-.05.34-.11.31-.17.29-.25.25-.31.24-.38.2-.44.17-.51.15-.58.13-.64.09-.71.07-.77.04-.84.01-1.27-.04-1.07-.14-.9-.2-.73-.25-.59-.3-.45-.33-.34-.34-.25-.34-.16-.33-.1-.3-.04-.25-.02-.2.01-.13v-5.34l.05-.64.13-.54.21-.46.26-.38.3-.32.33-.24.35-.2.35-.14.33-.1.3-.06.26-.04.21-.02.13-.01h5.84l.69-.05.59-.14.5-.21.41-.28.33-.32.27-.35.2-.36.15-.36.1-.35.07-.32.04-.28.02-.21V6.07h2.09l.14.01zm-6.47 14.25l-.23.33-.08.41.08.41.23.33.33.23.41.08.41-.08.33-.23.23-.33.08-.41-.08-.41-.23-.33-.33-.23-.41-.08-.41.08z";

/**
 * The language marks beside a filename: the official C++ and Python logos, taken from
 * Simple Icons (https://simpleicons.org), whose icon files are released under CC0 1.0 —
 * public domain. The marks themselves remain trademarks of their owners and are used here
 * only to say which language a file is in.
 *
 * Each is one path on a 24px grid, drawn as an outline rather than filled: a solid mark
 * reads as a block of colour beside a filename, which is heavier than everything else in
 * the interface. The stroke is thinner than the icon set's 1.4 on its 16px grid, because
 * these shapes carry far more detail and thicken into a blob before they read.
 *
 * The colour is `currentColor`, so a theme's `--cpp` and `--python` decide it, and the
 * counters inside the shape — the "C++" in the hexagon, the snakes' eyes — stay open.
 */
export function LanguageIcon({ language, size = 16, className }: { language: string; size?: number; className?: string }) {
  const name = language === "python" ? "python" : "cpp";
  return (
    <svg
      className={`language-icon ${name}${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={name === "python" ? "Python" : "C++"}
    >
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        strokeLinecap="round"
        d={name === "cpp" ? CPP_LOGO : PYTHON_LOGO}
      />
    </svg>
  );
}
