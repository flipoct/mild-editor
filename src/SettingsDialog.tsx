import { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import type { BackgroundImage } from "./backgroundImage";
import type { ClangdInfo } from "./clangd";
import { updateStatusLine, type messages, type Translate } from "./i18n";
import { AppLogo, Icon, LanguageIcon } from "./icons";
import { setupMonaco } from "./monacoSetup";
import { errorMessage, IS_TAURI } from "./platform";
import { loadTemplateDrafts, templates, templateSources, templateStorageKey } from "./problems";
import type { BrowserStatus } from "./ProblemWindow";
import { ATCODER_BETTER_USERSCRIPT, clampEditorFontSize, clampUiZoom, DEFAULT_PROFILE_FLAGS, EDITOR_FONT_SIZE_MAX, EDITOR_FONT_SIZE_MIN, IS_DEV_BUILD, pickEditorFont, TAMPERMONKEY_ID, UI_STYLES, UI_THEMES, UI_ZOOM_MAX, UI_ZOOM_MIN, UI_ZOOM_STEP, UPDATES_SUPPORTED, wallpaperCss } from "./settings";
import { adjustUiZoom, getSetting, setSetting, useSetting } from "./settingsStore";
import { DEFAULT_DETAILS, DEFAULT_PRESENCE_OPTIONS, DEFAULT_STATE, DISCORD_APPLICATION_ID, discordActivity, PLACEHOLDERS } from "./discord";
import { iconFromUrl, imageToIcon, isImageAddress } from "./appIcon";
import { chosenToolchain, ensureToolchains, rescanToolchains, toolchainLabel, toolchains, type PythonDownload, type Toolchain } from "./toolchains";
import type { BrowserExtension, ClangdStatus, CodeSnippet, CompanionStatus, EditorFontOption, Language, ProblemSource, SettingsPage, UiLocale, UiStyle, UiTheme, UpdateStatus, WallpaperLayout } from "./types";

/** The pages in the order the navigation lists them, each with the message that names it. */
const PAGES: Array<[SettingsPage, keyof typeof messages.en]> = [
  ["appearance", "appearance"], ["template", "template"], ["snippets", "snippets"], ["judge", "judge"],
  ["build", "buildSettings"], ["languages", "languagesSettings"], ["language-server", "languageServer"], ["discord", "discordSettings"], ["browser", "browserSettings"], ["updates", "updates"],
];

const THEME_NOTES: Record<UiTheme, string> = {
  pastel: "Muted, Sublime-inspired", midnight: "Soft pastel dark", latte: "Warm, quiet light", sakura: "Purple, pink and cyan",
  blossom: "Warm retro contrast", nord: "Calm arctic blue", tokyo: "Electric city blue",
  "one-dark": "Atom's dark, a soft blue-grey", "github-dimmed": "GitHub's dark, lower contrast", everforest: "Soft green-grey, easy on the eyes",
};

const STYLE_NOTES: Record<UiStyle, keyof typeof messages.en> = { mild: "styleMildNote", instrument: "styleInstrumentNote", paper: "stylePaperNote" };

/**
 * What the dialog needs from the app around it. Preferences are not here: every page reads
 * and writes those in the settings store. These are the things only the app window knows,
 * or that reach outside the dialog when pressed.
 */
export type SettingsDialogProps = {
  t: Translate;
  /** The page on show; `null` while the dialog is closed. The app opens it on a page of its choosing. */
  page: SettingsPage | null;
  onPage: (page: SettingsPage | null) => void;
  /** Language of the file being edited: what a new snippet and the template tab start on. */
  language: Language;
  /** The stock faces found on this machine, measured once by the app for the editor. */
  systemFonts: EditorFontOption[];
  background: BackgroundImage;
  /** Puts a line in the status bar, for a failure that has no place of its own in the dialog. */
  showStatus: (message: string) => void;
  resetLayout: () => void;
  /** Writes a template into the open file. */
  applyTemplate: (template: string, source: ProblemSource, language: Language) => void;
  companionStatus: CompanionStatus;
  companionError: string;
  refreshingJudge: boolean;
  refreshSubmissionStatuses: () => void;
  browserStatus: BrowserStatus;
  /** Shows the problem panel and has Tampermonkey install the script there. */
  installUserscript: (url: string) => void;
  clangdStatus: ClangdStatus;
  clangdInfo: ClangdInfo | null;
  connectClangd: () => void;
  appVersion: string;
  updateStatus: UpdateStatus;
  /** A failed install still has its update at hand, so it can be tried again. */
  updateRetryable: boolean;
  checkForUpdates: () => void;
  installUpdate: () => void;
  exportSettings: () => void;
  importSettings: () => void;
};

/**
 * The preferences dialog. It stays mounted while closed, so a half-written template or
 * snippet, a typed clangd path and the extension list are still there when it comes back,
 * and the extension list keeps following installs that finish in the background.
 */
export function SettingsDialog(props: SettingsDialogProps) {
  const { t, page, onPage, language, systemFonts } = props;
  const close = () => onPage(null);
  const templateDrafts = useTemplateDrafts(language, page !== null);
  const snippetEditor = useSnippetEditor(language);
  const extensions = useBrowserExtensions(page === "browser");
  // Typed freely; it only becomes the stored path when "Connect clangd" is pressed.
  const [clangdPath, setClangdPath] = useState(() => getSetting("clangdPath"));
  const [uiTheme] = useSetting("uiTheme");
  const [editorFont] = useSetting("editorFont");
  const [customFonts] = useSetting("customFonts");
  if (page === null) return null;

  const fontOptions = [...systemFonts, ...customFonts];
  const selectedFont = pickEditorFont(fontOptions, editorFont);
  const monaco = { theme: `mild-${uiTheme}`, fontFamily: selectedFont.family };
  const title = t(PAGES.find(([id]) => id === page)![1]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <nav className="settings-pages" aria-label={t("preferences")}>
          <span className="settings-nav-title">{t("preferences")}</span>
          {PAGES.map(([id, label]) => <button key={id} className={page === id ? "active" : ""} onClick={() => onPage(id)}>{t(label)}{id === "updates" && props.updateStatus.phase === "available" && <i className="nav-dot" />}</button>)}
        </nav>
        <div className="settings-main">
        <header className="settings-header">
          <div><h2 id="settings-title">{title}</h2></div>
          <button className="modal-close" onClick={close} aria-label="Close settings"><Icon name="close" size={14} /></button>
        </header>
        {page === "appearance" ? <AppearancePage t={t} fontOptions={fontOptions} selectedFont={selectedFont} systemFonts={systemFonts} background={props.background} showStatus={props.showStatus} resetLayout={props.resetLayout} />
          : page === "template" ? <TemplatePage t={t} drafts={templateDrafts} monaco={monaco} applyTemplate={props.applyTemplate} close={close} />
          : page === "snippets" ? <SnippetsPage t={t} editor={snippetEditor} monaco={monaco} />
          : page === "judge" ? <JudgePage t={t} companionStatus={props.companionStatus} companionError={props.companionError} refreshingJudge={props.refreshingJudge} refreshSubmissionStatuses={props.refreshSubmissionStatuses} />
          : page === "build" ? <BuildPage t={t} />
          : page === "languages" ? <LanguagesPage t={t} />
          : page === "discord" ? <DiscordPage t={t} />
          : page === "browser" ? <BrowserPage t={t} extensions={extensions} browserStatus={props.browserStatus} installUserscript={props.installUserscript} />
          : page === "updates" ? <UpdatesPage t={t} appVersion={props.appVersion} updateStatus={props.updateStatus} updateRetryable={props.updateRetryable} checkForUpdates={props.checkForUpdates} installUpdate={props.installUpdate} exportSettings={props.exportSettings} importSettings={props.importSettings} />
          : <LanguageServerPage t={t} clangdPath={clangdPath} setClangdPath={setClangdPath} clangdStatus={props.clangdStatus} clangdInfo={props.clangdInfo} connectClangd={props.connectClangd} />}
        </div>
      </section>
    </div>
  );
}

/** How the two small Monaco editors in the dialog follow the app's theme and editor font. */
type MonacoLook = { theme: string; fontFamily: string };

/** The app's icon: the mark, a picture from this computer, or one from an address — which Discord can show as well. */
function AppIconSection({ t }: Pick<SettingsDialogProps, "t">) {
  const [appIcon, setAppIcon] = useSetting("appIcon");
  const [appIconUrl, setAppIconUrl] = useSetting("appIconUrl");
  const [address, setAddress] = useState(appIconUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const fromFile = (file: File | undefined) => {
    if (!file) return;
    setError("");
    imageToIcon(file).then((icon) => { setAppIcon(icon); setAppIconUrl(""); setAddress(""); }, (reason) => setError(errorMessage(reason)));
  };
  const fromAddress = () => {
    if (!isImageAddress(address.trim())) { setError(t("appIconHttps")); return; }
    setError("");
    setBusy(true);
    iconFromUrl(address.trim()).then((icon) => { setAppIcon(icon); setAppIconUrl(address.trim()); }, (reason) => setError(errorMessage(reason))).finally(() => setBusy(false));
  };
  return <>
    <div className="appearance-group"><span>{t("appIcon")}</span></div>
    <div className="app-icon-picker">
      <span className="app-icon-preview welcome-mark"><AppLogo icon={appIcon} /></span>
      <div className="app-icon-actions">
        <div className="companion-controls">
          <button className="subtle-button" onClick={() => fileRef.current?.click()}>{t("appIconUpload")}</button>
          <button className="subtle-button" onClick={() => { setAppIcon(""); setAppIconUrl(""); setAddress(""); setError(""); }} disabled={!appIcon}>{t("reset")}</button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(event) => { fromFile(event.target.files?.[0]); event.target.value = ""; }} />
        </div>
        <span className="path-picker"><input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="https://…/icon.png" spellCheck={false} aria-label={t("appIconAddress")} onKeyDown={(event) => { if (event.key === "Enter") fromAddress(); }} /><button className="subtle-button" onClick={fromAddress} disabled={busy || !address.trim()}>{busy ? t("appIconLoading") : t("appIconUse")}</button></span>
      </div>
    </div>
    <p className="settings-help">{appIcon && !appIconUrl ? t("appIconLocalNote") : t("appIconHelp")}</p>
    {error && <p className="settings-help toolchain-error" role="alert">{error}</p>}
  </>;
}

function AppearancePage({ t, fontOptions, selectedFont, systemFonts, background, showStatus, resetLayout }: Pick<SettingsDialogProps, "t" | "systemFonts" | "background" | "showStatus" | "resetLayout"> & { fontOptions: EditorFontOption[]; selectedFont: EditorFontOption }) {
  const [uiLocale, setUiLocale] = useSetting("uiLocale");
  const [uiZoom, setUiZoom] = useSetting("uiZoom");
  const [uiTheme, setUiTheme] = useSetting("uiTheme");
  const [uiStyle, setUiStyle] = useSetting("uiStyle");
  const [wallpaperLayout, setWallpaperLayout] = useSetting("wallpaperLayout");
  const [wallpaperScale, setWallpaperScale] = useSetting("wallpaperScale");
  const [wallpaperPositionX, setWallpaperPositionX] = useSetting("wallpaperPositionX");
  const [wallpaperPositionY, setWallpaperPositionY] = useSetting("wallpaperPositionY");
  const [acrylicOpacity, setAcrylicOpacity] = useSetting("acrylicOpacity");
  const [acrylicBlur, setAcrylicBlur] = useSetting("acrylicBlur");
  const [editorFont, setEditorFont] = useSetting("editorFont");
  const [editorFontSize, setEditorFontSize] = useSetting("editorFontSize");
  const [customFonts, setCustomFonts] = useSetting("customFonts");
  const [autoSave, setAutoSave] = useSetting("autoSave");
  const wallpaper = wallpaperCss(wallpaperLayout, wallpaperScale, wallpaperPositionX, wallpaperPositionY);
  // The field holds free text while it is typed and only applies on commit; clamping on
  // every keystroke would turn the "2" on the way to "20" into the minimum.
  const [editorFontSizeDraft, setEditorFontSizeDraft] = useState(() => String(editorFontSize));

  useEffect(() => {
    setEditorFontSizeDraft(String(editorFontSize));
  }, [editorFontSize]);

  const commitEditorFontSize = () => {
    const parsed = Number.parseFloat(editorFontSizeDraft);
    const next = Number.isFinite(parsed) ? clampEditorFontSize(parsed) : editorFontSize;
    setEditorFontSize(next);
    // Re-sync the text even when the size did not change, e.g. "99" clamped to an already-set 40.
    setEditorFontSizeDraft(String(next));
  };

  const addEditorFont = async () => {
    try {
      const path = await open({ multiple: false, directory: false, title: "Add editor font", filters: [{ name: "Font files", extensions: ["ttf", "otf", "woff", "woff2"] }] });
      if (!path || Array.isArray(path)) return;
      const label = path.split(/[\\/]/).at(-1)?.replace(/\.(ttf|otf|woff2?)$/i, "") || "Custom font";
      const id = `custom-${crypto.randomUUID()}`;
      const faceFamily = `MildCustom_${id.replace(/-/g, "_")}`;
      const bytes = await invoke<number[]>("read_font_file", { request: { path } });
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
      try {
        const face = new FontFace(faceFamily, `url(${url})`);
        await face.load();
        document.fonts.add(face);
      } finally { URL.revokeObjectURL(url); }
      const font = { id, label, family: `'${faceFamily}', monospace`, path };
      setCustomFonts([...customFonts, font]);
      setEditorFont(id);
    } catch (error) { showStatus(errorMessage(error)); }
  };

  const removeEditorFont = () => {
    setCustomFonts(customFonts.filter((font) => font.id !== editorFont));
    setEditorFont(systemFonts[0]?.id || "consolas");
  };

  return <div className="appearance-settings">
    <div className="appearance-group"><label>{t("interfaceLanguage")}<select value={uiLocale} onChange={(event) => setUiLocale(event.target.value as UiLocale)}><option value="en">{t("english")}</option><option value="ko">{t("korean")}</option></select></label></div>
    <div className="appearance-group">
      <label className="appearance-range"><span>{t("interfaceScale")}</span><input type="range" min={UI_ZOOM_MIN} max={UI_ZOOM_MAX} step={UI_ZOOM_STEP} value={uiZoom} onChange={(event) => setUiZoom(clampUiZoom(Number(event.target.value)))} aria-label={t("interfaceScale")} /><output>{uiZoom}%</output></label>
      <div className="wallpaper-layout-actions"><button className="subtle-button" onClick={() => adjustUiZoom(-UI_ZOOM_STEP)} disabled={uiZoom <= UI_ZOOM_MIN} aria-label="zoom out">−</button><button className="subtle-button" onClick={() => adjustUiZoom(UI_ZOOM_STEP)} disabled={uiZoom >= UI_ZOOM_MAX} aria-label="zoom in">＋</button><button className="subtle-button" onClick={() => setUiZoom(100)} disabled={uiZoom === 100}>{t("reset")}</button></div>
    </div>
    <p className="settings-help">{t("interfaceScaleHelp")}</p>
    <div className="appearance-group"><span>{t("layoutTitle")}</span><div className="companion-controls"><button className="subtle-button" onClick={resetLayout}>{t("layoutReset")}</button></div></div>
    <p className="settings-help">{t("layoutHint")}</p>
    <AppIconSection t={t} />
    <p className="settings-help">{t("appearanceHelp")}</p>
    <div className="appearance-group"><span>{t("theme")}</span><div className="theme-options">
      {UI_THEMES.map(([theme, name]) => <button key={theme} className={`theme-option ${theme} ${uiTheme === theme ? "active" : ""}`} onClick={() => setUiTheme(theme)}><i /><strong>{name}</strong><small>{THEME_NOTES[theme]}</small></button>)}
    </div></div>
    <div className="appearance-group"><span>{t("uiStyle")}</span><div className="theme-options">
      {UI_STYLES.map(([style, name]) => <button key={style} className={`theme-option style-option ${uiStyle === style ? "active" : ""}`} data-preview={style} aria-pressed={uiStyle === style} onClick={() => setUiStyle(style)}><i>Aa</i><strong>{name}</strong><small>{t(STYLE_NOTES[style])}</small></button>)}
    </div></div>
    <div className="appearance-group wallpaper-settings">
      <span>{t("backgroundImage")}</span>
      <p className="settings-help">{t("backgroundHelp")}</p>
      <div className="wallpaper-picker">
        <input ref={background.inputRef} className="wallpaper-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" onChange={background.chooseFile} tabIndex={-1} />
        <div className={`wallpaper-preview ${background.url ? "has-image" : ""}`} style={background.url ? { backgroundImage: `url(${background.url})`, backgroundPosition: wallpaper.position, backgroundRepeat: wallpaper.repeat, backgroundSize: wallpaper.size } : undefined}><span>{background.url ? background.path.split(/[\\/]/).at(-1) : t("noBackground")}</span></div>
        <div className="font-actions"><button className="subtle-button" onClick={() => void background.choose()}>{t("chooseBackground")}</button>{background.path && <button className="danger-button" onClick={background.clear}>{t("clearBackground")}</button>}</div>
      </div>
      {background.error && <p className="wallpaper-error">{background.error}</p>}
      <label className="wallpaper-layout-select"><span>{t("wallpaperLayout")}</span><select value={wallpaperLayout} onChange={(event) => setWallpaperLayout(event.target.value as WallpaperLayout)}><option value="cover">{t("wallpaperCover")}</option><option value="contain">{t("wallpaperContain")}</option><option value="stretch">{t("wallpaperStretch")}</option><option value="original">{t("wallpaperOriginal")}</option><option value="tile">{t("wallpaperTile")}</option><option value="custom">{t("wallpaperCustom")}</option></select></label>
      {(wallpaperLayout === "custom" || wallpaperLayout === "tile") && <label className="appearance-range"><span>{t("wallpaperScale")}</span><input type="range" min="25" max="300" step="5" value={wallpaperScale} onChange={(event) => setWallpaperScale(Number(event.target.value))} /><output>{wallpaperScale}%</output></label>}
      <label className="appearance-range"><span>{t("wallpaperPositionX")}</span><input type="range" min="0" max="100" value={wallpaperPositionX} onChange={(event) => setWallpaperPositionX(Number(event.target.value))} /><output>{wallpaperPositionX}%</output></label>
      <label className="appearance-range"><span>{t("wallpaperPositionY")}</span><input type="range" min="0" max="100" value={wallpaperPositionY} onChange={(event) => setWallpaperPositionY(Number(event.target.value))} /><output>{wallpaperPositionY}%</output></label>
      <div className="wallpaper-layout-actions"><button className="subtle-button" onClick={() => { setWallpaperLayout("cover"); setWallpaperScale(100); setWallpaperPositionX(50); setWallpaperPositionY(50); }}>{t("resetWallpaperLayout")}</button></div>
      <label className="appearance-range"><span>{t("acrylicOpacity")}</span><input type="range" min="0" max="100" value={acrylicOpacity} onChange={(event) => setAcrylicOpacity(Number(event.target.value))} /><output>{acrylicOpacity}%</output></label>
      <label className="appearance-range"><span>{t("acrylicBlur")}</span><input type="range" min="0" max="32" value={acrylicBlur} onChange={(event) => setAcrylicBlur(Number(event.target.value))} /><output>{acrylicBlur}px</output></label>
    </div>
    <div className="appearance-group"><label>{t("editorFont")}<select value={selectedFont.id} onChange={(event) => setEditorFont(event.target.value)}>{fontOptions.map((font) => <option value={font.id} key={font.id}>{font.label}</option>)}</select></label><label>{t("editorFontSize")}<span className="editor-font-size"><input type="number" inputMode="numeric" min={EDITOR_FONT_SIZE_MIN} max={EDITOR_FONT_SIZE_MAX} step={1} value={editorFontSizeDraft} onChange={(event) => setEditorFontSizeDraft(event.target.value)} onBlur={commitEditorFontSize} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} aria-label={t("editorFontSize")} /><small>px</small></span></label><div className="font-actions"><button className="subtle-button" onClick={() => void addEditorFont()}>{t("addFont")}</button>{selectedFont.path && <button className="danger-button" onClick={removeEditorFont}>{t("remove")}</button>}</div><pre style={{ fontFamily: selectedFont.family, fontSize: editorFontSize }}>int main() {'{'} return 0; {'}'}</pre></div>
    <div className="appearance-group"><label className="companion-toggle"><input type="checkbox" checked={autoSave} onChange={(event) => setAutoSave(event.target.checked)} />{t("autoSave")}</label><p className="settings-help">{t("autoSaveHelp")}</p></div>
  </div>;
}

