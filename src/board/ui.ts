import { kindOf, SHAPES, TOOL_KIND, type BoardCanvas, type StyleKind, type Tool } from "./canvas";
import { boardPicture } from "./export";
import { COLORS, fillShade, SIZES, strokeShade, type Element } from "./model";
import type { BoardWords } from "./words";

/**
 * The board's controls, over its canvas: the tools at the top, the style of what is selected
 * or about to be drawn at the left, zoom and undo at the bottom, and a menu (save or copy a
 * PNG, the grid, drawing with fingers, the shortcuts). Plain DOM, so that the editor and a
 * tablet's page show the very same board.
 */

const PATHS: Record<string, string> = {
  select: '<path d="M5 3.5l10.5 6-4.6 1.3-1.4 4.7z"/>',
  hand: '<path d="M10 2.5v15M2.5 10h15M10 2.5L7.8 4.7M10 2.5l2.2 2.2M10 17.5l-2.2-2.2M10 17.5l2.2-2.2M2.5 10l2.2-2.2M2.5 10l2.2 2.2M17.5 10l-2.2-2.2M17.5 10l-2.2 2.2"/>',
  pen: '<path d="M3.5 16.5l.9-3.6L13.6 3.7a1.4 1.4 0 012 0l.7.7a1.4 1.4 0 010 2L7.1 15.6zM12.3 5l2.7 2.7"/>',
  highlighter: '<path d="M8 12.5l6.2-8.2 2.6 2-6.2 8.2zM8 12.5l-1.7 2.6 2.4 1.8 1.9-2.4M3 17h4"/>',
  eraser: '<path d="M8.5 16.5l-3.8-3.4a1.2 1.2 0 010-1.7l6.6-7.3a1.2 1.2 0 011.7-.1l3.6 3.2a1.2 1.2 0 01.1 1.7l-6.9 7.6zM8.2 8.3l5.3 4.8M8.5 16.5H17"/>',
  text: '<path d="M4.5 6V4.5h11V6M10 4.5v11M7.8 15.5h4.4"/>',
  rect: '<rect x="3.5" y="4.5" width="13" height="11" rx="2"/>',
  ellipse: '<ellipse cx="10" cy="10" rx="6.8" ry="5.8"/>',
  arrow: '<path d="M4.5 15.5l11-11M9 4.5h6.5V11"/>',
  line: '<path d="M4.5 15.5l11-11"/>',
  image: '<rect x="3.5" y="4.5" width="13" height="11" rx="2"/><circle cx="7.6" cy="8.4" r="1.2"/><path d="M4 14l3.6-3.4 2.8 2.6 2.2-2 3.6 3.2"/>',
  undo: '<path d="M7 5L3.5 8.5 7 12M3.5 8.5h8a4.2 4.2 0 010 8.4H9"/>',
  redo: '<path d="M13 5l3.5 3.5L13 12M16.5 8.5h-8a4.2 4.2 0 000 8.4H11"/>',
  menu: '<circle cx="5" cy="10" r="1"/><circle cx="10" cy="10" r="1"/><circle cx="15" cy="10" r="1"/>',
  plus: '<path d="M10 4.5v11M4.5 10h11"/>',
  minus: '<path d="M4.5 10h11"/>',
  trash: '<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.3a1.2 1.2 0 001.2 1.2h4.2a1.2 1.2 0 001.2-1.2L14 6"/>',
  copy: '<rect x="7" y="7" width="9" height="9" rx="1.8"/><path d="M13 7V5.2A1.2 1.2 0 0011.8 4H5.2A1.2 1.2 0 004 5.2v6.6A1.2 1.2 0 005.2 13H7"/>',
  front: '<rect x="8" y="8" width="8" height="8" rx="1.5" fill="currentColor"/><path d="M12 5.5V5a1 1 0 00-1-1H5a1 1 0 00-1 1v6a1 1 0 001 1h.5"/>',
  back: '<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/><path d="M14.5 8h.5a1 1 0 011 1v6a1 1 0 01-1 1H9a1 1 0 01-1-1v-.5"/>',
  lock: '<rect x="5" y="9" width="10" height="7.5" rx="1.8"/><path d="M7.2 9V6.8a2.8 2.8 0 015.6 0V9"/>',
  fit: '<path d="M4 7.5V4h3.5M16 7.5V4h-3.5M4 12.5V16h3.5M16 12.5V16h-3.5"/>',
};

export const boardIcon = (name: string) =>
  `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ""}</svg>`;

export type BoardHost = {
  /** The board's name, for a saved picture. */
  name(): string;
  /** Saves a PNG of the board where the person says. */
  savePng(blob: Blob, name: string): Promise<void> | void;
};

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", html = "") => {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (html) made.innerHTML = html;
  return made;
};

