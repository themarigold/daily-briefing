// src/eval/posture.ts — C2: let the release gate state the security posture it measured.
//
// WHY THIS EXISTS. After C1 the provider can end up with more authority than the default without anyone
// noticing: a capability-probe anomaly, a `--help` that hides `--tools` (claude 2.1.220 hides ~45 flags,
// so this is a stable per-version state, not a race), a user's own conflicting argv, `provider.harden:
// false`, or the B6 ladder latching hardening off mid-run. Each raises a `runtimeWarnings` entry, and the
// eval and audit reports were dropping all of them.
//
// The claim this supports is deliberately narrow. A partially-unhardened run probably produces IDENTICAL
// briefing text on synthetic gold cases, so this is not about contaminated numbers. It is about
// provenance: an `EVAL.md` row recorded under unknown hardening cannot honestly be compared with a later
// one. A gate that cannot state the posture it measured is not a gate.

import { stripControl } from "../render";

/** Substrings marking a warning as speaking to hardening posture.
 *
 *  MY FIRST VERSION OF THIS LIST WAS WRONG, and the way it was wrong is the reason it now looks like
 *  this. It matched 7 of the 14 warnings the provider stack actually emits. Six of the seven misses were in the
 *  dangerous direction — a run whose working directory was never narrowed reported `posture: full`. (The
 *  seventh, the argv-widening warning, says "hardening still applies" in its own text, so it misdescribed
 *  the provider's AUTHORITY rather than its hardening — worth stating precisely rather than rounding up.) The comment
 *  defending it argued that a machine-readable channel would be "two things to keep in sync"; an ad-hoc
 *  substring list in a *different file* is precisely that, and it had already drifted before shipping.
 *
 *  Two changes rather than just adding the missing entries: the vocabulary is now grouped by the FAMILY
 *  of warning it covers, so a gap is visible by reading; and `test/posture.test.ts` parses `harden.ts`'s
 *  SOURCE — of both `harden.ts` and `provider.ts`, and including the `warning:` returns that reach a
 *  push site only through a variable — and fails if any goes unmatched. That mechanical guard is the actual fix — the
 *  list will drift again otherwise, because nothing about adding a warning prompts you to come here. */
const POSTURE_MARKERS = [
  // flag injection: disabled, failed, skipped, partial
  "provider hardening",
  "did not inject",
  "rejected an injected",
  "hardening flags are disabled",
  // authority widened by the user's own argv
  "widens what the provider can do",
  // the private working directory: not narrowed, degraded to a fallback, refused, or lost mid-run.
  // The broadest entry here, and substring matching over interpolated text is in principle spoofable —
  // core.ts's drift warning embeds git-status filenames, so a file literally named "working directory"
  // would flip a row. Left as is: the failure direction is CONSERVATIVE (a false `degraded`, never an
  // unearned `full`), and narrowing the marker to buy back a contrived case would risk the direction
  // that actually matters.
  "working directory",
] as const;

/** Exported for the source-parsing coverage test — the guard against this list drifting again. */
export const isPostureWarning = (w: string) => POSTURE_MARKERS.some((m) => w.includes(m));

/** The one warning the provider raises that is deliberately OUTSIDE the posture vocabulary: it
 *  describes a broken output STREAM, not the provider's authority. Classifying it as posture would
 *  blame hardening for a pipe problem and flip EVAL.md rows to `degraded`.
 *
 *  The sentinel is duplicated — it also appears inline at the emission site in `provider.ts`, because
 *  test/posture.test.ts scans source for warning LITERALS and a helper call would be invisible to it.
 *  That duplication is the price of the guard being able to see the channel at all, and
 *  `test/provider.incomplete-read.test.ts` pins that the emitted text still contains this substring. */
export const TRUNCATION_SENTINEL = "its output stream never closed";
export const isTruncationWarning = (w: string) => w.includes(TRUNCATION_SENTINEL);

/** ` · truncated` when any warning says the output was cut off, else "". NOT exported and NOT a
 *  separate call: it is folded into `postureLine` below. It began life as a sibling helper, and every
 *  one of the seven call sites was `postureLine(w) + truncationMark(w)` — which then needed a static
 *  source-scanning test whose only job was policing that nobody forgot the `+`. A guard invented to
 *  defend a duplication is a sign the duplication should not exist. */
const truncationMark = (warnings: readonly string[]): string =>
  warnings.some(isTruncationWarning) ? " · truncated" : "";

/** `harden: false` is a deliberate choice; everything else in this family is a malfunction. Reporting
 *  both as "degraded" would make a considered configuration look like a broken machine. */
const isOptOut = (w: string) => w.includes("DISABLED by config");

/** A non-claude CLI gets no flags by design — expected, not a malfunction. Same carve-out reasoning as
 *  the opt-out: without it a codex user reads `degraded` on every row forever, which dilutes the one
 *  signal this field exists to carry. */
const isUnhardenable = (w: string) => w.includes("is not recognised as the claude CLI");

