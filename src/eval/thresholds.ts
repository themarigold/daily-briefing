// src/eval/thresholds.ts — verdictForRuns: the pure threshold policy for the live `bun run eval`
// gate (scripts/eval.ts). Pure/unit-tested (test/eval/thresholds.test.ts); the runner itself
// (which actually spawns the live provider N times) is validated only by a manual smoke.
//
// `runs` is the findings[] from N (=3) independent live runs of ONE gold case. Direction (exact,
// task-10 brief):
//   - a HARD-rule fail-finding (see RULE_TIER / HARD_RULES — do NOT hand-enumerate the set here;
//     the list rotted every time the union widened) in ANY of the runs -> that rule resolves to
//     "fail" -> gate FAILs. A single flaky-looking hallucination on a hard rule is disqualifying —
//     these are the never-acceptable-even-once failure modes.
//   - a SOFT-rule fail-finding (RULE_TIER / SOFT_RULES — currently coverage, structure, redundancy,
//     recency; the Record is the source of truth) in >=2/N runs -> "fail"; in exactly 1/N ->
//     "flaky" (a warn signal surfaced for visibility, NOT a gate fail — softer rules are more
//     sensitive to model non-determinism, so a single miss shouldn't block the gate).
//   - warn-severity findings never fail the gate, on any rule (only `severity: "fail"` findings
//     are counted at all).
//   - `pass` = no rule resolved to "fail" (a "flaky" rule keeps the gate passing).
import type { Finding } from "./types";

export type VerdictLabel = "pass" | "fail" | "flaky";

export type Verdict = {
  pass: boolean;
  perRule: Record<string, VerdictLabel>;
};

// ⚠ THESE TWO SETS MUST COVER `Finding["rule"]` EXHAUSTIVELY. When G5 landed, `eval/types.ts`
// widened that union from six members to TWELVE and this file was not updated, so all six G5 rules
// fell through to the else-branch below — whose comment asserted the branch was unreachable. The
// behaviour was already correct (unknown ⇒ hard ⇒ fails loudly), but the policy was inherited from a
// fallback rather than chosen, and no test covered a G5 rule reaching `verdictForRuns` at all.
//
// G5's six are HARD, decided 2026-08-04 (user-directed, eval-integrity class). The reason is not
// severity-by-vibes: the SOFT tier exists solely to absorb MODEL non-determinism, and whys are a CODE
// projection — `core.ts` assigns them from the transcript after generation and the prompt never asks
// the model for one. So the tier's own rationale barely applies. They are also truthfulness rules: a
// why is the USER'S OWN WORDS quoted back, and misquoting once is disqualifying, not flaky.
// `surface` is the one with a real argument for SOFT — it is the only G5 rule keyed to rendered
// output rather than the projection — and it stays hard because it is precisely the rule that stops
// the tool putting your words somewhere you did not say them. Revisit if it ever proves flaky.
/** ⚠ A `Record` over the FULL union, not two hand-kept Sets — so omitting a rule is a COMPILE error
 *  rather than a silent fallback. That is the whole point: the previous two-Set form let
 *  `eval/types.ts` widen the union from six members to twelve while this file kept classifying six,
 *  and the else-branch below absorbed the other six under a comment asserting it was unreachable.
 *  A test could only have caught that by re-listing the union, which drifts the same way. This
 *  cannot: add a rule to `Finding["rule"]` and `tsc` fails here until it is tiered. */
