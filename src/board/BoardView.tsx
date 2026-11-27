import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import qrcode from "qrcode-generator";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCollab } from "../collab/collabStore";
import { explorerBasename, fileKey } from "../fileNaming";
import type { Translate } from "../i18n";
import { Icon } from "../icons";
import { errorMessage, IS_TAURI } from "../platform";
import { workspace } from "../workspaceStore";
import "./board.css";
import { holdBoard } from "./boardStore";
import { BoardCanvas } from "./canvas";
import { parseBoard, type Element } from "./model";
import { pairBoard, pairings, reachFromOutside, unpairBoard } from "./pads";
import { mountBoardUi } from "./ui";
import { boardWords } from "./words";

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

/** The writing on a board, for searching it. */
const writingOf = (elements: readonly Element[]) => elements.flatMap((element) => element.type === "text" ? [element.text] : []).join("\n");

/**
 * The workspace's boards beside the open one, and a search through their names and what is
 * written on them. A board's writing is read from its file the first time it is searched.
 */
function BoardList({ t, boards, current, currentWriting, onOpen, onNew, onHide }: { t: Translate; boards: string[]; current: string; currentWriting: () => string; onOpen: (path: string) => void; onNew: () => void; onHide: () => void }) {
  const [query, setQuery] = useState("");
  const [writing, setWriting] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());
  // The writing of another board may have changed since it was read.
  useEffect(() => { asked.current.clear(); setWriting({}); }, [boards]);
  useEffect(() => {
    if (!query.trim()) return;
    const folderPath = workspace.get().workspacePath;
    if (!folderPath) return;
    for (const path of boards) {
      if (fileKey(path) === fileKey(current) || asked.current.has(path)) continue;
      asked.current.add(path);
      void invoke<string>("read_workspace_board", { request: { folderPath, filename: path } })
        .then((text) => setWriting((known) => ({ ...known, [path]: writingOf(parseBoard(text).elements) })), () => undefined);
    }
  }, [query, boards, current]);
  const needle = query.trim().toLocaleLowerCase();
  const found = useMemo(() => boards.map((path) => {
    if (!needle) return { path, line: "" };
    if (path.toLocaleLowerCase().includes(needle)) return { path, line: "" };
    const text = fileKey(path) === fileKey(current) ? currentWriting() : writing[path] ?? "";
    const line = text.split("\n").find((item) => item.toLocaleLowerCase().includes(needle));
    return line === undefined ? null : { path, line: line.trim().slice(0, 80) };
  }).filter((item): item is { path: string; line: string } => item !== null), [boards, needle, writing, current, currentWriting]);
  return <aside className="board-list" aria-label={t("boardList")}>
    <div className="board-list-head">
      <strong>{t("boardList")}</strong>
      <span>
        <button className="board-tool" title={t("boardNew")} aria-label={t("boardNew")} onClick={onNew}><Icon name="plus" size={14} /></button>
        <button className="board-tool" title={`${t("boardListHide")} (Ctrl+\\)`} aria-label={t("boardListHide")} onClick={onHide}><Icon name="arrowLeft" size={14} /></button>
      </span>
    </div>
    <label className="board-list-search"><Icon name="search" size={13} /><input type="search" value={query} placeholder={t("boardSearch")} spellCheck={false} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }} /></label>
    <div className="board-list-items" role="listbox">
      {!boards.length ? <p className="board-list-empty">{t("boardNone")}</p> : !found.length ? <p className="board-list-empty">{t("boardNoMatch")}</p> : found.map(({ path, line }) => {
        const slash = path.lastIndexOf("/");
        return <button key={path} role="option" aria-selected={fileKey(path) === fileKey(current)} className={`board-list-item ${fileKey(path) === fileKey(current) ? "active" : ""}`} title={path} onClick={() => onOpen(path)}>
          <span><Icon name="board" size={13} />{explorerBasename(path)}</span>
          {slash > 0 && <small>{path.slice(0, slash)}</small>}
          {line && <small className="board-list-line">{line}</small>}
        </button>;
      })}
    </div>
  </aside>;
}

const LIST_KEY = "mild-board-list";

/**
 * A board in the editor's place: the board list, the canvas with its tools (ui.ts — the same
 * as a tablet's), and the way to draw on it from a tablet. `themeKey` changes with the theme,
 * which every colour's shade follows.
 */