/** One word for the posture: `full`, `off (by config)`, or `degraded`. */
export function posturePhrase(warnings: readonly string[]): string {
  const relevant = warnings.filter(isPostureWarning);
  if (relevant.length === 0) return "full";
  // Both carve-outs describe EXPECTED states, so a run containing only expected states is not degraded —
  // reporting it as such would be the same misreport the carve-outs exist to prevent, just with two of
  // them present instead of one. The explicit config choice dominates when both apply.
  const isExpected = (w: string) => isOptOut(w) || isUnhardenable(w);
  if (relevant.every(isExpected)) {
    return relevant.some(isOptOut) ? "off (by config)" : "unhardened (non-claude CLI)";
  }
  return "degraded";
}

/** A compact one-liner for `EVAL.md`'s Notes column and the audit report.
 *
 *  Folded into Notes rather than given its own column, deliberately: the value is the boring word "full"
 *  on almost every run, and an eighth column would reshape every historical row of a hand-maintained
 *  table to carry it. But `degraded` alone would leave a reader unable to compare two rows, so the
 *  degraded form names WHAT was lost. */
export function postureLine(warnings: readonly string[]): string {
  const phrase = posturePhrase(warnings);
  // Truncation is NOT a posture warning — it describes a broken output stream, not the provider's
  // authority — but it rides this line because this is the line every report already records. Without
  // it a truncated run renders `posture: full` and is scored as a normal briefing: the exact
  // provenance hole C2 closed for hardening, reopened one warning later for streams.
  const cut = truncationMark(warnings);
  if (phrase === "full") return `posture: full${cut}`;
  if (phrase === "unhardened (non-claude CLI)") return `posture: ${phrase}${cut}`;
  const detail = [...new Set(warnings.filter(isPostureWarning))]
    .map(cellSafe)
    .join(" · ");
  return truncate(`posture: ${phrase}${cut} — ${detail}`, 190);
}

/** Make a warning safe to embed in a markdown table CELL, and readable on a console.
 *
 *  The pipe matters and is not hypothetical: `provider.ts` builds its diagnostic by joining stderr and
 *  stdout with " | ", `harden.ts` interpolates that into the flag-rejection warning, and the resulting
 *  EVAL.md row was measured carrying 9 pipes where a 7-column row needs 8 — silently corrupting the very
 *  table this feature exists to make trustworthy. Substituted rather than backslash-escaped, because the
 *  same string is also printed to a console where `\|` reads as noise. */
function cellSafe(w: string): string {
  // stripControl FIRST: ESC and BEL are not `\s`, so the whitespace collapse never touched them, and
  // unlike audit.ts (whose report goes through stripControlLines) `scripts/eval.ts` sanitizes nothing
  // anywhere. The chain is real — a commit subject reaches the model, the model's partial output reaches
  // provider.ts's diagnostic, harden.ts embeds that in the latch warning, and it lands in the operator's
  // terminal and the row they paste into EVAL.md.
  // Collapse whitespace FIRST, then strip: doing it the other way deleted newlines outright, so
  // `line one\nline two` came out as `line oneline two` (measured). `\s` covers U+2028/U+2029 too, so the
  // Unicode line separators are handled by the same pass; stripControl then removes ESC/BEL, which are
  // not whitespace and therefore survive the collapse.
  return stripControl(w.replace(/\s+/g, " ")).replace(/\|/g, "/").trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = max - 1;
  // Back off if the cut would leave a DANGLING half of a surrogate pair — either direction. Checking only
  // the trailing high surrogate is the obvious version and is not sufficient on its own.
  if (/[\uD800-\uDBFF]/.test(s.charAt(cut - 1))) cut -= 1;
  else if (/[\uDC00-\uDFFF]/.test(s.charAt(cut - 1)) && /[\uD800-\uDBFF]/.test(s.charAt(cut - 2))) { /* whole pair kept */ }
  return `${s.slice(0, cut)}…`;
}

/** Read `warnings`/`runtimeWarnings` off anything that might carry them, and de-duplicate.
 *
 *  Three sources, because a warning can hide in three places: the SUCCESS path stashes them in
 *  `struct.warnings` (core.ts folds the provider's in); the FAILURE path attaches them to the thrown
 *  `ProviderError`; and a judge provider — a second `hardenedProvider` that never passes through
 *  `runCore` — keeps them only on its own `runtimeWarnings`.
 *
 *  Total by contract: it is called on an unknown caught value and on providers that may be plain
 *  `Provider` stubs, so it must never throw. A reporting helper that crashes the reporter is worse than
 *  no report at all. */
export function mergeWarnings(...sources: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    // Per-source try/catch, because "never throws" was aspirational rather than true: a throwing getter
    // or a hostile Proxy made property access itself throw. This runs inside eval.ts's catch on an
    // UNKNOWN caught value, in a `main()` with no outer `.catch` — so an exotic thrown object would have
    // taken down the reporter WHILE it was reporting an error. Per-source, not per-call, so one bad
    // source cannot hide the warnings carried by the others.
    try {
      if (src === null || typeof src !== "object") continue;
      for (const key of ["warnings", "runtimeWarnings"] as const) {
        const v = (src as Record<string, unknown>)[key];
        if (!Array.isArray(v)) continue;
        for (const w of v) {
          if (typeof w !== "string" || seen.has(w)) continue;
          seen.add(w);
          out.push(w);
        }
      }
    } catch { /* unreadable source — a reporting helper must not crash the reporter */ }
  }
  return out;
}
