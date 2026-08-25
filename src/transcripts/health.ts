// Slice 1.5 T3.7 + T3.8 — `TranscriptHealth` (§3.8): the day record, multi-run accumulation,
// streaks, the four degradation triggers, and the embedded self-test.
//
// ⚠ THE FILE IS NOT A SINK. §3.4 makes this a RULE, not an aspiration: every value written here is a
// NUMBER or an ENUMERATED CODE. `lastWarning` was removed for exactly this reason — free text in a
// file under `supportDir()` is a sink, and a warning is a DropReason code plus a count.
import type { DropReason, TranscriptRunCounters } from "./scan";
import { DROP_REASONS, UNIT_DENOMINATED_DROPS, emptyCounters } from "./scan";

export type TranscriptDay = TranscriptRunCounters & { date: string };

export type TranscriptHealth = {
  version: 1;
  days: TranscriptDay[];
  /** Pre-mortem risk 4: the session-start -> first-commit delta distribution, in HOURS. This is what
   *  MEASURES the right read-window margin instead of guessing it — the plan chose 24 h, and without
   *  this counter that choice could never be checked against reality. Histogram, never raw instants. */
  startToCommitHours: Record<"0-1" | "1-4" | "4-12" | "12-24" | "24+", number>;
  /** Pre-mortem risk 5: units whose `norm(label)` collides. Otherwise unknown until 1.5b — i.e.
   *  after the gate that depends on it. */
  labelCollisions: number;
};

export function emptyHealth(): TranscriptHealth {
  return {
    version: 1, days: [],
    startToCommitHours: { "0-1": 0, "1-4": 0, "4-12": 0, "12-24": 0, "24+": 0 },
    labelCollisions: 0,
  };
}

export function bucketStartToCommit(hours: number): keyof TranscriptHealth["startToCommitHours"] {
  if (hours < 1) return "0-1";
  if (hours < 4) return "1-4";
  if (hours < 12) return "4-12";
  if (hours < 24) return "12-24";
  return "24+";
}

/** ⚠ RULE 1 — only a run that ACTUALLY EXECUTED THE SCAN writes a day record. The agent fires on a
 *  ~10-minute interval and most runs return BEFORE the scan's insertion point (empty/blocked window,
 *  offline). Without this rule a non-scanning run stamps a record whose derived sets are all zero,
 *  which under last-run-wins would zero the day and fire the zero-yield trigger EVERY SINGLE DAY.
 *
 *  ⚠ RULE 2 — MERGE, never overwrite. Counters SUM across scanning runs within a date; booleans OR. */
export function mergeRun(health: TranscriptHealth, date: string, run: TranscriptRunCounters): TranscriptHealth {
  // The two pre-mortem counters are health-level (accumulated across days), not per-day, so they are
  // folded here rather than living in the day record.
  const startToCommitHours = { ...health.startToCommitHours };
  for (const k of Object.keys(startToCommitHours) as (keyof typeof startToCommitHours)[]) {
    startToCommitHours[k] += run.startToCommitHours[k] ?? 0;
  }
  const labelCollisions = health.labelCollisions + (run.labelCollisions ?? 0);
  health = { ...health, startToCommitHours, labelCollisions };
  const days = [...health.days];
  const i = days.findIndex((d) => d.date === date);
  if (i === -1) { days.push({ date, ...run }); return { ...health, days: days.sort((a, b) => a.date.localeCompare(b.date)) }; }

  const prev = days[i]!;
  const merged: TranscriptDay = { ...prev, date };
  for (const k of Object.keys(run) as (keyof TranscriptRunCounters)[]) {
    const a = prev[k], b = run[k];
    if (typeof a === "number" && typeof b === "number") (merged as Record<string, unknown>)[k] = a + b;
    else if (typeof a === "boolean" && typeof b === "boolean") (merged as Record<string, unknown>)[k] = a || b;
  }
  merged.drops = Object.fromEntries(DROP_REASONS.map((r) => [r, (prev.drops[r] ?? 0) + (run.drops[r] ?? 0)])) as Record<DropReason, number>;
  merged.byUnitFileCount = { ...prev.byUnitFileCount };
  for (const b of Object.keys(run.byUnitFileCount) as (keyof TranscriptRunCounters["byUnitFileCount"])[]) {
    merged.byUnitFileCount[b] = {
      eligible: prev.byUnitFileCount[b].eligible + run.byUnitFileCount[b].eligible,
      conservative: prev.byUnitFileCount[b].conservative + run.byUnitFileCount[b].conservative,
      strictMajority: prev.byUnitFileCount[b].strictMajority + run.byUnitFileCount[b].strictMajority,
    };
  }
  days[i] = merged;
  return { ...health, days };
}