const button = (className: string, label: string, html: string, onPress: () => void) => {
  const made = element("button", className, html);
  made.type = "button";
  made.title = label;
  made.setAttribute("aria-label", label);
  made.addEventListener("click", onPress);
  return made;
};

export const mountBoardUi = (root: HTMLElement, board: BoardCanvas, words: BoardWords, host: BoardHost) => {
  const disposers: (() => void)[] = [];
  const hints: Partial<Record<Tool, string>> = {
    select: words.hintSelect, hand: words.hintHand, pen: words.hintPen, highlighter: words.hintHighlighter, eraser: words.hintEraser,
    text: words.hintText, rect: words.hintRect, ellipse: words.hintEllipse, arrow: words.hintArrow, line: words.hintLine,
  };
  const keys: Partial<Record<Tool, string>> = { select: "V", hand: "H", pen: "P", highlighter: "M", eraser: "E", text: "T", rect: "R", ellipse: "O", arrow: "A", line: "L" };

  // ── The tools ──
  const toolbar = element("div", "board-island board-toolbar");
  toolbar.setAttribute("role", "toolbar");
  const lock = button("board-ui-tool", words.lock, boardIcon("lock"), () => board.toggleLock());
  toolbar.append(lock, element("span", "board-ui-sep"));
  const toolButtons = new Map<Tool, HTMLButtonElement>();
  const order: (Tool | "-" | "image")[] = ["hand", "select", "-", "pen", "highlighter", "eraser", "-", "text", ...SHAPES, "image"];
  for (const tool of order) {
    if (tool === "-") { toolbar.append(element("span", "board-ui-sep")); continue; }
    if (tool === "image") { toolbar.append(button("board-ui-tool", words.image, boardIcon("image"), () => board.pickImages())); continue; }
    const label = words[tool];
    const made = button("board-ui-tool", keys[tool] ? `${label} (${keys[tool]})` : label, boardIcon(tool) + (keys[tool] ? `<sub>${keys[tool]}</sub>` : ""), () => board.setTool(tool));
    toolButtons.set(tool, made);
    toolbar.append(made);
  }

  // ── Zoom, undo, the hint ──
  const bottom = element("div", "board-bottom");
  const zoomIsland = element("div", "board-island");
  const zoomLabel = button("board-ui-zoom", words.zoomReset, "100%", () => board.zoomReset());
  zoomIsland.append(
    button("board-ui-tool", words.zoomOut, boardIcon("minus"), () => board.zoom(0.8)),
    zoomLabel,
    button("board-ui-tool", words.zoomIn, boardIcon("plus"), () => board.zoom(1.25)),
    button("board-ui-tool", `${words.fit} (Shift+1)`, boardIcon("fit"), () => board.fit()),
  );
  const historyIsland = element("div", "board-island");
  const undo = button("board-ui-tool", `${words.undo} (Ctrl+Z)`, boardIcon("undo"), () => board.undo());
  const redo = button("board-ui-tool", `${words.redo} (Ctrl+Shift+Z)`, boardIcon("redo"), () => board.redo());
  historyIsland.append(undo, redo);
  const hint = element("p", "board-hint");
  bottom.append(zoomIsland, historyIsland, hint);

  // ── The menu ──
  const menuButton = button("board-ui-tool board-menu-button", words.menu, boardIcon("menu"), () => openMenu());
  const menuIsland = element("div", "board-island board-menu-island");
  menuIsland.append(menuButton);

  const toastBox = element("div", "board-toast");
  toastBox.setAttribute("role", "status");
  toastBox.hidden = true;
  let toastTimer = 0;
  const toast = (message: string) => {
    toastBox.textContent = message;
    toastBox.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toastBox.hidden = true; }, 3200);
  };

  const picture = async () => {
    try { return await boardPicture(board); } catch (error) {
      toast(error instanceof Error && error.message === "empty" ? words.nothingToExport : words.pngFailed);
      return null;
    }
  };

  let menu: HTMLElement | null = null;
  const closeMenu = () => { menu?.remove(); menu = null; document.removeEventListener("pointerdown", away, true); };
  const away = (event: Event) => { if (menu && !menu.contains(event.target as Node) && !menuButton.contains(event.target as Node)) closeMenu(); };
  const openMenu = () => {
    if (menu) { closeMenu(); return; }
    menu = element("div", "board-menu");
    menu.setAttribute("role", "menu");
    const item = (label: string, action: () => void, checked?: boolean, hintText?: string) => {
      const made = element("button", "", `<span>${checked === true ? "✓ " : checked === false ? "<i></i>" : ""}${label}</span>${hintText ? `<kbd>${hintText}</kbd>` : ""}`);
      made.type = "button";
      made.setAttribute("role", "menuitem");
      made.addEventListener("click", () => { closeMenu(); action(); });
      menu!.append(made);
    };
    item(words.exportPng, async () => { const blob = await picture(); if (blob) await host.savePng(blob, `${host.name().replace(/\.board$/i, "") || "board"}.png`); });
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      item(words.copyPng, async () => {
        const blob = await picture();
        if (!blob) return;
        try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); toast(words.copied); } catch { toast(words.pngFailed); }
      });
    }
    menu.append(element("hr"));
    item(words.fit, () => board.fit(), undefined, "Shift+1");
    item(words.grid, () => board.setGrid(!board.grid), board.grid);
    item(words.fingerDraw, () => { board.setFingerDraw(!board.fingerDraw); toast(board.fingerDraw ? words.fingersDraw : words.fingersPan); }, board.fingerDraw);
    menu.append(element("hr"));
    item(words.shortcuts, () => help.showModal(), undefined, "?");
    menuIsland.append(menu);
    window.setTimeout(() => document.addEventListener("pointerdown", away, true));
    (menu.querySelector("button") as HTMLButtonElement | null)?.focus();
  };

  // ── Shortcuts ──
  const help = element("dialog", "board-help");
  const row = (label: string, keysHtml: string) => `<dt>${label}</dt><dd>${keysHtml}</dd>`;
  const k = (key: string) => `<kbd>${key}</kbd>`;
  help.innerHTML = `<h2>${words.shortcuts}</h2><div class="board-keys">
    <section><h3>${words.keysTools}</h3><dl>
      ${row(words.select, `${k("V")} ${k("1")}`)}${row(words.hand, `${k("H")} · ${k("Space")}+${words.drag}`)}
      ${row(words.pen, `${k("P")} ${k("2")}`)}${row(words.highlighter, `${k("M")} ${k("3")}`)}${row(words.eraser, `${k("E")} ${k("4")}`)}
      ${row(words.text, `${k("T")} ${k("5")} · ${words.empty} ${words.doubleClick}`)}${row(`${words.rect} · ${words.ellipse}`, `${k("R")} · ${k("O")}`)}
      ${row(`${words.arrow} · ${words.line}`, `${k("A")} · ${k("L")}`)}${row(words.lock.split(" (")[0], k("Q"))}
    </dl></section>
    <section><h3>${words.keysEdit}</h3><dl>
      ${row(words.keyUndo, `${k("Ctrl")}+${k("Z")} · ${k("Ctrl")}+${k("Shift")}+${k("Z")}`)}${row(words.keyClip, `${k("Ctrl")}+${k("C")} ${k("X")} ${k("V")}`)}
      ${row(words.keyDuplicate, `${k("Ctrl")}+${k("D")} · ${k("Alt")}+${words.drag}`)}${row(words.keySelectAll, `${k("Ctrl")}+${k("A")}`)}
      ${row(words.keyOrder, `${k("Ctrl")}+${k("]")} · ${k("Ctrl")}+${k("[")}`)}${row(words.keyEditText, `${words.doubleClick} · ${k("Enter")}`)}
      ${row(words.keyEndText, `${k("Esc")} · ${k("Ctrl")}+${k("Enter")}`)}${row(words.keyShift, k("Shift"))}
    </dl></section>
    <section><h3>${words.keysView}</h3><dl>
      ${row(words.keyMove, words.wheel)}${row(words.keyZoom, `${k("Ctrl")}+${words.wheel} · ${words.pinch}`)}
      ${row(words.keyFit, `${k("Ctrl")}+${k("0")} · ${k("Shift")}+${k("1")}`)}
    </dl><h3>${words.keysMath}</h3><p class="board-note"></p></section>
  </div><form method="dialog"><button type="submit">${words.close}</button></form>`;
  help.querySelector(".board-note")!.textContent = words.mathNote;

  // ── The style of what is selected, or of what is drawn next ──
  const panel = element("div", "board-island board-style");
  panel.hidden = true;
  const section = (title: string, body: HTMLElement) => {
    const made = element("section");
    const heading = element("h4");
    heading.textContent = title;
    made.append(heading, body);
    return made;
  };
  const swatches = (prop: "color" | "fill", current: string, dark: boolean, withNone: boolean) => {
    const grid = element("div", "board-swatches");
    for (const color of withNone ? ["none", ...COLORS] : COLORS) {
      const made = button(`board-sw${color === "none" ? " none" : ""}`, color === "none" ? words.noFill : color, "", () => board.setProp(prop, color));
      if (color !== "none") made.style.setProperty("--c", prop === "fill" ? fillShade(color as (typeof COLORS)[number], dark) : strokeShade(color as (typeof COLORS)[number], dark));
      made.setAttribute("aria-pressed", String(color === current));
      grid.append(made);
    }
    return grid;
  };
  const segments = (items: { value: string | number; label: string; html: string }[], current: unknown, onPick: (value: string | number) => void) => {
    const made = element("div", "board-seg");
    for (const item of items) {
      const choice = button("", item.label, item.html, () => onPick(item.value));
      choice.setAttribute("aria-pressed", String(item.value === current));
      made.append(choice);
    }
    return made;
  };
  const hasFill = (item: Element) => item.type === "rect" || item.type === "ellipse";

  const syncStyle = () => {
    const picked = board.tool === "select" ? board.selected() : [];
    const kinds = new Set<StyleKind | "image">(picked.length ? picked.map(kindOf) : TOOL_KIND[board.tool] ? [TOOL_KIND[board.tool]!] : []);
    if (!kinds.size || board.isEditing) { panel.hidden = true; return; }
    const dark = board.dark();
    panel.replaceChildren();
    const first = (kind: StyleKind) => picked.find((item) => kindOf(item) === kind);
    const drawKind = (["pen", "highlighter", "shape", "text"] as StyleKind[]).find((kind) => kinds.has(kind));
    if (drawKind) {
      const current = picked.length ? (first(drawKind) as { color: string }).color : board.style[drawKind].color;
      panel.append(section(words.color, swatches("color", current, dark, false)));
    }
    const fillable = picked.length ? picked.some(hasFill) : board.tool === "rect" || board.tool === "ellipse";
    if (fillable) {
      const current = picked.length ? (picked.find(hasFill) as { fill: string }).fill : board.style.shape.fill;
      panel.append(section(words.fill, swatches("fill", current, dark, true)));
    }
    const sizeKind = (["pen", "highlighter", "shape"] as const).find((kind) => kinds.has(kind));
    if (sizeKind) {
      const size = picked.length ? (first(sizeKind) as { size: number }).size : board.style[sizeKind].size;
      const sizes = SIZES[sizeKind] as readonly number[];
      const current = sizes.indexOf(size);
      const items = [words.thin, words.medium, words.bold].map((label, index) => ({ value: index, label, html: `<span class="board-dot" style="width:${4 + index * 4}px;height:${4 + index * 4}px"></span>` }));
      panel.append(section(words.width, segments(items, current, (index) => board.setProp("size", index))));
    }
    if (kinds.has("text")) {
      const current = picked.length ? (first("text") as { fontSize: number }).fontSize : board.style.text.fontSize;
      const items = SIZES.text.map((value, index) => ({ value, label: `${words.fontSize} ${value}`, html: ["S", "M", "L", "XL"][index] }));
      panel.append(section(words.fontSize, segments(items, current, (value) => board.setProp("fontSize", value))));
    }
    if (picked.length) {
      const actions = [
        { value: "front", label: `${words.front} (Ctrl+Shift+])`, html: boardIcon("front") },
        { value: "back", label: `${words.back} (Ctrl+Shift+[)`, html: boardIcon("back") },
        { value: "dup", label: `${words.duplicate} (Ctrl+D)`, html: boardIcon("copy") },
        { value: "del", label: `${words.remove} (Delete)`, html: boardIcon("trash") },
      ];
      panel.append(section(words.selection, segments(actions, null, (value) => {
        if (value === "dup") board.duplicateSelection();
        else if (value === "del") board.deleteSelection();
        else board.reorderSelection(value as "front" | "back");
      })));
    }
    panel.hidden = false;
  };

  const sync = () => {
    toolButtons.forEach((made, tool) => made.setAttribute("aria-pressed", String(board.tool === tool)));
    lock.setAttribute("aria-pressed", String(board.toolLock));
    zoomLabel.textContent = `${Math.round(board.view.scale * 100)}%`;
    undo.disabled = !board.canUndo();
    redo.disabled = !board.canRedo();
    hint.textContent = hints[board.tool] ?? "";
    syncStyle();
  };

  const top = element("div", "board-top");
  top.append(element("div", "board-top-side"), toolbar, (() => { const side = element("div", "board-top-side right"); side.append(menuIsland); return side; })());
  root.append(top, panel, bottom, toastBox, help);
  disposers.push(board.listen(sync));
  const helpKey = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (event.key === "?" && !event.ctrlKey && !event.altKey && !target?.closest("input, textarea, select, [contenteditable=true]")) { help.showModal(); event.preventDefault(); }
  };
  root.addEventListener("keydown", helpKey);
  disposers.push(() => root.removeEventListener("keydown", helpKey));
  sync();

  return {
    toast,
    /** The theme changed: the swatches show the other shades. */
    refresh: sync,
    destroy: () => {
      closeMenu();
      window.clearTimeout(toastTimer);
      disposers.forEach((dispose) => dispose());
      for (const made of [top, panel, bottom, toastBox, help]) made.remove();
    },
  };
};
