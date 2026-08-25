// ⛔ CHECKPOINT C3's rule, as an executable check.
//
// "C3 asserts every M2/M3 code has a non-zero count on a fixture engineered to trigger it. A code
// that cannot be triggered is either dead or unimplemented — both are defects."
//
// This exists because THREE separate spec rounds each found one enumerated drop code whose writer was
// never tasked (`outcome-verb`, `credential-hit`, `hardening-off`). Fixing them one at a time is how
// the same finding recurred three times. C3 found two more of the same class in the IMPLEMENTATION:
// `unrecognised-shape` and `path-unresolvable` were counted as local numbers and written to no drops
// record at all, so they could never have appeared in telemetry.
import { test, expect } from "bun:test";
import { emptyDrops, type DropReason } from "../src/transcripts/scan";
import { selectAll } from "../src/transcripts/select";
import { transformLines } from "../src/transcripts/transform";
import { buildSegments } from "../src/transcripts/segments";
import { joinEvidence } from "../src/transcripts/join";
import { unitKey } from "../src/subprojects";
import { unrecognisedLine } from "./fixtures/session";
import type { Activity } from "../src/types";

/** Every code the coverage table assigns to M2 or M3. `hardening-off` (T8.2, M8) and
 *  `label-collision` (T7.3, M7) are deliberately excluded — they are not built yet. */
const M2_M3_CODES: readonly DropReason[] = [
  // M2
  "harness-wrapped", "continuation-word", "slash-command", "turn-too-short", "over-cap-turn", "control-byte",
  "unrecognised-shape",
  // M3
  "no-qualifying-turn", "anchor-unresolvable", "no-segment", "ambiguous", "path-unresolvable",
  "outcome-verb", "credential-hit",
];

const REPO = "/repo";
const K = (root: string | null) => unitKey(REPO, root);
const bucket = (abs: string): string | null => abs.startsWith(`${REPO}/a/`) ? K("a") : null;
const unitA = { repo: REPO, root: "a", label: "a", hasResumptionState: false, hasWindowContent: true, resumptionNote: "", dirtyFiles: [], latestCommitTime: null };
const commit = (files: string[]): Activity => ({
  source: "git", kind: "commit", event_id: "c1", repo: REPO, timestamp: "2026-07-30T12:00:00.000Z", text: "c",
  meta: { diffstat: files.map((f) => ({ file: f, added: 1, removed: 0 })) },
});
const turn = (sessionId: string, uuid: string, tsUtc: string, text: string, order = 0) => ({ sessionId, uuid, tsUtc, text, order });
const editAt = (sessionId: string, tsUtc: string, path = `${REPO}/a/x.ts`) => ({ sessionId, tsUtc, path });

