import packageInfo from "../package.json";
import { IS_TAURI, isMac } from "./platform";
import { columnsFromOrder, completeLayout, type PanelLayout } from "./panelLayout";
import type { CodeSnippet, CompileProfile, EditorFontOption, PanelId, PanelWeights, UiTheme, WallpaperLayout } from "./types";

export const PANEL_IDS: PanelId[] = ["tests", "editor", "problem", "explorer"];

/** Relative size a panel takes before anyone drags a divider, roughly the old fixed widths. */
export const DEFAULT_WEIGHT: Record<PanelId, number> = { tests: 1, editor: 3.2, problem: 2, explorer: 0.75 };

/** Width of the strip a divider can be grabbed by, in CSS pixels (see .panel-resizer). */
export const PANEL_DIVIDER_HIT = 10;

export const storedPanelLayout = (): PanelLayout<PanelId> => {
  // VITE_PANEL_ORDER=problem,tests,editor,explorer (development only) overrides the layout.
  const forced = String(import.meta.env.VITE_PANEL_ORDER || "").split(",").filter((id): id is PanelId => PANEL_IDS.includes(id as PanelId));
  if (forced.length) return completeLayout(columnsFromOrder(forced), PANEL_IDS);
  try {
    const saved = JSON.parse(localStorage.getItem("mild-panel-layout") || "null") as unknown;
    if (Array.isArray(saved)) {
      const columns = saved
        .filter(Array.isArray)
        .map((column) => (column as unknown[]).filter((id): id is PanelId => PANEL_IDS.includes(id as PanelId)));
      return completeLayout(columns, PANEL_IDS);
    }
    // Layouts saved before panels could be stacked were a single left-to-right order.
    const legacy = JSON.parse(localStorage.getItem("mild-panel-order") || "[]") as unknown;
    const order = Array.isArray(legacy) ? legacy.filter((id): id is PanelId => PANEL_IDS.includes(id as PanelId)) : [];
    return completeLayout(columnsFromOrder(order), PANEL_IDS);
  } catch { return columnsFromOrder(PANEL_IDS); }
};


export const storedPanelWeights = (): PanelWeights => {
  try {
    const saved = JSON.parse(localStorage.getItem("mild-panel-weights") || "null");
    if (saved && typeof saved === "object") return saved as PanelWeights;
    // Widths used to be pixels against a whole-window row; keep the proportions they set.
    const pixels: PanelWeights = {};
    for (const [id, key] of [["tests", "mild-test-panel-width"], ["problem", "mild-problem-panel-width"], ["explorer", "mild-explorer-width"]] as const) {
      const value = Number(localStorage.getItem(key));
      if (Number.isFinite(value) && value > 0) pixels[id] = { width: value / 190 };
    }
    return pixels;
  } catch { return {}; }
};

/** Installed from the Web Store on first start (see DEFAULT_EXTENSIONS in browser.rs). */
export const TAMPERMONKEY_ID = "dhdgffkkebhmkfjojejmpbldmpobfkfo";

/** AtCoder Better! only runs under Tampermonkey; Greasy Fork serves the script by id. */
export const ATCODER_BETTER_USERSCRIPT = "https://greasyfork.org/scripts/471106/code/atcoder-better.user.js";

export const knownEditorFonts: EditorFontOption[] = [
  ...(isMac ? [
    { id: "sfmono", label: "SF Mono", family: "'SF Mono', ui-monospace, SFMono-Regular, monospace" },
    { id: "menlo", label: "Menlo", family: "Menlo, ui-monospace, monospace" },
    { id: "monaco", label: "Monaco", family: "Monaco, ui-monospace, monospace" },
  ] : []),
  { id: "cascadia", label: "Cascadia Code", family: "'Cascadia Code', Consolas, ui-monospace, monospace" },
  { id: "jetbrains", label: "JetBrains Mono", family: "'JetBrains Mono', ui-monospace, monospace" },
  { id: "fira", label: "Fira Code", family: "'Fira Code', ui-monospace, monospace" },
  ...(isMac ? [] : [{ id: "consolas", label: "Consolas", family: "Consolas, monospace" }]),
];

/** Cascadia and Consolas do not exist on macOS, so the stored Windows default is not a sensible starting point there. */
export const defaultEditorFontId = isMac ? "sfmono" : "cascadia";

export const alwaysInstalledFontIds = isMac ? ["sfmono", "menlo", "monaco"] : ["consolas"];

export const fallbackEditorFont = knownEditorFonts.find((font) => font.id === defaultEditorFontId) || knownEditorFonts[0];

/** The face the editor is set in: the chosen one while it is still on offer, otherwise the first that is. */
export const pickEditorFont = (options: EditorFontOption[], id: string) => options.find((font) => font.id === id) || options[0] || fallbackEditorFont;

export const loadCustomFonts = (): EditorFontOption[] => {
  try { return JSON.parse(localStorage.getItem("mild-custom-fonts") || "[]"); } catch { return []; }
};

export const UI_ZOOM_MIN = 50;

export const UI_ZOOM_MAX = 200;

export const UI_ZOOM_STEP = 10;

