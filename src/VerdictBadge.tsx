import { verdictView } from "./workbench";

/**
 * A judge's verdict beside a filename. Never cut short: for a partial score the number is the
 * point, so the filename gives way instead.
 */
export function VerdictBadge({ status, title }: { status: string; title?: string }) {
  const view = verdictView(status);
  return <span className={`judge-badge ${view.tone}`} title={title || view.title}>{view.text}</span>;
}
