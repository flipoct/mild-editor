import type { ReactNode } from "react";

/**
 * The little of GitHub's release markdown that the notes actually use: a heading, bullets,
 * and paragraphs, with `**bold**` reduced to strong text. Anything else is shown as
 * written rather than guessed at — these notes come from a release this build did not
 * compose, so the safe reading of an unknown line is that it is a line of prose.
 */
export const renderReleaseNotes = (notes: string): ReactNode[] => {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const emphasise = (text: string) => text.split(/\*\*([^*]+)\*\*/g).map((part, index) => index % 2 ? <strong key={index}>{part}</strong> : part);
  const flush = () => {
    if (!bullets.length) return;
    blocks.push(<ul key={`list-${blocks.length}`}>{bullets.map((item, index) => <li key={index}>{emphasise(item)}</li>)}</ul>);
    bullets = [];
  };
  for (const line of notes.replace(/\r\n/g, "\n").split("\n")) {
    const text = line.trim();
    if (!text) { flush(); continue; }
    const bullet = text.match(/^[-*]\s+(.*)$/);
    if (bullet) { bullets.push(bullet[1]); continue; }
    flush();
    const heading = text.match(/^#+\s+(.*)$/);
    if (heading) blocks.push(<h3 key={`heading-${blocks.length}`}>{heading[1]}</h3>);
    else blocks.push(<p key={`text-${blocks.length}`}>{emphasise(text)}</p>);
  }
  flush();
  return blocks;
};
