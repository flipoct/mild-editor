/**
 * The workspace arranged the way VS Code arranges its editor groups
 * (`src/vs/base/browser/ui/grid/gridview.ts`): a tree whose branches split their box along
 * alternating axes. The root lays its children out side by side or stacked, as `orientation`
 * says; each branch below it splits the other way, and every leaf is one panel.
 *
 * So any arrangement two dividers can make is one this can hold: the explorer under the tests
 * while the problem sits beside the editor, the editor across the whole top, and so on.
 *
 * Sizes are weights among siblings rather than pixels, so a layout keeps its proportions when
 * the window changes size (VS Code's `proportionalLayout`). A hidden panel keeps its place and
 * weight in the tree and is only left out when the boxes are worked out, so showing it again
 * puts it back where it was. Every function here is pure; the tree is never mutated in place.
 */

/** As in VS Code: horizontal children sit side by side, vertical ones are stacked. */
export type Orientation = "horizontal" | "vertical";
export type Direction = "left" | "right" | "up" | "down";
export type GridLeaf<Id extends string> = { view: Id; size: number };
export type GridBranch<Id extends string> = { children: GridNode<Id>[]; size: number };
export type GridNode<Id extends string> = GridLeaf<Id> | GridBranch<Id>;
export type Grid<Id extends string> = { orientation: Orientation; root: GridBranch<Id> };
/** Percentages of the workspace. */
export type Rect = { left: number; top: number; width: number; height: number };

export const isLeaf = <Id extends string>(node: GridNode<Id>): node is GridLeaf<Id> => "view" in node;
export const orthogonal = (orientation: Orientation): Orientation => orientation === "horizontal" ? "vertical" : "horizontal";
const orientationOf = (direction: Direction): Orientation => direction === "left" || direction === "right" ? "horizontal" : "vertical";
const isAfter = (direction: Direction) => direction === "right" || direction === "down";
/** The axis a branch at `depth` lays its children along. */
const orientationAt = <Id extends string>(grid: Grid<Id>, depth: number) => depth % 2 ? orthogonal(grid.orientation) : grid.orientation;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const goodSize = (size: unknown) => typeof size === "number" && Number.isFinite(size) && size > 0 ? size : 1;
const total = <Id extends string>(nodes: GridNode<Id>[]) => nodes.reduce((sum, node) => sum + node.size, 0) || 1;

/** The child indices that lead from the root to `id`, or null when it is not in the grid. */
export const findView = <Id extends string>(node: GridNode<Id>, id: Id): number[] | null => {
  if (isLeaf(node)) return node.view === id ? [] : null;
  for (let index = 0; index < node.children.length; index += 1) {
    const rest = findView(node.children[index], id);
    if (rest) return [index, ...rest];
  }
  return null;
};

export const nodeAt = <Id extends string>(root: GridBranch<Id>, path: number[]): GridNode<Id> | undefined =>
  path.reduce<GridNode<Id> | undefined>((node, index) => node && !isLeaf(node) ? node.children[index] : undefined, root);

export const viewsOf = <Id extends string>(node: GridNode<Id>): Id[] =>
  isLeaf(node) ? [node.view] : node.children.flatMap((child) => viewsOf(child));

/**
 * What VS Code's grid does after every change, so no two trees mean the same layout: an
 * empty branch goes, and a branch left with one child gives way to it. A leaf takes the
 * branch's place outright; a branch's children split the same way as the grandparent, so
 * they join it directly, sharing out the room the branch had.
 */
