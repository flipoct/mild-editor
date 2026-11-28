/**
 * A check of the drawing board's rules, its document and the tablet's messages, run with
 * `node --experimental-strip-types src/board/board.check.ts`.
 */
import * as Y from "yjs";
import { BoardDoc } from "./boardDoc.ts";
import {
  boundsOf, cleanElement, erased, fitView, hit, parseBoard, reorder, restore, richParts, serializeBoard, snapshotOf, zoomAt,
  type BoxElement, type Element, type ImageElement, type PenElement, type TextElement,
} from "./model.ts";
import { applyChange, changes, fullState, heard, newSent, readFromPad, readToPad } from "./padProtocol.ts";

let failed = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed += 1; console.log("FAIL", label, "\n  got ", got, "\n  want", want); }
  else console.log("ok   ", label, "->", JSON.stringify(got).slice(0, 120));
};

const pen: PenElement = { id: "a", type: "pen", x: 0, y: 0, angle: 0, color: "red", size: 4, points: [0, 0, 0.5, 100, 0, 0.5] };
const note: TextElement = { id: "t", type: "text", x: 10, y: 10, angle: 0, color: "ink", text: "area $\\pi r^2$", fontSize: 24, wrap: null };
const frame: BoxElement = { id: "r", type: "rect", x: 200, y: 0, w: 100, h: 50, angle: 0, color: "blue", size: 2, fill: "none" };
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const photo: ImageElement = { id: "i", type: "image", x: 0, y: 100, w: 40, h: 30, angle: 0, asset: "abcdef0123" };

// --- the file -------------------------------------------------------------------------------
eq("a board survives its file", parseBoard(serializeBoard([pen, note, frame, photo], { abcdef0123: PNG, unused0000: PNG })), { elements: [pen, note, frame, photo], assets: { abcdef0123: PNG } });
eq("an empty board", parseBoard(serializeBoard([])), { elements: [], assets: {} });
eq("not a board at all", [parseBoard("nope"), parseBoard("{}"), parseBoard("[1,2]")].map((board) => board.elements.length), [0, 0, 0]);
eq("a board from before elements is read as pen lines", parseBoard(JSON.stringify({ version: 1, strokes: [{ id: "s", ink: "purple", width: 9, points: [1, 2, 3, 4] }] })).elements,
  [{ id: "s", type: "pen", x: 0, y: 0, angle: 0, color: "violet", size: 9, points: [1, 2, 0.5, 3, 4, 0.5] }]);
eq("broken elements are left out", parseBoard(JSON.stringify({ elements: [pen, { ...pen, id: "x y" }, { ...pen, id: "c", points: [1, 2] }, { ...note, id: "e", text: "" }, { ...frame, id: "w", w: -1 }, { id: "z", type: "script", x: 0, y: 0 }] })).elements.map((element) => element.id), ["a"]);
eq("one id once", parseBoard(JSON.stringify({ elements: [pen, { ...pen, color: "blue" }] })).elements.length, 1);
eq("only raster pictures are kept", Object.keys(parseBoard(JSON.stringify({ elements: [], assets: { aaaaaaaa: PNG, bbbbbbbb: "data:image/svg+xml;base64,PHN2Zz4=", cccccccc: "javascript:1" } })).assets), ["aaaaaaaa"]);
eq("an unknown colour is ink, a wild size is held in", cleanElement({ ...frame, color: "#ff0000", size: 900 }), { ...frame, color: "ink", size: 128 });
eq("points far away are refused", cleanElement({ ...pen, points: [1e9, 0, 0.5] }), null);
eq("one element a line", serializeBoard([pen, note]).split("\n").length, 5);

// --- touching and erasing -------------------------------------------------------------------
eq("on the line, its width counted", [hit(pen, [50, 2.8], 1), hit(pen, [50, 3], 1)], [true, false]);
eq("beside it", hit(pen, [50, 12], 2), false);
eq("an empty rectangle is touched at its edge only", [hit(frame, [201, 25], 2), hit(frame, [250, 25], 2)], [true, false]);
eq("a filled one inside too", hit({ ...frame, fill: "yellow" }, [250, 25], 2), true);
eq("a turned rectangle", [hit({ ...frame, angle: Math.PI / 2 }, [250, -24], 2), hit({ ...frame, angle: Math.PI / 2 }, [201, 25], 2)], [true, false]);
eq("a fast swipe rubs out what it crossed, but not pictures", erased([pen, frame, photo], [50, -40], [50, 140], 2), ["a"]);

// --- the view -------------------------------------------------------------------------------
eq("bounds with widths", boundsOf([pen, frame]), { x: -2, y: -2, w: 303, h: 53 });
eq("fitting a small drawing stays at 100 %", fitView({ x: 0, y: 0, w: 100, h: 50 }, 800, 600).scale, 1);
eq("fitting a large one zooms out", fitView({ x: 0, y: 0, w: 4000, h: 100 }, 800, 600, 0).scale, 0.2);
const zoomed = zoomAt({ x: 0, y: 0, scale: 1 }, 2, 100, 100);
eq("zooming keeps the point under the pointer", [zoomed.x + 100 / zoomed.scale, zoomed.y + 100 / zoomed.scale], [100, 100]);

// --- writing --------------------------------------------------------------------------------
eq("formulas in writing", richParts("a $x^2$ b\n$$\\int f$$\nc \\$5"), [{ kind: "text", value: "a " }, { kind: "math", value: "x^2" }, { kind: "text", value: " b\n" }, { kind: "display", value: "\\int f" }, { kind: "text", value: "c $5" }]);

