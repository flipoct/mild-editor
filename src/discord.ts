/**
 * What Discord shows on the user's profile while the editor is open (src-tauri/src/discord.rs
 * passes it on): the problem in front, its language and version, a contest's clock, the room.
 * Built here as plain data so `discord.check.ts` can read it without Discord.
 */

/** The Discord application the status is shown as ("Playing Mild Editor"). */
export const DISCORD_APPLICATION_ID = "";

/** The images, from this repository at the commit that added them (assets/discord). */
const IMAGES = "https://raw.githubusercontent.com/flipoct/mild-editor/84e1a86f3e33a9a6d184a39aed0400eeaedd34c3/assets/discord";
export const DISCORD_IMAGES = { mild: `${IMAGES}/mild.png`, cpp: `${IMAGES}/cpp.png`, python: `${IMAGES}/python.png` };

export const PROJECT_URL = "https://github.com/flipoct/mild-editor";

export type PresenceInput = {
  locale: "en" | "ko";
  version: string;
  /** The file in front, if any. */
  file: { title: string; filename: string; language: "cpp" | "python"; source?: string } | null;
  /** What it runs with, as shown: `Python 3.14`, `C++20`; empty for just the language. */
  toolchain: string;
  /** When the file came to the front, or the editor opened. */
  since: number;
  contest: { endsAt: number; solved: number; total: number } | null;
  /** Teammates in a shared room, not counting this user. */
  teammates: number;
  showFile: boolean;
  showContest: boolean;
};

const JUDGES: Record<string, string> = { atcoder: "AtCoder", codeforces: "Codeforces", doj: "DOJ" };

const WORDS = {
  en: {
    solving: "Solving a problem", idle: "Looking around the workspace", solved: (count: number, total: number) => `${count}/${total} solved`,
    team: (count: number) => count === 1 ? "with a teammate" : `with ${count} teammates`, contest: "In a contest",
  },
  ko: {
    solving: "문제 푸는 중", idle: "작업 공간을 둘러보는 중", solved: (count: number, total: number) => `${count}/${total} 해결`,
    team: (count: number) => `팀원 ${count}명과 함께`, contest: "대회 중",
  },
};

/** Discord takes 2 to 128 characters in a line of text: shorter is padded, longer is cut with an ellipsis. */
export const fitText = (text: string, most = 128) => {
  const clean = text.replace(/\s+/g, " ").trim();
  const cut = [...clean].length > most ? `${[...clean].slice(0, most - 1).join("")}…` : clean;
  return [...cut].length >= 2 ? cut : `${cut}  `.slice(0, 2);
};

const basename = (filename: string) => filename.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || filename;

/** The activity for `input`, in the shape Discord's SET_ACTIVITY takes. */
export const discordActivity = (input: PresenceInput) => {
  const words = WORDS[input.locale];
  const { file, contest } = input;
  const inContest = Boolean(contest && input.showContest && contest.endsAt > Date.now());
  const judge = file?.source ? JUDGES[file.source] : undefined;
  const problem = file ? (file.title.trim() || basename(file.filename)) : "";
  const details = !file ? words.idle : input.showFile ? (judge ? `${judge} · ${problem}` : problem) : words.solving;
  const language = file?.language === "python" ? "Python" : file ? "C++" : "";
  const parts = [
    file ? input.toolchain.trim() || language : "",
    inContest && contest ? (contest.total ? words.solved(contest.solved, contest.total) : words.contest) : "",
    input.teammates > 0 ? words.team(input.teammates) : "",
  ].filter(Boolean);
  const small = file?.language === "python" ? DISCORD_IMAGES.python : file ? DISCORD_IMAGES.cpp : undefined;
  return {
    // "Competing in" while a contest's clock runs, "Playing" otherwise.
    type: inContest ? 5 : 0,
    details: fitText(details),
    ...(parts.length ? { state: fitText(parts.join(" · ")) } : {}),
    // A contest counts down to its end; anything else counts up from when it began.
    timestamps: inContest && contest ? { end: Math.floor(contest.endsAt / 1000) } : { start: Math.floor(input.since / 1000) },
    assets: {
      large_image: DISCORD_IMAGES.mild,
      large_text: fitText(`Mild Editor ${input.version}`),
      ...(small ? { small_image: small, small_text: fitText(parts[0] || language) } : {}),
    },
    buttons: [{ label: "Mild Editor", url: PROJECT_URL }],
  };
};
