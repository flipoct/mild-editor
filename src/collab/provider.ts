import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates, type Awareness } from "y-protocols/awareness";
import { readSyncMessage, writeSyncStep1, writeUpdate } from "y-protocols/sync";
import type * as Y from "yjs";
import { MESSAGE, reconnectDelay, roomUrl, seal, unseal, type MessageKind, type Room } from "./protocol";

/** The relay's close codes (src-tauri/relay/src/lib.rs) this side acts on; any other close is a lost connection. */
const CLOSE = { badRequest: 4400, noRoom: 4404, roomFull: 4409, tooManyRooms: 4429 } as const;

/** Why a provider gave up for good. Anything else it retries by itself. */
export type EndReason =
  /** The relay could not be reached at all: the address is wrong, or nothing listens there. */
  | "unreachable"
  /** The relay has no such room: a wrong code, or a room nobody is in any more. */
  | "no-room"
  | "room-full"
  /** A relay that serves no more rooms, or one that is not a relay of this protocol. */
  | "refused"
  /** The relay under the room was shut down by the member whose computer it ran on. */
  | "closed"
  /** The connection was lost and did not come back within `GIVE_UP_AFTER`. */
  | "lost";

export type Link = "connecting" | "online" | "offline";

type Options = {
  address: string;
  room: Room;
  doc: Y.Doc;
  awareness: Awareness;
  /** This peer opened the room, so it starts out with the document and may create the room on the relay. */
  opener: boolean;
  /** The relay is inside this peer's app: when this peer goes, the room goes, and the others are told. */
  ownsRelay: boolean;
  onLink: (link: Link) => void;
  /** Somebody's copy of the document has reached this one for the first time. */
  onSynced: () => void;
  onEnd: (reason: EndReason) => void;
};

/** A connection attempt that has not opened by now is given up, where the system would take most of a minute. */
const CONNECT_TIMEOUT = 8000;

/**
 * How long a lost connection is retried before the room is called over for this peer. Long
 * enough for a relay to restart or a laptop to change networks; short enough that nobody
 * goes on believing they are in a room whose relay — a teammate's computer, perhaps — is gone.
 */
export const GIVE_UP_AFTER = 60_000;

/**
 * Keeps a `Y.Doc` and its awareness in step with the other peers of a room, through a
 * relay that only forwards (see protocol.ts for what goes over the wire).
 *
 * There is no copy of the document on a server to catch up from, so the peers catch up
 * from each other: whoever connects says what it has (`hello`), everyone already there
 * answers with what it lacks and asks the same in return. After that each local change is
 * sent as it happens. A lost connection is retried with a growing wait, and the same
 * exchange on reconnecting merges whatever each side typed while apart — which is all a
 * CRDT needs.
 *
 * Nobody owns the room. It is there while anyone is in it, whoever opened it; a peer that
 * has the document recreates it on the relay when it comes back to find it gone (a relay
 * that restarted), while a newcomer can only join a room that exists — which is what makes
 * a wrong code "no such room" instead of an empty one.
 */
export class RelayProvider {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private retry: number | null = null;
  private timeout: number | null = null;
  private everOpened = false;
  private ended = false;
  /** When the connection was lost, while it is; retrying stops `GIVE_UP_AFTER` later. */
  private offlineSince: number | null = null;
  synced: boolean;
  /** Frames are sealed and opened asynchronously; these keep each direction in the order it happened. */
  private outbox: Promise<void> = Promise.resolve();
  private inbox: Promise<void> = Promise.resolve();
  /** Sealed ahead of time: when the window is closing there is no time left to encrypt. */
  private farewell: Uint8Array<ArrayBuffer> | null = null;
  private readonly options: Options;

  constructor(options: Options) {
    this.options = options;
    // Whoever opened the room has the document; everyone else has it once somebody answered.
    this.synced = options.opener;
    options.doc.on("update", this.onDocUpdate);
    options.awareness.on("update", this.onAwarenessUpdate);
    window.addEventListener("pagehide", this.onPageHide);
    if (options.ownsRelay) void seal(options.room, MESSAGE.bye).then((frame) => { this.farewell = frame; });
    this.connect();
  }