/**
 * The templates as they are being edited, one per site and language. Nothing reaches
 * localStorage until "Save"; "Apply to editor" uses the draft as it stands.
 */
function useTemplateDrafts(activeLanguage: Language, dialogOpen: boolean) {
  const [language, setLanguage] = useState<Language>("cpp");
  const [source, setSource] = useState<ProblemSource>("other");
  const [drafts, setDrafts] = useState<Record<string, string>>(loadTemplateDrafts);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const key = templateStorageKey(source, language);
  const setDraft = (code: string) => setDrafts((current) => ({ ...current, [key]: code }));

  // Each time the dialog comes up, the template tab starts on the language being written.
  const wasOpenRef = useRef(dialogOpen);
  useEffect(() => {
    if (dialogOpen && !wasOpenRef.current) setLanguage(activeLanguage);
    wasOpenRef.current = dialogOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen]);

  const save = () => Object.entries(drafts).forEach(([draftKey, value]) => localStorage.setItem(draftKey, value));

  const setCursor = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const position = editor?.getPosition();
    if (!editor || !model || !position) return;
    const template = drafts[key] || "";
    const rawOffset = model.getOffsetAt(position);
    const offset = template.slice(0, rawOffset).replaceAll("${cursor}", "").length;
    const clean = template.replaceAll("${cursor}", "");
    setDraft(`${clean.slice(0, offset)}${"${cursor}"}${clean.slice(offset)}`);
    window.requestAnimationFrame(() => {
      const nextModel = editorRef.current?.getModel();
      if (!nextModel) return;
      editorRef.current?.setPosition(nextModel.getPositionAt(offset + "${cursor}".length));
      editorRef.current?.focus();
    });
  };

  return { language, setLanguage, source, setSource, draft: drafts[key], setDraft, editorRef, setCursor, save };
}

