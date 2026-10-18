/**
 * The ICPC rule for a room: a team has one keyboard. Everybody may read any file, but only
 * one member at a time writes code, and the keyboard is free again once its holder has
 * typed nothing for `KEYBOARD_IDLE_MS`.
 *
 * There is nobody to hand the keyboard out, and no clock the members share, so each member
 * works out who has it alone, from the same facts, and they all arrive at the same answer:
 *
 * - Whoever writes says so in their awareness state as `write: { run, n }`. `n` goes up
 *   with their edits; `run` is the turn they are on, and is new each time they take a
 *   free keyboard: one more than the largest turn they have seen anyone take.
 * - A member is writing while their `n` last changed less than `KEYBOARD_IDLE_MS` ago, by
 *   the clock of whoever is looking. Nobody compares their clock with anybody else's; the
 *   holder's own view of their idle time ends a moment before everyone else's, so nobody
 *   can start before the holder has stopped.
 * - Of everyone writing, the keyboard is the one on the earliest turn, the lower client id
 *   if two took the same turn in the same instant. A turn already under way therefore
 *   always beats a newcomer, and of two who started together exactly one goes on.
 *
 * Nothing here touches the editor; `src/collab/collabStore.ts` feeds it and applies it.
 */

export const KEYBOARD_IDLE_MS = 5000;

/** What a member's awareness state says of their writing. */
export type WriteClaim = { run: number; n: number };

/** A member as this computer has seen them write: their claim, and when (by this clock) it last moved. */
export type Writer = WriteClaim & { id: number; at: number };

/** The `write` field of somebody's awareness state, or null when it is not one. */
export const writeClaim = (state: unknown): WriteClaim | null => {
  const write = state && typeof state === "object" ? (state as { write?: unknown }).write : undefined;
  if (!write || typeof write !== "object") return null;
  const { run, n } = write as { run?: unknown; n?: unknown };
  const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  return whole(run) && whole(n) ? { run, n } : null;
};

/**
 * What this computer knows of a member after hearing their claim at `now`. Only a claim that
 * moved is writing. The first one heard of somebody says nothing about when they wrote it —
 * they may have stopped long ago — so it only records where they are.
 */
export const heardClaim = (known: Writer | undefined, id: number, claim: WriteClaim, now: number): Writer => {
  const moved = known !== undefined && (claim.n !== known.n || claim.run !== known.run);
  return { id, run: claim.run, n: claim.n, at: moved ? now : known?.at ?? Number.NEGATIVE_INFINITY };
};

export type Keyboard = {
  /** Who has the keyboard, or null when it is free. */
  holder: number | null;
  /** When (by this clock) the holder's idle time runs out and the keyboard is free, unless they write again; 0 while it is free. */
  until: number;
};

/** Who has the keyboard at `now`, of everyone as this computer has seen them write — itself included. */
export const keyboardAt = (writers: Iterable<Writer>, now: number, idle = KEYBOARD_IDLE_MS): Keyboard => {
  let best: Writer | null = null;
  for (const writer of writers) {
    if (!(now - writer.at < idle)) continue;
    if (!best || writer.run < best.run || (writer.run === best.run && writer.id < best.id)) best = writer;
  }
  return best ? { holder: best.id, until: best.at + idle } : { holder: null, until: 0 };
};

/** The turn a member takes when they find the keyboard free: past every turn anyone has been seen on. */
export const nextRun = (writers: Iterable<Writer>) => {
  let largest = 0;
  for (const writer of writers) largest = Math.max(largest, writer.run);
  return largest + 1;
};

/** Seconds left before a keyboard held until `until` is free, as shown: whole seconds, rounded up. */
export const secondsLeft = (until: number, now: number) => Math.max(0, Math.ceil((until - now) / 1000));
