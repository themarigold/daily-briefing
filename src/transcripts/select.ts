// Slice 1.5 T2.6 — the substantive-turn pipeline (§3.2).
//
// ⚠ THE ORDER IS NORMATIVE, and it is load-bearing for TELEMETRY, not just for the qualifying set.
// Each stage feeds a distinct DropReason counter that 1.5a exists to produce, so a different order
// yields different telemetry and a different 1.5b decision. It was corrected twice during the spec:
//   · putting the >=40-char rule second makes `continuation-word` and `slash-command` structurally
//     zero, since every continuation word is under 40 characters;
//   · putting the control-byte rule before the cap steals 28.7% of the cap's denominator (long human
//     turns are overwhelmingly multi-line pastes), collapsing `over-cap-turn` from 532 to 54 and
//     making `control-byte` the second-largest bucket — 1.5b would then tune the wrong knob.
// §2.5's measured table is a re-derivation UNDER THIS EXACT ORDER, reconciling to 4 587.
import type { DropReason } from "./scan";

/** §8 plan-time parameters. The spec fixes them at the values §2.5's counts are derived from, so
 *  they are named here rather than inlined: 1.5b tunes them, and a tuned value must not require
 *  hunting for a magic number. ⚠ The EXISTENCE and POSITION of each rule is NOT a parameter. */
export const MIN_TURN_CHARS = 40;
export const MAX_TURN_CHARS = 600;
export const CONTINUATION_WORDS: readonly string[] = ["yes", "ok", "continue", "go ahead", "y", "n", "stop"];

/** ⚠ EXACTLY `stripControl`'s class (`render.ts:17`), and it must stay exactly that class.
 *  `\x7f` (DEL) is neither C0 nor C1 — describing this as "C0/C1" omits it, and a turn containing
 *  U+007F would then clear selection, be silently mutated at render, and persist NOT byte-equal to
 *  its anchor. Any future change to `stripControl` must change this in the same commit. */
export const CONTROL_BYTE_CLASS = /[\x00-\x1f\x7f-\x9f]/;

export type SelectOutcome = { ok: true } | { ok: false; reason: DropReason };

const OK: SelectOutcome = { ok: true };
const drop = (reason: DropReason): SelectOutcome => ({ ok: false, reason });

/** Decide whether ONE human turn is substantive. `text` must be the VERBATIM, untrimmed
 *  `message.content` — the exact bytes `textSha` covers. Trimming is used for the length TESTS only
 *  and never applied to the value, because the emitted text must stay byte-equal to its anchor. */
