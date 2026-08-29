// src/postcheck.ts — DETERMINISTIC checks on the RENDERED briefing, not on the prompt.
//
// ⚠ WHY THIS MODULE EXISTS, and it is the whole design rationale (EVAL.md day 25).
// Two defects shipped 2026-08-09 as PROMPT CLAUSES, each with a test that asserted the CLAUSE WAS
// PRESENT IN THE PROMPT:
//
//   #157 `7d875dc` — "a suggestion must NOT restate a RESUME bullet"   (generator.ts +1 line)
//   #155 `99eff57` — RESUME must anchor on the NEWEST same-day work    (generator.ts:167)
//
// Both suites were GREEN. On 2026-08-10 the model ignored both: every suggestion restated a RESUME
// bullet, and RESUME anchored on the OLDEST same-day commit for two units out of two (`3fcc1d2`
// 00:09, oldest of 11; `e5f3650` 04:04, superseded 27 minutes later) — even though `buildDoneBlock`
// hands the model those items ALREADY SORTED NEWEST-FIRST under a cap of 30 that truncated nothing.
//
// So the data was right, the ordering was right, the instruction was right, and the output was
// wrong. A prompt-text assertion cannot tell "the model obeyed" from "the model ignored it" — it is
// a test answering a question adjacent to the one asked. These checks read the OUTPUT instead, so
// they are falsifiable by a fixture rather than by waiting for a live morning.
//
// ⚠ TIER: these are DIAGNOSTICS, not a gate. They run ONLY at the foot of `runCore` (core.ts) —
// they were inside `generateBriefing` until 2026-08-11, and that placement graded a struct two
// later writers had not finished building; see the tombstone in generator.ts —
// and print `postcheck [rule]: …` to stderr / briefing.log. They are NOT wired into
// `scripts/audit.ts`, do NOT join the audit's deterministic list, and therefore do NOT move
// `flagCount` — by absence from audit, not by an INFO-prefix mechanism. Promoting either to a
// counted defect (or wiring them into audit) changes what an EVAL row's flag count means and is an
// eval-integrity decision for the operator, not a code change to make quietly.

import { norm } from "./subprojects";
import { STAGE1_TEXT_CAP } from "./reduce";
import type { DoneItem } from "./types";

// Re-exported so this module's tests and callers keep one import site; the DEFINITION is in
// ./types, because four other places spelled the same shape inline (see the comment there).
export type { DoneItem };
export type ResumeBullet = { repo: string; text: string };
/** `promoted?` mirrors `BriefingStruct.suggestions` (types.ts) — the CODE-BUILT channel added by
 *  `promoteResumeActions` (S1). Carried here because `checkSuggestionRestatement` must be able to
 *  tell the two channels apart; see the skip at its head. */
export type Suggestion = { text: string; promoted?: true };

/**
 * THE ONE DEFINITION of how a DONE subject is rendered into the prompt — i.e. exactly what the model
 * is shown. `buildDoneBlock` (generator.ts) renders with it; `checkResumeFreshness` below matches a
 * model's quotation against it. Those were TWO COPIES and they had ALREADY DRIFTED: the renderer
 * collapsed newlines BEFORE slicing, the matcher sliced the raw subject. Since `norm()` does not
 * collapse internal whitespace, any subject containing a newline rendered one way and was compared
 * another, and the freshness check would silently skip that bullet.
 *
 * ⚠ IT IS UNREACHABLE TODAY, AND THAT IS EXACTLY WHY IT IS EXTRACTED RATHER THAN LEFT ALONE.
 * `today` holds only git commits (`extractor.ts:205`) and every commit text is read with `%s`, which
 * git guarantees is a single line — so no subject currently contains a newline. The matcher was
 * therefore correct BY AN INVARIANT RECORDED NOWHERE, two files away from the code that maintains
 * it. The day `today` gains a non-commit activity (a transcript line, a stash body), the check
 * degrades silently and no test fails. One definition removes the coupling instead of documenting it.
 */