  private connect() {
    if (this.ended) return;
    const { address, room } = this.options;
    this.options.onLink(this.everOpened ? "offline" : "connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(roomUrl(address, room.roomId, this.synced));
    } catch {
      // Not an address a socket can be opened to at all (or one the page may not connect to).
      this.end("unreachable");
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.timeout = window.setTimeout(() => socket.close(), CONNECT_TIMEOUT);
    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.clearTimers();
      this.everOpened = true;
      this.attempt = 0;
      this.offlineSince = null;
      this.options.onLink("online");
      const hello = encoding.createEncoder();
      writeSyncStep1(hello, this.options.doc);
      this.send(MESSAGE.hello, encoding.toUint8Array(hello));
      this.send(MESSAGE.query);
      this.sendAwareness([this.options.doc.clientID]);
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket || !(event.data instanceof ArrayBuffer)) return;
      const frame = new Uint8Array(event.data);
      this.inbox = this.inbox.then(() => unseal(this.options.room, frame)).then((message) => {
        // A frame that does not open is not this room's; there is nothing to do about it.
        if (message && socket === this.socket) this.receive(message.kind, message.body);
      }).catch((error) => console.error("collab: could not apply a message", error));
    };
    socket.onclose = (event) => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.clearTimers();
      if (this.ended) return;
      if (event.code === CLOSE.roomFull) return this.end("room-full");
      if (event.code === CLOSE.badRequest || event.code === CLOSE.tooManyRooms) return this.end("refused");
      // Only a peer without the document asks to join rather than open, so this is a wrong
      // code, or a room everybody has left.
      if (event.code === CLOSE.noRoom) return this.end("no-room");
      if (!this.everOpened) return this.end("unreachable");
      this.offlineSince ??= Date.now();
      if (Date.now() - this.offlineSince >= GIVE_UP_AFTER) return this.end("lost");
      this.options.onLink("offline");
      this.retry = window.setTimeout(() => this.connect(), reconnectDelay(this.attempt));
      this.attempt += 1;
    };
  }

  private clearTimers() {
    if (this.timeout !== null) window.clearTimeout(this.timeout);
    if (this.retry !== null) window.clearTimeout(this.retry);
    this.timeout = this.retry = null;
  }

  /** Queues one message. Without a connection it is dropped: the exchange on reconnecting covers whatever it said. */
  private send(kind: MessageKind, body?: Uint8Array) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    this.outbox = this.outbox.then(() => seal(this.options.room, kind, body)).then((frame) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    }).catch(() => undefined);
  }

  private sendAwareness(clients: number[]) {
    this.send(MESSAGE.awareness, encodeAwarenessUpdate(this.options.awareness, clients));
  }

  private receive(kind: MessageKind, body: Uint8Array) {
    const { doc, awareness } = this.options;
    if (kind === MESSAGE.hello || kind === MESSAGE.sync) {
      // A peer still waiting for the document has none to offer: its empty answer would
      // tell a second newcomer it had caught up.
      if (kind === MESSAGE.hello && !this.synced) return;
      const reply = encoding.createEncoder();
      // Applies an update or a step 2, or writes the step 2 that answers a step 1.
      const step = readSyncMessage(decoding.createDecoder(body), reply, doc, this);
      if (encoding.length(reply) > 0) this.send(MESSAGE.sync, encoding.toUint8Array(reply));
      if (kind === MESSAGE.hello) {
        const ask = encoding.createEncoder();
        writeSyncStep1(ask, doc);
        this.send(MESSAGE.sync, encoding.toUint8Array(ask));
      } else if (step === 1 && !this.synced) {
        this.synced = true;
        this.options.onSynced();
      }
    } else if (kind === MESSAGE.awareness) {
      applyAwarenessUpdate(awareness, body, this);
    } else if (kind === MESSAGE.query) {
      this.sendAwareness([doc.clientID]);
    } else if (kind === MESSAGE.bye && !this.options.ownsRelay) {
      this.end("closed");
    }
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return;
    const message = encoding.createEncoder();
    writeUpdate(message, update);
    this.send(MESSAGE.sync, encoding.toUint8Array(message));
  };

  private onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    // Only this peer's own state is its to announce; what it heard, the others heard too.
    if (origin === "local") this.sendAwareness([...added, ...updated, ...removed]);
  };

  /** The window is going away, and the relay with it: no time for anything asynchronous, so the goodbye was sealed beforehand. */
  private onPageHide = () => {
    if (this.farewell && this.socket?.readyState === WebSocket.OPEN) this.socket.send(this.farewell);
  };

  private end(reason: EndReason) {
    if (this.ended) return;
    this.destroy();
    this.options.onEnd(reason);
  }

  /**
   * Leaves the room on purpose: the others are told this peer's cursor is gone and, when the
   * relay is this peer's and about to stop, that the room is over, before the connection
   * goes. Resolves once that is sent.
   */
  async leave() {
    if (this.ended) return;
    if (this.options.ownsRelay) this.send(MESSAGE.bye);
    removeAwarenessStates(this.options.awareness, [this.options.doc.clientID], "local");
    const sent = this.outbox;
    this.destroy(false);
    await Promise.race([sent, new Promise((resolve) => window.setTimeout(resolve, 1000))]);
    this.socket?.close();
    this.socket = null;
  }

  destroy(closeSocket = true) {
    this.ended = true;
    this.clearTimers();
    this.options.doc.off("update", this.onDocUpdate);
    this.options.awareness.off("update", this.onAwarenessUpdate);
    window.removeEventListener("pagehide", this.onPageHide);
    if (closeSocket) {
      this.socket?.close();
      this.socket = null;
    }
  }
}
