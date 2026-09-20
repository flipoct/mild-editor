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

/**
 * The language marks beside a filename, from Tabler Icons (https://tabler.io/icons),
 * MIT licensed — Copyright (c) 2020-2026 Paweł Kuna. The marks themselves remain
 * trademarks of their owners and are used here only to say which language a file is in.
 *
 * Line art rather than solid: a filled logo is a block of colour beside a filename, and
 * the open shape sits at the weight of everything else on the row. They are built exactly
 * like the icon set above — 24px grid, `currentColor`, round caps — so a theme's `--cpp`
 * and `--python` decide the colour and the stroke matches the rest of the interface.
 */
const CPP_LOGO = [
  "M18 12h4",
  "M20 10v4",
  "M11 12h4",
  "M13 10v4",
  "M9 9a3 3 0 0 0 -3 -3h-.5a3.5 3.5 0 0 0 -3.5 3.5v5a3.5 3.5 0 0 0 3.5 3.5h.5a3 3 0 0 0 3 -3",
];
const PYTHON_LOGO = [
  "M12 9h-7a2 2 0 0 0 -2 2v4a2 2 0 0 0 2 2h3",
  "M12 15h7a2 2 0 0 0 2 -2v-4a2 2 0 0 0 -2 -2h-3",
  "M8 9v-4a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v5a2 2 0 0 1 -2 2h-4a2 2 0 0 0 -2 2v5a2 2 0 0 0 2 2h4a2 2 0 0 0 2 -2v-4",
  "M11 6l0 .01",
  "M13 18l0 .01",
];

export function LanguageIcon({ language, size = 16, className }: { language: string; size?: number; className?: string }) {
  const name = language === "python" ? "python" : "cpp";
  return (
    <svg
      className={`language-icon ${name}${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={name === "python" ? "Python" : "C++"}
    >
      {(name === "cpp" ? CPP_LOGO : PYTHON_LOGO).map((d) => <path key={d} d={d} />)}
    </svg>
  );
}
