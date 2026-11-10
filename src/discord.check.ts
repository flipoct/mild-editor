/**
 * A check of what Discord is told, run with `node --experimental-strip-types src/discord.check.ts`.
 */
import { DEFAULT_PRESENCE_OPTIONS, DISCORD_IMAGES, discordActivity, fillTemplate, fitText, PROJECT_URL, type PresenceInput } from "./discord.ts";

let failed = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed += 1; console.log("FAIL", label, "\n  got ", got, "\n  want", want); }
  else console.log("ok   ", label, "->", JSON.stringify(got).slice(0, 140));
};

const base: PresenceInput = {
  locale: "en", version: "1.20.0", toolchain: "Python 3.14", since: 1_700_000_000_000, contest: null, teammates: 0, options: DEFAULT_PRESENCE_OPTIONS,
  file: { title: "A - Takahashi's Snack", filename: "AtCoder/abc300/A.py", language: "python", source: "atcoder" },
};
const withOptions = (options: Partial<PresenceInput["options"]>, rest: Partial<PresenceInput> = {}) => discordActivity({ ...base, ...rest, options: { ...DEFAULT_PRESENCE_OPTIONS, ...options } });

const plain = discordActivity(base);
eq("the problem, with its judge", plain.details, "AtCoder · A - Takahashi's Snack");
eq("its language and version", plain.state, "Python 3.14");
eq("playing, counting up from when it came to the front", [plain.type, plain.timestamps], [0, { start: 1_700_000_000 }]);
eq("the app's mark, and the language's", [plain.assets.large_image, plain.assets.small_image, plain.assets.small_text], [DISCORD_IMAGES.mild, DISCORD_IMAGES.python, "Python 3.14"]);
eq("the version under the mark", plain.assets.large_text, "Mild Editor 1.20.0");
eq("one button, to the project", plain.buttons, [{ label: "Mild Editor", url: `${PROJECT_URL}` }]);

eq("the problem kept private", withOptions({ showFile: false }).details, "Solving a problem");

const contest = withOptions({}, { contest: { endsAt: Date.now() + 42 * 60_000, solved: 3, total: 7 }, teammates: 2, file: { ...base.file!, language: "cpp" }, toolchain: "C++20" });
eq("competing, counting down to the end", [contest.type, "end" in (contest.timestamps ?? {})], [5, true]);
eq("progress and the team", contest.state, "C++20 · 3/7 solved · with 2 teammates");
eq("the C++ mark", contest.assets.small_image, DISCORD_IMAGES.cpp);
eq("a contest that is over is not one", withOptions({}, { contest: { endsAt: Date.now() - 1000, solved: 7, total: 7 } }).type, 0);
eq("a contest kept private", withOptions({ showContest: false }, { contest: { endsAt: Date.now() + 60_000, solved: 1, total: 2 } }).state, "Python 3.14");

const idle = discordActivity({ ...base, file: null });
eq("nothing open", [idle.details, "state" in idle, "small_image" in idle.assets], ["Looking around the workspace", false, false]);
eq("nothing open, in the user's words", withOptions({ idle: "Thinking about life" }, { file: null }).details, "Thinking about life");

const korean = discordActivity({ ...base, locale: "ko", teammates: 1, options: { ...DEFAULT_PRESENCE_OPTIONS, showFile: false } });
eq("in Korean", [korean.details, korean.state], ["문제 푸는 중", "Python 3.14 · 팀원 1명과 함께"]);

// --- the user's own lines -----------------------------------------------------------------
eq("its placeholders filled", withOptions({ details: "Grinding {judge} {file}" }).details, "Grinding AtCoder A");
eq("an empty part takes its separator with it", fillTemplate("{judge} · {problem} · {team}", { judge: "", problem: "A - Sum", team: "" }), "A - Sum");
eq("an unknown placeholder stays as typed", fillTemplate("{nope} x", {}), "{nope} x");
eq("solved and total on their own", withOptions({ state: "{solved} of {total}" }, { contest: { endsAt: Date.now() + 60_000, solved: 2, total: 5 } }).state, "2 of 5");
eq("a template that comes out empty falls back to the problem", withOptions({ details: "{team}" }).details, "A - Takahashi's Snack");

// --- what may be hidden ---------------------------------------------------------------------
const bare = withOptions({ showTime: false, showLanguage: false, button: null });
eq("no clock, no language mark, no button", ["timestamps" in bare, "small_image" in bare.assets, "buttons" in bare], [false, false, false]);
eq("a button of their own", withOptions({ button: { label: "My blog", url: "https://example.org/blog" } }).buttons, [{ label: "My blog", url: "https://example.org/blog" }]);
eq("a button that is not an address is left out", "buttons" in withOptions({ button: { label: "x", url: "javascript:alert(1)" } }), false);
eq("a long label is cut to Discord's 32", withOptions({ button: { label: "x".repeat(50), url: "https://example.org" } }).buttons?.[0].label.length, 32);

// --- the picture ----------------------------------------------------------------------------
eq("their own picture, by address", withOptions({ image: "https://example.org/me.png" }).assets.large_image, "https://example.org/me.png");
eq("not an https address: the editor's mark", withOptions({ image: "data:image/png;base64,AAAA" }).assets.large_image, DISCORD_IMAGES.mild);

eq("a file without a title goes by its name", discordActivity({ ...base, file: { title: " ", filename: "x/Weird_Name.cpp", language: "cpp" }, toolchain: "" }).details, "Weird_Name");
eq("no toolchain known: the language", discordActivity({ ...base, toolchain: "" }).state, "Python");
eq("long text is cut", [...fitText("가".repeat(300))].length, 128);
eq("too short is padded", fitText("A").length, 2);

console.log(failed ? `\n${failed} failed` : "\nall passed");
if (failed) process.exit(1);