export const clampUiZoom = (value: number) => Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, Math.round(value / UI_ZOOM_STEP) * UI_ZOOM_STEP));

export const EDITOR_FONT_SIZE_MIN = 8;

export const EDITOR_FONT_SIZE_MAX = 40;

export const EDITOR_FONT_SIZE_DEFAULT = 14;

export const clampEditorFontSize = (value: number) => Math.min(EDITOR_FONT_SIZE_MAX, Math.max(EDITOR_FONT_SIZE_MIN, Math.round(value)));

/** The editor has always set 14px text on 22px lines; every other size keeps that proportion. */
export const editorLineHeightFor = (fontSize: number) => Math.round(fontSize * 22 / 14);


export const boundedNumber = (stored: string | null, fallback: number, minimum: number, maximum: number) => {
  if (stored === null) return fallback;
  const value = Number(stored);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
};

export const wallpaperLayouts: WallpaperLayout[] = ["cover", "contain", "stretch", "original", "tile", "custom"];

export const parseWallpaperLayout = (stored: string | null): WallpaperLayout =>
  wallpaperLayouts.includes(stored as WallpaperLayout) ? stored as WallpaperLayout : "cover";

/** A wallpaper layout as CSS background values, shared by the window and the preview in the settings. */
export const wallpaperCss = (layout: WallpaperLayout, scale: number, positionX: number, positionY: number) => ({
  size: layout === "cover" ? "cover"
    : layout === "contain" ? "contain"
      : layout === "stretch" ? "100% 100%"
        : layout === "original" ? "auto"
          : `${scale}% auto`,
  repeat: layout === "tile" ? "repeat" : "no-repeat",
  position: `${positionX}% ${positionY}%`,
});


/** A shortcut spelled for the platform: `⌘⇧↵` on macOS, `Ctrl+Shift+Enter` elsewhere. */
export const shortcutLabel = (key: string, modifiers: { shift?: boolean; alt?: boolean } = {}) => isMac
  ? `⌘${modifiers.shift ? "⇧" : ""}${modifiers.alt ? "⌥" : ""}${key === "Enter" ? "↵" : key}`
  : `Ctrl+${modifiers.shift ? "Shift+" : ""}${modifiers.alt ? "Alt+" : ""}${key}`;

export const UI_THEMES: Array<[UiTheme, string]> = [["pastel", "Pastel Dusk"], ["midnight", "Catppuccin Mocha"], ["latte", "Rosé Pine Dawn"], ["sakura", "Dracula"], ["blossom", "Gruvbox Dark"], ["nord", "Nord"], ["tokyo", "Tokyo Night"]];

/** MinGW ships no sanitizer runtimes, so the Windows default stops at the checked containers. */
export const DEFAULT_PROFILE_FLAGS: Record<CompileProfile, string> = {
  release: "-O2",
  debug: /windows/i.test(navigator.userAgent)
    ? "-O0 -g -DLOCAL -D_GLIBCXX_DEBUG -Wall -Wextra -Wshadow"
    : "-O0 -g -DLOCAL -D_GLIBCXX_DEBUG -fsanitize=address,undefined -fno-omit-frame-pointer -Wall -Wextra -Wshadow",
};

export const storedProfileFlags = (profile: CompileProfile) => localStorage.getItem(`mild-compile-flags-${profile}`) ?? DEFAULT_PROFILE_FLAGS[profile];

export const loadSnippets = (): CodeSnippet[] => {
  try { return JSON.parse(localStorage.getItem("mild-snippets") || "[]"); } catch { return []; }
};

export const APP_VERSION = packageInfo.version;

/** `tauri dev` runs under tauri.dev.conf.json: its own name, identifier, and no updater. */
export const IS_DEV_BUILD = import.meta.env.DEV;

// The development build keeps its own workspace memory, and starts in a scratch folder
// under its own app data directory, so testing an import cannot disturb the folder the
// installed app is working in.
export const WORKSPACE_KEY = IS_DEV_BUILD ? "mild-dev-last-workspace" : "mild-last-workspace";

/**
 * Settings that belong to this machine's session rather than to the user's setup: which
 * workspace was open, which tabs, which folders were folded, a contest in progress. A
 * backup restored on another machine should not drag these along, and `:` marks the ones
 * that are keyed by workspace path.
 */
export const SESSION_SETTING_KEYS = ["mild-last-workspace", "mild-dev-last-workspace", "mild-last-open-tabs", "mild-dev-last-open-tabs", "mild-release-notes"];

export const isPortableSetting = (key: string) => key.startsWith("mild-") && !key.includes(":") && !SESSION_SETTING_KEYS.includes(key);

/** Marks a file as ours, so importing the wrong JSON says so instead of wiping the setup. */
export const SETTINGS_BACKUP_KIND = "mild-editor-settings";


/** Release notes parked by an update for the build that comes up after it. */
export const RELEASE_NOTES_KEY = "mild-release-notes";


export const OPEN_TABS_KEY = IS_DEV_BUILD ? "mild-dev-last-open-tabs" : "mild-last-open-tabs";

export const UPDATES_SUPPORTED = IS_TAURI && !IS_DEV_BUILD;

