// test/health.zero-yield-notice.test.ts — the zero-yield warning must report evidence, not a guess.
//
// WHY THIS EXISTS. The warning used to read "the pipeline may have silently stopped matching
// (allowlist or discriminator decay)". On 2026-08-06 BOTH hypotheses were refuted by the very
// telemetry the trigger reads: ~6 700 files scanned/day, ZERO parse failures, 16-22 segments, 9-11
// in-window sessions — while `whysStrictMajority` ran 0,1,1,0 over the same days `whysConservative`
// read 1,0,0,0. The scan was healthy; the CONSERVATIVE RULE was filtering everything, which is that
// rule working as designed.
//
// The day-22 judge then caught the tool being self-referentially blind: it printed that guess one
// section BELOW recapping the commit titled "the zero-yield trigger fires with a false diagnosis".
import { test, expect } from "bun:test";
import { zeroYieldEvidence, zeroYieldNotice, emptyHealth, mergeRun } from "../src/transcripts/health";
import { emptyCounters } from "../src/transcripts/scan";

const day = (date: string, o: { sessions: number; cons: number; strict: number; parseFail?: number }) => {
  const c = { ...emptyCounters(), sessionsInWindow: o.sessions, whysConservative: o.cons,
    whysStrictMajority: o.strict, parseFailures: o.parseFail ?? 0 };
  return { date, c };
};
const build = (ds: ReturnType<typeof day>[]) =>
  ds.reduce((h, d) => mergeRun(h, d.date, d.c), emptyHealth());

test("⚠ the streak breaks on EITHER curve — a strict-majority-only day now YIELDS", () => {
  // ⚠ Dates moved past ANCHOR_COUNTER_FIXED_ON (2026-08-06). These fixtures are about the NOTICE
  // logic and their dates were incidental — but real dates in a fixture are not inert: once the
  // trust boundary landed, 08-04/08-05 became excluded days and the fixtures silently stopped
  // exercising the branch they were written for. Kept as real post-fix dates rather than synthetic
  // ones, so the boundary itself stays visible here.
  // ⚠ REWRITTEN 2026-08-10 for the A9 UNION. This used to expect days=3, counting two
  // strict-majority-only days INSIDE the streak. Under the union those days render whys, so calling
  // them "zero yield" would alarm about days that yielded. Only the trailing both-dry day counts.
  const e = zeroYieldEvidence(build([
    day("2026-08-06", { sessions: 9, cons: 1, strict: 0 }),
    day("2026-08-07", { sessions: 11, cons: 0, strict: 1 }),   // yields under the union
    day("2026-08-08", { sessions: 9, cons: 0, strict: 1 }),    // breaks the streak
    day("2026-08-09", { sessions: 10, cons: 0, strict: 0 }),
  ]));
  expect(e.days).toBe(1);
  expect(e.sessions).toBe(10);
});

test("⚠ a strict-majority-only day CANNOT appear inside a streak — the branch that explained it is gone", () => {
  // SUPERSEDED 2026-08-10 by the A9 union, and rewritten to pin WHY rather than deleted.
  // This used to assert the notice said "the pipeline is NOT broken: the strict-majority rule found
  // N ... the conservative rule is filtering them". That branch existed to EXPLAIN whys conservative
  // discarded. The union renders them instead, so such a day breaks the streak and the explanation
  // has nothing to explain. The property now is that the situation cannot form at all.
  const e = zeroYieldEvidence(build([
    day("2026-08-07", { sessions: 11, cons: 0, strict: 1 }),
    day("2026-08-08", { sessions: 9, cons: 0, strict: 1 }),
    day("2026-08-09", { sessions: 10, cons: 0, strict: 0 }),
  ]));
  expect(e.days).toBe(1);                                   // only the trailing both-dry day
  const notice = zeroYieldNotice(e);
  expect(notice).toContain("NEITHER attribution rule produced one");
  expect(notice).not.toContain("NOT broken");               // the deleted branch stays deleted
  expect(notice).not.toContain("conservative attribution rule is filtering");
});