test("C3: every M2/M3 DropReason code is reachable and non-zero on an engineered fixture", () => {
  const drops = emptyDrops();

  // ── M2: the six pipeline stages (T2.6) ─────────────────────────────────────────────────────────
  selectAll([
    "<task-notification>" + "x".repeat(80) + "</task-notification>",   // harness-wrapped
    "yes",                                                              // continuation-word
    "/clear",                                                           // slash-command
    "short",                                                            // turn-too-short
    "y".repeat(700),                                                    // over-cap-turn
    "z".repeat(60) + "\n" + "z".repeat(60),                             // control-byte
  ], drops);

  // ── M2: the fail-closed transform (T2.2) ───────────────────────────────────────────────────────
  transformLines([unrecognisedLine({ sessionId: "s1", ts: "2026-07-30T10:00:00.000Z" })], "/root/-p/s1.jsonl", "depth1", drops);

  // ── M3: transcript-side bucketing (T3.1) ───────────────────────────────────────────────────────
  buildSegments([{ sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: "/not-a-configured-repo/z.ts" }], bucket, drops);

  // ── M3: no-segment (T3.3) — an eligible unit no session claims.
  const noSeg = joinEvidence({ segments: [], firstEdit: new Map(), candidates: [], units: [unitA], activities: [commit(["a/x.ts"])], bucket });
  for (const [k, v] of Object.entries(noSeg.drops)) drops[k as DropReason] += v ?? 0;

  // ── M3: ambiguous (T3.3) — two sessions claiming one unit.
  const amb = buildSegments([editAt("s1", "2026-07-30T10:00:00.000Z"), editAt("s2", "2026-07-30T10:00:00.000Z")], bucket);
  const ambOut = joinEvidence({
    segments: amb.segments, firstEdit: amb.firstEdit,
    candidates: [turn("s1", "u1", "2026-07-30T09:00:00.000Z", "a substantive turn explaining the unit a work in progress", 0),
                 turn("s2", "u2", "2026-07-30T09:00:00.000Z", "another substantive turn from a different session entirely", 1)],
    units: [unitA], activities: [commit(["a/x.ts"])], bucket,
  });
  for (const [k, v] of Object.entries(ambOut.drops)) drops[k as DropReason] += v ?? 0;

  // ── M3: no-qualifying-turn (T3.1) — a claimed unit whose only turn comes AFTER the first edit.
  const nq = buildSegments([editAt("s1", "2026-07-30T10:00:00.000Z")], bucket);
  const nqOut = joinEvidence({
    segments: nq.segments, firstEdit: nq.firstEdit,
    candidates: [turn("s1", "u1", "2026-07-30T14:00:00.000Z", "a turn written long after the edit had already landed", 0)],
    units: [unitA], activities: [commit(["a/x.ts"])], bucket,
  });
  for (const [k, v] of Object.entries(nqOut.drops)) drops[k as DropReason] += v ?? 0;

  // ── M3: outcome-verb (T3.6a) and credential-hit (T3.6b) — unit-scoped suppressions.
  for (const text of [
    "fixed the plurality vote so the mixed-commit case is done now and behaving",
    "re-run with AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY to reproduce it",
  ]) {
    const b = buildSegments([editAt("s1", "2026-07-30T10:00:00.000Z")], bucket);
    const o = joinEvidence({
      segments: b.segments, firstEdit: b.firstEdit,
      candidates: [turn("s1", "u1", "2026-07-30T09:00:00.000Z", text, 0)],
      units: [unitA], activities: [commit(["a/x.ts"])], bucket,
    });
    for (const [k, v] of Object.entries(o.drops)) drops[k as DropReason] += v ?? 0;
  }

  // ── M3: anchor-unresolvable (T3.4a) — the SAME turn present twice in the candidate corpus, so the
  // composite cannot identify which line was quoted.
  const dupText = "I rewrote the join to drop on ambiguity because two claimants are not resolvable";
  const dupB = buildSegments([editAt("s1", "2026-07-30T10:00:00.000Z")], bucket);
  const dupOut = joinEvidence({
    segments: dupB.segments, firstEdit: dupB.firstEdit,
    candidates: [turn("s1", "u1", "2026-07-30T09:00:00.000Z", dupText, 0),
                 turn("s1", "u1", "2026-07-30T09:00:00.000Z", dupText, 1)],   // identical composite
    units: [unitA], activities: [commit(["a/x.ts"])], bucket,
  });
  for (const [k, v] of Object.entries(dupOut.drops)) drops[k as DropReason] += v ?? 0;
  expect(dupOut.sources.size).toBe(0);   // an unverifiable why is dropped, not shipped

  // ── The assertion C3 exists for ────────────────────────────────────────────────────────────────
  const dead = M2_M3_CODES.filter((c) => drops[c] === 0);
  expect(dead).toEqual([]);   // a code that cannot be triggered is dead or unimplemented — both defects

  // ⚠ These two are NOT exercised by this fixture — they belong to M7 and M8 and are driven from
  // their own tests — so they stay at zero HERE. That is a statement about this fixture's scope, not
  // about the codes being unreachable: both now have writers (`label-collision` in core.ts's
  // projection, `hardening-off` in scripts/audit.ts), each with its own red-checked receipt.
  // Asserting them at zero is what stops this test quietly "covering" a code it never drove.
  expect(drops["hardening-off"]).toBe(0);   // driven by test/transcripts-safety.test.ts (T8.2)
  expect(drops["label-collision"]).toBe(0); // driven by test/transcripts-render.test.ts (T7.3/T7.6)
});
