// Slice 1.5 T3.6 — the outcome-verb suppression function.
//
// ONE implementation, TWO call sites: 1.5a runs it to populate the `outcome-verb` drop code
// (T3.6a's call site in the join), and 1.5b's G5 `scope` check re-invokes this same function. Its
// own module precisely so the two cannot drift.
//
// ⚠ LEXICAL, NOT SEMANTIC, and the limits are documented rather than papered over: "turned out to be
// a stale cache entry" and "sussed it out — was the token TTL" both defeat it. Under quotation the
// consequence of a miss is different IN KIND from a paraphrase: the briefing quotes something the
// user ACTUALLY WROTE that happens to describe an outcome. That is a tidiness failure, not a
// truthfulness one — which is why R7 is downgraded and this filter stays deliberately small.

/** Enumerated English completion verbs/phrases. Word-boundary matched, case-insensitive. */
export const OUTCOME_VERBS: readonly string[] = [
  "fixed", "fixes", "solved", "resolved", "done", "finished", "completed",
  "works now", "working now", "it works", "that worked", "all good", "all set",
  "shipped", "merged", "landed", "closed", "sorted", "nailed it", "got it working",
];

const PATTERN = new RegExp(
  `\\b(?:${OUTCOME_VERBS.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")).join("|")})\\b`,
  "i",
);

/** True when the turn reads as reporting an OUTCOME rather than stating intent. A hit drops that
 *  unit's why (never the bullet, never the run). */
export function hasOutcomeVerb(text: string): boolean {
  return PATTERN.test(text);
}
