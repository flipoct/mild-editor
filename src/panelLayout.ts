/**
 * The workspace is a row of columns; each column is a stack of panels, top to bottom.
 * `[["tests"], ["editor"], ["explorer"]]` is the flat arrangement the editor has always
 * had, and `[["tests", "explorer"], ["editor"]]` puts the file list under the test cases.
 *
 * Every function here is pure and index-free at the edges: sizes are keyed by panel id, not
 * by position, so showing or hiding a panel cannot shift someone else's width.
 */
export type PanelLayout<Id extends string = string> = Id[][];
export type Edge = "left" | "right" | "top" | "bottom";
export type Rect = { left: number; top: number; width: number; height: number };

/** Where a panel sits, or null when it is not in the layout. */
export const locate = <Id extends string>(layout: PanelLayout<Id>, id: Id) => {
  for (let column = 0; column < layout.length; column += 1) {
    const row = layout[column].indexOf(id);
    if (row >= 0) return { column, row };
  }
  return null;
};

const withoutEmpty = <Id extends string>(layout: PanelLayout<Id>) => layout.filter((column) => column.length > 0);

/** The layout with `id` taken out, and any column it emptied removed. */
export const removePanel = <Id extends string>(layout: PanelLayout<Id>, id: Id) =>
  withoutEmpty(layout.map((column) => column.filter((panel) => panel !== id)));

/** Drop unknown or hidden panels; used to render only what is showing. */
export const visibleLayout = <Id extends string>(layout: PanelLayout<Id>, isVisible: (id: Id) => boolean) =>
  withoutEmpty(layout.map((column) => column.filter(isVisible)));

/** A layout for panels that have never been placed: one column each, in the given order. */
export const columnsFromOrder = <Id extends string>(order: Id[]): PanelLayout<Id> => order.map((id) => [id]);

/** Everything in `ids` appears exactly once, keeping the placements already made. */
export const completeLayout = <Id extends string>(layout: PanelLayout<Id>, ids: readonly Id[]): PanelLayout<Id> => {
  const seen = new Set<Id>();
  const kept = withoutEmpty(
    layout.map((column) => column.filter((panel) => ids.includes(panel) && !seen.has(panel) && (seen.add(panel), true))),
  );
  return [...kept, ...ids.filter((id) => !seen.has(id)).map((id) => [id])];
};

/**
 * Move a panel to the column beside it, joining that column's stack. A panel that shares a
 * column steps out into a new column of its own when it runs out of columns to join, so a
 * stack can always be broken up from the keyboard.
 */
export const moveToColumn = <Id extends string>(layout: PanelLayout<Id>, id: Id, direction: -1 | 1): PanelLayout<Id> => {
  const at = locate(layout, id);
  if (!at) return layout;
  const target = at.column + direction;
  const alone = layout[at.column].length === 1;
  if (target < 0 || target >= layout.length) {
    if (alone) return layout;
    const rest = removePanel(layout, id);
    return direction < 0 ? [[id], ...rest] : [...rest, [id]];
  }
  const next = layout.map((column) => [...column]);
  next[at.column].splice(at.row, 1);
  next[target].push(id);
  return withoutEmpty(next);
};

/** Move a panel up or down inside its own column. */
export const moveWithinColumn = <Id extends string>(layout: PanelLayout<Id>, id: Id, direction: -1 | 1): PanelLayout<Id> => {
  const at = locate(layout, id);
  if (!at) return layout;
  const to = at.row + direction;
  const column = layout[at.column];
  if (to < 0 || to >= column.length) return layout;
  const next = layout.map((items) => [...items]);
  [next[at.column][at.row], next[at.column][to]] = [next[at.column][to], next[at.column][at.row]];
  return next;
};

/** Take a stacked panel out into a column of its own, immediately to the right. */
export const splitPanel = <Id extends string>(layout: PanelLayout<Id>, id: Id): PanelLayout<Id> => {
  const at = locate(layout, id);
  if (!at || layout[at.column].length === 1) return layout;
  const next = layout.map((column) => [...column]);
  next[at.column].splice(at.row, 1);
  next.splice(at.column + 1, 0, [id]);
  return withoutEmpty(next);
};

/** Drop `id` against one edge of `target`: beside it as a new column, or into its stack. */
export const dropPanel = <Id extends string>(layout: PanelLayout<Id>, id: Id, target: Id, edge: Edge): PanelLayout<Id> => {
  if (id === target) return layout;
  const rest = removePanel(layout, id);
  const at = locate(rest, target);
  if (!at) return layout;
  const next = rest.map((column) => [...column]);
  if (edge === "left" || edge === "right") {
    next.splice(at.column + (edge === "right" ? 1 : 0), 0, [id]);
  } else {
    next[at.column].splice(at.row + (edge === "bottom" ? 1 : 0), 0, id);
  }
  return withoutEmpty(next);
};

/** Which edge of a panel a pointer at (x, y) is nearest, as a fraction of its box. */
export const edgeAt = (rect: { left: number; top: number; width: number; height: number }, x: number, y: number): Edge => {
  const horizontal = (x - rect.left) / (rect.width || 1);
  const vertical = (y - rect.top) / (rect.height || 1);
  // The closer of the two axes wins, so the middle of a wide panel still splits vertically.
  const fromSide = Math.min(horizontal, 1 - horizontal);
  const fromEnd = Math.min(vertical, 1 - vertical);
  if (fromSide <= fromEnd) return horizontal < 0.5 ? "left" : "right";
  return vertical < 0.5 ? "top" : "bottom";
};

const share = (weights: number[]) => {
  const total = weights.reduce((sum, weight) => sum + Math.max(weight, 0.05), 0) || 1;
  return weights.map((weight) => Math.max(weight, 0.05) / total);
};

/**
 * Percentage boxes for every panel. A column's width is taken from the panel at its top and
 * a panel's height from itself, so both survive a panel being hidden or moved.
 */
export const layoutRects = <Id extends string>(
  layout: PanelLayout<Id>,
  weightOf: (id: Id, axis: "width" | "height") => number,
): Map<Id, Rect> => {
  const rects = new Map<Id, Rect>();
  const widths = share(layout.map((column) => weightOf(column[0], "width")));
  let left = 0;
  layout.forEach((column, index) => {
    const width = widths[index];
    const heights = share(column.map((panel) => weightOf(panel, "height")));
    let top = 0;
    column.forEach((panel, row) => {
      rects.set(panel, { left: left * 100, top: top * 100, width: width * 100, height: heights[row] * 100 });
      top += heights[row];
    });
    left += width;
  });
  return rects;
};