/** A QUALIFYING day is one where the scan found >=1 in-window session — the denominator "zero yield"
 *  is defined over. A quiet day is not decay. */
export const isQualifyingDay = (d: TranscriptDay): boolean => d.sessionsInWindow > 0;

/** Consecutive qualifying days, counting back from the most recent, that produced zero whys. */
export function zeroYieldStreak(health: TranscriptHealth): number {
  let n = 0;
  for (let i = health.days.length - 1; i >= 0; i--) {
    const d = health.days[i]!;
    if (!isQualifyingDay(d)) continue;                       // skipped, not streak-breaking
    // ⚠ THE ADOPTED CURVE, not conservative alone (2026-08-10). Since A9 adopted the UNION, a day
    // where only strict-majority resolved DOES render whys — breaking the streak on conservative
    // alone would raise a zero-yield alarm about a day that yielded. `either > 0` is EXACTLY
    // `union > 0`, so no extra counter is needed to express it. The hazard was already named in the
    // comment below; adopting the union is what made it live.
    if (d.whysConservative > 0 || d.whysStrictMajority > 0) break;
    n++;
  }
  return n;
}

/** What the zero-yield streak can HONESTLY say about itself.
 *
 *  ⚠ `zeroYieldStreak` breaks on EITHER curve (`whysConservative > 0 || whysStrictMajority > 0`) —
 *  the adopted A9 union. An earlier comment here still said it broke on conservative alone; that
 *  was the pre-union behaviour and is wrong under the live code. Historical context for the
 *  false-diagnosis incident: on 2026-08-06 the warning blamed "allowlist or discriminator decay"
 *  while telemetry showed a healthy scan (`whysStrictMajority` 0,1,1,0 vs `whysConservative` 1,0,0,0)
 *  — the conservative RULE was filtering, not the pipeline.
 *
 *  The day-22 judge then caught the tool being self-referentially blind: it printed that confident
 *  guess one section BELOW recapping the commit whose subject is "the zero-yield trigger fires with a
 *  false diagnosis". The one component known to be unreliable was the one still asserting a cause.
 *
 *  So: report what is MEASURED and name the counter to read.
 *
 *  ⚠ THE DISCRIMINATION THIS PARAGRAPH USED TO DESCRIBE NO LONGER EXISTS, and the tail asserting it
 *  was deleted on 2026-08-11 rather than left to mislead. It said a non-zero strict-majority count
 *  over the streak PROVES the pipeline still matches. Under the A9 union the streak breaks on
 *  EITHER curve being non-zero (see `zeroYieldStreak`), so every day inside a streak has both at
 *  zero and that count is structurally unreachable — exactly what the deleted-field note below
 *  says. The notice now has ONE branch, and it asserts no cause. */