export const normalize = <Id extends string>(grid: Grid<Id>): Grid<Id> => {
  const tidy = (branch: GridBranch<Id>): GridNode<Id>[] => branch.children.flatMap((child): GridNode<Id>[] => {
    if (isLeaf(child)) return [{ view: child.view, size: goodSize(child.size) }];
    const children = tidy(child);
    const size = goodSize(child.size);
    if (!children.length) return [];
    if (children.length > 1) return [{ children, size }];
    const [only] = children;
    if (isLeaf(only)) return [{ view: only.view, size }];
    const sum = total(only.children);
    return only.children.map((grandchild) => ({ ...grandchild, size: grandchild.size / sum * size }));
  });
  let orientation = grid.orientation;
  let children = tidy(grid.root);
  // A root holding a single branch hands the whole workspace to it, which flips the axis.
  while (children.length === 1 && !isLeaf(children[0])) {
    children = children[0].children;
    orientation = orthogonal(orientation);
  }
  return { orientation, root: { children, size: 1 } };
};

/** The grid without `id`; the room it took goes to its siblings in proportion. */
export const removeView = <Id extends string>(grid: Grid<Id>, id: Id): Grid<Id> => {
  const path = findView(grid.root, id);
  if (!path) return grid;
  const next = clone(grid);
  const parent = nodeAt(next.root, path.slice(0, -1)) as GridBranch<Id>;
  parent.children.splice(path[path.length - 1], 1);
  return normalize(next);
};

/**
 * Splits `target` to make room for `id` on its `direction` side, as dropping an editor on
 * another group's edge does. Along the axis the target's parent already splits, the new panel
 * becomes its sibling and takes half the target's room; across it, the target turns into a
 * branch of the two. A panel already in the grid moves (VS Code's `moveView`).
 */
export const splitView = <Id extends string>(grid: Grid<Id>, id: Id, target: Id, direction: Direction): Grid<Id> => {
  if (id === target) return grid;
  const next = clone(removeView(grid, id));
  const path = findView(next.root, target);
  if (!path) return grid;
  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1];
  const parent = nodeAt(next.root, parentPath) as GridBranch<Id>;
  const leaf = parent.children[index];
  const after = isAfter(direction);
  if (orientationOf(direction) === orientationAt(next, parentPath.length)) {
    leaf.size /= 2;
    parent.children.splice(index + (after ? 1 : 0), 0, { view: id, size: leaf.size });
  } else {
    const placed: GridNode<Id> = { view: id, size: 1 };
    const kept: GridNode<Id> = { ...leaf, size: 1 };
    parent.children[index] = { size: leaf.size, children: after ? [kept, placed] : [placed, kept] };
  }
  return normalize(next);
};

/** The share of the workspace a panel dropped on its border takes. */
export const EDGE_SHARE = 0.25;

/**
 * Puts `id` along a whole side of the workspace, spanning it end to end: VS Code's
 * `addView` against the root. Across the root's axis the whole old grid becomes one branch
 * beside the new panel. The share is of what is on screen: hidden panels keep their weight,
 * but it does not count towards the room the new one is given.
 */
export const dockView = <Id extends string>(grid: Grid<Id>, id: Id, direction: Direction, isVisible: (id: Id) => boolean = () => true): Grid<Id> => {
  const next = clone(removeView(grid, id));
  const shows = showsWith(isVisible);
  const sum = total(next.root.children);
  const size = total(next.root.children.filter(shows)) * EDGE_SHARE / (1 - EDGE_SHARE);
  const placed: GridNode<Id> = { view: id, size };
  const after = isAfter(direction);
  if (!next.root.children.length) return normalize({ orientation: orientationOf(direction), root: { children: [placed], size: 1 } });
  if (orientationOf(direction) === next.orientation) {
    next.root.children.splice(after ? next.root.children.length : 0, 0, placed);
    return normalize(next);
  }
  const rest: GridNode<Id> = { children: next.root.children, size: sum };
  return normalize({ orientation: orthogonal(next.orientation), root: { children: after ? [rest, placed] : [placed, rest], size: 1 } });
};

/** Trades places between two panels; each takes the other's box. */
export const swapViews = <Id extends string>(grid: Grid<Id>, a: Id, b: Id): Grid<Id> => {
  const pathA = findView(grid.root, a);
  const pathB = findView(grid.root, b);
  if (!pathA || !pathB || a === b) return grid;
  const next = clone(grid);
  (nodeAt(next.root, pathA) as GridLeaf<Id>).view = b;
  (nodeAt(next.root, pathB) as GridLeaf<Id>).view = a;
  return next;
};

