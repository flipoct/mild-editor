import qrcode from "qrcode-generator";
import { useEffect, useRef, useState } from "react";
import { useCollab } from "../collab/collabStore";
import { explorerBasename, fileKey } from "../fileNaming";
import type { Translate } from "../i18n";
import { Icon } from "../icons";
import { errorMessage } from "../platform";
import { clearBoard, holdBoard, type BoardHandle } from "./boardStore";
import { BoardCanvas, type Tool } from "./canvas";
import { INK_SHADES, INKS, WIDTHS, type Ink } from "./model";
import { pairBoard, pairings, reachFromOutside, unpairBoard } from "./pads";

/** Whether the theme in use is a dark one, from its own background. */
const themeIsDark = () => {
  const probe = document.createElement("span");
  probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--bg-0").trim() || "#fff";
  document.body.append(probe);
  const [r, g, b] = (getComputedStyle(probe).color.match(/\d+(\.\d+)?/g) ?? ["255", "255", "255"]).map(Number);
  probe.remove();
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
};

/** A QR code as an SVG path, crisp at any size; `text` is somebody's URL, never markup. */
function QrCode({ text }: { text: string }) {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const count = code.getModuleCount();
  let path = "";
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) if (code.isDark(row, column)) path += `M${column + 2} ${row + 2}h1v1h-1z`;
  }
  return <svg className="board-qr" viewBox={`0 0 ${count + 4} ${count + 4}`} role="img" aria-label={text}><rect width={count + 4} height={count + 4} fill="#fff" /><path d={path} fill="#111" /></svg>;
}

/** Drawing on a board from a tablet: the QR code to scan, and who is drawing. */
function TabletPanel({ t, path, onClose }: { t: Translate; path: string; onClose: () => void }) {
  const [error, setError] = useState("");
  const [pairing, setPairing] = useState(() => pairings.get()[fileKey(path)] ?? null);
  useEffect(() => {
    const follow = () => setPairing(pairings.get()[fileKey(path)] ?? null);
    const stop = pairings.subscribe(follow);
    if (!pairings.get()[fileKey(path)]) pairBoard(path).then(follow, (reason) => setError(errorMessage(reason)));
    return stop;
  }, [path]);
  const [away, setAway] = useState(false);
  const [first, ...others] = pairing?.urls ?? [];
  const outside = pairing?.outside ?? { state: "none" as const };
  const goAway = () => {
    setAway(true);
    // The router is only asked once somebody wants the way in from outside.
    if (outside.state !== "open" && outside.state !== "checking") void reachFromOutside(path);
  };
  return <div className="board-tablet" role="dialog" aria-label={t("boardTablet")}>
    <header><strong>{t("boardTablet")}</strong><button className="board-tool" aria-label={t("cancel")} onClick={onClose}><Icon name="close" size={13} /></button></header>
    {error ? <p className="board-tablet-error">{error}</p> : !pairing ? <p>{t("boardTabletStarting")}</p> : <>
      <div className="collab-switch board-tablet-where" role="tablist">
        <button type="button" role="tab" aria-selected={!away} className={away ? "" : "active"} onClick={() => setAway(false)}>{t("boardTabletHere")}</button>
        <button type="button" role="tab" aria-selected={away} className={away ? "active" : ""} onClick={goAway}>{t("boardTabletAway")}</button>
      </div>
      {!away ? !first ? <p className="board-tablet-error">{t("boardTabletNoNetwork")}</p> : <>
        <QrCode text={first} />
        <p>{t("boardTabletHelp")}</p>
        <code>{first}</code>
        {others.length > 0 && <details><summary>{t("boardTabletOther")}</summary>{others.map((url) => <code key={url}>{url}</code>)}</details>}
      </> : outside.state === "open" ? <>
        <QrCode text={outside.url} />
        <p>{t("boardTabletAwayHelp")}</p>
        <code>{outside.url}</code>
      </> : outside.state === "checking" || outside.state === "none" ? <p>{t("boardTabletAwayChecking")}</p>
        : <p className="board-tablet-error">{t(outside.state === "nat" ? "boardTabletAwayNat" : outside.state === "no-gateway" ? "boardTabletAwayNoGateway" : "boardTabletAwayRefused")}</p>}
      <footer>
        <span className={pairing.tablets ? "connected" : ""}><i />{pairing.tablets ? t("boardTabletConnected").replace("{count}", String(pairing.tablets)) : t("boardTabletWaiting")}</span>
        <button className="subtle-button" onClick={() => { unpairBoard(path); onClose(); }}>{t("boardTabletStop")}</button>
      </footer>
    </>}
  </div>;
}

/**
 * A board in the editor's place: the canvas, its tools, and the way to draw on it from a
 * tablet. `themeKey` changes with the theme, which every ink's shade follows.
 */