/**
 * One editor shows each draft in turn, and switching writes the next one into the same text
 * model — as an edit, which joins its undo history. Ctrl+Z after a switch then brought the
 * draft that was shown before back into the one shown now, and Save kept it there: a C++
 * template holding Python. Starting the history afresh on every switch keeps each draft to
 * the edits made to it. Effects of the editor run before this one, so the new draft is in
 * the model by now, and the change this reports is that draft, unchanged.
 */
const useHistoryPerDraft = (editorRef: { current: Monaco.editor.IStandaloneCodeEditor | null }, draftKey: string) => {
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model) model.setValue(model.getValue());
  }, [editorRef, draftKey]);
};

function TemplatePage({ t, drafts, monaco, applyTemplate, close }: Pick<SettingsDialogProps, "t" | "applyTemplate"> & { drafts: ReturnType<typeof useTemplateDrafts>; monaco: MonacoLook; close: () => void }) {
  const { language, source } = drafts;
  useHistoryPerDraft(drafts.editorRef, `${source}/${language}`);
  return <>
    <div className="template-tabs" role="tablist" aria-label="Template language">
      <button className={language === "cpp" ? "active" : ""} onClick={() => drafts.setLanguage("cpp")}>C++</button>
      <button className={language === "python" ? "active" : ""} onClick={() => drafts.setLanguage("python")}>Python</button>
    </div>
    <div className="template-tabs template-source-tabs" role="tablist" aria-label="Template site">
      {templateSources.map((site) => <button key={site} className={source === site ? "active" : ""} onClick={() => drafts.setSource(site)}>{site === "other" ? t("local") : site === "atcoder" ? "AtCoder" : site === "codeforces" ? "Codeforces" : "DOJ"}</button>)}
    </div>
    <p className="settings-help">{t("templateHelp")}</p>
    <div className="template-monaco"><Editor beforeMount={setupMonaco} onMount={(editor) => { drafts.editorRef.current = editor; }} height="100%" language={language === "cpp" ? "cpp" : "python"} value={drafts.draft} onChange={(code) => drafts.setDraft(code || "")} theme={monaco.theme} options={{ minimap: { enabled: false }, fontFamily: monaco.fontFamily, fontSize: 12, lineNumbers: "on", scrollBeyondLastLine: false, automaticLayout: true, tabSize: 4, padding: { top: 10, bottom: 10 } }} /></div>
    <footer className="settings-footer">
      <button className="subtle-button" onClick={() => drafts.setDraft(templates[language])}>{t("reset")}</button>
      <button className="subtle-button" onClick={drafts.setCursor}>Set cursor here</button>
      <span className="footer-spacer" />
      <button className="subtle-button" onClick={() => applyTemplate(drafts.draft, source, language)}>{t("applyEditor")}</button>
      <button className="primary-button" onClick={() => { drafts.save(); close(); }}>{t("saveTemplate")}</button>
    </footer>
  </>;
}

