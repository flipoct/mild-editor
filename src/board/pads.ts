import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { explorerBasename, fileKey } from "../fileNaming";
import { IS_TAURI } from "../platform";
import { createStore } from "../store";
import { holdBoard, type BoardHandle } from "./boardStore";
import { catchUp, fullState, readFromPad, type Sent, type ToPad } from "./padProtocol";

/**
 * The editor's end of drawing on a board from a tablet (src-tauri/src/pad.rs has the wire,
 * padProtocol.ts the messages). A board is paired once, with a random token the QR code
 * carries; any number of tablets may then draw on it until the pairing is closed. A pairing
 * holds its board open by itself, so a tablet keeps drawing while the editor shows code.
 */

type PadAddress = { port: number; addresses: string[] };

/**
 * Whether a tablet outside this network can reach the board: not asked yet, being asked of
 * the router, the address it opens, or why not (src-tauri/src/collab.rs names the reasons).
 */
export type Outside = { state: "none" | "checking" | "no-gateway" | "nat" | "refused" } | { state: "open"; url: string };

/** What the board's QR panel shows: where a tablet goes, and how many are drawing now. */
export type PairingView = { urls: string[]; tablets: number; outside: Outside };

export const pairings = createStore<Record<string, PairingView>>({});

type Pairing = {
  token: string;
  path: string;
  handle: BoardHandle;
  /** How much of the board each connected tablet has. */
  tablets: Map<number, Sent>;
  unsubscribe: () => void;
  timer: number | null;
};

const byToken = new Map<string, Pairing>();
const byPath = new Map<string, Pairing>();

const token = () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => alphabet[byte % alphabet.length]).join("");
};

const send = (pairing: Pairing, client: number, message: ToPad) =>
  invoke("pad_send", { token: pairing.token, client, text: JSON.stringify(message) }).catch(() => undefined);

const show = (pairing: Pairing, change: Partial<PairingView> = {}) => pairings.set((state) => {
  const known = state[fileKey(pairing.path)];
  return { ...state, [fileKey(pairing.path)]: { urls: known?.urls ?? [], outside: known?.outside ?? { state: "none" }, ...change, tablets: pairing.tablets.size } };
});

/** Brings every tablet up to the board, a moment after it changed: a stroke being drawn changes it every frame. */
const catchUpSoon = (pairing: Pairing) => {
  if (pairing.timer !== null) return;
  pairing.timer = window.setTimeout(() => {
    pairing.timer = null;
    const strokes = pairing.handle.source.strokes();
    for (const [client, sent] of pairing.tablets) catchUp(sent, strokes).forEach((message) => void send(pairing, client, message));
  }, 30);
};

/** Pairs the board at `path` with tablets, or returns the pairing it has; resolves to the addresses a tablet can open. */
export const pairBoard = async (path: string): Promise<string[]> => {
  const known = byPath.get(fileKey(path));
  if (known) return pairings.get()[fileKey(path)]?.urls ?? [];
  const pairing: Pairing = { token: token(), path, handle: holdBoard(path), tablets: new Map(), unsubscribe: () => undefined, timer: null };
  byPath.set(fileKey(path), pairing);
  byToken.set(pairing.token, pairing);
  pairing.unsubscribe = pairing.handle.source.subscribe(() => catchUpSoon(pairing));
  try {
    const address = await invoke<PadAddress>("pad_open", { token: pairing.token });
    const urls = address.addresses.map((host) => `http://${host}:${address.port}/#${pairing.token}`);
    show(pairing, { urls });
    return urls;
  } catch (error) {
    unpairBoard(path);
    throw error;
  }
};

const REASONS = new Set(["no-gateway", "nat", "refused"]);

/**
 * Lets a tablet that is not on this network in: the router is asked to forward the pairing's
 * port here, which is only done when somebody asks for it.
 */
export const reachFromOutside = async (path: string) => {
  const pairing = byPath.get(fileKey(path));
  if (!pairing) return;
  show(pairing, { outside: { state: "checking" } });
  const outcome = await invoke<string>("pad_forward_port").then((address) => ({ address }), (error: unknown) => ({ error: String(error) }));
  if (byPath.get(fileKey(path)) !== pairing) return;
  show(pairing, { outside: "address" in outcome
    ? { state: "open", url: `http://${outcome.address}/#${pairing.token}` }
    : { state: REASONS.has(outcome.error) ? outcome.error as "no-gateway" | "nat" | "refused" : "refused" } });
};

/** Ends the board's pairing: its tablets are told and let go. */
export const unpairBoard = (path: string) => {
  const pairing = byPath.get(fileKey(path));
  if (!pairing) return;
  for (const client of pairing.tablets.keys()) void send(pairing, client, { t: "bye" });
  byPath.delete(fileKey(path));
  byToken.delete(pairing.token);
  pairing.unsubscribe();
  if (pairing.timer !== null) window.clearTimeout(pairing.timer);
  pairing.handle.release();
  // After the goodbyes, which are queued on the same connections.
  window.setTimeout(() => void invoke("pad_close", { token: pairing.token }).catch(() => undefined), 200);
  pairings.set((state) => { const next = { ...state }; delete next[fileKey(path)]; return next; });
};

/** Every pairing ends, when the workspace they were for goes. */
export const unpairAll = () => [...byPath.values()].forEach((pairing) => unpairBoard(pairing.path));

type PadEvent = { client: number; token: string; text?: string };

if (IS_TAURI) {
  void listen<PadEvent>("pad-message", ({ payload }) => {
    const pairing = byToken.get(payload.token);
    const message = pairing && payload.text ? readFromPad(payload.text) : null;
    if (!pairing || !message) return;
    const source = pairing.handle.source;
    let sent = pairing.tablets.get(payload.client);
    if (message.t === "hello") {
      sent = new Map();
      pairing.tablets.set(payload.client, sent);
      void send(pairing, payload.client, fullState(sent, explorerBasename(pairing.path), source.strokes()));
      show(pairing);
      return;
    }
    if (!sent) return;
    // What the tablet drew it already has: counted as sent before the change is heard.
    if (message.t === "begin") {
      sent.set(message.stroke.id, message.stroke.points.length);
      source.begin(message.stroke);
    } else if (message.t === "pts") {
      sent.set(message.id, (sent.get(message.id) ?? 0) + message.pts.length);
      source.extend(message.id, message.pts);
    } else if (message.t === "erase") {
      message.ids.forEach((id) => sent!.delete(id));
      source.erase(message.ids);
    }
  });
  void listen<PadEvent>("pad-gone", ({ payload }) => {
    const pairing = byToken.get(payload.token);
    if (pairing?.tablets.delete(payload.client)) show(pairing);
  });
}
