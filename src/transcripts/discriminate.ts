// Slice 1.5 T2.5 — the §2.3 discriminators. Mechanical, measured, and deliberately dumb: no
// heuristics, no first-line sniffing.
//
// Readable-not-emittable, per §3.3: `toolUseResult`'s PRESENCE (never its content) and
// `message.content`'s TYPE (string vs array, never the array's contents). Those two fields ARE the
// primary discriminator, so this module consults exactly them and nothing more.

export type Line = Record<string, unknown>;

const msg = (l: Line): Record<string, unknown> | undefined => {
  const m = l.message;
  return m && typeof m === "object" && !Array.isArray(m) ? m as Record<string, unknown> : undefined;
};

/** §2.3, measured over 22 725 depth-1 user lines: `toolUseResult` present ⇒ harness plumbing (77.6%);
 *  `message.content` is a plain string ⇒ genuine human-typed turn (20.7%). Text-block-only (1.6%) and
 *  `document` (0.1%) turns are NEITHER — they are not harness, but they are not human prose either,
 *  so they can never supply a why. */
export function isHumanTurn(l: Line): boolean {
  if (l.type !== "user") return false;
  if ("toolUseResult" in l) return false;          // PRESENCE only — the content is not-readable
  return typeof msg(l)?.content === "string";      // TYPE only — an array's contents are not-readable
}

/** The other half of §2.3's discriminator. ⚠ Not called in 1.5a — `isHumanTurn` alone decides what
 *  the pipeline consumes. Kept because it names the 77.6% majority shape explicitly and is what the
 *  discriminator tests assert against; a reader should not have to infer "harness" from "not human". */
export function isHarnessTurn(l: Line): boolean {
  return l.type === "user" && "toolUseResult" in l;
}

/** ⚠ VALUE, not presence. §2.3 measured the field present on 100% of user lines, with the value
 *  `false` on 22 725/22 725 depth-1 and `true` on 47 674/47 674 subagent lines — zero exceptions
 *  either way. Reading it as presence ("`isSidechain` in l") is therefore ALWAYS true and silently
 *  classifies every depth-1 line as a subagent line; the presence statistic reads as "always the
 *  same, therefore useless", which is the exact opposite of the truth. */
export function isSubagentLine(l: Line): boolean {
  return l.isSidechain === true;
}

/** ⚠ AUTOMATED PROMPTS — a turn produced by a SCRIPT, not typed by a person.
 *
 *  §2.3's shape discriminator cannot see this: a headless job's prompt is plain string content with
 *  no `toolUseResult`, so it looks exactly like a human turn. Measured on the author's machine over a
 *  2.1-day window: **6,573 of 6,840** in-window human-SHAPED turns came from automated jobs
 *  (`vault_autolog`, `ai_news`, `/loop`), each a ~1,445-char template.
 *
 *  `promptSource` separates the two populations EXACTLY — 6,573/6,573 automated turns carry `"sdk"`,
 *  and zero human-typed turns do (they carry `typed`, `suggestion_accepted`, or nothing).
 *
 *  ⚠ This AMENDS §3.6, which declined to exclude this traffic on the grounds that it is "other tools
 *  whose transcripts are legitimate evidence". That reasoning assumes a HUMAN USING another tool; the
 *  measurement says otherwise — these are jobs where nobody typed. User-directed, 2026-08-03.
 *
 *  ⚠ Keyed on `promptSource`, NOT on `entrypoint: "sdk-cli"`, and the difference is load-bearing:
 *  `promptSource` is per-TURN, so a human who types into a headless session is still heard, whereas
 *  an entrypoint check would discard the whole session. §2.3 dismissed `promptSource` as carrying no
 *  signal — true of the harness-vs-human question it was asked about, false here.
 *
 *  ⚠ NOT counted as a `DropReason`. This is a discriminator, in the same tier as `isSidechain` and
 *  `isCompactSummary` — the turn was never a candidate. Adding a code would mean a seventeenth
 *  enumerated value outside the closed set and would falsify §5's six-bucket accounting. */
export function isAutomatedPrompt(l: Line): boolean {
  return l.promptSource === "sdk";
}

/** An additional exclusion, NOT the filter — 34 occurrences, 0.15% (§2.3). Kept separate from
 *  `isHumanTurn` so the two are not confused: a compact summary IS shaped like a human turn. */
export function isExcludedMeta(l: Line): boolean {
  return l.isCompactSummary === true || l.isMeta === true;
}

/** The verbatim turn text, or null when the line is not a human turn. This is the ONLY string this
 *  module hands out, and it is unmodified — pre-cap, pre-trim, pre-normalise — because it is the
 *  byte domain `textSha` covers (§3.2). */
export function humanTurnText(l: Line): string | null {
  if (!isHumanTurn(l)) return null;
  return msg(l)!.content as string;
}