const blankSnippet = (language: Language): CodeSnippet => ({ id: crypto.randomUUID(), name: "", language, code: "" });

/** The snippet in the form: a saved one being changed, or a new one that has no entry yet. */
function useSnippetEditor(activeLanguage: Language) {
  const [snippets, setSnippets] = useSetting("snippets");
  const [draft, setDraft] = useState<CodeSnippet>(() => blankSnippet("cpp"));
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const startNew = () => setDraft(blankSnippet(activeLanguage));

  const save = () => {
    if (!draft.name.trim() || !draft.code.trim()) return;
    setSnippets(snippets.some((snippet) => snippet.id === draft.id)
      ? snippets.map((snippet) => snippet.id === draft.id ? { ...draft, name: draft.name.trim() } : snippet)
      : [...snippets, { ...draft, name: draft.name.trim() }]);
    startNew();
  };

  const setCursor = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const position = editor?.getPosition();
    if (!editor || !model || !position) return;
    const marker = "${0}";
    const rawOffset = model.getOffsetAt(position);
    const offset = draft.code.slice(0, rawOffset).replaceAll(marker, "").length;
    const clean = draft.code.replaceAll(marker, "");
    const next = `${clean.slice(0, offset)}${marker}${clean.slice(offset)}`;
    setDraft((current) => ({ ...current, code: next }));
    window.requestAnimationFrame(() => {
      const nextModel = editorRef.current?.getModel();
      if (!nextModel) return;
      editorRef.current?.setPosition(nextModel.getPositionAt(offset + marker.length));
      editorRef.current?.focus();
    });
  };

  const remove = (id: string) => {
    setSnippets(snippets.filter((snippet) => snippet.id !== id));
    if (draft.id === id) startNew();
  };

  /** Moves a snippet past the next one of its language, up or down: the order is its rank among the completions. */
  const move = (id: string, step: -1 | 1) => setSnippets((current) => {
    const at = current.findIndex((snippet) => snippet.id === id);
    if (at < 0) return current;
    let other = at + step;
    while (other >= 0 && other < current.length && current[other].language !== current[at].language) other += step;
    if (other < 0 || other >= current.length) return current;
    const next = [...current];
    [next[at], next[other]] = [next[other], next[at]];
    return next;
  });

  return { snippets, draft, setDraft, editorRef, startNew, save, setCursor, remove, move };
}

function SnippetsPage({ t, editor, monaco }: Pick<SettingsDialogProps, "t"> & { editor: ReturnType<typeof useSnippetEditor>; monaco: MonacoLook }) {
  const { draft, setDraft } = editor;
  const [snippetsFirst, setSnippetsFirst] = useSetting("snippetsFirst");
  // Each snippet keeps its own undo history too: the editor is shared in the same way.
  useHistoryPerDraft(editor.editorRef, draft.id);
  return <div className="snippet-settings">
    <aside className="snippet-list">
      <button className="new-snippet" onClick={editor.startNew}><Icon name="plus" size={13} />New snippet</button>
      {editor.snippets.map((snippet) => <div className={`snippet-item ${snippet.id === draft.id ? "active" : ""}`} key={snippet.id}>
        <button onClick={() => setDraft(snippet)}><span>{snippet.name}</span><small>{snippet.language}</small></button>
        <span className="snippet-order">
          <button onClick={() => editor.move(snippet.id, -1)} aria-label={t("snippetUp")} title={t("snippetUp")}><Icon name="chevronDown" size={11} className="flip" /></button>
          <button onClick={() => editor.move(snippet.id, 1)} aria-label={t("snippetDown")} title={t("snippetDown")}><Icon name="chevronDown" size={11} /></button>
        </span>
        <button className="snippet-delete" onClick={() => editor.remove(snippet.id)} aria-label={`Delete ${snippet.name}`}><Icon name="close" size={12} /></button>
      </div>)}
      <label className="companion-toggle snippet-first"><input type="checkbox" checked={snippetsFirst} onChange={(event) => setSnippetsFirst(event.target.checked)} />{t("snippetsFirst")}</label>
    </aside>
    <div className="snippet-form">
      <div className="snippet-guide">
        <strong>How to use snippets</strong>
        <span>{t("snippetsHelp")}</span>
        <span>Monaco placeholders are supported: <code>{"${1:value}"}</code> selects the first editable field and <code>{"${0}"}</code> sets the final cursor position. Snippets are stored locally on this device.</span>
      </div>
      <div className="snippet-meta">
        <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Snippet name" aria-label="Snippet name" />
        <select value={draft.language} onChange={(event) => setDraft((current) => ({ ...current, language: event.target.value as Language }))} aria-label="Snippet language"><option value="cpp">C++</option><option value="python">Python</option></select>
      </div>
      <div className="snippet-monaco"><Editor beforeMount={setupMonaco} onMount={(mounted) => { editor.editorRef.current = mounted; }} height="100%" language={draft.language === "cpp" ? "cpp" : "python"} value={draft.code} onChange={(code) => setDraft((current) => ({ ...current, code: code || "" }))} theme={monaco.theme} options={{ minimap: { enabled: false }, fontFamily: monaco.fontFamily, fontSize: 12, lineNumbers: "on", scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, padding: { top: 10, bottom: 10 } }} /></div>
      <footer className="settings-footer"><button className="subtle-button" onClick={editor.setCursor}>Set cursor here</button><span className="footer-spacer" /><button className="primary-button" onClick={editor.save} disabled={!draft.name.trim() || !draft.code.trim()}>Save snippet</button></footer>
    </div>
  </div>;
}

