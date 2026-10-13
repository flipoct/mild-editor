/**
 * The shared-room protocol: everything two copies of the editor must agree on, in one place.
 * Pure — no editor, no Yjs, no socket — so it is checked without a browser
 * (`src/collab/protocol.check.ts`); the relay's side of it is src-tauri/relay/src/lib.rs.
 *
 * ── The join code ──
 * Twelve symbols of Crockford's base32 (0-9 and A-Z without I, L, O, U), shown in groups of
 * four: `K7QM-2XWP-9HDT`. Typed without regard to case, spaces or hyphens, and O, I and L are
 * read as the digits they look like. That is 60 random bits, made afresh for every room.
 *
 * Sixty bits are enough only because every guess is made expensive: somebody who recorded a
 * session (on the LAN, or the relay itself) can test codes offline, and each test costs
 * 600,000 rounds of PBKDF2 — about 2^20 SHA-256 compressions. Trying half the codes is some
 * 2^79 compressions: twenty thousand years for a hundred GPUs doing 10^10 hashes a second
 * each, for a text that stops being a secret when the contest ends. Twelve symbols can still
 * be read out across a table, which sixteen cannot comfortably be.
 *
 * ── What is derived from it ──
 *   master  = PBKDF2-HMAC-SHA-256(code, salt "mild-editor/collab/v1", 600,000 rounds, 256 bits)
 *   room id = HKDF-SHA-256(master, info "room id")      128 bits, as 32 hex digits
 *   key     = HKDF-SHA-256(master, info "aes-256-gcm")  256 bits, never leaves WebCrypto
 * The relay is given the room id and nothing else. The id and the key are separate outputs
 * of a one-way function, so the id says nothing about the key; and because the id also sits
 * behind the slow step, it is no shortcut for guessing the code either — it travels in the
 * clear, in the URL of the connection.
 *
 * ── On the wire ──
 * A peer connects to `ws://<address>/room/<room id>`. One that already has the document —
 * whoever opened the room, or a member coming back after a lost connection — adds `?open`,
 * which creates the room if it is not there. A newcomer does not, and can only join a room
 * that exists: with a wrong code it is told "no such room". A room lasts while anyone is in
 * it; one that everybody left is gone, and its code with it.
 * Every message is one binary WebSocket frame:
 *
 *   byte 0        1, the version of this layout
 *   bytes 1..12   the nonce, 96 random bits per frame
 *   the rest      AES-256-GCM(key, nonce, plaintext), its 128-bit tag included;
 *                 the version and the room id are authenticated with it
 *
 *   plaintext     one byte saying what the body is (`MESSAGE`), then the body
 *     hello       a y-protocols sync step 1 from a peer that has just connected. Answered
 *                 with what it is missing and, unlike a plain step 1, with the answerer's own
 *                 step 1 — there is no server holding the document, so this is how the two
 *                 sides learn of each other's edits made while apart.
 *     sync        a y-protocols sync message (step 1, step 2 or an update)
 *     awareness   a y-protocols awareness update: who is here, their name, colour and cursor
 *     query       asks everyone to send their awareness again
 *     bye         the relay itself is about to stop — it ran inside the sender's app, which
 *                 is closing the room — so there is nothing to reconnect to; the body is empty
 *
 * ── What the relay can and cannot see ──
 * It sees the room id, who is connected to it from which address, and the size and timing
 * of the frames. It cannot read or forge a frame, and it never sees the code. It can drop,
 * delay, repeat or reorder frames; repeating and reordering change nothing (document updates
 * are idempotent and commute, awareness carries its own clock), so the worst a relay can do
 * is not relay.
 */

// ── The join code ──

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const JOIN_CODE_LENGTH = 12;
const GROUP = 4;

/** A new code. The bytes come from the system's generator; 256 is a multiple of 32, so taking five bits of each is unbiased. */
export const generateJoinCode = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(JOIN_CODE_LENGTH)), (byte) => ALPHABET[byte & 31]).join("");

/** The code as it is derived from: twelve symbols, upper case. Null when what was typed cannot be a code. */
export const normalizeJoinCode = (typed: string): string | null => {
  const code = typed.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return code.length === JOIN_CODE_LENGTH && [...code].every((symbol) => ALPHABET.includes(symbol)) ? code : null;
};

/** The code as it is shown and copied: `K7QM-2XWP-9HDT`. */
export const formatJoinCode = (code: string) => code.match(new RegExp(`.{1,${GROUP}}`, "g"))?.join("-") ?? code;

// ── The address ──

export const DEFAULT_RELAY_PORT = 10044;

