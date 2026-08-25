// Slice 1.5 T7.1 — the quotation frame, as an exported constant PAIRED WITH A PARSER.
//
// ⚠ The pairing is the point (§3.5 rule 5). §6's audit-side `surface` check and T8.1a's content
// search both have to strip this frame back off to recover the bare turn. Letting `render.ts` and
// `checks.ts` each encode the affix independently degrades that detector to a prefix coincidence —
// they drift, and the check starts passing on text it no longer actually recognises.
//
// The exact wording is a §8 plan-time parameter; that it round-trips is not.

/** Rendered at the same indent as the bullets it introduces, WITHOUT repeating the `[label]` —
 *  every bullet already carries one. */
export const WHY_INDENT = "   ";
export const WHY_PREFIX = `${WHY_INDENT}— you wrote: "`;
export const WHY_SUFFIX = `"`;

/** Frame a bare turn into the line `render.ts` emits. */
export function renderWhy(turn: string): string {
  return `${WHY_PREFIX}${turn}${WHY_SUFFIX}`;
}

/** Recover the bare turn, or null when the line is not a why line.
 *
 *  ⚠ Uses the LAST suffix, not the first: a turn may itself contain a double quote, and a
 *  first-match parse would truncate at the turn's own quote and silently return a fragment — which
 *  would then fail byte-equality against `textSha` and look like a corruption bug rather than a
 *  parsing one. */
export function parseWhy(line: string): string | null {
  if (!line.startsWith(WHY_PREFIX)) return null;
  const end = line.lastIndexOf(WHY_SUFFIX);
  if (end < WHY_PREFIX.length) return null;
  return line.slice(WHY_PREFIX.length, end);
}

/** True when the line is a rendered why. */
/** ⚠ TEST-ONLY. Production reads the turn via `parseWhy`; this is the boolean form the render
 *  and safety tests assert with. */
export const isWhyLine = (line: string): boolean => parseWhy(line) !== null;
