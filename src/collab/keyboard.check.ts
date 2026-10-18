/**
 * A check of the one-keyboard rule, run with
 * `node --experimental-strip-types src/collab/keyboard.check.ts`.
 *
 * Besides the functions one by one, a small simulated team: members with clocks that do not
 * agree, messages that take a while, typing at the same moment. Each member decides alone,
 * and the point is that they never both believe they may write.
 */
import { heardClaim, KEYBOARD_IDLE_MS, keyboardAt, nextRun, secondsLeft, writeClaim, type WriteClaim, type Writer } from "./keyboard.ts";

let failed = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed += 1; console.log("FAIL", label, "\n  got ", got, "\n  want", want); }
  else console.log("ok   ", label, "->", JSON.stringify(got));
};

// --- what an awareness state says ----------------------------------------------------------
eq("a claim", writeClaim({ user: {}, write: { run: 3, n: 41 } }), { run: 3, n: 41 });
eq("nothing said", writeClaim({ user: {} }), null);
eq("not numbers", writeClaim({ write: { run: "3", n: 1 } }), null);
eq("not whole", writeClaim({ write: { run: 1.5, n: 1 } }), null);
eq("negative", writeClaim({ write: { run: 1, n: -1 } }), null);
eq("not a state", [writeClaim(null), writeClaim(7), writeClaim({ write: null })], [null, null, null]);

// --- hearing a claim -----------------------------------------------------------------------
const first = heardClaim(undefined, 9, { run: 4, n: 17 }, 1000);
eq("first heard: not writing, whenever they wrote it", first, { id: 9, run: 4, n: 17, at: Number.NEGATIVE_INFINITY });
eq("the same claim again: still not", heardClaim(first, 9, { run: 4, n: 17 }, 2000).at, Number.NEGATIVE_INFINITY);
const wrote = heardClaim(first, 9, { run: 4, n: 18 }, 2000);
eq("a new n is writing, now", wrote.at, 2000);
eq("heard again unchanged keeps when", heardClaim(wrote, 9, { run: 4, n: 18 }, 4000).at, 2000);
eq("a new turn is writing too", heardClaim(wrote, 9, { run: 5, n: 18 }, 4500).at, 4500);

// --- who has the keyboard ------------------------------------------------------------------
const writer = (id: number, run: number, at: number): Writer => ({ id, run, n: 1, at });
eq("nobody wrote", keyboardAt([writer(1, 0, Number.NEGATIVE_INFINITY), writer(2, 0, Number.NEGATIVE_INFINITY)], 10_000), { holder: null, until: 0 });
eq("the one writing", keyboardAt([writer(1, 1, 9000), writer(2, 0, Number.NEGATIVE_INFINITY)], 10_000), { holder: 1, until: 14_000 });
eq("still theirs just before five seconds", keyboardAt([writer(1, 1, 9000)], 13_999).holder, 1);
eq("free at five seconds", keyboardAt([writer(1, 1, 9000)], 14_000).holder, null);
eq("the earlier turn beats a newcomer", keyboardAt([writer(7, 2, 9900), writer(3, 3, 9950)], 10_000).holder, 7);
eq("one turn taken twice: the lower id", keyboardAt([writer(7, 3, 9900), writer(3, 3, 9950)], 10_000).holder, 3);
eq("the loser takes over only once the winner is idle", keyboardAt([writer(7, 3, 9900), writer(3, 3, 9000)], 14_100), { holder: 7, until: 14_900 });
eq("a turn past every turn seen", nextRun([writer(1, 4, 0), writer(2, 9, Number.NEGATIVE_INFINITY), writer(3, 2, 0)]), 10);
eq("the first turn of a room", nextRun([writer(1, 0, 0)]), 1);
eq("countdown rounds up", [secondsLeft(14_000, 9000), secondsLeft(14_000, 10_001), secondsLeft(14_000, 13_999), secondsLeft(14_000, 14_000), secondsLeft(0, 5)], [5, 4, 1, 0, 0]);

// --- a team ----------------------------------------------------------------------------------
/**
 * Members as collabStore.ts runs them: a clock of their own (`skew` from true time), the
 * others' claims heard `delay` ms after they were made, and a member who finds the keyboard
 * somebody else's not typing.
 */
type Member = { id: number; skew: number; self: Writer; heard: Map<number, Writer> };
const team = (ids: number[], skews: number[]): Member[] =>
  ids.map((id, index) => ({ id, skew: skews[index], self: { id, run: 0, n: 0, at: Number.NEGATIVE_INFINITY }, heard: new Map() }));
const clock = (member: Member, time: number) => time + member.skew;
const view = (member: Member, time: number) => keyboardAt([...member.heard.values(), member.self], clock(member, time));
const mayWrite = (member: Member, time: number) => { const { holder } = view(member, time); return holder === null || holder === member.id; };

