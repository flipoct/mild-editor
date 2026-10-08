import { DEMO_MODE } from "./demo";
import { DEFAULT_FLOAT_TOLERANCE } from "./judge";
import { IS_TAURI } from "./platform";
import { boundedNumber, clampEditorFontSize, clampUiZoom, defaultEditorFontId, EDITOR_FONT_SIZE_DEFAULT, EDITOR_FONT_SIZE_MAX, EDITOR_FONT_SIZE_MIN, loadCustomFonts, loadSnippets, parseWallpaperLayout, storedPanelLayout, storedPanelWeights, storedProfileFlags, UI_ZOOM_MAX, UI_ZOOM_MIN } from "./settings";
import { createStore } from "./store";
import type { CompileProfile, EditorFont, ExplorerSort, Language, ProblemBrowserMode, ProblemSource, UiLocale, UiTheme } from "./types";
import { autoSaveEnabled } from "./workbench";

/**
 * One persisted preference: how it is read at start, and how it goes back to localStorage.
 * `lazy` marks the ones that are only written once they change; the rest are also written
 * at start-up, which is what turns a default, a legacy key or a clamped value into the
 * stored one.
 */
type Setting<T> = { read: () => T; save: (value: T) => void; lazy?: boolean };

const stored = <T>(key: string, read: (stored: string | null) => T, write: (value: T) => string = String): Setting<T> => ({
  read: () => read(localStorage.getItem(key)),
  save: (value) => localStorage.setItem(key, write(value)),
});

/** A switch stored as "1"/"0"; `fallback` is what it is before anyone has touched it. */
const flag = (key: string, fallback: boolean) =>
  stored(key, (value) => fallback ? value !== "0" : value === "1", (on) => on ? "1" : "0");

const bounded = (key: string, fallback: number, minimum: number, maximum: number) =>
  stored(key, (value) => boundedNumber(value, fallback, minimum, maximum));

const text = <T extends string = string>(key: string, fallback: NoInfer<T>, write?: (value: T) => string) =>
  stored<T>(key, (value) => (value as T | null) || fallback, write);

/** Handles and paths are kept as typed while the app runs, and stored without the stray spaces. */
const trimmed = (value: string) => value.trim();

