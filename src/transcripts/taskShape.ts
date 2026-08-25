// Slice 1.5 T7.7 — the decision-shape filter. ⚠ ADDED AT GATE-R3, user-approved (option B).
//
// WHY IT EXISTS, from the gate's own measured sample: of 14 conservative-curve candidates, ~6 were
// routine TASK INSTRUCTIONS that restate the commit they accompany —
//   "run the day 18 audit, then commit and push any changes to EVAL.md"
//   "update the EVAL.md file with the findings"
//   "fill the day-5 EVAL.md row and do a session update"
// against commits that say exactly that. They are TRUE but USELESS: the residual §3.5 predicts, a
// tidiness failure rather than a truthfulness one. What the gate kept is the opposite shape — turns
// carrying a DECISION or a REQUIREMENT, which commits never carry:
//   "lets go with C (build A now, designed to double as B later)"
//
// ⚠ LEXICAL, NOT SEMANTIC — R7's warning applies here exactly as to the outcome-verb gate, so the
// documented defeats below are part of the deliverable, not a caveat on it. It lands one slice
// earlier than §3.5 planned; T3.7's question-shaped counter measures what it costs.

/** Verbs that open an imperative addressed to the assistant. Matched only at the START of the turn:
 *  a turn that MENTIONS running something ("I ran the migration because…") is real content. */
const TASK_VERBS = [
  "run", "rerun", "re-run", "do", "fill", "update", "commit", "push", "log", "open",
  "add", "create", "write", "make", "fix", "check", "read", "look", "show", "give",
  "continue", "proceed", "go ahead", "carry on", "keep going",
  "start", "execute", "kick off", "begin",
];

const TASK_OPENER = new RegExp(
  `^(?:ok(?:ay)?[,.]?\\s+|yes[,.]?\\s+|now\\s+|then\\s+|also\\s+|please\\s+|lets?\\s+|let's\\s+)*` +
  `(?:${TASK_VERBS.map((v) => v.replace(/[-']/g, "[-']")).join("|")})\\b`,
  "i",
);

/** A turn is DECISION-SHAPED when it carries a choice, a rationale or a requirement. These markers
 *  rescue a turn that merely opens with a task verb but goes on to say WHY. */
const DECISION_MARKERS = /\b(?:because|so that|instead of|rather than|the reason|we should|it should|must|needs? to|prefer|decided|going with|go with|option [a-d]\b|trade[- ]?off)\b/i;

/** True when the turn reads as a routine task instruction that a commit subject already conveys.
 *
 *  ⚠ Documented defeats, measured rather than assumed — these are NOT caught, and saying so is the
 *  point (a filter claimed to close a class it only samples is worse than one with stated limits):
 *   · "Its a new day. Do a bun run audit for today"  — the task verb is not at the start
 *   · "the EVAL.md row needs filling"                — a task, phrased as a statement
 *   · "You should also look through the rest of the spec" — `we/it should` is a decision marker, so
 *     this is deliberately KEPT even though the gate judged it thin */
export function isTaskShaped(text: string): boolean {
  const t = text.trim();
  if (!TASK_OPENER.test(t)) return false;
  if (DECISION_MARKERS.test(t)) return false;   // it opens as a task but carries a reason — keep it
  return true;
}
