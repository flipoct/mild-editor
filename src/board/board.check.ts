/**
 * A check of the drawing board's rules and its document, run with
 * `node --experimental-strip-types src/board/board.check.ts`.
 */
import * as Y from "yjs";
import { BoardDoc } from "./boardDoc.ts";
import { boundsOf, cleanStroke, erased, fitView, parseBoard, serializeBoard, touches, zoomAt, type Stroke } from "./model.ts";
import { catchUp, fullState, readFromPad, readToPad, type Sent } from "./padProtocol.ts";

let failed = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed += 1; console.log("FAIL", label, "\n  got ", got, "\n  want", want); }
  else console.log("ok   ", label, "->", JSON.stringify(got).slice(0, 120));
};

const line: Stroke = { id: "a", ink: "red", width: 4, points: [0, 0, 100, 0] };
const dot: Stroke = { id: "b", ink: "ink", width: 2, points: [50, 50] };

// --- the file -------------------------------------------------------------------------------
eq("a board survives its file", parseBoard(serializeBoard([line, dot])), [line, dot]);
eq("an empty board", parseBoard(serializeBoard([])), []);
eq("not a board at all", [parseBoard("nope"), parseBoard("{}"), parseBoard("[1,2]")], [[], [], []]);
eq("broken strokes are left out", parseBoard(JSON.stringify({ strokes: [line, { id: "x y", points: [1, 2] }, { id: "c", points: [1] }, { id: "d", points: [1, "2"] }, { id: "e", points: [1, Infinity] }] })).map((stroke) => stroke.id), ["a"]);
eq("one id once", parseBoard(JSON.stringify({ strokes: [line, { ...line, ink: "blue" }] })).length, 1);
eq("an unknown ink is ink, a wild width is held in", cleanStroke({ id: "q", ink: "#ff0000", width: 900, points: [0, 0] }), { id: "q", ink: "ink", width: 64, points: [0, 0] });
eq("points far away are refused", cleanStroke({ id: "q", points: [1e9, 0] }), null);
eq("one stroke a line", serializeBoard([line, dot]).split("\n").length, 5);

// --- the eraser -----------------------------------------------------------------------------
eq("on the line", touches(line, 50, 3, 1), true);
eq("its width counts", [touches(line, 50, 2.4, 0.5), touches(line, 50, 2.6, 0.5)], [true, false]);
eq("beside it", touches(line, 50, 10, 2), false);
eq("past its end", touches(line, 110, 0, 5), false);
eq("a dot", [touches(dot, 51, 51, 1), touches(dot, 60, 60, 1)], [true, false]);
eq("a fast swipe rubs out what it crossed", erased([line, dot], 50, -40, 50, 80, 2), ["a", "b"]);
eq("and only that", erased([line, dot], 200, -40, 200, 80, 2), []);

// --- the view -------------------------------------------------------------------------------
eq("bounds with widths", boundsOf([line, dot]), { left: -2, top: -2, right: 102, bottom: 51 });
eq("nothing to fit", fitView(null, 800, 600), { x: 0, y: 0, scale: 1 });
const fitted = fitView({ left: 0, top: 0, right: 2000, bottom: 1000 }, 1000, 600, 0);
eq("a big drawing is zoomed out to fit", fitted.scale, 0.5);
eq("and centred", [fitted.x, fitted.y], [0, -100]);
eq("a small one is not zoomed in", fitView({ left: 0, top: 0, right: 10, bottom: 10 }, 1000, 600).scale, 1);
const zoomed = zoomAt({ x: 0, y: 0, scale: 1 }, 2, 100, 50);
eq("zooming keeps the point under the pointer", [zoomed.x + 100 / zoomed.scale, zoomed.y + 50 / zoomed.scale], [100, 50]);
eq("zoom has limits", [zoomAt({ x: 0, y: 0, scale: 1 }, 1000, 0, 0).scale, zoomAt({ x: 0, y: 0, scale: 1 }, 0.0001, 0, 0).scale], [8, 0.1]);