const definitions = {
  uiLocale: text<UiLocale>("mild-ui-locale", "en"),
  // `?demo&theme=…` (development only) shows the preview in a theme without a click.
  uiTheme: stored<UiTheme>("mild-ui-theme", (value) => (DEMO_MODE !== null && new URLSearchParams(window.location.search).get("theme") as UiTheme) || (value as UiTheme) || "pastel"),
  uiZoom: bounded("mild-ui-zoom", 100, UI_ZOOM_MIN, UI_ZOOM_MAX),
  // Independent of the interface zoom: that scales every panel, this only sizes the code.
  editorFontSize: stored("mild-editor-font-size", (value) => clampEditorFontSize(boundedNumber(value, EDITOR_FONT_SIZE_DEFAULT, EDITOR_FONT_SIZE_MIN, EDITOR_FONT_SIZE_MAX))),
  editorFont: text<EditorFont>("mild-editor-font", defaultEditorFontId),
  customFonts: { read: loadCustomFonts, save: (fonts) => localStorage.setItem("mild-custom-fonts", JSON.stringify(fonts)), lazy: true } as Setting<ReturnType<typeof loadCustomFonts>>,
  // The preview has no file system to read a path from, so it never starts with a wallpaper.
  backgroundImagePath: stored("mild-background-image", (value) => IS_TAURI ? value || "" : ""),
  wallpaperLayout: stored("mild-wallpaper-layout", parseWallpaperLayout),
  wallpaperScale: bounded("mild-wallpaper-scale", 100, 25, 300),
  wallpaperPositionX: bounded("mild-wallpaper-position-x", 50, 0, 100),
  wallpaperPositionY: bounded("mild-wallpaper-position-y", 50, 0, 100),
  acrylicOpacity: bounded("mild-acrylic-opacity", 82, 0, 100),
  acrylicBlur: bounded("mild-acrylic-blur", 14, 0, 32),
  // On unless turned off: an edit reaches the disk a second after the typing stops.
  autoSave: stored("mild-auto-save", autoSaveEnabled, (on) => on ? "1" : "0"),

  panelLayout: stored("mild-panel-layout", storedPanelLayout, JSON.stringify),
  panelWeights: stored("mild-panel-weights", storedPanelWeights, JSON.stringify),
  explorerVisible: flag("mild-explorer-visible", true),
  testPanelVisible: flag("mild-test-panel-visible", true),
  problemPanelOpen: stored("mild-problem-panel", (value) => import.meta.env.VITE_PROBLEM_PANEL_OPEN === "force" || (value ?? (import.meta.env.VITE_PROBLEM_PANEL_OPEN === "1" ? "1" : "0")) === "1", (open) => open ? "1" : "0"),
  problemBrowserMode: stored<ProblemBrowserMode>("mild-problem-browser-mode", (value) => value === "window" ? "window" : "panel"),
  explorerSort: text<ExplorerSort>("mild-explorer-sort", "problem"),
  explorerSource: text<ProblemSource | "all">("mild-explorer-source", "all"),

  atcoderHandle: text("mild-atcoder-handle", "", trimmed),
  codeforcesHandle: text("mild-codeforces-handle", "", trimmed),
  dojHandle: text("mild-doj-handle", "", trimmed),
  // Language for every file the editor creates on its own: contest and single imports,
  // Competitive Companion, and blank files typed without an extension. The old key only
  // covered contest imports, so it seeds the new one for existing installs.
  defaultLanguage: stored<Language>("mild-default-language", (value) => (value || localStorage.getItem("mild-contest-import-language")) as Language || "cpp"),
  organizeImports: flag("mild-organize-imports", false),
  // Off by default: a submission is only sent when the user has asked for the button to be pressed.
  submitPress: flag("mild-submit-press", false),
  companionEnabled: flag("mild-companion-enabled", true),
  companionPort: bounded("mild-companion-port", 10043, 1024, 65535),

  compileProfile: stored<CompileProfile>("mild-compile-profile", (value) => value === "debug" ? "debug" : "release"),
  profileFlags: {
    read: () => ({ release: storedProfileFlags("release"), debug: storedProfileFlags("debug") }),
    save: (flags) => {
      localStorage.setItem("mild-compile-flags-release", flags.release);
      localStorage.setItem("mild-compile-flags-debug", flags.debug);
    },
  } as Setting<Record<CompileProfile, string>>,
  precompileHeaders: flag("mild-precompile-headers", true),
  floatTolerance: stored("mild-float-tolerance", (value) => value === null ? DEFAULT_FLOAT_TOLERANCE : Number(value) || 0),

  snippets: { read: loadSnippets, save: (snippets) => localStorage.setItem("mild-snippets", JSON.stringify(snippets)), lazy: true } as Setting<ReturnType<typeof loadSnippets>>,
  // Empty means "find clangd on PATH", which is stored as no key at all.
  clangdPath: {
    read: () => localStorage.getItem("mild-clangd-path") || "",
    save: (path) => { if (path) localStorage.setItem("mild-clangd-path", path); else localStorage.removeItem("mild-clangd-path"); },
    lazy: true,
  } as Setting<string>,
  atcoderLibraryPath: text("mild-atcoder-library-path", "", trimmed),
};

export type Settings = { [K in keyof typeof definitions]: (typeof definitions)[K] extends Setting<infer T> ? T : never };
export type SettingName = keyof Settings;
type Update<T> = T | ((current: T) => T);

const names = Object.keys(definitions) as SettingName[];
const definition = <K extends SettingName>(name: K) => definitions[name] as unknown as Setting<Settings[K]>;

// Everything is read here, in one pass and before anything is written, so a legacy key is
// still there for the setting that falls back to it.
const store = createStore(Object.fromEntries(names.map((name) => [name, definition(name).read()])) as Settings);

export const getSetting = <K extends SettingName>(name: K): Settings[K] => store.get()[name];

/** Changes a preference and stores it. Takes a value or an updater, like a `useState` setter. */
export const setSetting = <K extends SettingName>(name: K, update: Update<Settings[K]>) => {
  const current = store.get()[name];
  const value = typeof update === "function" ? (update as (current: Settings[K]) => Settings[K])(current) : update;
  if (Object.is(value, current)) return;
  store.set({ [name]: value } as unknown as Partial<Settings>);
  definition(name).save(value);
};

/** One stable setter per preference, so it can sit in a dependency list like a `useState` one. */
const setters = Object.fromEntries(names.map((name) => [name, (update: Update<Settings[SettingName]>) => setSetting(name, update)])) as unknown as { [K in SettingName]: (update: Update<Settings[K]>) => void };

/** `[value, setValue]` for one preference; the component re-renders when that one changes. */
export const useSetting = <K extends SettingName>(name: K) =>
  [store.use((settings) => settings[name]), setters[name]] as const;

/**
 * Writes the preferences back as they were read. The app window does this once when it
 * starts, never the module itself: the problem window loads the same bundle, and it only
 * reads these keys.
 */
export const persistSettings = () => names.forEach((name) => {
  if (!definition(name).lazy) definition(name).save(store.get()[name]);
});

export const adjustUiZoom = (delta: number) => setSetting("uiZoom", (current) => clampUiZoom(current + delta));