export function selectTurn(text: string): SelectOutcome {
  const trimmed = text.trim();

  // 1. Not harness-injected. Runs FIRST because a wrapper is routinely long enough and prose-like
  //    enough to pass every other test. The single largest exclusion: 2 125 of 4 587 examined
  //    turns, 46%.
  //    ⚠ PREFIX-based and drops the WHOLE turn — not tag-name-based, not strip-and-retest. A
  //    name-based implementation would miss whatever tag CC adds next. Stated limitation: a turn
  //    beginning with a wrapper could in principle carry real prose after the closing tag; those are
  //    dropped. Fail-closed, per invariant 6.
  if (trimmed.startsWith("<")) return drop("harness-wrapped");

  // 2. Not an enumerated continuation word. Must precede the length floor — every continuation word
  //    is under 40 chars, so a floor-first order zeroes this counter structurally.
  if (CONTINUATION_WORDS.includes(trimmed.toLowerCase())) return drop("continuation-word");

  // 3. Not EXCLUSIVELY a slash-command invocation. Same ordering reason as 2.
  if (isOnlySlashCommand(trimmed)) return drop("slash-command");

  // 4. >= 40 characters after trimming.
  //    ⚠ Measured, the floor is necessary but NOT sufficient: "yes to the hook like and yes to the
  //    one line rename fix." (56 chars) passes it. Sharpening it is 1.5b's call, after 1.5a counts
  //    how often it matters.
  if (trimmed.length < MIN_TURN_CHARS) return drop("turn-too-short");

  // 5. <= 600 characters — a SELECTION filter, not a truncation: an over-cap turn is REJECTED, so
  //    the emitted bytes are exactly the bytes `textSha` covers. Rejects 29.8% of the 1 788 turns
  //    that reach it.
  //    ⚠ Measured on the VERBATIM length, not the trimmed one, because the verbatim string is what
  //    gets emitted. The two differ only by leading/trailing SPACES — every other whitespace byte is
  //    in stage 6's class — but capping on the trimmed value would let a 601-byte turn through as
  //    emittable, which is precisely what "capped is never truncated" forbids.
  if (text.length > MAX_TURN_CHARS) return drop("over-cap-turn");

  // 6. Contains no byte in [\x00-\x1f\x7f-\x9f]. Tested against the VERBATIM, UNTRIMMED content —
  //    the exact bytes `textSha` covers — not the trimmed value.
  //    ⚠ A correctness requirement, not hygiene: `renderBriefing` ends in `L.map(stripControl)` and
  //    `stripControl` deletes this whole class, so a multi-line turn would persist NOT byte-equal to
  //    its anchor — falsifying invariant 5 at sinks 1-3 and making G5's `verbatim` pass on every
  //    single-line fixture while failing 100% in production.
  //    ⚠ It runs LAST, after the cap. Here it rejects 2.79% of the 1 256 turns reaching it — the
  //    true marginal cost of the guarantee.
  if (CONTROL_BYTE_CLASS.test(text)) return drop("control-byte");

  return OK;
}

/** "Exclusively a slash-command invocation" — the whole trimmed turn is one `/command`, optionally
 *  with arguments on the same line. A turn that merely MENTIONS a slash command in prose is real
 *  human content and must survive, so this anchors at the start and rejects embedded newlines. */
function isOnlySlashCommand(trimmed: string): boolean {
  // ⚠ The argument separator is non-newline whitespace only. With a bare `\s+` the separator
  // matched a NEWLINE, so `/loop\n<real prose>` was attributed to `slash-command` instead of
  // falling through to the later stages. Both end in a drop, so the qualifying set is unchanged —
  // but the stage attribution IS the telemetry, and the order is normative precisely because 1.5b
  // reads these buckets.
  return /^\/[A-Za-z0-9][\w:-]*(?:[^\S\n]+\S+)*$/.test(trimmed);
}

/** The six stage codes IN PIPELINE ORDER. Exported so the §5 accounting assertion can sum over a
 *  complete bucket set rather than a hand-written list that can drift from the pipeline. */
export const SELECT_DROP_REASONS: readonly DropReason[] = [
  "harness-wrapped", "continuation-word", "slash-command", "turn-too-short", "over-cap-turn", "control-byte",
] as const;

export type SelectTally = { examined: number; qualified: number; drops: Record<DropReason, number> };

/** Run the pipeline over a batch, tallying every outcome. The §5 accounting assertion is
 *  `sum(six drop buckets) + qualified === examined` — it holds by construction here, and the test
 *  exercises it over a fixture with >=1 turn in every bucket so "by construction" is demonstrated
 *  rather than asserted. */
/** ⚠ TEST-ONLY, and deliberately so. Production runs its OWN per-turn loop in `scan.ts` — which
 *  is why harden r3 added an accounting receipt over THAT loop: asserting the §5 identity here only
 *  ever proved a path the product does not execute. Kept as the batch helper those bucket tests use. */
export function selectAll(texts: string[], drops: Record<DropReason, number>): SelectTally {
  let qualified = 0;
  for (const t of texts) {
    const r = selectTurn(t);
    if (r.ok) qualified++;
    else drops[r.reason]++;
  }
  return { examined: texts.length, qualified, drops };
}