export const doneSubjectAsShown = (subject: string): string =>
  subject.replace(/[\r\n]+/g, " ").slice(0, STAGE1_TEXT_CAP);

export type PostFinding = {
  rule: "resume-stale" | "suggestion-restates" | "suggestion-restates-near";
  detail: string;
  /** true = calibration telemetry, not a finding. Printed as `postcheck-info [rule]` (core.ts) so the
   *  EVAL convention `grep -c "postcheck \["` — and everything downstream of it — counts nothing new. */
  info?: boolean;
};

// Words carrying no topical signal. Deliberately SMALL: an over-eager list silently converts a real
// overlap into a miss, and this check's failure mode should be a false positive (visible, INFO-only)
// rather than a false negative (invisible, which is what the prompt clause already gave us).
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "with", "from", "into", "onto", "that", "this",
  "these", "those", "it", "its", "is", "was", "are", "were", "be", "been", "being", "as", "at",
  "by", "in", "of", "on", "to", "up", "off", "out", "so", "if", "then", "than", "not", "no",
  "you", "your", "yet", "still", "now", "today", "yesterday", "left", "resume", "resuming",
  "here", "there", "what", "which", "who", "when", "where", "how", "why", "do", "does", "did",
  "has", "have", "had", "will", "would", "can", "could", "should", "next", "more", "one", "own",
]);

/**
 * Topical tokens: lowercased, markdown stripped, stopwords and 1-2 char noise dropped.
 *
 * ⚠ SPLITS ON UNICODE letters/numbers (`\p{L}\p{N}`), not `a-z0-9`. The ASCII form silently
 * destroyed every non-Latin briefing — MEASURED before the fix:
 *
 *   "café résumé naïve déployé"  ->  { caf, sum, ploy }   (accents split words mid-token)
 *   "исправить ошибку"           ->  { }                  (zero tokens)
 *   "認証リファクタを完了する"       ->  { }                  (zero tokens)
 *
 * Zero tokens means `containment` returns 0 and BOTH checks silently no-op — no crash, no signal,
 * no way to tell from the outside. On a public cross-platform product that is the same
 * fails-invisibly class this whole module exists to catch, one layer out.
 *
 * ⚠ HONEST LIMIT, not fixed here: scripts without word separators (Chinese, Japanese, Thai) now
 * yield ONE long token per run rather than zero. That is strictly better — a run can at least match
 * an identical run — but it is not segmentation, so containment stays coarse there. Real CJK
 * segmentation needs a dictionary or Intl.Segmenter and is out of scope for a diagnostic.
 */