export function BoardView({ t, path, themeKey, korean, boards, onOpen, onNew, onClose }: {
  t: Translate; path: string; themeKey: string; korean: boolean; boards: string[];
  onOpen: (path: string) => void; onNew: () => void; onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<BoardCanvas | null>(null);
  const uiRef = useRef<ReturnType<typeof mountBoardUi> | null>(null);
  const [tablet, setTablet] = useState(false);
  const [listOpen, setListOpen] = useState(() => localStorage.getItem(LIST_KEY) !== "0");
  const [confirmClear, setConfirmClear] = useState(false);
  const [dark, setDark] = useState(themeIsDark);
  const shared = useCollab((state) => state.boards.has(fileKey(path)));
  const paired = pairings.use((state) => Boolean(state[fileKey(path)]));
  const tablets = pairings.use((state) => state[fileKey(path)]?.tablets ?? 0);

  useEffect(() => {
    const handle = holdBoard(path);
    const words = boardWords(korean);
    const root = rootRef.current!;
    const board = new BoardCanvas(stageRef.current!, handle.source, { dark: themeIsDark, words, scope: root, toast: (message) => uiRef.current?.toast(message) });
    boardRef.current = board;
    uiRef.current = mountBoardUi(root, board, words, {
      name: () => explorerBasename(path),
      savePng: async (blob, name) => {
        if (!IS_TAURI) {
          const link = document.createElement("a");
          link.href = URL.createObjectURL(blob);
          link.download = name;
          link.click();
          window.setTimeout(() => URL.revokeObjectURL(link.href), 5000);
          return;
        }
        const target = await save({ defaultPath: name, filters: [{ name: "PNG", extensions: ["png"] }] });
        if (!target) return;
        try {
          await invoke("save_board_picture", { request: { path: target, data: Array.from(new Uint8Array(await blob.arrayBuffer())) } });
          uiRef.current?.toast(t("boardSavedPng").replace("{name}", target.split(/[\\/]/).pop() ?? name));
        } catch (error) {
          uiRef.current?.toast(errorMessage(error));
        }
      },
    });
    // A board opens ready to write on.
    board.setTool("pen");
    root.focus({ preventScroll: true });
    return () => { uiRef.current?.destroy(); uiRef.current = null; board.destroy(); handle.release(); boardRef.current = null; };
    // `t` follows `korean`; the board is not made again for a new translate function.
  }, [path, korean]);
  useEffect(() => {
    setDark(themeIsDark());
    boardRef.current?.redraw();
    uiRef.current?.refresh();
  }, [themeKey]);
  useEffect(() => { localStorage.setItem(LIST_KEY, listOpen ? "1" : "0"); }, [listOpen]);
  // Ctrl+\ folds the board list away and back, wherever in the board view the keyboard is.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === "Backslash" && sectionRef.current?.contains(event.target as Node)) {
        event.preventDefault();
        event.stopPropagation();
        setListOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  const currentWriting = useMemo(() => () => writingOf(boardRef.current?.elements() ?? []), []);

  return <section ref={sectionRef} className="board-view" aria-label={explorerBasename(path)}>
    <header className="board-bar">
      <button className={`board-tool ${listOpen ? "active" : ""}`} aria-pressed={listOpen} title={`${t(listOpen ? "boardListHide" : "boardListShow")} (Ctrl+\\)`} aria-label={t(listOpen ? "boardListHide" : "boardListShow")} onClick={() => setListOpen((open) => !open)}><Icon name="files" size={14} /></button>
      <span className="board-name"><Icon name="board" size={14} />{explorerBasename(path)}{shared && <small className="board-shared"><Icon name="users" size={11} />{t("boardShared")}</small>}</span>
      <div className="board-actions">
        <button className="subtle-button" onClick={() => setConfirmClear(true)}>{t("boardClear")}</button>
        <button className={`subtle-button board-tablet-button ${paired ? "paired" : ""}`} onClick={() => setTablet((open) => !open)}><Icon name="tablet" size={14} />{t("boardTablet")}{tablets > 0 && <em>{tablets}</em>}</button>
        <button className="board-tool" aria-label={t("boardClose")} title={t("boardClose")} onClick={onClose}><Icon name="close" size={14} /></button>
      </div>
    </header>
    <div className="board-body">
      {listOpen && <BoardList t={t} boards={boards} current={path} currentWriting={currentWriting} onOpen={onOpen} onNew={onNew} onHide={() => { setListOpen(false); rootRef.current?.focus({ preventScroll: true }); }} />}
      <div className="board-stage">
        <div ref={rootRef} className={`board-root in-editor ${dark ? "board-dark" : ""}`} tabIndex={-1}>
          <div ref={stageRef} />
        </div>
        {tablet && <TabletPanel t={t} path={path} onClose={() => setTablet(false)} />}
        {confirmClear && <div className="board-confirm" role="alertdialog">
          <p>{shared ? t("boardClearShared") : t("boardClearAsk")}</p>
          <div><button className="subtle-button" autoFocus onClick={() => setConfirmClear(false)}>{t("cancel")}</button><button className="danger-button" onClick={() => { boardRef.current?.clearAll(); setConfirmClear(false); }}>{t("boardClear")}</button></div>
        </div>}
      </div>
    </div>
  </section>;
}