/** ⚠ `strictMajorityWhys` WAS HERE AND WAS DELETED on 2026-08-10, when A9 adopted the UNION curve.
 *  It is not an oversight and must not be restored without re-reading this: under the union, a day
 *  where strict-majority resolved anything RENDERS those whys, so it breaks the streak above. Every
 *  day inside a streak therefore has BOTH curves at zero, and the field could only ever hold 0.
 *  Keeping a field whose name promises "whys the other curve found" while it is structurally
 *  incapable of being non-zero is this project's most-recorded defect — a field answering a question
 *  adjacent to the one its name implies (`flagCount`, `judge posture: full`, the Ground column,
 *  `modelOf`, `filesScanned`). Deleted rather than documented. */
export type ZeroYieldEvidence = {
  days: number;                 // qualifying days in the streak
  sessions: number;             // sessions seen across them — the scan is alive if this is > 0
  parseFailures: number;
  /** Eligible units across the streak — the DENOMINATOR the notice's loss account is stated over.
   *  Without it "4 ambiguous" is unreadable: 4 of 8 is the story, 4 of 400 is noise. */
  unitsEligible: number;
  /** Unit-denominated losses only (`UNIT_DENOMINATED_DROPS`), summed across the streak, highest
   *  first. NEVER the full drop map — see the warning on that constant. */
  unitDrops: { reason: DropReason; count: number }[];
};

