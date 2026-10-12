/**
 * A quick check of the shared-room protocol — the join code, what is derived from it, and
 * the frames — run with `node --experimental-strip-types src/collab/protocol.check.ts`.
 */
import { DEFAULT_RELAY_PORT, deriveRoom, formatInvite, formatJoinCode, FRAME_VERSION, generateJoinCode, JOIN_CODE_LENGTH, KDF_ROUNDS, MESSAGE, normalizeJoinCode, normalizeRelayAddress, parseInvite, PEER_COLORS, peerName, pickPeerColor, reconnectDelay, roomFile, roomUrl, seal, unseal } from "./protocol.ts";

let failed = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed += 1; console.log("FAIL", label, "\n  got ", got, "\n  want", want); }
  else console.log("ok   ", label, "->", JSON.stringify(got));
};
const text = (bytes: Uint8Array | undefined) => bytes ? new TextDecoder().decode(bytes) : null;
const bytes = (value: string) => new TextEncoder().encode(value);

// --- The join code ------------------------------------------------------------------------
const codes = Array.from({ length: 200 }, generateJoinCode);
eq("a code is twelve symbols", codes.every((code) => code.length === JOIN_CODE_LENGTH), true);
eq("of the alphabet without I, L, O and U", codes.every((code) => /^[0-9A-HJKMNP-TV-Z]+$/.test(code)), true);
eq("and no two are alike", new Set(codes).size, codes.length);
eq("every symbol turns up", new Set(codes.join("")).size, 32);
eq("a code is its own normal form", codes.every((code) => normalizeJoinCode(code) === code), true);
eq("shown in groups of four", formatJoinCode("K7QM2XWP9HDT"), "K7QM-2XWP-9HDT");
eq("typed as shown", normalizeJoinCode("K7QM-2XWP-9HDT"), "K7QM2XWP9HDT");
eq("in lower case, with spaces", normalizeJoinCode(" k7qm 2xwp 9hdt "), "K7QM2XWP9HDT");
eq("O, I and L are the digits they look like", normalizeJoinCode("OIL0-1111-oooo"), "011011110000");
eq("too short", normalizeJoinCode("K7QM-2XWP"), null);
eq("too long", normalizeJoinCode("K7QM-2XWP-9HDT-AAAA"), null);
eq("U is no symbol", normalizeJoinCode("K7QM-2XWP-9HDU"), null);
eq("nothing typed", normalizeJoinCode(""), null);

// --- The address --------------------------------------------------------------------------
eq("a bare address gets the port", normalizeRelayAddress("192.168.0.7"), `ws://192.168.0.7:${DEFAULT_RELAY_PORT}`);
eq("a port is kept", normalizeRelayAddress(" 192.168.0.7:4000 "), "ws://192.168.0.7:4000");
eq("a host name", normalizeRelayAddress("relay.example.org"), `ws://relay.example.org:${DEFAULT_RELAY_PORT}`);
eq("ws:// as typed", normalizeRelayAddress("ws://10.0.0.2:10044/"), "ws://10.0.0.2:10044");
eq("ws:// without a port gets the relay's", normalizeRelayAddress("ws://10.0.0.2"), `ws://10.0.0.2:${DEFAULT_RELAY_PORT}`);
eq("ws:// on port 80, said outright, stays there", normalizeRelayAddress("ws://10.0.0.2:80"), "ws://10.0.0.2");
eq("wss:// keeps the port of its scheme", normalizeRelayAddress("wss://relay.example.org"), "wss://relay.example.org");
eq("a relay under a path", normalizeRelayAddress("wss://example.org/relay/"), "wss://example.org/relay");
eq("https:// is wss://", normalizeRelayAddress("https://relay.example.org"), "wss://relay.example.org");
eq("http:// is ws://", normalizeRelayAddress("http://localhost:10044"), "ws://localhost:10044");
eq("IPv6", normalizeRelayAddress("[::1]:10044"), "ws://[::1]:10044");
eq("no credentials in an address", normalizeRelayAddress("ws://user:secret@host"), null);
eq("not an address", normalizeRelayAddress("two words"), null);
eq("another scheme", normalizeRelayAddress("ftp://host"), null);
eq("nothing typed", normalizeRelayAddress("  "), null);
eq("whoever has the document may open the room", roomUrl("ws://h:1", "abc", true), "ws://h:1/room/abc?open");
eq("a newcomer only joins it", roomUrl("wss://h/relay", "abc", false), "wss://h/relay/room/abc");

