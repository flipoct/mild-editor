/**
 * What Discord shows on the user's profile while the editor is open (src-tauri/src/discord.rs
 * passes it on): the problem in front, its language and version, a contest's clock, the room —
 * each line written from a template the user can change, each part one they can hide.
 * Built here as plain data so `discord.check.ts` can read it without Discord.
 */

/** The Discord application the status is shown as ("Playing Mild Editor"). */
export const DISCORD_APPLICATION_ID = "";

/** The images, from this repository at the commit that added them (assets/discord). */
const IMAGES = "https://raw.githubusercontent.com/flipoct/mild-editor/84e1a86f3e33a9a6d184a39aed0400eeaedd34c3/assets/discord";
export const DISCORD_IMAGES = { mild: `${IMAGES}/mild.png`, cpp: `${IMAGES}/cpp.png`, python: `${IMAGES}/python.png` };

export const PROJECT_URL = "https://github.com/flipoct/mild-editor";

/** The lines as they are unless changed in Settings → Discord. */
export const DEFAULT_DETAILS = "{judge} · {problem}";
export const DEFAULT_STATE = "{language} · {contest} · {team}";

/** What a template may say, with what each stands for. */
export const PLACEHOLDERS = ["problem", "file", "judge", "language", "contest", "solved", "total", "team"] as const;

export type PresenceOptions = {
  /** Templates of the two lines; empty is the default. */
  details: string;
  state: string;
  /** What is shown while no file is open; empty is the default. */
  idle: string;
  showFile: boolean;
  showContest: boolean;
  /** The clock: time spent on the problem, or a contest's time left. */
  showTime: boolean;
  /** The language's mark in the corner of the big picture. */
  showLanguage: boolean;
  /** The button others see; none hides it. */
  button: { label: string; url: string } | null;
  /** The big picture: an https address, or empty for the editor's mark. */
  image: string;
};

export const DEFAULT_PRESENCE_OPTIONS: PresenceOptions = {
  details: "", state: "", idle: "", showFile: true, showContest: true, showTime: true, showLanguage: true,
  button: { label: "Mild Editor", url: PROJECT_URL }, image: "",
};

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
  options: PresenceOptions;
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

/**
 * `template` with its placeholders filled. A part left empty takes its `·` with it, so
 * "{judge} · {problem}" reads "A - Sum" for a file of no judge, not "· A - Sum".
 */
export const fillTemplate = (template: string, values: Partial<Record<(typeof PLACEHOLDERS)[number], string>>) => {
  const filled = template.replace(/\{(\w+)\}/g, (whole, name: string) => name in values ? values[name as keyof typeof values] ?? "" : whole);
  return filled.split("·").map((part) => part.trim()).filter(Boolean).join(" · ");
};

const basename = (filename: string) => filename.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || filename;

/** A button Discord takes: a short label and an http(s) address. */
const validButton = (button: PresenceOptions["button"]) => {
  if (!button?.label.trim()) return null;
  try {
    const url = new URL(button.url.trim());
    return /^https?:$/.test(url.protocol) && url.href.length <= 512 ? { label: [...button.label.trim()].slice(0, 32).join(""), url: url.href } : null;
  } catch { return null; }
};

/** The activity for `input`, in the shape Discord's SET_ACTIVITY takes. */
export const discordActivity = (input: PresenceInput) => {
  const words = WORDS[input.locale];
  const { file, contest, options } = input;
  const inContest = Boolean(contest && options.showContest && contest.endsAt > Date.now());
  const language = file?.language === "python" ? "Python" : file ? "C++" : "";
  const values = {
    problem: !file ? "" : options.showFile ? (file.title.trim() || basename(file.filename)) : words.solving,
    file: file && options.showFile ? basename(file.filename) : "",
    judge: file?.source && options.showFile ? JUDGES[file.source] ?? "" : "",
    language: file ? input.toolchain.trim() || language : "",
    contest: inContest && contest ? (contest.total ? words.solved(contest.solved, contest.total) : words.contest) : "",
    solved: inContest && contest ? String(contest.solved) : "",
    total: inContest && contest ? String(contest.total) : "",
    team: input.teammates > 0 ? words.team(input.teammates) : "",
  };
  const details = file ? fillTemplate(options.details.trim() || DEFAULT_DETAILS, values) || values.problem : options.idle.trim() || words.idle;
  const state = file ? fillTemplate(options.state.trim() || DEFAULT_STATE, values) : values.team;
  const small = options.showLanguage && file ? (file.language === "python" ? DISCORD_IMAGES.python : DISCORD_IMAGES.cpp) : undefined;
  const button = validButton(options.button);
  return {
    // "Competing in" while a contest's clock runs, "Playing" otherwise.
    type: inContest ? 5 : 0,
    details: fitText(details),
    ...(state ? { state: fitText(state) } : {}),
    // A contest counts down to its end; anything else counts up from when it began.
    ...(options.showTime ? { timestamps: inContest && contest ? { end: Math.floor(contest.endsAt / 1000) } : { start: Math.floor(input.since / 1000) } } : {}),
    assets: {
      large_image: /^https:\/\//.test(options.image.trim()) ? options.image.trim() : DISCORD_IMAGES.mild,
      large_text: fitText(`Mild Editor ${input.version}`),
      ...(small ? { small_image: small, small_text: fitText(values.language || language) } : {}),
    },
    ...(button ? { buttons: [button] } : {}),
  };
};