// --- undo -----------------------------------------------------------------------------------
const before = [pen, note, frame];
const moved = before.map((element) => element.id === "r" ? { ...element, x: 500 } : element);
const snapshot = snapshotOf(before, ["r"]);
const theirs: Element = { ...note, id: "o", text: "theirs" };
eq("undo puts back only what it changed", restore([...moved, theirs], snapshot, false).map((element) => element.id === "r" ? (element as BoxElement).x : element.id), ["a", "t", 200, "o"]);
eq("undoing a removal puts it back where it was", restore([pen, frame], snapshotOf(before, ["t"]), false).map((element) => element.id), ["a", "t", "r"]);
eq("undoing an addition takes it away", restore([...before, theirs], new Map([["o", null]]), false).map((element) => element.id), ["a", "t", "r"]);
eq("to the front", reorder(before, new Set(["a"]), "front").map((element) => element.id), ["t", "r", "a"]);
eq("one step back", reorder(before, new Set(["r"]), "backward").map((element) => element.id), ["a", "r", "t"]);

// --- the document ---------------------------------------------------------------------------
const one = new Y.Doc();
const two = new Y.Doc();
one.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "wire") Y.applyUpdate(two, update, "wire"); });
two.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "wire") Y.applyUpdate(one, update, "wire"); });
const a = new BoardDoc(one.getMap("board"));
const b = new BoardDoc(two.getMap("board"));
a.add({ ...pen, points: [0, 0, 0.5] });
a.extend("a", [100, 0, 0.5]);
eq("a line drawn on one copy is on the other", b.elements(), [pen]);
b.commit([...b.elements(), note, frame]);
eq("what the other draws comes back", a.elements().map((element) => element.id), ["a", "t", "r"]);
const sameLine = a.elements()[0];
a.commit(a.elements().map((element) => element.id === "r" ? { ...element, x: 300 } : element));
eq("a move is a change of the element alone", [(b.elements()[2] as BoxElement).x, a.elements()[0] === sameLine], [300, true]);
a.commit(reorder(a.elements(), new Set(["a"]), "front"));
eq("the order goes over", b.elements().map((element) => element.id), ["t", "r", "a"]);
b.putAsset("abcdef0123", PNG);
b.commit([...b.elements(), photo]);
eq("a picture goes with its element", [a.assets().abcdef0123 === PNG, a.elements().length], [true, 4]);
b.commit(b.elements().filter((element) => element.id !== "t"));
eq("and so does a removal", a.elements().map((element) => element.id), ["r", "a", "i"]);
a.clear();
eq("cleared for both", b.elements(), []);
const old = new Y.Doc();
const oldStrokes = new Y.Array<Y.Map<unknown>>();
old.getMap("board").set("strokes", oldStrokes);
const stroke = new Y.Map<unknown>();
stroke.set("id", "s"); stroke.set("ink", "blue"); stroke.set("width", 2);
const strokePoints = new Y.Array<number>(); strokePoints.push([0, 0, 10, 10]); stroke.set("points", strokePoints);
oldStrokes.push([stroke]);
const legacy = new BoardDoc(old.getMap("board"));
eq("an old teammate's strokes are drawn", legacy.elements().map((element) => [element.id, element.type, (element as PenElement).color]), [["s", "pen", "blue"]]);
legacy.commit([...legacy.elements(), note]);
eq("and stay put while something else is drawn", [oldStrokes.length, legacy.elements().map((element) => element.id)], [1, ["s", "t"]]);
legacy.commit(legacy.elements().map((element) => element.id === "s" ? { ...element, x: 5 } : element));
eq("moving one moves it over to the elements", [oldStrokes.length, legacy.elements().map((element) => [element.id, element.x])], [0, [["s", 5], ["t", 10]]]);

// --- the tablet -----------------------------------------------------------------------------
const sent = newSent();
eq("a tablet that has just come gets the board", fullState(sent, "plan.board", [pen]), { t: "state", name: "plan.board", elements: [pen] });
eq("nothing new, nothing said", changes(sent, [pen], {}), []);
const longer = { ...pen, points: [...pen.points, 150, 0, 0.5] };
eq("a growing line goes as its new points", changes(sent, [longer], {}), [{ t: "pts", id: "a", pts: [150, 0, 0.5] }]);
eq("a moved one whole", changes(sent, [{ ...longer, x: 3 }], {}).map((change) => change.t), ["put"]);
eq("a picture before the element that shows it", changes(sent, [{ ...longer, x: 3 }, photo], { abcdef0123: PNG }).map((change) => change.t), ["asset", "put"]);
eq("a new order when it is not what the tablet would make of it", changes(sent, [photo, { ...longer, x: 3 }], { abcdef0123: PNG }), [{ t: "order", ids: ["i", "a"] }]);
eq("removals", changes(sent, [photo], {}), [{ t: "del", ids: ["a"] }]);
heard(sent, { t: "put", element: note });
eq("what the tablet said is not said back", changes(sent, [photo, { ...note }], {}), []);
eq("a change applies on the other end", applyChange([pen], { t: "pts", id: "a", pts: [9, 9, 1] }).map((element) => (element as PenElement).points.length), [9]);
eq("an order names what it knows of", applyChange([pen, note, frame], { t: "order", ids: ["r", "a"] }).map((element) => element.id), ["r", "a", "t"]);
eq("a tablet's messages are checked", [readFromPad("{\"t\":\"hello\"}"), readFromPad("{\"t\":\"put\",\"element\":{\"id\":\"x\",\"type\":\"pen\"}}"), readFromPad("nope"), readFromPad("{\"t\":\"asset\",\"id\":\"aaaaaaaa\",\"data\":\"data:text/html;base64,AA==\"}")], [{ t: "hello" }, null, null, null]);
eq("and so are the editor's", readToPad(JSON.stringify({ t: "state", name: "x", elements: [pen, { id: "bad" }] })), { t: "state", name: "x", elements: [pen] });

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