/**
 * What was typed for an address as the URL the socket opens, without a trailing slash:
 * `192.168.0.7`, `host:10044`, `ws://…` and `wss://…` are all fine, and `http(s)://` is read
 * as the WebSocket scheme it corresponds to. A bare host gets the default port; a `wss://`
 * address keeps the port its scheme implies, since that one is behind a proxy. A path stays,
 * for a relay served under one. Null when it is not an address.
 */
export const normalizeRelayAddress = (typed: string): string | null => {
  const text = typed.trim();
  if (!text || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text.replace(/^http/i, "ws") : `ws://${text}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { return null; }
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || !url.hostname || url.username || url.password) return null;
  const port = url.port || (url.protocol === "ws:" && !/^ws:\/\/[^/]+:\d+/i.test(withScheme) ? String(DEFAULT_RELAY_PORT) : "");
  return `${url.protocol}//${url.hostname}${port ? `:${port}` : ""}${url.pathname.replace(/\/+$/, "")}`;
};

/** The URL of a room on a relay. `open` creates the room if it is not there; without it only an existing room is joined. */
export const roomUrl = (address: string, roomId: string, open: boolean) => `${address}/room/${roomId}${open ? "?open" : ""}`;

/**
 * Several addresses of one relay, separated by commas: a room opened on a teammate's
 * computer is reached at one address from the same network, at another through a VPN and
 * at a third from outside, and whoever joins cannot be asked to know which is theirs. Null
 * when any of them is not an address.
 */
export const normalizeRelayAddresses = (typed: string): string[] | null => {
  const addresses = typed.split(",").map((part) => part.trim()).filter(Boolean).map(normalizeRelayAddress);
  return addresses.length && addresses.every((address): address is string => address !== null) ? [...new Set(addresses)] : null;
};

/** An address as it is shown and sent: the scheme and the port are left off where they are the plain ones. */
export const shortAddress = (address: string) => address.replace(/^ws:\/\//, "").replace(new RegExp(`^([^/]+):${DEFAULT_RELAY_PORT}$`), "$1");

/**
 * Every way into a room as one line to send a teammate — the invitation, and the only
 * thing a teammate is given or types: `192.168.0.7,211.36.140.7#K7QM-2XWP-9HDT`.
 */
export const formatInvite = (addresses: string[], code: string) => `${addresses.map(shortAddress).join(",")}#${formatJoinCode(code)}`;

/**
 * Takes an invitation apart again, wherever it was pasted. Either half may be missing: the
 * addresses alone, or a code alone, are returned as what they are.
 */
export const parseInvite = (pasted: string): { address?: string; code?: string } => {
  const text = pasted.trim();
  const shown = (addresses: string[]) => addresses.map(shortAddress).join(",");
  const split = /^(.*?)[#\s]+([^#\s]+(?:[\s-]+[^#\s]+)*)$/.exec(text);
  if (split) {
    const addresses = normalizeRelayAddresses(split[1]);
    const code = normalizeJoinCode(split[2]);
    if (addresses && code) return { address: shown(addresses), code };
  }
  const code = normalizeJoinCode(text);
  if (code) return { code };
  const addresses = normalizeRelayAddresses(text);
  return addresses ? { address: shown(addresses) } : {};
};

// ── Derivation ──

const KDF_SALT = "mild-editor/collab/v1";
export const KDF_ROUNDS = 600_000;

const utf8 = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export type Room = { roomId: string; key: CryptoKey };

/**
 * The room a join code leads to. Takes a few hundred milliseconds, on purpose (see above).
 * `rounds` is only ever passed by the check script, which cannot wait that long forty times.
 */
export const deriveRoom = async (code: string, rounds = KDF_ROUNDS): Promise<Room> => {
  const password = await crypto.subtle.importKey("raw", utf8(code), "PBKDF2", false, ["deriveBits"]);
  const master = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: utf8(KDF_SALT), iterations: rounds }, password, 256);
  const expand = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveBits", "deriveKey"]);
  const part = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(info) });
  const roomId = hex(new Uint8Array(await crypto.subtle.deriveBits(part("room id"), expand, 128)));
  const key = await crypto.subtle.deriveKey(part("aes-256-gcm"), expand, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { roomId, key };
};

// ── Frames ──

export const FRAME_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** What a frame's body is; the first byte of the plaintext. */
export const MESSAGE = { hello: 0, sync: 1, awareness: 2, query: 3, bye: 4 } as const;
export type MessageKind = (typeof MESSAGE)[keyof typeof MESSAGE];
const KINDS = new Set<number>(Object.values(MESSAGE));

export type Message = { kind: MessageKind; body: Uint8Array };

const associatedData = (roomId: string) => utf8(`mild-collab/${FRAME_VERSION}/${roomId}`);