export function contentTokens(s: string): Set<string> {
  const cleaned = s.toLowerCase().replace(/[`*_]/g, " ");
  const raw = cleaned.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return new Set(raw.filter((t) => t.length > 2 && !STOPWORDS.has(t)));
}

/**
 * CONTAINMENT, not Jaccard: |A∩B| / min(|A|,|B|).
 *
 * ⚠ Jaccard is the wrong metric here, and choosing it would have MISSED the worse of the two live
 * defects. A suggestion is typically much shorter than the RESUME bullet it restates, so the union
 * is dominated by the bullet's extra prose. MEASURED on the 2026-08-10 briefing:
 *
 *   pair                          containment   jaccard
 *   quant_stocks  (escalation)        0.667       0.455
 *   vault_autolog (near-verbatim)     0.636       0.350   <- Jaccard sinks the WORSE offender lower
 *
 * Under Jaccard at this module's 0.45 threshold the escalation case clears by 0.005 and the
 * near-verbatim case is MISSED outright. Containment asks the question actually being asked: "is the
 * shorter text essentially a subset of the longer one?"
 */
export function sharedTokens(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

export function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  return sharedTokens(a, b) / Math.min(a.size, b.size);
}

/**
 * ⚠ THE ABSOLUTE FLOOR THAT MAKES THE RATIO MEANINGFUL. Containment divides by `min(|A|,|B|)`, so a
 * SHORT suggestion quantizes hard: with k topical tokens the only achievable scores are multiples of
 * 1/k — a 1-token suggestion scores exactly 0 or **1.000**, clearing any threshold on a single
 * coincidental word. MEASURED on this repo's own fixtures:
 *
 *   pair                                          |A|   shared   containment
 *   quant_stocks  (TRUE positive, 2026-08-10)      15      10        0.667
 *   vault_autolog (TRUE positive, 2026-08-10)      11       7        0.636
 *   "open the PR for feature/auth" (FALSE pos)      3       2        0.667   <- same score, no signal
 *
 * The two real restatements share 7 and 10 tokens; the false positive shares 2. A floor of 4 sits in
 * the empty band between them and, by construction, no suggestion with fewer than 4 topical tokens
 * can ever trip the check. ⚠ n is small (2 true, 1 false) — like the threshold itself this is
 * provisional, which is why the whole module ships INFO-only.
 */
export const MIN_SHARED_TOKENS = 4;

/**
 * MEASURED against the 2026-08-10 briefing (2 suggestions x 7 RESUME bullets, all 14 pairs scored):
 *   0.667  quant_stocks   suggestion vs its RESUME bullet  — judge: a genuine escalation, still 1:1 derived
 *   0.636  vault_autolog  suggestion vs its RESUME bullet  — judge: "near-verbatim restatement"
 *   0.143  highest score against any NON-corresponding bullet — the noise floor
 *
 * ⚠ Scored against the bullet text with the `[label]` prefix STRIPPED, as `parseBriefing` stores it.
 * A first pass measured 0.800/0.727 by leaving the label in, which inflated every pair sharing a
 * repo name — the unit test pinning these numbers is what caught it.
 *
 * Both true positives sit above 0.63 and the nearest false positive is 0.143, so the threshold is
 * placed in a ~0.49-wide empty band rather than balanced on an edge. ⚠ n=1 day, 14 pairs. It will
 * need re-checking once several days of INFO output exist — which is why this ships INFO-only.
 */
export const RESTATEMENT_THRESHOLD = 0.45;

/**
 * Calibration floor for NEAR-MISS telemetry (decided 2026-08-18, user-directed — option A of the
 * day-33 threshold decision). The corpus that has to justify moving RESTATEMENT_THRESHOLD grew by
 * five points in 33 days because only tripping pairs were ever logged; day 33's 0.423 arguable case
 * was invisible until measured by hand. Every run now logs each suggestion's BEST pair when it
 * scores >= this floor but is NOT a finding — as `info` telemetry (`postcheck-info` prefix), which
 * the EVAL flag-count convention deliberately does not match. The threshold itself is UNCHANGED;
 * revisit with ~2 weeks of near-miss data. 0.30 sits above the measured noise floor (0.143) with
 * room to see the whole contested region below 0.45.
 */
export const NEAR_MISS_FLOOR = 0.30;

/**
 * #157, moved from prompt to output. Flags any suggestion that is substantially a restatement of a
 * RESUME bullet. Reports the single strongest match per suggestion — a suggestion overlapping two
 * bullets is one defect, not two.
 */
export function checkSuggestionRestatement(
  suggestions: readonly Suggestion[],
  resume: readonly ResumeBullet[],
): PostFinding[] {
  const out: PostFinding[] = [];
  const resumeTokens = resume.map((r) => ({ r, tok: contentTokens(r.text) }));
  for (const s of suggestions) {
    // ⚠ SKIP THE CODE-BUILT CHANNEL (S1). A `promoted: true` suggestion is the VERBATIM tail of a
    // RESUME bullet, so it restates one BY CONSTRUCTION and would score at or near 1.000 every single
    // morning. This rule (#157) exists to catch the MODEL padding SUGGESTIONS with RESUME prose; a
    // deterministic promotion is the opposite — a deliberate carry-down the day-43 judge asked for,
    // labelled `(from resume)` in the render so the reader is never misled about where it came from.
    //
    // The skip covers the near-miss telemetry below as well, and that is the load-bearing half: the
    // NEAR_MISS_FLOOR corpus is what a future move of RESTATEMENT_THRESHOLD will rest on, and seeding
    // it with a guaranteed-1.000 pair every run would poison exactly the calibration data
    // NEAR_MISS_FLOOR was added (2026-08-18) to collect. Neither threshold changes here.
    //
    // ⚠ TWO CALL SITES, AND THE SECOND IS AN EVAL CHECK — this skip narrows both. `g6Redundancy`
    // (src/eval/checks.ts) reuses THIS function deliberately, so that "restatement" has one
    // definition on the delivery path and in the harness; the consequence is that a `promoted`
    // suggestion is now invisible to G6 as well as to the morning diagnostic. G6 is severity `warn`
    // and is in SOFT_RULES, so it reports and never gates — nothing that could pass a run starts
    // passing because of this. ⚠ The behaviour is PENDING OPERATOR ACK: narrowing what an eval check
    // observes is an eval-integrity decision, not a refactor, and it is recorded here rather than
    // decided here. No threshold, gold fixture or severity is touched by this change; the pin lives
    // in test/eval/checks.g6.test.ts so the narrowing is visible rather than implicit.
    if (s.promoted) continue;
    const sTok = contentTokens(s.text);
    let best: { score: number; shared: number; bullet: ResumeBullet } | undefined;
    for (const { r, tok } of resumeTokens) {
      const score = containment(sTok, tok);
      if (!best || score > best.score) best = { score, shared: sharedTokens(sTok, tok), bullet: r };
    }
    // BOTH gates: a high ratio on 2-of-3 tokens is arithmetic, not evidence (see MIN_SHARED_TOKENS).
    if (best && best.score >= RESTATEMENT_THRESHOLD && best.shared >= MIN_SHARED_TOKENS) {
      out.push({
        rule: "suggestion-restates",
        // Both numbers are printed because the promotion decision needs the calibration data, and a
        // ratio without its shared-token count is exactly what made the fixture FP look convincing.
        detail: `suggestion restates a RESUME bullet (${best.score.toFixed(2)} containment, ${best.shared} shared tokens, [${best.bullet.repo}]): "${clip(s.text)}" vs "${clip(best.bullet.text)}"`,
      });
    } else if (best && best.score >= NEAR_MISS_FLOOR) {
      // Near-miss telemetry (info, never a finding): the pair that DIDN'T trip, with the same two
      // numbers, so the threshold decision accumulates a point every morning instead of only on the
      // mornings the bar trips. Includes pairs blocked solely by the token floor — whether
      // MIN_SHARED_TOKENS is ever the binding gate is itself calibration data (days 28-30 vs 27/31).
      out.push({
        rule: "suggestion-restates-near",
        info: true,
        detail: `below threshold (${best.score.toFixed(2)} containment, ${best.shared} shared tokens, [${best.bullet.repo}]): "${clip(s.text)}" vs "${clip(best.bullet.text)}"`,
      });
    }
  }
  return out;
}

/** Backtick-quoted commit subjects a RESUME bullet cites, e.g. ``per today's `docs(state): …` ``. */
export function quotedSubjects(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim()).filter((s) => s.length > 0);
}

/**
 * #155, moved from prompt to output. For each RESUME bullet that cites a same-day commit subject,
 * flags when a NEWER same-day commit exists for the same unit — i.e. the bullet anchored on stale
 * work while fresher work sat in the very block handed to the model.
 *
 * ⚠ Matching is by SUBJECT EQUALITY against the DONE items, not fuzzy. A bullet that paraphrases
 * rather than quotes yields no match and is silently skipped: this check UNDER-reports by design.
 * Over-reporting here would mean accusing well-grounded prose of staleness, which is worse than
 * missing a paraphrase — and the paraphrase case is exactly what the judge is for.
 */
export function checkResumeFreshness(
  resume: readonly ResumeBullet[],
  done: readonly DoneItem[],
): PostFinding[] {
  const out: PostFinding[] = [];
  // Newest same-day item per unit label.
  const newestFor = new Map<string, DoneItem>();
  for (const d of done) {
    // ⚠ A NON-FINITE `whenMs` POISONS THE WHOLE UNIT, so it is skipped rather than compared.
    // `whenMs` is `new Date(a.timestamp ?? 0).getTime()` (core.ts), which is NaN whenever a
    // timestamp is present but unparseable. Every comparison against NaN is false, so a NaN item
    // arriving first would stay "newest" forever AND `cited.whenMs < NaN` would be false — silently
    // suppressing every freshness finding for that unit. A diagnostic that disables itself on bad
    // input is worse than one that skips the bad input, because the silence looks like a pass.
    if (!Number.isFinite(d.whenMs)) continue;
    const k = norm(d.label);
    const cur = newestFor.get(k);
    if (!cur || d.whenMs > cur.whenMs) newestFor.set(k, d);
  }
  for (const r of resume) {
    const newest = newestFor.get(norm(r.repo));
    if (!newest) continue;
    // ⚠ Take the NEWEST item the bullet cited, across ALL its quoted subjects. Two defects both
    // reduce to this, and both were live before:
    //  (a) `done.find(...)` returned the FIRST subject match, so two same-day commits sharing a
    //      subject ("wip", a retry, a recurring bot subject) made the verdict depend on array
    //      order — older-first flagged, newer-first did not. Reproduced.
    //  (b) flagging on the first stale quoted span meant a bullet saying "finished `old`, then
    //      landed `new`" was called stale while explicitly anchoring on the newest. Reproduced.
    // Comparing the bullet's newest citation against the unit's newest commit answers the question
    // actually being asked: did this bullet reach the front of the work, by any of its citations?
    // ⚠ Matches the FULL subject or its prompt-visible RENDERING. `buildDoneBlock` transforms
    // subjects before the model ever sees them (generator.ts), so a model faithfully quoting what it
    // was shown produces the transformed string — which never equals the full subject stored here,
    // and the check silently under-reported. Rare (1 of 1184 subjects in this repo exceeds the cap)
    // but free to close, and the asymmetry itself is the bug.
    const citedBy = (d: DoneItem, q: string) =>
      norm(d.subject) === norm(q) || norm(doneSubjectAsShown(d.subject)) === norm(q);
    // ⚠ THE SAME NON-FINITE GUARD AS `newestFor` ABOVE, and it is needed on BOTH sides. Guarding
    // only the newest-per-unit map left this reduce with the identical defect its own seed makes
    // worse: `!acc` accepts a NaN item unconditionally when it arrives first, every later
    // `d.whenMs > NaN` is false so it is never displaced, and `cited.whenMs < newest.whenMs` is then
    // `NaN < finite` — false. The unit's freshness finding is silently suppressed, which is exactly
    // the self-disabling failure the comment above rejects, and it is array-order-dependent, which
    // is defect (a) directly below returning by another route. Reproduced 2026-08-11.
    const cited = quotedSubjects(r.text)
      .flatMap((q) => done.filter((d) => Number.isFinite(d.whenMs) && norm(d.label) === norm(r.repo) && citedBy(d, q)))
      .reduce<DoneItem | undefined>((acc, d) => (!acc || d.whenMs > acc.whenMs ? d : acc), undefined);
    if (!cited) continue;                       // paraphrase, or quotes nothing we recognise
    if (cited.whenMs < newest.whenMs) {
      out.push({
        rule: "resume-stale",
        // "work", not "commit": todaySuppress also carries same-day MERGES as `Merged #N (branch)`
        // (core.ts), so `newest` is not necessarily a commit and naming it one would be a small
        // instance of the very class this row keeps recording — a field describing something
        // narrower than what it actually holds.
        detail: `[${r.repo}] RESUME anchors on "${clip(cited.subject)}" but NEWER same-day work exists: "${clip(newest.subject)}" (${Math.round((newest.whenMs - cited.whenMs) / 60000)} min later)`,
      });
    }
  }
  return out;
}

const clip = (s: string, n = 90) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