function JudgePage({ t, companionStatus, companionError, refreshingJudge, refreshSubmissionStatuses }: Pick<SettingsDialogProps, "t" | "companionStatus" | "companionError" | "refreshingJudge" | "refreshSubmissionStatuses">) {
  const [companionEnabled, setCompanionEnabled] = useSetting("companionEnabled");
  const [companionPort, setCompanionPort] = useSetting("companionPort");
  const [defaultLanguage, setDefaultLanguage] = useSetting("defaultLanguage");
  const [organizeImports, setOrganizeImports] = useSetting("organizeImports");
  const [autoContest, setAutoContest] = useSetting("autoContest");
  const [submitPress, setSubmitPress] = useSetting("submitPress");
  const [atcoderHandle, setAtcoderHandle] = useSetting("atcoderHandle");
  const [codeforcesHandle, setCodeforcesHandle] = useSetting("codeforcesHandle");
  const [dojHandle, setDojHandle] = useSetting("dojHandle");
  return <div className="language-server-settings judge-settings">
    <p className="settings-help">{t("judgeHelp")}</p>
    <div className={`lsp-state ${companionStatus.listening ? "ready" : companionError ? "error" : "idle"}`}>
      <span className="lsp-dot" />
      <div>
        <strong>{t("companion")}</strong>
        <small>{companionError || (companionStatus.listening ? `${t("companionListening")} · ${companionStatus.port}` : t("companionOff"))}</small>
      </div>
    </div>
    <p className="settings-help">{t("companionHelp")}</p>
    <div className="companion-controls">
      <label className="companion-toggle"><input type="checkbox" checked={companionEnabled} onChange={(event) => setCompanionEnabled(event.target.checked)} />{t("companionEnable")}</label>
      <label className="clangd-path-label">{t("companionPort")}<input type="number" min={1024} max={65535} value={companionPort} onChange={(event) => setCompanionPort(Math.min(65535, Math.max(1024, Number(event.target.value) || 10043)))} /></label>
    </div>
    <label className="clangd-path-label">{t("defaultLanguage")}<select value={defaultLanguage} onChange={(event) => setDefaultLanguage(event.target.value as Language)}><option value="cpp">C++ (.cpp)</option><option value="python">Python (.py)</option></select></label>
    <p className="settings-help">{t("defaultLanguageHelp")}</p>
    <label className="companion-toggle"><input type="checkbox" checked={organizeImports} onChange={(event) => setOrganizeImports(event.target.checked)} />{t("organizeImports")}</label>
    <p className="settings-help">{t("organizeImportsHelp")}</p>
    <label className="companion-toggle"><input type="checkbox" checked={autoContest} onChange={(event) => setAutoContest(event.target.checked)} />{t("autoContest")}</label>
    <p className="settings-help">{t("autoContestHelp")}</p>
    <label className="companion-toggle"><input type="checkbox" checked={submitPress} onChange={(event) => setSubmitPress(event.target.checked)} />{t("submitPress")}</label>
    <p className="settings-help">{t("submitPressHelp")}</p>
    <label className="clangd-path-label">AtCoder handle<input value={atcoderHandle} onChange={(event) => setAtcoderHandle(event.target.value)} placeholder="tourist" spellCheck={false} /></label>
    <label className="clangd-path-label">Codeforces handle<input value={codeforcesHandle} onChange={(event) => setCodeforcesHandle(event.target.value)} placeholder="tourist" spellCheck={false} /></label>
    <label className="clangd-path-label">DOJ handle<input value={dojHandle} onChange={(event) => setDojHandle(event.target.value)} placeholder="username" spellCheck={false} /></label>
    <footer className="settings-footer"><span className="footer-spacer" /><button className="primary-button" disabled={refreshingJudge} onClick={refreshSubmissionStatuses}>{refreshingJudge ? t("refreshing") : t("refreshNow")}</button></footer>
  </div>;
}

function BuildPage({ t }: Pick<SettingsDialogProps, "t">) {
  const [profileFlags, setProfileFlags] = useSetting("profileFlags");
  const [compileProfile, setCompileProfile] = useSetting("compileProfile");
  const [precompileHeaders, setPrecompileHeaders] = useSetting("precompileHeaders");
  const [floatTolerance, setFloatTolerance] = useSetting("floatTolerance");
  return <div className="language-server-settings judge-settings">
    <div className="appearance-group"><span>{t("compileProfiles")}</span></div>
    <p className="settings-help">{t("compileProfilesHelp")}</p>
    {(["release", "debug"] as const).map((profile) => (
      <label className="clangd-path-label" key={profile}>{profile === "release" ? "Release" : "Debug"}
        <span className="path-picker"><input value={profileFlags[profile]} onChange={(event) => setProfileFlags((current) => ({ ...current, [profile]: event.target.value }))} spellCheck={false} aria-label={`${profile} flags`} /><button className="subtle-button" onClick={() => setProfileFlags((current) => ({ ...current, [profile]: DEFAULT_PROFILE_FLAGS[profile] }))} disabled={profileFlags[profile] === DEFAULT_PROFILE_FLAGS[profile]}>{t("reset")}</button></span>
      </label>
    ))}
    <label className="clangd-path-label">{t("activeProfile")}<select value={compileProfile} onChange={(event) => setCompileProfile(event.target.value === "debug" ? "debug" : "release")}><option value="release">Release</option><option value="debug">Debug</option></select></label>
    <p className="settings-help">{t("activeProfileHelp")}</p>
    <label className="companion-toggle"><input type="checkbox" checked={precompileHeaders} onChange={(event) => setPrecompileHeaders(event.target.checked)} />{t("precompileHeaders")}</label>
    <p className="settings-help">{t("precompileHeadersHelp")}</p>
    <div className="appearance-group"><span>{t("judging")}</span></div>
    <label className="clangd-path-label">{t("floatTolerance")}<select value={String(floatTolerance)} onChange={(event) => setFloatTolerance(Number(event.target.value))}><option value="0">{t("floatToleranceOff")}</option><option value="0.0001">1e-4</option><option value="0.000001">1e-6</option><option value="1e-9">1e-9</option></select></label>
    <p className="settings-help">{t("floatToleranceHelp")}</p>
  </div>;
}

type DiscordStatus = { connected: boolean; user: string | null; error: string | null };