// --- The invitation -----------------------------------------------------------------------
eq("an invitation", formatInvite("ws://192.168.0.7:10044", "K7QM2XWP9HDT"), "ws://192.168.0.7:10044#K7QM-2XWP-9HDT");
eq("and back", parseInvite("ws://192.168.0.7:10044#K7QM-2XWP-9HDT"), { address: "ws://192.168.0.7:10044", code: "K7QM2XWP9HDT" });
eq("pasted with a space instead", parseInvite(" 192.168.0.7  k7qm 2xwp 9hdt\n"), { address: `ws://192.168.0.7:${DEFAULT_RELAY_PORT}`, code: "K7QM2XWP9HDT" });
eq("only a code", parseInvite("K7QM-2XWP-9HDT"), { code: "K7QM2XWP9HDT" });
eq("only an address", parseInvite("192.168.0.7:10044"), { address: "ws://192.168.0.7:10044" });
eq("neither", parseInvite("hello there, friend"), {});

// --- Derivation ---------------------------------------------------------------------------
// The real cost is paid once, to show what it is; the rest of the checks use a token amount.
const started = performance.now();
const real = await deriveRoom("K7QM2XWP9HDT");
const elapsed = Math.round(performance.now() - started);
console.log(`       (${KDF_ROUNDS} rounds took ${elapsed} ms here)`);
eq("the room id is 32 hex digits", /^[0-9a-f]{32}$/.test(real.roomId), true);
// Pinned: two builds that disagree here cannot find each other's rooms.
eq("the derivation is the documented one", real.roomId, "c62402241622de101c000a2200191cd6");
eq("the key stays inside WebCrypto", [real.key.extractable, real.key.algorithm.name, real.key.usages.slice().sort()], [false, "AES-GCM", ["decrypt", "encrypt"]]);
eq("the same code is the same room", (await deriveRoom("K7QM2XWP9HDT")).roomId, real.roomId);

const QUICK = 1000;
const room = await deriveRoom("K7QM2XWP9HDT", QUICK);
const again = await deriveRoom("K7QM2XWP9HDT", QUICK);
const other = await deriveRoom("K7QM2XWP9HDV", QUICK);
eq("the rounds are part of the derivation", room.roomId === real.roomId, false);
eq("another code is another room", other.roomId === room.roomId, false);
eq("the room id is not the code, nor made of it", [room.roomId.toUpperCase().includes("K7QM"), room.roomId.length], [false, 32]);

// --- Frames -------------------------------------------------------------------------------
const frame = await seal(room, MESSAGE.sync, bytes("int main() { return 0; }"));
eq("a frame starts with the version", frame[0], FRAME_VERSION);
eq("and costs 30 bytes over its body", frame.length, 1 + 12 + 1 + 24 + 16);
eq("the same key opens it", await unseal(again, frame).then((message) => message && [message.kind, text(message.body)]), [MESSAGE.sync, "int main() { return 0; }"]);
eq("nothing of the body is readable in it", text(frame)?.includes("main"), false);
eq("another code's key does not", await unseal(other, frame), null);
eq("nor the right key under another room id", await unseal({ roomId: other.roomId, key: room.key }, frame), null);
const twin = await seal(room, MESSAGE.sync, bytes("int main() { return 0; }"));
eq("the same message twice is two different frames", Buffer.from(frame).equals(Buffer.from(twin)), false);

const flipped = (index: number) => { const copy = frame.slice(); copy[index] ^= 1; return copy; };
eq("a changed version", await unseal(room, flipped(0)), null);
eq("a changed nonce", await unseal(room, flipped(5)), null);
eq("a changed body", await unseal(room, flipped(20)), null);
eq("a changed tag", await unseal(room, flipped(frame.length - 1)), null);
eq("a frame cut short", await unseal(room, frame.subarray(0, frame.length - 1)), null);
eq("a frame of nothing", await unseal(room, new Uint8Array(0)), null);
eq("noise", await unseal(room, crypto.getRandomValues(new Uint8Array(64))), null);