/** One message as the frame that goes to the relay. */
export const seal = async (room: Room, kind: MessageKind, body: Uint8Array = new Uint8Array(0)): Promise<Uint8Array<ArrayBuffer>> => {
  const plaintext = new Uint8Array(1 + body.length);
  plaintext[0] = kind;
  plaintext.set(body, 1);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: associatedData(room.roomId) }, room.key, plaintext));
  const frame = new Uint8Array(1 + NONCE_BYTES + sealed.length);
  frame[0] = FRAME_VERSION;
  frame.set(nonce, 1);
  frame.set(sealed, 1 + NONCE_BYTES);
  return frame;
};

/**
 * The message in a frame, or null for anything that is not one of this room's: another
 * version, a frame cut short, one sealed with another key or for another room, or one that
 * was altered on the way. Never throws — a frame is whatever the network delivered.
 */
export const unseal = async (room: Room, frame: Uint8Array): Promise<Message | null> => {
  if (frame.length < 1 + NONCE_BYTES + TAG_BYTES + 1 || frame[0] !== FRAME_VERSION) return null;
  try {
    // Copies, so the views handed to WebCrypto are over buffers of exactly their own bytes.
    const nonce = frame.slice(1, 1 + NONCE_BYTES);
    const sealed = frame.slice(1 + NONCE_BYTES);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: associatedData(room.roomId) }, room.key, sealed));
    const kind = plaintext[0];
    return KINDS.has(kind) ? { kind: kind as MessageKind, body: plaintext.subarray(1) } : null;
  } catch {
    return null;
  }
};

// ── The folder ──

/**
 * A room shares a folder: every source file under it, with its folders. In the document
 * each file is a map under a random id — `path` (relative to the shared folder, forward
 * slashes), `text` (the code, a Y.Text), and three JSON strings that are replaced whole:
 * `meta`, `tests` and `judge`. Folders that hold no file are listed apart, by path.
 *
 * Everything in there is a teammate's text that ends up as a path or a field in this
 * user's workspace, so nothing is taken as it comes: the functions below say what is
 * acceptable, and what is not is left out.
 */

const SOURCE = /\.(cpp|cc|cxx|py)$/i;

/**
 * A path from the room as one this workspace can take: relative, no drive, no `..`, no
 * character a file name cannot have, at most eight folders deep — and, for a file, a source
 * file. Null for anything else; a path is never repaired, since two members repairing it
 * differently would no longer agree on where the file is.
 */
