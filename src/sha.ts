// src/sha.ts — the ONE commit-SHA shape test, shared by the generator's grounding guard
// (verifyEvidence), the audit's citation miner (extractCitedShas), and — since 2026-08-03 — the
// eval's FABRICATION decision in `eval/checks.ts`. Kept here, not duplicated, so they can NEVER
// disagree: the generator KEEPS a token in rendered evidence iff the audit treats it as a citation.
// When they diverged, the generator's Tier-A fix (correctly keeping prose like "added"/"cafe")
// re-surfaced a stale audit false-positive that flagged the same word as a `fabricated SHA`
// (final-review Tier-D). One function, one truth.
//
// ⚠ THAT HEADER WAS FALSE FOR ~A MONTH, and the correction is the reason this note exists.
// `eval/checks.ts` carried a THIRD copy that never imported this file and applied no `[a-f]`
// requirement at all, so an all-digit token — a date, a timestamp, a PR number — in an evidence
// field became a `fail`-severity G2 fabrication verdict while the generator and the audit both
// correctly ignored it. Converged 2026-08-03. The one thing still NOT shared is the minimum LENGTH:
// the eval's evidence miner keeps a 7-char floor where this file allows 4, deliberately and with the
// measurement recorded at its definition. So: one shape test, one truth — and one documented,
// measured exception rather than a silent fourth divergence.

// 4–40 hex chars — a full or abbreviated git object name (git's default abbrev is 7).
export const SHA_RE = /^[0-9a-f]{4,40}$/i;

// Is `tok` plausibly an (abbreviated) commit SHA, vs. an innocent hex-ish English word or bare number?
// SHA_RE alone matches "2024" (a year), "20260716" (a date), and "added"/"cafe"/"dead"/"decade" (all-[a-f]
// words), which produced FALSE "fabricated SHA" warnings and destructive rewrites. Require at least one
// a–f LETTER (rules out pure numbers like dates/PR#s) AND either a digit or length ≥ 7 (rules out short
// hex-only words like "cafe"/"added", while still catching a mixed abbrev or an all-letter placeholder
// like "deadbeef"). Residual false-positives are only 7+-char all-[a-f] English words (e.g. "defaced"),
// which are vanishingly rare in commit evidence. Prose and file paths pass through.
// Residual false-NEGATIVE (accepted tradeoff): a pure-digit or short all-letter garble is indistinguishable
// from a PR#/date/word and is treated as non-SHA — so it isn't grounding-checked. Symmetric on both sides.
export function isShaShaped(tok: string): boolean {
  if (!SHA_RE.test(tok)) return false;
  if (!/[a-f]/i.test(tok)) return false; // pure numbers (years, dates, PR numbers) are not SHAs
  return /[0-9]/.test(tok) || tok.length >= 7;
}