/** The panels a node holds, as one string: what a divider remembers its two sides by. */
export const signatureOf = <Id extends string>(node: GridNode<Id> | undefined) => node ? viewsOf(node).join(",") : "";

/**
 * New weights for two siblings, as a divider between them is dragged. A divider is found by
 * position in the tree, so it also names the panels it expects on each side: if the tree was
 * rearranged meanwhile (the layout reset from the palette mid-drag, say) the position may
 * now hold something else, and the grid is left alone rather than resizing the wrong pair.
 */
export const resizeSiblings = <Id extends string>(
  grid: Grid<Id>, path: number[], before: number, after: number, beforeSize: number, afterSize: number,
  expect?: { before: string; after: string },
): Grid<Id> => {
  const next = clone(grid);
  const branch = nodeAt(next.root, path);
  if (!branch || isLeaf(branch) || !branch.children[before] || !branch.children[after]) return grid;
  if (expect && (signatureOf(branch.children[before]) !== expect.before || signatureOf(branch.children[after]) !== expect.after)) return grid;
  branch.children[before].size = goodSize(beforeSize);
  branch.children[after].size = goodSize(afterSize);
  return next;
};

/**
 * Evens out the given children of a branch, keeping the room they cover together: what
 * double-clicking a divider does in VS Code. Hidden siblings keep their own weight.
 */
export const distributeSiblings = <Id extends string>(grid: Grid<Id>, path: number[], indices: number[]): Grid<Id> => {
  const next = clone(grid);
  const branch = nodeAt(next.root, path);
  if (!branch || isLeaf(branch)) return grid;
  const nodes = indices.map((index) => branch.children[index]).filter(Boolean);
  const even = total(nodes) / (nodes.length || 1);
  nodes.forEach((node) => { node.size = even; });
  return next;
};

// --- Turning the tree into boxes ------------------------------------------------------------

export type Sash = {
  key: string;
  /** The branch the divider sits in, and the visible siblings it lies between. */
  path: number[];
  before: number;
  after: number;
  /** x: a vertical line dragged sideways; y: a horizontal line dragged up and down. */
  axis: "x" | "y";
  /** Where the divider is along its axis, and how far it reaches across, in percentages. */
  position: number;
  from: number;
  length: number;
  /** The share of the workspace the two siblings cover together along the axis, 0–1. */
  pair: number;
  /** The visible siblings in the branch, for evening them out. */
  siblings: number[];
};

/**
 * Weights as fractions, exactly proportional. No floor here: a floor would draw a panel at a
 * size its weight does not say, and a divider dragged against it would stop following the
 * pointer. How small a panel may get is the divider's business (see `resizeLimit`).
 */
const share = (weights: number[]) => {
  const sum = weights.reduce((total, weight) => total + weight, 0) || 1;
  return weights.map((weight) => weight / sum);
};

/** Whether a node has anything on screen. */
const showsWith = <Id extends string>(isVisible: (id: Id) => boolean) => {
  const shows = (node: GridNode<Id>): boolean => isLeaf(node) ? isVisible(node.view) : node.children.some(shows);
  return shows;
};

/** The smallest a panel gets while a divider is dragged, in CSS pixels along the drag. */
export const MIN_PANEL_PX = { x: 160, y: 90 };

/**
 * The least weight either side of a divider may keep: 8% of the pair, and never below the
 * pixel minimum while there is room for it — VS Code gives every view a minimum size.
 * Never more than half the pair, so a divider can always move.
 */
export const resizeLimit = (pairWeight: number, spanPx: number, axis: "x" | "y") =>
  Math.min(pairWeight / 2, Math.max(0.08 * pairWeight, spanPx > 0 ? MIN_PANEL_PX[axis] / spanPx * pairWeight : 0));

