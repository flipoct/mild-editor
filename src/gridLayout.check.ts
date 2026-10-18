/**
 * A quick check of the workspace grid, run with
 * `node --experimental-strip-types src/gridLayout.check.ts`.
 */
import { applyDrop, completeGrid, distributeSiblings, dockView, dropTargetAt, gridFromColumns, layoutGrid, normalize, regionAt, removeView, resizeLimit, resizeSiblings, splitView, swapViews, type Grid } from "./gridLayout.ts";

let failed = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed += 1; console.log("FAIL", label, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); }
  else console.log("ok   ", label);
};

type Id = "a" | "b" | "c" | "d";
const ids: Id[] = ["a", "b", "c", "d"];
const row: Grid<Id> = { orientation: "horizontal", root: { size: 1, children: [{ view: "a", size: 1 }, { view: "b", size: 1 }, { view: "c", size: 1 }] } };

// --- the shape of the tree ------------------------------------------------------------------
/** The tree without sizes, to compare shapes: [orientation, nested ids]. */
const shape = (grid: Grid<Id>) => {
  const walk = (node: Grid<Id>["root"]["children"][number]): unknown => "view" in node ? node.view : node.children.map(walk);
  return [grid.orientation, grid.root.children.map(walk)];
};

eq("split across the parent's axis nests a branch", shape(splitView(row, "c", "a", "down")), ["horizontal", [["a", "c"], "b"]]);
eq("split along the parent's axis adds a sibling", shape(splitView(row, "c", "a", "left")), ["horizontal", ["c", "a", "b"]]);
eq("split takes half of the target's room", splitView(row, "c", "a", "right").root.children.slice(0, 2).map((node) => node.size), [0.5, 0.5]);
eq("moving out of a pair collapses it", shape(splitView(splitView(row, "c", "a", "down"), "c", "b", "right")), ["horizontal", ["a", "b", "c"]]);
eq("a root left with one branch flips the axis", shape(removeView({ orientation: "horizontal", root: { size: 1, children: [{ size: 1, children: [{ view: "a", size: 1 }, { view: "b", size: 1 }] }, { view: "c", size: 1 }] } }, "c")), ["vertical", ["a", "b"]]);
eq("a lone branch splices into its grandparent", shape(normalize({ orientation: "horizontal", root: { size: 1, children: [{ view: "a", size: 1 }, { size: 2, children: [{ size: 1, children: [{ view: "b", size: 1 }, { view: "c", size: 3 }] }] }] } })), ["horizontal", ["a", "b", "c"]]);
eq("spliced children share the room their branch had", normalize({ orientation: "horizontal", root: { size: 1, children: [{ view: "a", size: 1 }, { size: 2, children: [{ size: 1, children: [{ view: "b", size: 1 }, { view: "c", size: 3 }] }] }] } }).root.children.map((node) => node.size), [1, 0.5, 1.5]);
eq("docking across the root wraps the old grid", shape(dockView(row, "d", "down")), ["vertical", [["a", "b", "c"], "d"]]);
eq("docking along the root adds to an end", shape(dockView(row, "c", "left")), ["horizontal", ["c", "a", "b"]]);
eq("swap trades places", shape(swapViews(row, "a", "c")), ["horizontal", ["c", "b", "a"]]);
eq("dropping on itself changes nothing", splitView(row, "a", "a", "left"), row);