const RULE_TIER: Record<Finding["rule"], "hard" | "soft"> = {
  attribution: "hard", fabrication: "hard", denylist: "hard", evidence: "hard",
  coverage: "soft", structure: "soft",
  // G5 (whys) — all hard, decided 2026-08-04, user-directed, eval-integrity class. See above.
  anchor: "hard", freshness: "hard", "why-attribution": "hard",
  scope: "hard", verbatim: "hard", surface: "hard",
  // G6 (redundancy) — SOFT, decided 2026-08-10, user-directed, eval-integrity class.
  //
  // ⚠ THE TIER IS NOT THE GATING DECISION HERE, and that distinction is the whole point of this
  // entry. G6 emits `severity: "warn"`, and warn findings never fail the gate on ANY rule (see the
  // header contract above), so today this rule is OBSERVATIONAL: it scores every eval run and
  // reports, but cannot block. The tier only starts to matter if the severity is later raised.
  //
  // Why observational rather than gating: the detector is `postcheck.checkSuggestionRestatement`,
  // whose `RESTATEMENT_THRESHOLD = 0.45` was calibrated on ONE day and 14 pairs (2 true positives,
  // 1 false positive). Hard-gating a release on an n=1 threshold locks it in before it is earned.
  // The plan of record is to read days 26-28 of `postcheck [...]` lines from `briefing.log`, then
  // decide the threshold and the severity together. Raising this to `fail` is a SEPARATE
  // eval-integrity decision — do not do it as a side effect of touching this file.
  //
  // SOFT (not hard) is the right tier for when that day comes: unlike the G5 whys, redundancy IS a
  // model-output property — the prompt asks the model not to restate and the model complies or does
  // not — so it is exactly the model non-determinism the soft tier exists to absorb.
  redundancy: "soft",
  // G7 (recency) — SOFT, decided 2026-08-10, user-directed, same call as G6 and for the same reason.
  //
  // ⚠ Like G6 it emits `severity: "warn"`, so it is OBSERVATIONAL today and the tier only starts to
  // matter if that is raised. But note the asymmetry with G6, because it is easy to get wrong later:
  // `recency` has NO CALIBRATED CONSTANT. It compares `whenMs` to `whenMs` and matches subjects for
  // equality — there is no threshold resting on n=1 to wait for. What holds it at `warn` is NOT
  // uncertainty about the detector; it is that its matcher UNDER-REPORTS by design (a paraphrasing
  // bullet yields no match), so a `fail` would be sound when it fires but silent when it misses.
  // Raising it is therefore a smaller step than raising G6's, and still a separate decision.
  //
  // SOFT is right for the same reason as G6: anchoring on the newest same-day work is a MODEL-OUTPUT
  // property — the prompt says "Where you left off means the NEWEST work" and the model complies or
  // does not — which is exactly the non-determinism the soft tier exists to absorb.
  recency: "soft",
};

/** Exported for the tier tests — asserting on these beats re-listing the union in a fixture. */
export const HARD_RULES: ReadonlySet<string> =
  new Set(Object.keys(RULE_TIER).filter((r) => RULE_TIER[r as Finding["rule"]] === "hard"));
export const SOFT_RULES: ReadonlySet<string> =
  new Set(Object.keys(RULE_TIER).filter((r) => RULE_TIER[r as Finding["rule"]] === "soft"));

export function verdictForRuns(runs: Finding[][]): Verdict {
  // Consider every rule that appears in ANY finding (fail or warn) across the runs — a rule that
  // only ever produced warn findings still gets an explicit "pass" entry, not silence.
  const rules = new Set<Finding["rule"]>();
  for (const run of runs) for (const finding of run) rules.add(finding.rule);

  const perRule: Record<string, VerdictLabel> = {};
  for (const rule of rules) {
    const runsWithFail = runs.filter((run) => run.some((f) => f.rule === rule && f.severity === "fail")).length;
    if (HARD_RULES.has(rule)) {
      perRule[rule] = runsWithFail >= 1 ? "fail" : "pass";
    } else if (SOFT_RULES.has(rule)) {
      perRule[rule] = runsWithFail >= 2 ? "fail" : runsWithFail === 1 ? "flaky" : "pass";
    } else {
      // Unreachable while the two sets cover Finding["rule"] exhaustively — a property now PINNED BY
      // A TEST rather than asserted in a comment, because this comment claimed unreachability for
      // five days while all six G5 rules routed through here. Treat an unrecognized rule as hard
      // rather than dropping it: a rule added to the union without updating this policy should fail
      // loudly, not pass silently.
      perRule[rule] = runsWithFail >= 1 ? "fail" : "pass";
    }
  }

  const pass = !Object.values(perRule).some((v) => v === "fail");
  return { pass, perRule };
}
