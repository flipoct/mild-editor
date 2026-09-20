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
 * The language marks beside a filename: the C++ and Python logos in the colours everyone
 * knows them by, from Devicon (https://devicon.dev), MIT licensed — Copyright (c) 2015
 * konpa. The marks remain trademarks of their owners and are used here only to say which
 * language a file is in.
 *
 * Each `viewBox` is the artwork's own bounding box squared off, not the 128 box it ships
 * in, for two reasons. Devicon's Python is drawn with a drop shadow below it, which is
 * dropped here; left in the original box the snakes then hang a tenth of the height above
 * centre, which is plainly visible against a filename. And the two logos fill their boxes
 * by different amounts, so cropping each to itself is what makes them the same size. The
 * hexagon is then eased back a little: a solid convex shape reads larger than open
 * artwork of the same height.
 */
const CPP_LOGO = {
  viewBox: "-6.82 -6.39 140.54 140.54",
  paths: [{ fill: "#00599C", d: "M63.443 0c-1.782 0-3.564.39-4.916 1.172L11.594 28.27C8.89 29.828 6.68 33.66 6.68 36.78v54.197c0 1.562.55 3.298 1.441 4.841l-.002.002c.89 1.543 2.123 2.89 3.475 3.672l46.931 27.094c2.703 1.562 7.13 1.562 9.832 0h.002l46.934-27.094c1.352-.78 2.582-2.129 3.473-3.672.89-1.543 1.441-3.28 1.441-4.843V36.779c0-1.557-.55-3.295-1.441-4.838v-.002c-.891-1.545-2.121-2.893-3.473-3.67L68.359 1.173C67.008.39 65.226 0 63.443 0zm.002 26.033c13.465 0 26.02 7.246 32.77 18.91l-16.38 9.479c-3.372-5.836-9.66-9.467-16.39-9.467-10.432 0-18.922 8.49-18.922 18.924S53.013 82.8 63.445 82.8c6.735 0 13.015-3.625 16.395-9.465l16.375 9.477c-6.746 11.662-19.305 18.91-32.77 18.91-20.867 0-37.843-16.977-37.843-37.844s16.976-37.844 37.843-37.844v-.002zM92.881 57.57h4.201v4.207h4.203v4.203h-4.203v4.207h-4.201V65.98h-4.207v-4.203h4.207V57.57zm15.765 0h4.208v4.207h4.203v4.203h-4.203v4.207h-4.208V65.98h-4.205v-4.203h4.205V57.57z" }],
};
const PYTHON_LOGO = {
  viewBox: "12.24 1.99 103.51 103.51",
  paths: [{ fill: "#3776AB", d: "M63.391 1.988c-4.222.02-8.252.379-11.8 1.007-10.45 1.846-12.346 5.71-12.346 12.837v9.411h24.693v3.137H29.977c-7.176 0-13.46 4.313-15.426 12.521-2.268 9.405-2.368 15.275 0 25.096 1.755 7.311 5.947 12.519 13.124 12.519h8.491V67.234c0-8.151 7.051-15.34 15.426-15.34h24.665c6.866 0 12.346-5.654 12.346-12.548V15.833c0-6.693-5.646-11.72-12.346-12.837-4.244-.706-8.645-1.027-12.866-1.008zM50.037 9.557c2.55 0 4.634 2.117 4.634 4.721 0 2.593-2.083 4.69-4.634 4.69-2.56 0-4.633-2.097-4.633-4.69-.001-2.604 2.073-4.721 4.633-4.721z" }, { fill: "#FFD43B", d: "M91.682 28.38v10.966c0 8.5-7.208 15.655-15.426 15.655H51.591c-6.756 0-12.346 5.783-12.346 12.549v23.515c0 6.691 5.818 10.628 12.346 12.547 7.816 2.297 15.312 2.713 24.665 0 6.216-1.801 12.346-5.423 12.346-12.547v-9.412H63.938v-3.138h37.012c7.176 0 9.852-5.005 12.348-12.519 2.578-7.735 2.467-15.174 0-25.096-1.774-7.145-5.161-12.521-12.348-12.521h-9.268zM77.809 87.927c2.561 0 4.634 2.097 4.634 4.692 0 2.602-2.074 4.719-4.634 4.719-2.55 0-4.633-2.117-4.633-4.719 0-2.595 2.083-4.692 4.633-4.692z" }],
};

export function LanguageIcon({ language, size = 16, className }: { language: string; size?: number; className?: string }) {
  const python = language === "python";
  const logo = python ? PYTHON_LOGO : CPP_LOGO;
  return (
    <svg
      className={`language-icon ${python ? "python" : "cpp"}${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox={logo.viewBox}
      role="img"
      aria-label={python ? "Python" : "C++"}
    >
      {logo.paths.map((path) => <path key={path.fill} fill={path.fill} d={path.d} />)}
    </svg>
  );
}
