/**
 * Which verdicts of a poll are news, kept apart from the component so it can be checked
 * without a judge (`src/verdictNotice.check.ts`).
 */
import type { SubmissionStatusResult } from "./types";

/** The judge is still working on it: `WJ`, `TESTING`, or AtCoder's running count `12/34`. */
export const isPendingVerdict = (status: string) => /^(WJ|WR|JUDGING|TESTING|IN QUEUE)$/i.test(status.trim()) || /^\d+\s*\/\s*\d+/.test(status.trim());

/** What a judge last answered about one problem, and which of its views said so. */
export type SeenVerdict = { status?: string; submissionUrl?: string; answeredBy?: string };

/**
 * Takes in one poll's answers and returns the verdicts among them worth announcing.
 *
 * A verdict is news when it is of a submission made while the editor was running. A judge
 * that dates its submissions says so itself; one that does not is believed when the verdict
 * differs from what it answered before — and only an answer counts for that, so a problem it
 * had not been asked about yet, or could not be reached for, has no "before" and its old
 * verdict is taken in silently when it does arrive. Nor does an answer from another view of
 * the judge count: DOJ's public page leaves out what its logged-in page lists, so the poll
 * after the problem browser opens would otherwise announce every old verdict only that page has.
 */
export const newVerdicts = (results: SubmissionStatusResult[], seen: Map<string, SeenVerdict>, startedAt: number) => {
  const news: Array<{ sourceUrl: string; status: string; submissionUrl?: string }> = [];
  for (const result of results) {
    if (result.settled === false) continue;
    const before = seen.get(result.sourceUrl);
    const status = result.status || undefined;
    const submissionUrl = result.submissionUrl || undefined;
    const answeredBy = result.answeredBy || undefined;
    const changed = Boolean(before) && before?.answeredBy === answeredBy && (before?.status !== status || before?.submissionUrl !== submissionUrl);
    const recent = result.submittedAt ? result.submittedAt * 1000 >= startedAt - 60_000 && (changed || !before) : changed;
    if (status && !isPendingVerdict(status) && recent) news.push({ sourceUrl: result.sourceUrl, status, submissionUrl });
    seen.set(result.sourceUrl, { status, submissionUrl, answeredBy });
  }
  return news;
};