// ⚠ "Cause unknown" WAS ASSERTED BY THREE TESTS HERE until 2026-08-11. It was the honest answer
// while the notice had no unit accounting to report; it stopped being honest once §5 could say
// exactly where the eligible units went, and no test failed at the moment it went stale — the
// assertions pinned the STRING, so they held the notice at the weakest claim it had ever made.
// Rewritten to pin the PROPERTY the string was standing in for: report accounting, never a cause.

test("⚠ when both rules are dry the notice ACCOUNTS for the units — and still asserts no cause", () => {
  // The 2026-08-11 record, which is what motivated the rewrite: 8 eligible units, none resolved,
  // fully accounted for by three unit-level buckets. "Cause unknown" was sending the reader to
  // derive this by hand from a drop map whose two largest entries (unrecognised-shape 32216,
  // path-unresolvable 468) are per-line and per-path and must NOT be summed against 8.
  const withUnits = (date: string, sessions: number) => ({
    date,
    c: {
      ...emptyCounters(), sessionsInWindow: sessions, whysConservative: 0, whysStrictMajority: 0,
      unitsEligible: 8,
      drops: { ...emptyCounters().drops, "no-segment": 2, ambiguous: 4, "no-qualifying-turn": 2,
        "unrecognised-shape": 32216, "path-unresolvable": 468 },
    },
  });
  const notice = zeroYieldNotice(zeroYieldEvidence(
    [withUnits("2026-08-09", 10)].reduce((h, d) => mergeRun(h, d.date, d.c), emptyHealth()),
  ));
  expect(notice).toContain("8 eligible unit(s) resolved to none");
  expect(notice).toContain("4 ambiguous");                 // dominant bucket, named
  expect(notice).toContain("2 no-segment");
  expect(notice).toContain("2 no-qualifying-turn");
  // ⚠ THE LOAD-BEARING NEGATIVES: the per-line/per-path tallies share the record but not the
  // denominator. If either ever appears in this sentence the notice is lying about scale.
  expect(notice).not.toContain("32216");
  expect(notice).not.toContain("468");
  expect(notice).toContain("transcript-health.json");
  expect(notice).toContain("10 sessions scanned");
});

test("⚠ zero eligible units reads as an UPSTREAM loss, not an empty account", () => {
  // All-zero counters: no unit reached the join at all. Printing "0 eligible units resolved to none,
  // accounted for as " with an empty list would be a confident nothing — the shape of answer this
  // whole file exists to prevent.
  const notice = zeroYieldNotice(zeroYieldEvidence(build([
    day("2026-08-07", { sessions: 11, cons: 0, strict: 0 }),
    day("2026-08-08", { sessions: 9, cons: 0, strict: 0 }),
    day("2026-08-09", { sessions: 10, cons: 0, strict: 0 }),
  ])));
  expect(notice).toContain("no unit was even eligible");
  expect(notice).toContain("upstream of the join");
  expect(notice).toContain("30 sessions scanned"); // the evidence a reader needs, stated
});

test("⚠ eligible units with NO unit-level drop is reported as a telemetry bug, not a yield problem", () => {
  // The §5 identity broken: units were eligible, none yielded, and nothing was recorded as a loss.
  // Silently printing an empty account here would hide exactly the bug the identity exists to catch.
  const notice = zeroYieldNotice({
    days: 1, sessions: 9, parseFailures: 0, unitsEligible: 5, unitDrops: [],
  });
  expect(notice).toContain("breaks the §5 accounting identity");
  expect(notice).toContain("telemetry bug");
});