// --- boxes and dividers ---------------------------------------------------------------------
const nested = splitView(row, "c", "a", "down"); // [[a / c], b]
const { views, sashes } = layoutGrid(nested, () => true);
eq("stacked panels share their column", [views.get("a"), views.get("c")], [{ left: 0, top: 0, width: 50, height: 50 }, { left: 0, top: 50, width: 50, height: 50 }]);
eq("one divider between columns, one inside the stack", sashes.map((sash) => [sash.axis, sash.path, sash.before, sash.after, sash.position]), [["y", [0], 0, 1, 50], ["x", [], 0, 1, 50]]);
const hidden = layoutGrid(nested, (id) => id !== "c");
eq("a hidden panel gives its room to its sibling", hidden.views.get("a"), { left: 0, top: 0, width: 50, height: 100 });
eq("and takes its divider with it", hidden.sashes.length, 1);
eq("evening out a branch", distributeSiblings({ orientation: "horizontal", root: { size: 1, children: [{ view: "a", size: 1 }, { view: "b", size: 3 }] } }, [], [0, 1]).root.children.map((node) => node.size), [2, 2]);

// --- dropping ---------------------------------------------------------------------------------
const box = { left: 0, top: 0, width: 90, height: 90 };
eq("the middle third swaps", regionAt(box, 45, 45), "center");
eq("the outer third splits", regionAt(box, 10, 45), "left");
eq("the nearer edge wins in a corner", regionAt(box, 5, 20), "left");
eq("bottom third", regionAt(box, 45, 80), "down");
const band = { x: 2, y: 2 };
eq("near the border docks", dropTargetAt(layoutGrid(row, () => true).views, "a", 99, 50, band), { kind: "dock", direction: "right" });
eq("over another panel splits", dropTargetAt(layoutGrid(row, () => true).views, "a", 70, 10, band), { kind: "split", target: "c", direction: "up" });
eq("over itself does nothing", dropTargetAt(layoutGrid(row, () => true).views, "a", 15, 50, band), null);
eq("a drop applies", shape(applyDrop(row, "a", { kind: "split", target: "c", direction: "up" })), ["horizontal", ["b", ["a", "c"]]]);

// --- the fixes after review -------------------------------------------------------------------
// [a 1 | b 1 | c 2(hidden)]: docking d on the right should take a quarter of what is showing.
const withHidden: Grid<Id> = { orientation: "horizontal", root: { size: 1, children: [{ view: "a", size: 1 }, { view: "b", size: 1 }, { view: "c", size: 2 }] } };
const docked = dockView(withHidden, "d", "right", (id) => id !== "c");
eq("a dock is a quarter of what shows, hidden weight aside", layoutGrid(docked, (id) => id !== "c").views.get("d")?.width, 25);
eq("tiny weights are drawn as they are, not floored", layoutGrid({ orientation: "horizontal", root: { size: 1, children: [{ view: "a", size: 0.01 }, { view: "b", size: 0.03 }] } }, () => true).views.get("a")?.width, 25);
eq("a resize applies when the pair is still there", resizeSiblings(row, [], 0, 1, 1.5, 0.5, { before: "a", after: "b" }).root.children.map((node) => node.size), [1.5, 0.5, 1]);
eq("a resize is dropped when the tree moved under it", resizeSiblings(swapViews(row, "a", "c"), [], 0, 1, 1.5, 0.5, { before: "a", after: "b" }).root.children.map((node) => node.size), [1, 1, 1]);
eq("the floor is the pixel minimum when there is room", resizeLimit(2, 1000, "x"), 2 * 160 / 1000);
eq("but never above half the pair", resizeLimit(2, 200, "x"), 1);
eq("and at least 8% of it", resizeLimit(2, 10000, "x"), 0.16);

// --- stored grids -------------------------------------------------------------------------------
eq("columns from the old layout", shape(gridFromColumns<Id>([["a", "d"], ["b"], ["c"]], () => 1)), ["horizontal", [["a", "d"], "b", "c"]]);
eq("unknown, repeated and missing panels are put right", shape(completeGrid({ orientation: "horizontal", root: { size: 1, children: [{ view: "a", size: 1 }, { view: "zz", size: 1 }, { view: "a", size: 1 }, { view: "b", size: 1 }] } }, ids)!), ["horizontal", ["a", "b", "c", "d"]]);
eq("not a grid", completeGrid([["a"]], ids), null);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