/** Discord's activity status as Discord's own profile card shows it, from the settings as they are now. */
function DiscordPreview({ t, locale }: Pick<SettingsDialogProps, "t"> & { locale: "en" | "ko" }) {
  const settings = {
    details: useSetting("discordDetails")[0], state: useSetting("discordState")[0], idle: useSetting("discordIdle")[0],
    showFile: useSetting("discordShowFile")[0], showContest: useSetting("discordShowContest")[0], showTime: useSetting("discordShowTime")[0],
    showLanguage: useSetting("discordShowLanguage")[0], showButton: useSetting("discordShowButton")[0],
    buttonLabel: useSetting("discordButtonLabel")[0], buttonUrl: useSetting("discordButtonUrl")[0],
  };
  const [appIcon] = useSetting("appIcon");
  const [contest, setContest] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const since = useRef(Date.now() - 12 * 60_000 - 34_000).current;
  const endsAt = useRef(Date.now() + 42 * 60_000 + 10_000).current;
  const activity = discordActivity({
    locale, version: "", toolchain: "Python 3.14", since, teammates: 2,
    file: { title: "A - Takahashi's Snack", filename: "AtCoder/abc300/A.py", language: "python", source: "atcoder" },
    contest: contest ? { endsAt, solved: 3, total: 7 } : null,
    options: {
      details: settings.details, state: settings.state, idle: settings.idle, showFile: settings.showFile, showContest: settings.showContest,
      showTime: settings.showTime, showLanguage: settings.showLanguage, image: "",
      button: settings.showButton ? { label: settings.buttonLabel || DEFAULT_PRESENCE_OPTIONS.button!.label, url: settings.buttonUrl || DEFAULT_PRESENCE_OPTIONS.button!.url } : null,
    },
  });
  const clock = (seconds: number) => { const value = Math.max(0, seconds); const hours = Math.floor(value / 3600); const rest = `${String(Math.floor(value / 60) % 60).padStart(2, "0")}:${String(Math.floor(value % 60)).padStart(2, "0")}`; return hours ? `${hours}:${rest}` : rest; };
  const stamps = activity.timestamps as { start?: number; end?: number } | undefined;
  const time = stamps && (stamps.end !== undefined
    ? t("discordLeft").replace("{time}", clock(stamps.end - now / 1000))
    : t("discordElapsed").replace("{time}", clock(now / 1000 - (stamps.start ?? now / 1000))));
  return <div className="discord-preview">
    <div className="discord-preview-head">
      <small>{activity.type === 5 ? t("discordCompeting") : t("discordPlaying")}</small>
      <label className="discord-preview-toggle"><input type="checkbox" checked={contest} onChange={(event) => setContest(event.target.checked)} />{t("discordPreviewContest")}</label>
    </div>
    <div className="discord-preview-body">
      <span className="discord-preview-art"><AppLogo icon={appIcon} />{"small_image" in activity.assets && <i><LanguageIcon language="python" size={14} /></i>}</span>
      <div className="discord-preview-text">
        <strong>Mild Editor</strong>
        <span>{activity.details}</span>
        {"state" in activity && <span>{activity.state}</span>}
        {time && <span className="discord-preview-time">{time}</span>}
      </div>
    </div>
    {activity.buttons?.map((button) => <span key={button.label} className="discord-preview-button" title={button.url}>{button.label}</span>)}
  </div>;
}

/** Discord's activity status: whether it is on, what it says, and whether Discord is there to show it. */
function DiscordPage({ t }: Pick<SettingsDialogProps, "t">) {
  const [enabled, setEnabled] = useSetting("discordEnabled");
  const [showFile, setShowFile] = useSetting("discordShowFile");
  const [showContest, setShowContest] = useSetting("discordShowContest");
  const [showTime, setShowTime] = useSetting("discordShowTime");
  const [showLanguage, setShowLanguage] = useSetting("discordShowLanguage");
  const [showButton, setShowButton] = useSetting("discordShowButton");
  const [details, setDetails] = useSetting("discordDetails");
  const [stateLine, setStateLine] = useSetting("discordState");
  const [idle, setIdle] = useSetting("discordIdle");
  const [buttonLabel, setButtonLabel] = useSetting("discordButtonLabel");
  const [buttonUrl, setButtonUrl] = useSetting("discordButtonUrl");
  const [appId, setAppId] = useSetting("discordAppId");
  const [appIcon] = useSetting("appIcon");
  const [appIconUrl] = useSetting("appIconUrl");
  const [uiLocale] = useSetting("uiLocale");
  const [status, setStatus] = useState<DiscordStatus | null>(null);
  useEffect(() => {
    if (!IS_TAURI) return;
    const look = () => void invoke<DiscordStatus>("discord_status").then(setStatus).catch(() => undefined);
    look();
    const timer = window.setInterval(look, 2000);
    return () => window.clearInterval(timer);
  }, []);
  const application = appId || DISCORD_APPLICATION_ID;
  const state = !enabled ? "off" : !application ? "no-app" : status?.connected ? "ready" : status?.error === "not-running" || !status?.error ? "waiting" : "error";
  const line = state === "off" ? t("discordOff") : state === "no-app" ? t("discordNoApp") : state === "ready" ? (status?.user ? t("discordConnectedAs").replace("{user}", status.user) : t("discordConnected"))
    : state === "waiting" ? t("discordWaiting") : `${t("discordError")}: ${status?.error}`;
  const toggle = (checked: boolean, set: (value: boolean) => void, label: string) =>
    <label className="companion-toggle"><input type="checkbox" checked={checked} disabled={!enabled} onChange={(event) => set(event.target.checked)} />{label}</label>;
  return <div className="language-server-settings judge-settings discord-settings">
    <p className="settings-help">{t("discordHelp")}</p>
    <div className={`lsp-state ${state === "ready" ? "ready" : state === "error" ? "error" : "idle"}`}>
      <span className="lsp-dot" />
      <div><strong>Discord</strong><small>{line}</small></div>
    </div>
    <label className="companion-toggle"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t("discordEnable")}</label>
    <DiscordPreview t={t} locale={uiLocale === "ko" ? "ko" : "en"} />
    <div className="appearance-group"><span>{t("discordShown")}</span></div>
    {toggle(showFile, setShowFile, t("discordShowFile"))}
    {toggle(showContest, setShowContest, t("discordShowContest"))}
    {toggle(showTime, setShowTime, t("discordShowTime"))}
    {toggle(showLanguage, setShowLanguage, t("discordShowLanguage"))}
    {toggle(showButton, setShowButton, t("discordShowButton"))}
    {showButton && <div className="discord-button-fields">
      <input value={buttonLabel} onChange={(event) => setButtonLabel(event.target.value)} placeholder={DEFAULT_PRESENCE_OPTIONS.button!.label} maxLength={32} aria-label={t("discordButtonLabel")} disabled={!enabled} />
      <input value={buttonUrl} onChange={(event) => setButtonUrl(event.target.value)} placeholder={DEFAULT_PRESENCE_OPTIONS.button!.url} spellCheck={false} aria-label={t("discordButtonUrl")} disabled={!enabled} />
    </div>}
    <div className="appearance-group"><span>{t("discordLines")}</span></div>
    <label className="clangd-path-label">{t("discordDetails")}<input value={details} onChange={(event) => setDetails(event.target.value)} placeholder={DEFAULT_DETAILS} spellCheck={false} disabled={!enabled} /></label>
    <label className="clangd-path-label">{t("discordState")}<input value={stateLine} onChange={(event) => setStateLine(event.target.value)} placeholder={DEFAULT_STATE} spellCheck={false} disabled={!enabled} /></label>
    <label className="clangd-path-label">{t("discordIdle")}<input value={idle} onChange={(event) => setIdle(event.target.value)} placeholder={t("discordIdlePlaceholder")} spellCheck={false} disabled={!enabled} /></label>
    <p className="settings-help">{t("discordLinesHelp")} {PLACEHOLDERS.map((name) => <code key={name}>{`{${name}}`}</code>)}</p>
    <p className="settings-help">{appIcon ? appIconUrl ? t("discordImageCustom") : t("discordImageLocal") : t("discordImageDefault")}</p>
    <details className="collab-advanced">
      <summary>{t("collabAdvanced")}</summary>
      <label className="clangd-path-label">{t("discordAppId")}<input value={appId} onChange={(event) => setAppId(event.target.value.replace(/\D/g, ""))} placeholder={DISCORD_APPLICATION_ID || "123456789012345678"} spellCheck={false} inputMode="numeric" /></label>
      <p className="settings-help">{t("discordAppIdHelp")}</p>
    </details>
  </div>;
}