export function zeroYieldEvidence(health: TranscriptHealth): ZeroYieldEvidence {
  const out: ZeroYieldEvidence = { days: 0, sessions: 0, parseFailures: 0, unitsEligible: 0, unitDrops: [] };
  const tally = new Map<DropReason, number>();
  for (let i = health.days.length - 1; i >= 0; i--) {
    const d = health.days[i]!;
    if (!isQualifyingDay(d)) continue;
    // ⚠ THE ADOPTED CURVE, not conservative alone (2026-08-10). Since A9 adopted the UNION, a day
    // where only strict-majority resolved DOES render whys — breaking the streak on conservative
    // alone would raise a zero-yield alarm about a day that yielded. `either > 0` is EXACTLY
    // `union > 0`, so no extra counter is needed to express it. The hazard was already named in the
    // comment below; adopting the union is what made it live.
    if (d.whysConservative > 0 || d.whysStrictMajority > 0) break;
    out.days++;
    out.sessions += d.sessionsInWindow;
    out.parseFailures += d.parseFailures ?? 0;
    out.unitsEligible += d.unitsEligible ?? 0;
    for (const r of UNIT_DENOMINATED_DROPS) {
      const n = d.drops?.[r] ?? 0;
      if (n > 0) tally.set(r, (tally.get(r) ?? 0) + n);
    }
  }
  // Highest first, ties by reason name so the notice text is deterministic across runs — a warning
  // whose wording reshuffles day to day reads as new information when nothing has changed.
  out.unitDrops = [...tally.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return out;
}

/** The user-facing zero-yield notice, built from evidence rather than from a guess. */
export function zeroYieldNotice(e: ZeroYieldEvidence): string {
  const where = "read `whysConservative` vs `whysStrictMajority` in transcript-health.json";
  const head = `transcript evidence has produced nothing for ${e.days} consecutive days that DID have sessions`;
  // ⚠ THE "PIPELINE IS NOT BROKEN, THE CONSERVATIVE RULE IS FILTERING" BRANCH WAS DELETED HERE on
  // 2026-08-10, and its deletion is a CONSEQUENCE of adopting the A9 union rather than an edit to
  // the notice. That branch existed to explain whys that the conservative rule had DISCARDED. Under
  // the union nothing discards them — a strict-majority-only resolution is now rendered — so the
  // situation it described cannot arise, and the streak it would have reported on cannot form.
  // Restoring it would print a cause for a state the code can no longer reach.
  // ⚠ "CAUSE UNKNOWN" WAS DELETED HERE on 2026-08-11. It had been true when written and stopped
  // being true without anyone editing it: the §5 unit accounting now says exactly where the units
  // went, and the notice was still sending the reader off to derive it by hand from a drop map whose
  // largest entries are the ones they must NOT use (per-line/per-path — see UNIT_DENOMINATED_DROPS).
  // On the 2026-08-11 record that reader would have found `unrecognised-shape: 32216` sitting beside
  // `unitsEligible: 8`.
  //
  // ⚠ IT STILL DOES NOT CLAIM A ROOT CAUSE, and the distinction is the whole point of the rewrite.
  // "4 of 8 units were ambiguous" is an ACCOUNTING statement, verifiable against the record. Why
  // those units were ambiguous is a different question this function has no evidence for. Naming the
  // dominant bucket tells the reader where to look; asserting a cause would repeat the failure the
  // header comment above already records — a fixed string whose two hypotheses were both refuted by
  // the very telemetry it told the reader to consult.
  const account = e.unitsEligible === 0
    // No eligible units at all: the loss is upstream of the join, so a unit-level breakdown would be
    // an empty list dressed up as an answer.
    ? "no unit was even eligible (>=1 in-window activity AND a non-empty file set), so nothing " +
      "reached the attribution rules — the loss is upstream of the join, in the scan"
    : e.unitDrops.length === 0
      // Eligible units, zero whys, and no unit-denominated drop: the §5 identity is broken. Say so
      // plainly rather than printing a confident empty account.
      ? `${e.unitsEligible} unit(s) were eligible and none produced a why, yet no unit-level drop ` +
        `was recorded — that breaks the §5 accounting identity and is a telemetry bug, not a yield problem`
      : `${e.unitsEligible} eligible unit(s) resolved to none, accounted for as ` +
        e.unitDrops.map((d) => `${d.count} ${d.reason}`).join(", ");
  return `${head}, and NEITHER attribution rule produced one (${e.sessions} sessions scanned, ` +
    `${e.parseFailures} parse failures): ${account}. To dig further, ${where}. The briefing is unaffected.`;
}

/** Days whose `anchorsAttempted` / `anchorsResolved` cannot be trusted, and WHY.
 *
 *  ⚠ THE A9 GATE WILL BE DECIDED FROM THIS FILE, and two of its rows are known-bad. Until
 *  2026-08-06 (PR #146) the anchor RESOLUTION pass iterated only the conservative curve's anchors —
 *  `anchors.push()` happened solely in that branch — so a strict-majority why was never anchor-
 *  verified and never counted. 2026-08-04 and 2026-08-05 therefore record `anchorsAttempted: 0,
 *  anchorsResolved: 0` beside `whysStrictMajority: 1`, which is impossible on its face: a why that
 *  never attempted an anchor cannot have been anchored.
 *
 *  The COUNTER is fixed. The RECORDED HISTORY is not, and cannot be — those runs are gone. What was
 *  missing is any marker saying so, which is the thing that would actually mislead A9: a reader
 *  comparing `whysConservative` against `whysStrictMajority` across the file has no way to know that
 *  the strict-majority column was collected under a laxer rule (unverified anchors were kept) for
 *  its first two non-zero days.
 *
 *  ⚠ AND THE BIAS HAS A DIRECTION: pre-fix strict-majority counts are, if anything, TOO HIGH —
 *  they include whys that would now be dropped as unresolvable. So the curve A9 is being asked to
 *  prefer is the one flattered by the bug. That is exactly the wrong way round to decide it. */
export const ANCHOR_COUNTER_FIXED_ON = "2026-08-06";

/** True when this day's anchor counters predate the PR #146 fix and must not be compared with later
 *  days. Exported so the A9 decision — and anything else reading the two curves — can exclude them
 *  explicitly rather than silently averaging over a schema change. */
export const anchorCountersTrustworthy = (day: { date: string }): boolean =>
  day.date >= ANCHOR_COUNTER_FIXED_ON;

export const HYSTERESIS_N = 3;                                // plan-time parameter (§3.8)
export const PARSE_FAILURE_RATE_THRESHOLD = 0.1;

export type TriggerCode = "zero-yield" | "parse-failure-rate" | "self-test-mismatch" | "cap-tripped";

/** The triggers `evaluateTriggers` emits — THREE of them: `zero-yield`, `parse-failure-rate`,
 *  `cap-tripped`. Each with a DENOMINATOR and an explicit zero-denominator SKIP.
 *
 *  ⚠ `TriggerCode` carries a FOURTH member, `self-test-mismatch`, which this function never
 *  produces — it is raised on a different path entirely (`ScanOutcome.degraded`, surfaced by the
 *  LOUD map in core.ts). Said "the four triggers" until 2026-08-11, which invited a reader to look
 *  here for a writer that was never going to be found. `scan.ts`'s own rule is that a code with no
 *  writer is unreachable telemetry; this one HAS a writer, just not in this function.
 *
 *  ⚠ The skip is load-bearing in ONE direction, and it is worth being precise about which. With
 *  `linesRead === 0` and `parseFailures === 0` the rate is `0/0 = NaN` and `NaN > threshold` is
 *  false, so that case is already inert. The case the guard actually protects is
 *  `parseFailures > 0` with `linesRead === 0`: that is `Infinity > threshold`, which fires the
 *  systematic-failure route on a run that read nothing at all. Today `reader.ts` increments
 *  `linesRead` before `parseFailures`, so the ratio cannot arise — but that invariant lives in a
 *  DIFFERENT module, and relying on it silently would make this trigger depend on the reader's
 *  internal ordering. The guard is what keeps them independent. */
export function evaluateTriggers(health: TranscriptHealth, today?: TranscriptDay): TriggerCode[] {
  const out: TriggerCode[] = [];
  if (zeroYieldStreak(health) >= HYSTERESIS_N) out.push("zero-yield");
  if (today) {
    if (today.linesRead > 0 && today.parseFailures / today.linesRead > PARSE_FAILURE_RATE_THRESHOLD) {
      out.push("parse-failure-rate");                        // denominator = linesRead; 0 => skipped
    }
    if (today.capTripped) out.push("cap-tripped");
  }
  return out;
}

/** ⚠ The embedded SELF-TEST. It runs BEFORE the live scan and its cost is excluded from the cap
 *  clock. It proves the pipeline still behaves on a known input; a mismatch routes to the
 *  systematic-failure tier (git-only + a loud warning) rather than shipping whys from a pipeline
 *  that has silently changed behaviour. Returns a CODE, never free text. */
export function selfTest(run: (text: string) => boolean): { ok: boolean } {
  // A turn that must qualify, and one that must not — the two directions, so a pipeline stuck at
  // "always true" or "always false" is caught.
  const mustQualify = "I switched the join to a membership test because the plurality vote mis-attributed mixed commits";
  const mustReject = "<task-notification>a wrapper long enough to pass every other stage of the pipeline</task-notification>";
  return { ok: run(mustQualify) === true && run(mustReject) === false };
}

/** T3.7 — the question-shaped turn counter (R15). "1.5a counts them; 1.5b decides whether to filter."
 *  Counted, never filtered: an intent-shape filter is exactly the class of lexical heuristic R7 warns
 *  about, so the measurement comes first. Under quotation these are TRUE but useless, not false. */
export function isQuestionShaped(text: string): boolean {
  const t = text.trim();
  if (t.includes("?")) return true;
  return /^(?:can|could|would|should|do|does|did|is|are|was|were|will|why|what|how|when|where|which|who|explain|tell me|show me)\b/i.test(t);
}

/** Serialise for disk. ⚠ The free-text guard is structural, not a convention: every leaf is a number,
 *  a boolean, an enumerated DropReason code (as a KEY), or the version. Nothing here can carry a
 *  turn, a path, a repo name, or a warning string. */
export function serialiseHealth(health: TranscriptHealth): string {
  return JSON.stringify(health, null, 2);
}

export { emptyCounters };