export function BoardView({ t, path, themeKey, onClose }: { t: Translate; path: string; themeKey: string; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boardRef = useRef<BoardCanvas | null>(null);
  const handleRef = useRef<BoardHandle | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [ink, setInk] = useState<Ink>("ink");
  const [width, setWidth] = useState<number>(WIDTHS[1]);
  const [zoom, setZoom] = useState(1);
  const [tablet, setTablet] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const shared = useCollab((state) => state.boards.has(fileKey(path)));
  const paired = pairings.use((state) => Boolean(state[fileKey(path)]));
  const tablets = pairings.use((state) => state[fileKey(path)]?.tablets ?? 0);
  const dark = themeIsDark();

  useEffect(() => {
    const handle = holdBoard(path);
    handleRef.current = handle;
    const board = new BoardCanvas(canvasRef.current!, handle.source, { dark: themeIsDark, onZoom: setZoom });
    boardRef.current = board;
    return () => { board.destroy(); handle.release(); boardRef.current = null; handleRef.current = null; };
  }, [path]);
  useEffect(() => { boardRef.current?.redraw(); }, [themeKey]);
  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    board.setTool(tool);
    board.ink = ink;
    board.width = width;
  }, [tool, ink, width, path]);
  // P, E and H pick the tool, while nothing that takes typing has the keyboard.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.metaKey || event.ctrlKey || event.altKey || target?.closest("input, textarea, select, [contenteditable=true], .monaco-editor")) return;
      const picked = ({ p: "pen", e: "eraser", h: "hand" } as Record<string, Tool>)[event.key.toLowerCase()];
      if (picked) { setTool(picked); event.preventDefault(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const toolButton = (name: Tool, icon: "pen" | "eraser" | "hand", label: string, keyHint: string) =>
    <button className={`board-tool ${tool === name ? "active" : ""}`} aria-pressed={tool === name} title={`${label} (${keyHint})`} onClick={() => setTool(name)}><Icon name={icon} size={15} /></button>;

  return <section className="board-view" aria-label={explorerBasename(path)}>
    <header className="board-bar">
      <span className="board-name"><Icon name="board" size={14} />{explorerBasename(path)}{shared && <small className="board-shared"><Icon name="users" size={11} />{t("boardShared")}</small>}</span>
      <div className="board-tools" role="toolbar">
        {toolButton("pen", "pen", t("boardPen"), "P")}
        {toolButton("eraser", "eraser", t("boardEraser"), "E")}
        {toolButton("hand", "hand", t("boardHand"), "H")}
        <span className="board-sep" />
        {INKS.map((name) => <button key={name} className={`board-ink ${ink === name ? "active" : ""}`} aria-pressed={ink === name} title={t("boardInk")} style={{ ["--ink" as string]: INK_SHADES[name][dark ? "dark" : "light"] }} onClick={() => { setInk(name); if (tool !== "pen") setTool("pen"); }} />)}
        <span className="board-sep" />
        {WIDTHS.map((size) => <button key={size} className={`board-width ${width === size ? "active" : ""}`} aria-pressed={width === size} title={t("boardWidth")} onClick={() => { setWidth(size); if (tool !== "pen") setTool("pen"); }}><i style={{ width: size + 3, height: size + 3 }} /></button>)}
        <span className="board-sep" />
        <button className="board-tool" title={t("boardZoomOut")} onClick={() => boardRef.current?.zoom(1 / 1.25)}><Icon name="minus" size={14} /></button>
        <button className="board-zoom" title={t("boardFit")} onClick={() => boardRef.current?.fit()}>{Math.round(zoom * 100)}%</button>
        <button className="board-tool" title={t("boardZoomIn")} onClick={() => boardRef.current?.zoom(1.25)}><Icon name="plus" size={14} /></button>
      </div>
      <div className="board-actions">
        <button className="subtle-button" onClick={() => setConfirmClear(true)}>{t("boardClear")}</button>
        <button className={`subtle-button board-tablet-button ${paired ? "paired" : ""}`} onClick={() => setTablet((open) => !open)}><Icon name="tablet" size={14} />{t("boardTablet")}{tablets > 0 && <em>{tablets}</em>}</button>
        <button className="board-tool" aria-label={t("boardClose")} title={t("boardClose")} onClick={onClose}><Icon name="close" size={14} /></button>
      </div>
    </header>
    <div className="board-stage">
      <canvas ref={canvasRef} className={`board-canvas tool-${tool}`} />
      {tablet && <TabletPanel t={t} path={path} onClose={() => setTablet(false)} />}
      {confirmClear && <div className="board-confirm" role="alertdialog">
        <p>{shared ? t("boardClearShared") : t("boardClearAsk")}</p>
        <div><button className="subtle-button" autoFocus onClick={() => setConfirmClear(false)}>{t("cancel")}</button><button className="danger-button" onClick={() => { if (handleRef.current) clearBoard(handleRef.current); setConfirmClear(false); }}>{t("boardClear")}</button></div>
      </div>}
    </div>
  </section>;
}