type Event = { time: number; run: () => void };
const simulate = (members: Member[], delay: number, typing: Array<{ id: number; from: number; to: number; every: number }>, until: number) => {
  // Kept in time order as events are added, ones at the same time in the order they were.
  const events: Event[] = [];
  const typed: Array<{ id: number; time: number }> = [];
  const post = (time: number, run: () => void) => {
    let at = events.length;
    while (at > 0 && events[at - 1].time > time) at -= 1;
    events.splice(at, 0, { time, run });
  };
  for (const plan of typing) {
    for (let time = plan.from; time <= plan.to; time += plan.every) {
      post(time, () => {
        const member = members.find((one) => one.id === plan.id)!;
        if (!mayWrite(member, time)) return;
        const now = clock(member, time);
        const fresh = !(now - member.self.at < KEYBOARD_IDLE_MS);
        member.self = { ...member.self, run: fresh ? nextRun([...member.heard.values(), member.self]) : member.self.run, n: member.self.n + 1, at: now };
        typed.push({ id: member.id, time });
        const claim: WriteClaim = { run: member.self.run, n: member.self.n };
        for (const other of members) {
          if (other !== member) post(time + delay, () => other.heard.set(member.id, heardClaim(other.heard.get(member.id), member.id, claim, clock(other, time + delay))));
        }
      });
    }
  }
  // Everyone has heard everyone once before anything happens, as on joining a room.
  for (const member of members) for (const other of members) if (other !== member) other.heard.set(member.id, heardClaim(undefined, member.id, { run: 0, n: 0 }, 0));
  const writersAt: Array<{ time: number; may: number[] }> = [];
  for (let time = 0; time <= until; time += 50) post(time, () => writersAt.push({ time, may: members.filter((member) => mayWrite(member, time) && view(member, time).holder === member.id).map((member) => member.id) }));
  // Events at one time run in the order posted: typing, then what was heard, then the look.
  while (events.length) events.shift()!.run();
  return { typed, writersAt };
};

{
  const members = team([11, 22, 33], [0, 0, 0]);
  const { typed } = simulate(members, 40, [
    { id: 11, from: 1000, to: 3000, every: 100 },
    { id: 22, from: 1500, to: 9000, every: 100 },
    { id: 33, from: 2000, to: 2500, every: 100 },
  ], 12_000);
  const by = (id: number) => typed.filter((keystroke) => keystroke.id === id).map((keystroke) => keystroke.time);
  eq("the first to type writes", by(11).length, 21);
  eq("the others wait while they do", by(33), []);
  eq("and the next writes only five seconds after the last keystroke", by(22)[0] >= 3000 + KEYBOARD_IDLE_MS, true);
  eq("so nobody typed over anybody", typed.every((keystroke, index) => typed.slice(0, index).every((before) => before.id === keystroke.id || keystroke.time - before.time >= KEYBOARD_IDLE_MS || typed.some((between) => between.id === keystroke.id && between.time < keystroke.time && between.time > before.time))), true);
}

{
  // Clocks a minute apart in both directions: nobody's clock is compared with anybody else's.
  const members = team([5, 6], [60_000, -45_000]);
  const { typed } = simulate(members, 120, [
    { id: 5, from: 1000, to: 2000, every: 100 },
    { id: 6, from: 1200, to: 9000, every: 250 },
  ], 10_000);
  const second = typed.filter((keystroke) => keystroke.id === 6).map((keystroke) => keystroke.time);
  eq("skewed clocks: the second waits all the same", second[0] >= 2000 + KEYBOARD_IDLE_MS, true);
}

{
  // Two press a key in the same instant: for a moment both typed, then exactly one goes on.
  const members = team([40, 30], [0, 0]);
  const { typed, writersAt } = simulate(members, 80, [
    { id: 40, from: 1000, to: 4000, every: 100 },
    { id: 30, from: 1000, to: 4000, every: 100 },
  ], 6000);
  const after = (id: number) => typed.filter((keystroke) => keystroke.id === id && keystroke.time > 1100).length;
  eq("a tie goes to the lower id", [after(30) > 0, after(40)], [true, 0]);
  eq("after the moment it takes to hear each other, one holder at a time", writersAt.filter((look) => look.time > 1100).every((look) => look.may.length <= 1), true);
  eq("and everyone agrees who", members.every((member) => view(member, 2000).holder === 30), true);
}

{
  // The holder pauses for four seconds and goes on: still theirs, nobody else got in.
  const members = team([1, 2], [0, 0]);
  const { typed } = simulate(members, 50, [
    { id: 1, from: 1000, to: 1000, every: 100 },
    { id: 1, from: 5000, to: 5000, every: 100 },
    { id: 2, from: 1500, to: 11_000, every: 500 },
  ], 12_000);
  const second = typed.filter((keystroke) => keystroke.id === 2).map((keystroke) => keystroke.time);
  eq("a pause shorter than five seconds keeps the keyboard", second[0] >= 5000 + KEYBOARD_IDLE_MS, true);
  eq("the holder's second keystroke went in", typed.filter((keystroke) => keystroke.id === 1).length, 2);
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
if (failed) process.exit(1);