/** One toolchain choice: the default (whatever is first on PATH) or one of those found, and a chosen one that has gone. */
function ToolchainSelect({ t, list, value, onChange, label }: { t: Translate; list: Toolchain[] | null; value: string; onChange: (path: string) => void; label: string }) {
  const fallback = list?.find((item) => item.isDefault);
  const known = !value || list === null || list.some((item) => item.path === value);
  return <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} disabled={list === null}>
    <option value="">{fallback ? `${t("toolchainDefault")} (${toolchainLabel(fallback, list ?? [])})` : list === null ? t("toolchainScanning") : t("toolchainDefault")}</option>
    {!known && <option value={value}>{t("toolchainMissing")}: {value}</option>}
    {(list ?? []).map((item) => <option key={item.path} value={item.path} title={item.path}>{toolchainLabel(item, list ?? [])}</option>)}
  </select>;
}

/** Which Python and which C++ compiler run a solution, and a Python of the editor's own when none fits. */
function LanguagesPage({ t }: Pick<SettingsDialogProps, "t">) {
  const [pythonPath, setPythonPath] = useSetting("pythonPath");
  const [cppCompiler, setCppCompiler] = useSetting("cppCompiler");
  const [cppStandard, setCppStandard] = useSetting("cppStandard");
  const pythons = toolchains.use((state) => state.pythons);
  const compilers = toolchains.use((state) => state.compilers);
  const scanning = toolchains.use((state) => state.scanning);
  const [downloads, setDownloads] = useState<PythonDownload[] | null>(null);
  const [wanted, setWanted] = useState("");
  const [installing, setInstalling] = useState<{ version: string; received: number; total: number } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { ensureToolchains(); }, []);
  useEffect(() => {
    if (!IS_TAURI) return;
    let stop: (() => void) | undefined;
    void listen<{ version: string; received: number; total: number }>("python-install-progress", (event) => setInstalling(event.payload)).then((unlisten) => { stop = unlisten; });
    return () => stop?.();
  }, []);
  const python = chosenToolchain(pythons, pythonPath);
  const compiler = chosenToolchain(compilers, cppCompiler);
  const showDownloads = () => {
    setError("");
    invoke<PythonDownload[]>("python_downloads").then((list) => { setDownloads(list); setWanted((current) => current || list[0]?.version || ""); }, (reason) => setError(errorMessage(reason)));
  };
  const install = () => {
    if (!wanted) return;
    setError("");
    setInstalling({ version: wanted, received: 0, total: downloads?.find((item) => item.version === wanted)?.size ?? 0 });
    invoke<Toolchain>("install_python", { version: wanted })
      .then(async (installed) => { await rescanToolchains(); setPythonPath(installed.path); }, (reason) => setError(errorMessage(reason)))
      .finally(() => setInstalling(null));
  };
  const remove = (path: string) => {
    setError("");
    invoke("remove_python", { path }).then(async () => { if (pythonPath === path) setPythonPath(""); await rescanToolchains(); }, (reason) => setError(errorMessage(reason)));
  };
  const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
  return <div className="language-server-settings judge-settings toolchain-settings">
    <div className="appearance-group"><span>Python</span><button className="subtle-button" disabled={scanning} onClick={() => void rescanToolchains()}>{scanning ? t("toolchainScanning") : t("toolchainRescan")}</button></div>
    <label className="clangd-path-label">{t("toolchainPython")}<ToolchainSelect t={t} list={pythons} value={pythonPath} onChange={setPythonPath} label="Python" /></label>
    {python && <p className="settings-help toolchain-path"><code>{python.path}</code>{python.managed && <button className="subtle-button" onClick={() => remove(python.path)}>{t("toolchainRemove")}</button>}</p>}
    <p className="settings-help">{t("toolchainPythonHelp")}</p>
    <div className="toolchain-install">
      {downloads === null
        ? <button className="subtle-button" onClick={showDownloads} disabled={Boolean(installing)}>{t("toolchainInstallPython")}</button>
        : <>
          <select value={wanted} onChange={(event) => setWanted(event.target.value)} disabled={Boolean(installing)} aria-label={t("toolchainInstallPython")}>
            {downloads.map((item) => <option key={item.version} value={item.version}>Python {item.version} · {megabytes(item.size)}</option>)}
          </select>
          <button className="primary-button" onClick={install} disabled={!wanted || Boolean(installing)}>{installing ? t("toolchainInstalling") : t("toolchainInstall")}</button>
        </>}
      {installing && <span className="toolchain-progress"><i style={{ width: `${installing.total ? Math.min(100, installing.received / installing.total * 100) : 5}%` }} /><em>{installing.total ? `${megabytes(installing.received)} / ${megabytes(installing.total)}` : ""}</em></span>}
    </div>
    <p className="settings-help">{t("toolchainInstallHelp")}</p>
    <div className="appearance-group"><span>C++</span></div>
    <label className="clangd-path-label">{t("toolchainCompiler")}<ToolchainSelect t={t} list={compilers} value={cppCompiler} onChange={setCppCompiler} label="C++" /></label>
    {compiler && <p className="settings-help toolchain-path"><code>{compiler.path}</code>{!compiler.gcc && <span className="toolchain-note">{t("toolchainNoStdcpp")}</span>}</p>}
    <label className="clangd-path-label">{t("toolchainStandard")}<select value={cppStandard} onChange={(event) => setCppStandard(event.target.value as typeof cppStandard)}>
      <option value="auto">{t("toolchainStandardAuto")}</option><option value="c++17">C++17</option><option value="c++20">C++20</option><option value="c++23">C++23</option>
    </select></label>
    <p className="settings-help">{t("toolchainCompilerHelp")}</p>
    {error && <p className="settings-help toolchain-error" role="alert">{error}</p>}
  </div>;
}