/**
 * The box of every visible panel, and the dividers between neighbours. A branch with nothing
 * visible takes no room, and one with a single visible child gives that child all of it.
 */
export const layoutGrid = <Id extends string>(grid: Grid<Id>, isVisible: (id: Id) => boolean) => {
  const views = new Map<Id, Rect>();
  const sashes: Sash[] = [];
  const shows = showsWith(isVisible);
  const visit = (node: GridNode<Id>, rect: Rect, orientation: Orientation, path: number[]) => {
    if (isLeaf(node)) { views.set(node.view, rect); return; }
    const shown = node.children.map((child, index) => ({ child, index })).filter(({ child }) => shows(child));
    const fractions = share(shown.map(({ child }) => child.size));
    const across = orientation === "horizontal";
    const extent = across ? rect.width : rect.height;
    let offset = across ? rect.left : rect.top;
    shown.forEach(({ child, index }, order) => {
      const length = fractions[order] * extent;
      const box = across
        ? { left: offset, top: rect.top, width: length, height: rect.height }
        : { left: rect.left, top: offset, width: rect.width, height: length };
      if (order > 0) {
        const previous = shown[order - 1].index;
        sashes.push({
          key: `${path.join(".")}/${previous}-${index}`,
          path, before: previous, after: index,
          axis: across ? "x" : "y",
          position: offset,
          from: across ? rect.top : rect.left,
          length: across ? rect.height : rect.width,
          pair: (fractions[order - 1] + fractions[order]) * extent / 100,
          siblings: shown.map((entry) => entry.index),
        });
      }
      visit(child, box, orthogonal(orientation), [...path, index]);
      offset += length;
    });
  };
  visit(grid.root, { left: 0, top: 0, width: 100, height: 100 }, grid.orientation, []);
  return { views, sashes };
};

// --- Dropping a dragged panel ---------------------------------------------------------------

export type DropTarget<Id extends string> =
  | { kind: "split"; target: Id; direction: Direction }
  | { kind: "swap"; target: Id }
  | { kind: "dock"; direction: Direction };

/**
 * Where on a panel a pointer is, as VS Code's editor drop overlay reads it: the outer thirds
 * split the panel on that side, the middle swaps the two. In a corner the nearer edge wins,
 * measured as a fraction of the panel so a wide panel still splits sideways near its ends.
 */
export const regionAt = (rect: Rect, x: number, y: number): Direction | "center" => {
  const horizontal = (x - rect.left) / (rect.width || 1);
  const vertical = (y - rect.top) / (rect.height || 1);
  const fromSide = Math.min(horizontal, 1 - horizontal);
  const fromEnd = Math.min(vertical, 1 - vertical);
  if (fromSide >= 1 / 3 && fromEnd >= 1 / 3) return "center";
  if (fromSide <= fromEnd) return horizontal < 0.5 ? "left" : "right";
  return vertical < 0.5 ? "up" : "down";
};

/**
 * What dropping `dragged` at (x, y) would do. Within `dockBand` of the workspace's border it
 * docks along that whole side; over another panel it splits or swaps; over itself, nothing.
 * `x`, `y` and `dockBand` are percentages of the workspace (the band is given per axis).
 */
export const dropTargetAt = <Id extends string>(
  views: Map<Id, Rect>, dragged: Id, x: number, y: number, dockBand: { x: number; y: number },
): DropTarget<Id> | null => {
  const edges: Array<[Direction, number]> = [["left", x / dockBand.x], ["right", (100 - x) / dockBand.x], ["up", y / dockBand.y], ["down", (100 - y) / dockBand.y]];
  const [nearest, distance] = edges.reduce((best, edge) => edge[1] < best[1] ? edge : best);
  if (distance < 1) return { kind: "dock", direction: nearest };
  for (const [target, rect] of views) {
    if (x < rect.left || x > rect.left + rect.width || y < rect.top || y > rect.top + rect.height) continue;
    if (target === dragged) return null;
    const region = regionAt(rect, x, y);
    return region === "center" ? { kind: "swap", target } : { kind: "split", target, direction: region };
  }
  return null;
};

