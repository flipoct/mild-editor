import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { formatClock } from "./problems";

/** The running part of a contest: when it began and when it ends, in epoch milliseconds. */
type Span = { startedAt: number; endsAt: number };

/**
 * The time, refreshed once a second while `active`. Only the small pieces below call it, so
 * a second passing redraws a few digits and not the editor around them.
 */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** The status bar's contest button: the countdown while one runs, a plain label otherwise. */
export function ContestStatusButton({ span, open, onToggle, title, overLabel }: {
  span: Span | null;
  open: boolean;
  onToggle: () => void;
  title: string;
  overLabel: string;
}) {
  const now = useNow(span !== null);
  const remaining = span ? span.endsAt - now : 0;
  const running = remaining > 0;
  const tone = span ? (running ? (remaining < 60000 ? "critical" : remaining < 10 * 60000 ? "ending" : "running") : "over") : "";
  return <button className={`contest-status ${tone}`} onClick={onToggle} aria-expanded={open} title={title}>
    <Icon name="timer" size={13} />{span ? (running ? formatClock(remaining) : overLabel) : title}
  </button>;
}

/** The top of the contest board: time left, time gone, and the bar between them. */
export function ContestHeader({ span, remainingLabel, overLabel, elapsedLabel }: {
  span: Span;
  remainingLabel: string;
  overLabel: string;
  elapsedLabel: string;
}) {
  const now = useNow(true);
  const remaining = span.endsAt - now;
  const running = remaining > 0;
  const length = span.endsAt - span.startedAt;
  return <>
    <header>
      <div><small>{running ? remainingLabel : overLabel}</small><strong className={running && remaining < 10 * 60000 ? "ending" : ""}>{formatClock(remaining)}</strong></div>
      <div className="contest-meta"><small>{elapsedLabel}</small><span>{formatClock(Math.min(now, span.endsAt) - span.startedAt)} / {formatClock(length)}</span></div>
    </header>
    <div className="contest-progress"><i style={{ width: `${Math.min(100, Math.max(0, ((now - span.startedAt) / length) * 100))}%` }} /></div>
  </>;
}
