/**
 * A check of what Discord is told, run with `node --experimental-strip-types src/discord.check.ts`.
 */
import { DISCORD_IMAGES, discordActivity, fitText, type PresenceInput } from "./discord.ts";

let failed = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed += 1; console.log("FAIL", label, "\n  got ", got, "\n  want", want); }
  else console.log("ok   ", label, "->", JSON.stringify(got).slice(0, 140));
};

const base: PresenceInput = {
  locale: "en", version: "1.20.0", toolchain: "Python 3.14", since: 1_700_000_000_000, contest: null, teammates: 0, showFile: true, showContest: true,
  file: { title: "A - Takahashi's Snack", filename: "AtCoder/abc300/A.py", language: "python", source: "atcoder" },
};

const plain = discordActivity(base);
eq("the problem, with its judge", plain.details, "AtCoder · A - Takahashi's Snack");
eq("its language and version", plain.state, "Python 3.14");
eq("playing, counting up from when it came to the front", [plain.type, plain.timestamps], [0, { start: 1_700_000_000 }]);
eq("the app's mark, and the language's", [plain.assets.large_image, plain.assets.small_image, plain.assets.small_text], [DISCORD_IMAGES.mild, DISCORD_IMAGES.python, "Python 3.14"]);
eq("the version under the mark", plain.assets.large_text, "Mild Editor 1.20.0");
eq("one button, to the project", plain.buttons.map((button) => button.label), ["Mild Editor"]);

const hidden = discordActivity({ ...base, showFile: false });
eq("the problem kept private", hidden.details, "Solving a problem");

const contest = discordActivity({ ...base, contest: { endsAt: Date.now() + 42 * 60_000, solved: 3, total: 7 }, teammates: 2, file: { ...base.file!, language: "cpp" }, toolchain: "C++20" });
eq("competing, counting down to the end", [contest.type, "end" in contest.timestamps], [5, true]);
eq("progress and the team", contest.state, "C++20 · 3/7 solved · with 2 teammates");
eq("the C++ mark", contest.assets.small_image, DISCORD_IMAGES.cpp);
eq("a contest that is over is not one", discordActivity({ ...base, contest: { endsAt: Date.now() - 1000, solved: 7, total: 7 } }).type, 0);
eq("a contest kept private", discordActivity({ ...base, showContest: false, contest: { endsAt: Date.now() + 60_000, solved: 1, total: 2 } }).state, "Python 3.14");

const idle = discordActivity({ ...base, file: null });
eq("nothing open", [idle.details, "state" in idle, "small_image" in idle.assets], ["Looking around the workspace", false, false]);

const korean = discordActivity({ ...base, locale: "ko", showFile: false, teammates: 1 });
eq("in Korean", [korean.details, korean.state], ["문제 푸는 중", "Python 3.14 · 팀원 1명과 함께"]);

eq("a file without a title goes by its name", discordActivity({ ...base, file: { title: " ", filename: "x/Weird_Name.cpp", language: "cpp" }, toolchain: "" }).details, "Weird_Name");
eq("no toolchain known: the language", discordActivity({ ...base, toolchain: "" }).state, "Python");
eq("long text is cut", [...fitText("가".repeat(300))].length, 128);
eq("too short is padded", fitText("A").length, 2);

console.log(failed ? `\n${failed} failed` : "\nall passed");
if (failed) process.exit(1);