test("the notice never claims a cause — in any branch", () => {
  const branches = [
    { days: 3, sessions: 30, parseFailures: 0, unitsEligible: 0, unitDrops: [] },
    { days: 1, sessions: 9, parseFailures: 0, unitsEligible: 5, unitDrops: [] },
    { days: 2, sessions: 20, parseFailures: 0, unitsEligible: 8,
      unitDrops: [{ reason: "ambiguous" as const, count: 6 }, { reason: "no-segment" as const, count: 2 }] },
  ];
  for (const e of branches) {
    const n = zeroYieldNotice(e);
    // ⚠ The framing, not the word. Any mention of decay must be hedged; the current text drops the
    // word entirely, and this stays conditional so a future rewrite that reintroduces it is still
    // held to the hedge rather than silently passing.
    const i = n.indexOf("has decayed");
    if (i !== -1) expect(n.slice(0, i)).toContain("before assuming");
    expect(n).not.toContain("may have silently stopped matching");
    expect(n).toContain("The briefing is unaffected.");   // the reassurance survives every rewrite
  }
});

test("the unit-drop account is ordered by count, ties broken by name — the wording must not reshuffle", () => {
  // A warning whose text reorders between runs reads as new information when nothing has changed.
  const e = {
    days: 1, sessions: 9, parseFailures: 0, unitsEligible: 9,
    unitDrops: [{ reason: "ambiguous" as const, count: 3 }, { reason: "no-segment" as const, count: 3 }],
  };
  expect(zeroYieldNotice(e)).toContain("3 ambiguous, 3 no-segment");   // tie → alphabetical
});

// ── A9 telemetry trust boundary (day-25) ─────────────────────────────────────────────────────────
import { anchorCountersTrustworthy, ANCHOR_COUNTER_FIXED_ON } from "../src/transcripts/health";

test("⚠ pre-#146 days are marked untrustworthy — A9 must not average across the fix", () => {
  // Until 2026-08-06 the anchor RESOLUTION pass iterated only the conservative curve, so a
  // strict-majority why was never anchor-verified and never counted. 08-04 and 08-05 record
  // anchorsAttempted: 0 beside whysStrictMajority: 1 — impossible on its face.
  expect(anchorCountersTrustworthy({ date: "2026-08-04" })).toBe(false);
  expect(anchorCountersTrustworthy({ date: "2026-08-05" })).toBe(false);
  expect(anchorCountersTrustworthy({ date: ANCHOR_COUNTER_FIXED_ON })).toBe(true);  // the fix day counts
  expect(anchorCountersTrustworthy({ date: "2026-08-09" })).toBe(true);
});

test("⚠ the zero-yield notice does not claim 'NOT broken' from an untrustworthy day", () => {
  // THE reason this gate exists. The notice asserts "The pipeline is NOT broken" on the strength of
  // strictMajorityWhys; sourcing that from a pre-fix day would rest a user-facing verdict on a count
  // collected under a laxer rule — and the bias has a DIRECTION: pre-fix strict-majority counts are
  // if anything TOO HIGH, since they include whys that would now be dropped as unresolvable.
  const day = (date: string, strict: number) => ({
    date, c: { ...emptyCounters(), sessionsInWindow: 9, whysConservative: 0, whysStrictMajority: strict },
  });
  const build = (ds: ReturnType<typeof day>[]) =>
    ds.reduce((h, d) => mergeRun(h, d.date, d.c), emptyHealth());

  // ⚠ REWRITTEN 2026-08-10 for the A9 union. This used to assert that pre-fix strict-majority counts
  // were EXCLUDED from the evidence while post-fix ones licensed a "NOT broken" claim. Both halves
  // are now moot: the union breaks the streak on any strict-majority day regardless of its trust
  // status, so no such day is ever summed. The trust boundary itself is still pinned — by the
  // anchorCountersTrustworthy test below, which is where that property actually belongs.
  const stale = zeroYieldEvidence(build([day("2026-08-04", 1), day("2026-08-05", 1)]));
  expect(stale.days).toBe(0);                                    // both days YIELD under the union
  const dry = zeroYieldEvidence(build([day("2026-08-07", 0), day("2026-08-08", 0)]));
  expect(dry.days).toBe(2);
  // These fixtures carry `emptyCounters()`, so no unit ever reached the join — the upstream branch.
  // (Asserted "Cause unknown" until 2026-08-11; see the block comment above.)
  expect(zeroYieldNotice(dry)).toContain("no unit was even eligible");
});