/** The extensions unpacked under the app profile, read again whenever the page is shown or the backend says they changed. */
function useBrowserExtensions(showing: boolean) {
  const [list, setList] = useState<BrowserExtension[]>([]);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = () => {
    if (!IS_TAURI) return;
    void invoke<BrowserExtension[]>("browser_extensions_list").then(setList).catch(() => setList([]));
  };
  useEffect(() => { if (showing) refresh(); }, [showing]);
  // The first start installs the default extensions in the background.
  useEffect(() => {
    if (!IS_TAURI) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen("browser-extensions-changed", () => refresh())
      .then((stopListening) => { if (disposed) stopListening(); else unlisten = stopListening; });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  const install = async () => {
    const trimmedSource = source.trim();
    if (!trimmedSource || busy) return;
    setBusy(true);
    setError("");
    try {
      await invoke("browser_extension_install", { source: trimmedSource });
      setSource("");
      refresh();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await invoke("browser_extension_remove", { id });
      refresh();
    } catch (error) {
      setError(errorMessage(error));
    }
  };

  return { list, source, setSource, busy, error, install, remove };
}

function BrowserPage({ t, extensions, browserStatus, installUserscript }: Pick<SettingsDialogProps, "t" | "browserStatus" | "installUserscript"> & { extensions: ReturnType<typeof useBrowserExtensions> }) {
  const [problemBrowserMode, setProblemBrowserMode] = useSetting("problemBrowserMode");
  const tampermonkeyLoaded = extensions.list.some((extension) => extension.id === TAMPERMONKEY_ID && !extension.pending);
  return <div className="language-server-settings browser-settings">
    <div className={`lsp-state ${browserStatus.available ? "ready" : "error"}`}>
      <span className="lsp-dot" /><div><strong>{t("problemPanel")}</strong><small>{browserStatus.available ? `CEF · ${browserStatus.open ? browserStatus.url || "open" : "idle"}` : browserStatus.error || "unavailable"}</small></div>
    </div>
    <div className="extension-defaults">
      <strong>{t("browserDefaultsTitle")}</strong>
      <small>{t("browserDefaultsHelp")}</small>
      <div className="companion-controls">
        <button className="subtle-button extension-userscript" disabled={!tampermonkeyLoaded} title={tampermonkeyLoaded ? ATCODER_BETTER_USERSCRIPT : t("browserNeedsTampermonkey")} onClick={() => installUserscript(ATCODER_BETTER_USERSCRIPT)}>{t("browserInstallAtCoderBetter")}</button>
      </div>
    </div>
    <div className="appearance-group"><label>{t("problemBrowserPlacement")}<select value={problemBrowserMode} onChange={(event) => setProblemBrowserMode(event.target.value === "window" ? "window" : "panel")} disabled={!browserStatus.available}><option value="panel">{t("problemBrowserInPanel")}</option><option value="window">{t("problemBrowserInWindow")}</option></select></label></div>
    <p className="settings-help">{t("problemBrowserPlacementHelp")}</p>
    <p className="settings-help">{t("browserExtensionsHelp")}</p>
    <label className="clangd-path-label">{t("browserExtensionSource")}<span className="extension-install"><input value={extensions.source} onChange={(event) => extensions.setSource(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void extensions.install(); } }} placeholder="https://chromewebstore.google.com/detail/…" spellCheck={false} disabled={extensions.busy || !browserStatus.available} /><button className="primary-button" onClick={() => void extensions.install()} disabled={extensions.busy || !extensions.source.trim() || !browserStatus.available}>{extensions.busy ? t("browserExtensionInstalling") : t("browserExtensionInstall")}</button></span></label>
    {extensions.error && <p className="settings-help extension-error">{extensions.error}</p>}
    <div className="extension-list" role="list">
      {extensions.list.length === 0 && <p className="settings-help">{t("browserExtensionsNone")}</p>}
      {extensions.list.map((extension) => (
        <div className="extension-row" role="listitem" key={extension.id}>
          <div><strong>{extension.name}{extension.builtin && <span className="extension-badge">{t("browserBuiltin")}</span>}</strong><small>{extension.version} · {extension.id}{extension.pending ? ` · ${t("browserPending")}` : ""}</small></div>
          {!extension.builtin && <button className="danger-button" onClick={() => void extensions.remove(extension.id)}>{t("browserExtensionRemove")}</button>}
        </div>
      ))}
    </div>
    {extensions.list.some((extension) => extension.pending) && <div className="extension-restart"><span>{IS_DEV_BUILD ? t("browserRestartDev") : t("browserRestartNeeded")}</span>{!IS_DEV_BUILD && <button className="subtle-button" onClick={() => void relaunch()}>{t("browserRestartNow")}</button>}</div>}
  </div>;
}

function UpdatesPage({ t, appVersion, updateStatus, updateRetryable, checkForUpdates, installUpdate, exportSettings, importSettings }: Pick<SettingsDialogProps, "t" | "appVersion" | "updateStatus" | "updateRetryable" | "checkForUpdates" | "installUpdate" | "exportSettings" | "importSettings">) {
  const updateBusy = updateStatus.phase === "checking" || updateStatus.phase === "downloading" || updateStatus.phase === "installing";
  return <div className="language-server-settings updates-settings">
    <div className={`lsp-state ${updateStatus.phase === "up-to-date" ? "ready" : updateStatus.phase === "available" || updateBusy ? "connecting" : updateStatus.phase === "error" ? "error" : "idle"}`}>
      <span className="lsp-dot" />
      <div><strong>Mild Editor v{appVersion}</strong><small>{updateStatusLine(updateStatus, t)}</small></div>
    </div>
    <p className="settings-help">{t("updatesHelp")}</p>
    <div className="companion-controls">
      <button className="subtle-button" onClick={checkForUpdates} disabled={!UPDATES_SUPPORTED || updateBusy}>{t("updatesCheck")}</button>
      {updateStatus.phase === "available" && <button className="primary-button" onClick={installUpdate}>{t("updatesInstall")} · v{updateStatus.version}</button>}
      {updateStatus.phase === "error" && updateRetryable && <button className="subtle-button" onClick={installUpdate}>{t("updatesRetry")}</button>}
    </div>
    {updateStatus.phase === "downloading" && <progress max={updateStatus.total || 1} value={updateStatus.total ? updateStatus.received || 0 : undefined} aria-label={t("updatesDownloading")} />}
    {updateStatus.notes && <pre className="update-notes">{updateStatus.notes}</pre>}
    <h3 className="settings-subheading">{t("settingsBackup")}</h3>
    <p className="settings-help">{t("settingsBackupHelp")}</p>
    <div className="companion-controls">
      <button className="subtle-button" onClick={exportSettings}><Icon name="download" size={14} />{t("settingsExport")}</button>
      <button className="subtle-button" onClick={importSettings}><Icon name="upload" size={14} />{t("settingsImport")}</button>
    </div>
  </div>;
}

function LanguageServerPage({ t, clangdPath, setClangdPath, clangdStatus, clangdInfo, connectClangd }: Pick<SettingsDialogProps, "t" | "clangdStatus" | "clangdInfo" | "connectClangd"> & { clangdPath: string; setClangdPath: (path: string) => void }) {
  const [atcoderLibraryPath, setAtcoderLibraryPath] = useSetting("atcoderLibraryPath");
  const chooseAtcoderLibrary = async () => {
    const path = await open({ directory: true, multiple: false, title: "Choose the AtCoder Library include folder" });
    if (path && !Array.isArray(path)) setAtcoderLibraryPath(path);
  };
  return <div className="language-server-settings">
    <div className={`lsp-state ${clangdStatus}`}><span className="lsp-dot" /><div><strong>{clangdStatus === "ready" ? "clangd connected" : clangdStatus === "connecting" ? "connecting…" : clangdStatus === "missing" ? "clangd not found" : clangdStatus === "error" ? "connection failed" : "clangd idle"}</strong><small>{clangdInfo?.version || "C++ semantic completion, diagnostics, hover and signature help"}</small></div></div>
    <label className="clangd-path-label">clangd executable path<input value={clangdPath} onChange={(event) => setClangdPath(event.target.value)} placeholder="Auto-detect from PATH, or C:\\Program Files\\LLVM\\bin\\clangd.exe" spellCheck={false} /></label>
    <p className="settings-help">Leave the path empty to search PATH automatically. If LLVM clangd is unavailable, Mild Editor keeps using its built-in lightweight completions.</p>
    <label className="clangd-path-label">{t("aclPath")}<span className="path-picker"><input value={atcoderLibraryPath} onChange={(event) => setAtcoderLibraryPath(event.target.value)} placeholder="C:\\library\\ac-library" spellCheck={false} /><button className="subtle-button" onClick={() => void chooseAtcoderLibrary()}>{t("chooseFolder")}</button></span></label>
    <p className="settings-help">{t("aclHelp")}</p>
    <footer className="settings-footer"><span className="footer-spacer" /><button className="subtle-button" onClick={() => { setClangdPath(""); setSetting("clangdPath", ""); }}>Auto-detect</button><button className="primary-button" onClick={() => { setSetting("clangdPath", clangdPath); connectClangd(); }}>Connect clangd</button></footer>
  </div>;
}