/** The grid once `dragged` is dropped on `drop`. */
export const applyDrop = <Id extends string>(grid: Grid<Id>, dragged: Id, drop: DropTarget<Id>, isVisible?: (id: Id) => boolean): Grid<Id> =>
  drop.kind === "swap" ? swapViews(grid, dragged, drop.target)
    : drop.kind === "split" ? splitView(grid, dragged, drop.target, drop.direction)
      : dockView(grid, dragged, drop.direction, isVisible);

/** The box the drop overlay lights up: the half a split would give, the whole panel for a swap, the strip a dock would take. */
export const dropPreview = <Id extends string>(views: Map<Id, Rect>, drop: DropTarget<Id>): Rect | null => {
  const sideOf = (rect: Rect, direction: Direction, fraction: number): Rect => {
    if (direction === "left") return { ...rect, width: rect.width * fraction };
    if (direction === "right") return { ...rect, left: rect.left + rect.width * (1 - fraction), width: rect.width * fraction };
    if (direction === "up") return { ...rect, height: rect.height * fraction };
    return { ...rect, top: rect.top + rect.height * (1 - fraction), height: rect.height * fraction };
  };
  if (drop.kind === "dock") return sideOf({ left: 0, top: 0, width: 100, height: 100 }, drop.direction, EDGE_SHARE);
  const rect = views.get(drop.target);
  if (!rect) return null;
  return drop.kind === "swap" ? rect : sideOf(rect, drop.direction, 0.5);
};

// --- Building and repairing a grid ----------------------------------------------------------

/**
 * The grid for the arrangement saved before this one: a row of columns, each a stack of
 * panels top to bottom, a column as wide as the weight of its top panel.
 */
export const gridFromColumns = <Id extends string>(columns: Id[][], weightOf: (id: Id, axis: "width" | "height") => number): Grid<Id> =>
  normalize({
    orientation: "horizontal",
    root: {
      size: 1,
      children: columns.filter((column) => column.length).map((column): GridNode<Id> => column.length === 1
        ? { view: column[0], size: weightOf(column[0], "width") }
        : { size: weightOf(column[0], "width"), children: column.map((id) => ({ view: id, size: weightOf(id, "height") })) }),
    },
  });

/**
 * A stored grid made whole: anything unknown or repeated is dropped, and a panel it has never
 * placed is added at the end of the root. Returns null for something that is not a grid.
 */
export const completeGrid = <Id extends string>(value: unknown, ids: readonly Id[]): Grid<Id> | null => {
  if (!value || typeof value !== "object") return null;
  const { orientation, root } = value as { orientation?: unknown; root?: unknown };
  if ((orientation !== "horizontal" && orientation !== "vertical") || !root || typeof root !== "object") return null;
  const seen = new Set<Id>();
  const read = (node: unknown): GridNode<Id> | null => {
    if (!node || typeof node !== "object") return null;
    const { view, children, size } = node as { view?: unknown; children?: unknown; size?: unknown };
    if (typeof view === "string") {
      if (!ids.includes(view as Id) || seen.has(view as Id)) return null;
      seen.add(view as Id);
      return { view: view as Id, size: goodSize(size) };
    }
    if (!Array.isArray(children)) return null;
    return { size: goodSize(size), children: children.map(read).filter((child): child is GridNode<Id> => child !== null) };
  };
  const tree = read(root);
  if (!tree || isLeaf(tree)) return null;
  const missing = ids.filter((id) => !seen.has(id));
  const grid = normalize({ orientation, root: tree });
  if (!missing.length) return grid;
  // Room for a newcomer along the root, as if it had been docked at the end.
  return missing.reduce((next, id) => dockView(next, id, next.orientation === "horizontal" ? "right" : "down"), grid);
};