export const safePath = (path: unknown, file: boolean): string | null => {
  if (typeof path !== "string" || !path || path.length > 400) return null;
  const parts = path.split("/");
  if (parts.length > 9 || parts.some((part) => !part || part !== part.trim() || part.length > 120 || /^\.+$/.test(part) || /[<>:"|?*\\\u0000-\u001f]/.test(part))) return null;
  return !file || SOURCE.test(parts[parts.length - 1]) ? path : null;
};

/** The name a joiner's copy of the shared folder gets; whatever the room calls it, it is one plain folder name. */
export const safeFolderName = (name: unknown) =>
  (typeof name === "string" ? name : "").replace(/[<>:"|?*\\/\u0000-\u001f]/g, "").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 60) || "shared";

const SOURCES = ["atcoder", "codeforces", "doj", "other"] as const;
const record = (json: unknown): Record<string, unknown> => {
  try { const parsed: unknown = JSON.parse(typeof json === "string" ? json : ""); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
};
const line = (value: unknown, limit: number) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
const webAddress = (value: unknown) => { const url = line(value, 500); return /^https?:\/\/\S+$/i.test(url) ? url : undefined; };

/** What a file is about: which problem it solves, for Submit and the verdict poll. */
export type FileMeta = { title: string; source?: (typeof SOURCES)[number]; sourceUrl?: string; limits?: { timeLimitMs?: number; memoryLimitMb?: number } };

export const fileMeta = (json: unknown): FileMeta => {
  const raw = record(json);
  const limit = (value: unknown, most: number) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(most, Math.round(value)) : undefined;
  const limits = raw.limits && typeof raw.limits === "object" ? raw.limits as Record<string, unknown> : {};
  const timeLimitMs = limit(limits.timeLimitMs, 600_000);
  const memoryLimitMb = limit(limits.memoryLimitMb, 65_536);
  return { title: line(raw.title, 200), source: SOURCES.find((source) => source === raw.source), sourceUrl: webAddress(raw.sourceUrl), limits: timeLimitMs || memoryLimitMb ? { timeLimitMs, memoryLimitMb } : undefined };
};

export type FileTest = { name: string; input: string; expected: string };

/** A file's test cases; at most a hundred, none larger than a megabyte a side. */
export const fileTests = (json: unknown): FileTest[] => {
  let raw: unknown = [];
  try { raw = JSON.parse(typeof json === "string" ? json : ""); } catch { /* not JSON: no tests */ }
  const field = (value: unknown) => typeof value === "string" ? value.slice(0, 1_000_000) : "";
  return (Array.isArray(raw) ? raw : []).slice(0, 100).filter((test): test is Record<string, unknown> => Boolean(test) && typeof test === "object")
    .map((test, index) => ({ name: line(test.name, 80) || `test ${index + 1}`, input: field(test.input), expected: field(test.expected) }));
};

/** Where a problem stands with its judge: the verdict shown, the submission it is of, and every verdict seen. */
export type FileJudge = { status?: string; url?: string; submissions?: Array<{ status: string; url?: string; at: number }> };

export const fileJudge = (json: unknown): FileJudge => {
  const raw = record(json);
  const submissions = (Array.isArray(raw.submissions) ? raw.submissions : []).slice(-200)
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({ status: line(item.status, 40), url: webAddress(item.url), at: typeof item.at === "number" && Number.isFinite(item.at) && item.at > 0 ? Math.round(item.at) : 0 }))
    .filter((item) => item.status);
  return { status: line(raw.status, 40) || undefined, url: webAddress(raw.url), submissions: submissions.length ? submissions : undefined };
};

/** Accepted, as the editor's own badge reads it (src/workbench.ts): AC, OK, Accepted, or a full score. */
const accepted = (status: string | undefined) => {
  const text = (status || "").trim();
  const score = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(text.replace(/^PAC\s*/i, ""));
  return /^(AC|OK|ACCEPTED)\b/i.test(text) || Boolean(score && Number(score[2]) > 0 && Number(score[1]) >= Number(score[2]));
};

/**
 * What a team knows of a problem, from what two of its members know: every submission
 * either has seen, and for the verdict an accepted one before any other, then the newer.
 * It does not matter which of the two is which, nor how often they are merged — which is
 * what lets every member do this on their own and still end up with the same answer.
 */
export const mergeJudge = (left: FileJudge, right: FileJudge): FileJudge => {
  const all = new Map<string, { status: string; url?: string; at: number }>();
  for (const item of [...left.submissions ?? [], ...right.submissions ?? []]) {
    const key = item.url || `${item.at}`;
    const known = all.get(key);
    // One submission seen twice is the same submission further along: judged beats waiting.
    if (!known || (accepted(item.status) && !accepted(known.status)) || (accepted(item.status) === accepted(known.status) && item.status > known.status)) all.set(key, item);
  }
  const submissions = [...all.values()].sort((a, b) => a.at - b.at || a.status.localeCompare(b.status) || (a.url || "").localeCompare(b.url || ""));
  const when = (judge: FileJudge) => submissions.find((item) => item.url && item.url === judge.url)?.at ?? 0;
  const rank = (judge: FileJudge): [number, number, string, string] => [judge.status ? accepted(judge.status) ? 2 : 1 : 0, when(judge), judge.status || "", judge.url || ""];
  const [a, b] = [rank(left), rank(right)];
  const order = a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]) || a[3].localeCompare(b[3]);
  const best = order >= 0 ? left : right;
  return { status: best.status, url: best.url, submissions: submissions.length ? submissions : undefined };
};

// ── Reconnecting ──

/**
 * How long to wait before reconnection attempt `attempt` (0 for the first): half a second,
 * doubling up to thirty, with up to a quarter taken off at random so the peers of a room
 * that lost its relay do not all come back in the same instant. `random` is in [0, 1).
 */
export const reconnectDelay = (attempt: number, random = Math.random()) =>
  Math.round(Math.min(30_000, 500 * 2 ** Math.min(attempt, 16)) * (1 - random / 4));

// ── People ──

/** Cursor colours, chosen to stay apart from each other and readable on every theme. */
export const PEER_COLORS = ["#e5a04b", "#5fb3d9", "#c88be0", "#7fc47f", "#ef7f8f", "#5ccfc0", "#d9c05f", "#8f9cf0"] as const;

/** The first colour nobody in the room has yet; once all are taken they are shared. */
export const pickPeerColor = (taken: Iterable<string>, fallback: number): string => {
  const used = new Set(taken);
  return PEER_COLORS.find((color) => !used.has(color)) ?? PEER_COLORS[Math.abs(fallback) % PEER_COLORS.length];
};

/** A name as it is shown beside a cursor: one line, no longer than a cursor label can be. */
export const peerName = (typed: string, fallback: string) => typed.replace(/\s+/g, " ").trim().slice(0, 24) || fallback;
