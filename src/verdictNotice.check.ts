/**
 * A quick check of which verdicts are announced, run with
 * `node --experimental-strip-types src/verdictNotice.check.ts`.
 */
import { newVerdicts, type SeenVerdict } from "./verdictNotice.ts";

let failed = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed += 1; console.log("FAIL", label, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); }
  else console.log("ok   ", label);
};

const STARTED_AT = 1_800_000_000_000;
const startedSecond = STARTED_AT / 1000;
const YEAR_AGO = startedSecond - 365 * 24 * 60 * 60;
const PROBLEM = "https://judge/problem/1";
const PAGE = "https://judge/status?problem=1";

/** Runs polls in order and says what each of them announced. */
const polls = (...answers: Array<Partial<Parameters<typeof newVerdicts>[0][number]>>) => {
  const seen = new Map<string, SeenVerdict>();
  return answers.map((answer) => newVerdicts([{ sourceUrl: PROBLEM, settled: true, ...answer }], seen, STARTED_AT).map((news) => news.status));
};
const doj = (answeredBy: string, status?: string) => ({ answeredBy, status, submissionUrl: status ? PAGE : undefined });
const dated = (status: string, id: number, submittedAt: number) => ({ status, submissionUrl: `https://judge/submission/${id}`, submittedAt });
const PUBLIC = "public:me";
const SESSION = "session:me";

// --- old submissions at startup --------------------------------------------------------------
eq("the public page has no contest's verdicts, and the panel reopening brings them in",
  polls(doj(PUBLIC), doj(SESSION, "AC"), doj(SESSION, "AC")), [[], [], []]);
eq("a verdict too old for the session's page comes back when one poll falls back to the public page",
  polls(doj(SESSION, "AC"), doj(SESSION), doj(PUBLIC, "AC"), doj(SESSION), doj(PUBLIC, "AC")), [[], [], [], [], []]);
eq("the public page and the session disagreeing is not a new submission",
  polls(doj(PUBLIC, "SCORE 40/100"), doj(SESSION, "AC")), [[], []]);
eq("the first answer is never news", polls(doj(SESSION, "AC")), [[]]);
eq("a problem put off to a later poll, or a judge out of reach, has no before",
  polls({ settled: false }, { settled: false }, doj(SESSION, "AC")), [[], [], []]);
eq("nor does a judge with no handle set", polls({ settled: false }, doj(PUBLIC, "AC")), [[], []]);
eq("another handle's verdict is not this one's news", polls(doj("public:m"), doj("public:me", "AC")), [[], []]);
eq("a dated verdict from long ago, seen first", polls(dated("AC", 1, YEAR_AGO)), [[]]);
eq("a dated verdict from long ago, turning up late", polls({}, dated("AC", 1, YEAR_AGO), dated("AC", 1, YEAR_AGO)), [[], [], []]);
eq("a dated verdict from before the editor started", polls(dated("AC", 1, startedSecond - 61)), [[]]);

// --- new verdicts while it runs --------------------------------------------------------------
eq("a first submission, on either page", [polls(doj(SESSION), doj(SESSION, "AC")), polls(doj(PUBLIC), doj(PUBLIC, "AC"))], [[[], ["AC"]], [[], ["AC"]]]);
eq("announced once, not on every poll", polls(doj(SESSION), doj(SESSION, "AC"), doj(SESSION, "AC")), [[], ["AC"], []]);
eq("the wait is not announced, its verdict is", polls(doj(SESSION), doj(SESSION, "JUDGING"), doj(SESSION, "WJ"), doj(SESSION, "SCORE 26/100")), [[], [], [], ["SCORE 26/100"]]);
eq("a verdict changing to another", polls(doj(SESSION, "SCORE 26/100"), doj(SESSION, "AC")), [[], ["AC"]]);
eq("resubmitting a problem too old for the session's page", polls(doj(SESSION, "AC"), doj(SESSION), doj(SESSION, "AC")), [[], [], ["AC"]]);
eq("after the page changed, the next verdict is compared with the new page", polls(doj(PUBLIC, "AC"), doj(SESSION, "JUDGING"), doj(SESSION, "AC")), [[], [], ["AC"]]);
eq("a dated verdict seen first", polls(dated("AC", 2, startedSecond + 30)), [["AC"]]);
eq("a dated submission from just before the editor started", polls(dated("AC", 2, startedSecond - 30)), [["AC"]]);
eq("a dated submission judged while it runs", polls(dated("WJ", 2, startedSecond + 30), dated("AC", 2, startedSecond + 30), dated("AC", 2, startedSecond + 30)), [[], ["AC"], []]);
eq("a dated resubmission after an old verdict", polls(dated("AC", 1, YEAR_AGO), dated("WA", 2, startedSecond + 30), dated("AC", 3, startedSecond + 60)), [[], ["WA"], ["AC"]]);

const seen = new Map<string, SeenVerdict>();
newVerdicts([{ sourceUrl: PROBLEM, settled: true }, { sourceUrl: `${PROBLEM}0`, settled: true }], seen, STARTED_AT);
const news = newVerdicts([{ sourceUrl: PROBLEM, settled: true, status: "AC", submissionUrl: PAGE }, { sourceUrl: `${PROBLEM}0`, settled: true }], seen, STARTED_AT);
eq("each problem is judged on its own, and the news says which", news, [{ sourceUrl: PROBLEM, status: "AC", submissionUrl: PAGE }]);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