const empty = await seal(room, MESSAGE.bye);
eq("a message without a body", await unseal(room, empty).then((message) => message && [message.kind, message.body.length]), [MESSAGE.bye, 0]);
eq("each kind comes back as itself", await Promise.all(Object.values(MESSAGE).map(async (kind) => (await unseal(room, await seal(room, kind, bytes("x"))))?.kind)), Object.values(MESSAGE));
// A kind this build does not know is dropped, not handed on as something else.
const unknown = await seal(room, 99 as never, bytes("x"));
eq("an unknown kind", await unseal(room, unknown), null);
const large = crypto.getRandomValues(new Uint8Array(60_000));
eq("a large body survives", await unseal(room, await seal(room, MESSAGE.sync, large)).then((message) => message && Buffer.from(message.body).equals(Buffer.from(large))), true);
// A view into a larger buffer is how a frame arrives when it was cut out of one.
const padded = new Uint8Array(frame.length + 8);
padded.set(frame, 4);
eq("a frame that is a view into a larger buffer", await unseal(room, padded.subarray(4, 4 + frame.length)).then((message) => text(message?.body)), "int main() { return 0; }");

// --- The file a joiner takes ---------------------------------------------------------------
const told = (file: unknown) => roomFile(JSON.stringify(file));
eq("a file as the opener has it", told({ filename: "AtCoder/abc400/A_Sum.cpp", language: "cpp", title: "A - Sum", source: "atcoder", sourceUrl: "https://atcoder.jp/contests/abc400/tasks/abc400_a", limits: { timeLimitMs: 2000, memoryLimitMb: 1024 } }),
  { filename: "AtCoder/abc400/A_Sum.cpp", language: "cpp", title: "A - Sum", source: "atcoder", sourceUrl: "https://atcoder.jp/contests/abc400/tasks/abc400_a", limits: { timeLimitMs: 2000, memoryLimitMb: 1024 } });
eq("a bare local file", told({ filename: "scratch.py", language: "python", title: "scratch" }), { filename: "scratch.py", language: "python", title: "scratch" });
eq("a name cannot climb out of the workspace", told({ filename: "../../secrets/../x.cpp", language: "cpp" }).filename, "secrets/x.cpp");
eq("nor be absolute", [told({ filename: "/etc/passwd.cpp" }).filename, told({ filename: "C:\\Users\\me\\a.cpp" }).filename], ["etc/passwd.cpp", "C/Users/me/a.cpp"]);
eq("backslashes are folders too", told({ filename: "a\\b\\c.cpp" }).filename, "a/b/c.cpp");
eq("the extension agrees with the language", [told({ filename: "a.py", language: "cpp" }).filename, told({ filename: "a.cc", language: "cpp" }).filename, told({ filename: "a.exe", language: "python" }).filename], ["a.cpp", "a.cc", "a.exe.py"]);
eq("an unknown language is C++", told({ filename: "a.cpp", language: "rust" }).language, "cpp");
eq("only a web address is a source URL", [told({ sourceUrl: "javascript:alert(1)" }).sourceUrl, told({ sourceUrl: "https://codeforces.com/contest/1/problem/A" }).sourceUrl], [undefined, "https://codeforces.com/contest/1/problem/A"]);
eq("an unknown judge is no judge", told({ source: "elsewhere" }).source, undefined);
eq("limits are positive numbers or nothing", [told({ limits: { timeLimitMs: -5, memoryLimitMb: "256" } }).limits, told({ limits: { timeLimitMs: 1500.4 } }).limits], [undefined, { timeLimitMs: 1500 }]);
eq("nothing readable is still a file", [roomFile(undefined), roomFile("not json"), roomFile("[1]")].map((file) => file.filename + "|" + file.language + "|" + file.title), ["shared.cpp|cpp|shared", "shared.cpp|cpp|shared", "shared.cpp|cpp|shared"]);

// --- Reconnecting -------------------------------------------------------------------------
eq("the waits double", [0, 1, 2, 3, 4].map((attempt) => reconnectDelay(attempt, 0)), [500, 1000, 2000, 4000, 8000]);
eq("up to thirty seconds", [6, 7, 20, 1000].map((attempt) => reconnectDelay(attempt, 0)), [30000, 30000, 30000, 30000]);
eq("less a random quarter at most", [reconnectDelay(2, 0.999) >= 1500, reconnectDelay(2, 0.999) < 2000], [true, true]);

// --- People -------------------------------------------------------------------------------
eq("the first colour is free", pickPeerColor([], 7), PEER_COLORS[0]);
eq("a taken colour is passed over", pickPeerColor([PEER_COLORS[0], PEER_COLORS[1]], 7), PEER_COLORS[2]);
eq("with all taken they are shared", pickPeerColor(PEER_COLORS, 10), PEER_COLORS[2]);
eq("a name is one short line", peerName("  Ada \n Lovelace, countess of somewhere far  ", "x"), "Ada Lovelace, countess o");
eq("no name falls back", peerName("   ", "Player 7"), "Player 7");

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log("\nall passed");