// --- the document, and two people drawing on it ---------------------------------------------
const left = new Y.Doc();
const right = new Y.Doc();
// Every update one side makes reaches the other, as a room's relay would carry it.
left.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "wire") Y.applyUpdate(right, update, "wire"); });
right.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== "wire") Y.applyUpdate(left, update, "wire"); });
const mine = new BoardDoc(left.getMap("board"));
const theirs = new BoardDoc(right.getMap("board"));
let heard = 0;
theirs.observe(() => { heard += 1; });
mine.add({ id: "s1", ink: "blue", width: 4, points: [0, 0] });
eq("a stroke reaches the other side as it starts", theirs.strokes(), [{ id: "s1", ink: "blue", width: 4, points: [0, 0] }]);
const before = theirs.strokes();
mine.extend("s1", [10, 10, 20, 15]);
eq("and as it grows", theirs.strokes()[0].points, [0, 0, 10, 10, 20, 15]);
eq("a new array for the canvas when it changed", theirs.strokes() !== before, true);
eq("the same one when it did not", theirs.strokes() === theirs.strokes(), true);
theirs.add({ id: "s2", ink: "green", width: 2, points: [5, 5] });
eq("both draw", mine.strokes().map((stroke) => stroke.id), ["s1", "s2"]);
mine.remove(["s2"]);
eq("erasing reaches everyone", theirs.strokes().map((stroke) => stroke.id), ["s1"]);
mine.extend("nope", [1, 1]);
mine.extend("s1", [1]);
eq("points for no stroke, or half a point, are nothing", theirs.strokes()[0].points.length, 6);
eq("the other side heard every change", heard > 0, true);
theirs.replace(parseBoard(serializeBoard([line, dot])));
eq("a file read in replaces everything", mine.strokes().map((stroke) => stroke.id), ["a", "b"]);
// A teammate's document with rubbish in it is drawn without the rubbish.
right.transact(() => { const map = new Y.Map<unknown>(); map.set("id", "bad id!"); map.set("points", Y.Array.from([1, 2])); (right.getMap("board").get("strokes") as Y.Array<unknown>).push([map]); });
eq("a broken stroke from somebody else is not drawn", mine.strokes().map((stroke) => stroke.id), ["a", "b"]);
mine.clear();
eq("clearing", theirs.strokes(), []);

// --- a tablet ---------------------------------------------------------------------------------
const sent: Sent = new Map();
eq("a tablet that comes gets everything", fullState(sent, "share.board", [line]), { t: "state", name: "share.board", strokes: [line] });
eq("nothing new, nothing sent", catchUp(sent, [line]), []);
const grown = { ...line, points: [...line.points, 120, 10] };
eq("a stroke that grew sends its new points", catchUp(sent, [grown, dot]), [{ t: "pts", id: "a", pts: [120, 10] }, { t: "add", stroke: dot }]);
eq("a stroke that went", catchUp(sent, [dot]), [{ t: "del", ids: ["a"] }]);
// What the tablet drew is marked sent as it comes in, so it is not sent back.
sent.set("p1", 4);
eq("the tablet's own stroke is not echoed", catchUp(sent, [dot, { id: "p1", ink: "ink", width: 4, points: [1, 1, 2, 2] }]), []);
eq("a tablet's messages are read", [readFromPad('{"t":"hello"}'), readFromPad(JSON.stringify({ t: "begin", stroke: dot })), readFromPad('{"t":"erase","ids":["a","b"]}')], [{ t: "hello" }, { t: "begin", stroke: dot }, { t: "erase", ids: ["a", "b"] }]);
eq("and nonsense is not", [readFromPad("{"), readFromPad('{"t":"pts","id":"a","pts":[1]}'), readFromPad('{"t":"erase","ids":["x y"]}'), readFromPad('{"t":"begin","stroke":{"id":"a","points":[]}}'), readFromPad('{"t":"drop"}')], [null, null, null, null, null]);
eq("the editor's messages are read back", readToPad(JSON.stringify({ t: "state", name: "b", strokes: [line, { id: "bad" }] })), { t: "state", name: "b", strokes: [line] });

console.log(failed ? `\n${failed} failed` : "\nall passed");
if (failed) process.exit(1);
