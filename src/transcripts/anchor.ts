// Slice 1.5 T3.2 — anchors and `textSha`.
//
// The anchor is the composite that lets a later reader prove a quoted turn is the turn that was
// selected: (sessionId, uuid, tsUtc, textSha, unitKey). `textSha` covers the VERBATIM
// `message.content` — pre-cap, pre-trim, pre-normalise — so G5's `verbatim` check is a plain
// equality and never has to reproduce a trim or strip a frame.
//
// ⚠ A trimmed or framed hash domain would make `verbatim` pass on every sub-600-char fixture and
// fail 100% on real data, which is why the domain is stated here and pinned by test.
import { createHash } from "node:crypto";
import type { TranscriptAnchor } from "./scan";

/** SHA-256 of the turn text EXACTLY as it appeared. UTF-8 bytes, so the digest is stable across
 *  platforms and independent of how the string was stored. */
export function textSha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function makeAnchor(o: {
  sessionId: string; uuid: string; tsUtc: string; unitKey: string; text: string;
}): TranscriptAnchor {
  return { sessionId: o.sessionId, uuid: o.uuid, tsUtc: o.tsUtc, unitKey: o.unitKey, textSha: textSha(o.text) };
}

/** Does `candidate` carry the exact bytes this anchor was built from? Equality on the digest, never
 *  on a normalised or trimmed form.
 *
 *  Called by G5's `verbatim` rule (eval/checks.ts) — the one place that decides whether a rendered
 *  quotation is byte-equal to its source, i.e. invariant 5 itself.
 *
 *  ⚠ It is NOT the emitter's check, and an earlier comment here claimed it was. The emitter's
 *  guarantee is STRUCTURAL: select.ts stage 6 rejects exactly the class `stripControl` deletes,
 *  pinned at test/transcripts-render.test.ts. And the audit uses CONTENT SEARCH rather than anchor
 *  lookup (T8.1a), because it holds no TranscriptEvidence. */
export function matchesAnchor(anchor: TranscriptAnchor, candidate: string): boolean {
  return textSha(candidate) === anchor.textSha;
}

/** T3.4a's resolution predicate: an anchor is RESOLVABLE iff its composite identifies exactly one
 *  line. Two lines matching means the composite cannot prove which turn was quoted, so the why is
 *  dropped and `anchor-unresolvable` is counted — a why we cannot later verify is worse than none.
 *  ⚠ `uuid` alone is NOT usable as the identity: 12.80% of lines collide on it. */
export function resolveAnchor<T extends { sessionId: string; uuid: string; tsUtc: string; text: string }>(
  anchor: TranscriptAnchor, corpus: T[],
): { resolved: true; line: T } | { resolved: false; matched: number } {
  const hits = corpus.filter((l) =>
    l.sessionId === anchor.sessionId && l.uuid === anchor.uuid &&
    l.tsUtc === anchor.tsUtc && textSha(l.text) === anchor.textSha);
  return hits.length === 1 ? { resolved: true, line: hits[0]! } : { resolved: false, matched: hits.length };
}
