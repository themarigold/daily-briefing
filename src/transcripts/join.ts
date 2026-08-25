// Slice 1.5 M3 — the pre-generation join (T3.3), escalation (T3.4), anchor resolution (T3.4a),
// A9's strict-majority curve (T3.5), and the unit-scoped suppression CALL SITES — T3.6a
// outcome-verb, T3.6b credentials, and T7.7 task-shaped (added later; the header said "the two"
// until 2026-08-11). They share one stack, `acceptWhyText`, applied to BOTH curves.
//
// ⚠ These suppressions are UNIT-scoped and live HERE, not in `select.ts`, for two independent
// reasons — and getting this wrong is the defect class that recurred three times during the spec:
//   · §3.3 is explicit that a credential hit "drops the why entirely; the bullet renders bare". A
//     turn-scoped drop in `select.ts` would merely ADVANCE membership to the next qualifying turn,
//     so the unit would still emit a why — the opposite of fail-closed.
//   · Neither is one of the six pipeline stages, so a `select.ts` drop would add a seventh bucket
//     and falsify T2.6's `sum(six) + qualifiers == examined` accounting.
import { unitKey as composeUnitKey } from "../subprojects";

/** Forward slashes, no trailing separator — the same normalisation `subprojects.ts` applies before
 *  any absolute-path comparison. Local because subprojects' copy is not exported; keep them in step. */
const normSlash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
import type { Activity } from "../types";
import type { Unit } from "../subprojects";
import type { DropReason, TranscriptWhySource, TranscriptAnchor } from "./scan";
import type { TurnRecord } from "./transform";
import { makeAnchor, resolveAnchor } from "./anchor";
import { hasOutcomeVerb } from "./outcomeVerb";
import { isTaskShaped } from "./taskShape";
import { ingestScan } from "./credentials";
import { segmentKey, turnForSegment, localDayOf, type Bucketer } from "./segments";
import type { TranscriptSegment } from "./scan";

/** §3.2's ambiguity policy. Injectable so MUT2 — the only detector that the drop is actually live —
 *  is buildable at all. `keep-earliest` = the surviving session with the EARLIEST first-edit
 *  timestamp for that unit, ties by `sessionId` lexicographically. */
export type OnAmbiguity = "drop" | "keep-earliest";

export type JoinInput = {
  segments: TranscriptSegment[];
  firstEdit: Map<string, string>;
  /** Qualifying human turns, with their file order for deterministic tie-breaks. */
  candidates: (TurnRecord & { order: number })[];
  units: Unit[];
  activities: Activity[];
  bucket: Bucketer;
  onAmbiguity?: OnAmbiguity;
};

/**
 * A9 — THE ADOPTED ATTRIBUTION CURVE (2026-08-10, user-directed, eval-integrity class).
 *
 * The UNION of the two rules, with a CONSERVATIVE-WINS tiebreak. Both rules are computed above and
 * neither is nested in the other: conservative resolves a unit when exactly ONE session claims it;
 * strict-majority resolves it when one session covers >50% of the unit's files. So each succeeds
 * where the other fails, and taking only one discards resolutions the other rule soundly produced.
 *
 * ⚠ WHY A UNION IS SAFE HERE, AND WHY IT IS STILL WRITTEN WITH A TIEBREAK. Measured on the frozen
 * corpus: of the unit-days where BOTH rules fire, they chose the SAME session **every time — ZERO
 * disagreement**. That is what makes this free coverage rather than a coin-flip.
 *
 * ⚠ THE INVARIANT IS "disagree == 0"; THE POPULATION SIZE IS NOT PART OF THE CLAIM, and an earlier
 * version of this comment cited "8 of 8" as though it were. That was a trap: the replay pairs a
 * FROZEN transcript snapshot with LIVE git history over a wall-clock window, so its counts move
 * between runs on the same corpus (#179) — EVAL.md's day-25 table records `both = 3` for a run whose
 * conservative total (9) matches ours exactly. Two runs, same corpus, different overlap: the counts
 * are not comparable and were never the argument. Re-measured 2026-08-11 against current code:
 * `{bothFire: 8, agree: 8, disagree: 0}`. Re-derive with `A3_DROPS=1 bun run scripts/inspect-whys.ts
 * --days=49` under a HOME pointed at the snapshot; check `disagree`, and do not compare the counts.
 *
 * Zero disagreement across one machine's corpus is encouraging, NOT a proof, and the failure it would hide is the
 * expensive one: a why is the USER'S OWN WORDS quoted back, so picking the wrong session of two
 * quotes them from a session they were not in. The `??` below therefore makes conservative win BY
 * CONSTRUCTION. Today it never fires — the two never disagree — and the day one does, the rule with
 * the stronger correctness argument (no competing claimant) takes it, silently and correctly.
 *
 * ⚠ Do NOT "simplify" this to `sourcesStrictMajority.get(key) ?? sources.get(key)`. The order IS the
 * policy: reversing it makes the higher-yield rule win a disagreement, which is exactly backwards.
 *
 * ⚠ The counts that motivated earlier framings of this decision are NOT reproducible — the A9 replay
 * pairs a frozen transcript snapshot with LIVE git history over a wall-clock window, so figures moved
 * within one evening (see #179). This function's justification deliberately rests on the AGREEMENT
 * measurement, which is a structural property, and not on any count.
 */
export function whySourceFor(
  e: { sources: Map<string, TranscriptWhySource>; sourcesStrictMajority: Map<string, TranscriptWhySource> },
  key: string,
): TranscriptWhySource | undefined {
  return e.sources.get(key) ?? e.sourcesStrictMajority.get(key);
}

/**
 * The ADOPTED A9 map: every unit that produces a why under the union, with the same conservative-
 * wins tiebreak as `whySourceFor`.
 *
 * ⚠ ONE DEFINITION. `scan.ts` needs this twice — escalation counts "how many units got a why", and
 * `startToCommitHours` iterates "each unit that produced a why". Building the map inline in two
 * places (Set of keys vs Map spread) is two copies of a decision-feeding derivation; if either
 * forgot the tiebreak order or only read one curve, telemetry would silently answer a different
 * question from the renderer. Call this instead.
 *
 * Construction order: strict first, conservative second so a shared key keeps the conservative
 * source — identical to `e.sources.get(k) ?? e.sourcesStrictMajority.get(k)`.
 */
export function whySourcesAdopted(
  e: { sources: Map<string, TranscriptWhySource>; sourcesStrictMajority: Map<string, TranscriptWhySource> },
): Map<string, TranscriptWhySource> {
  return new Map([...e.sourcesStrictMajority, ...e.sources]);
}

/** |union| — the count `shouldEscalate` and any "how many whys did we get?" counter must use. */
export function countAdoptedWhys(
  e: { sources: Map<string, TranscriptWhySource>; sourcesStrictMajority: Map<string, TranscriptWhySource> },
): number {
  return whySourcesAdopted(e).size;
}

export type JoinOutput = {
  sources: Map<string, TranscriptWhySource>;
  sourcesStrictMajority: Map<string, TranscriptWhySource>;
  unitFiles: Map<string, string[]>;
  drops: Partial<Record<DropReason, number>>;
  unitsEligible: number;
  anchorsAttempted: number;
  anchorsResolved: number;
};

/** ⚠ `unitFiles` comes from `activities` ONLY, and EXCLUDES `meta.excluded` commits — §3.1's rule,
 *  whose other half is T0.2. This is the half that could not land in M0 because `unitFiles` did not
 *  exist yet. Union of the unit's in-window pre-`reduce` diffstats plus its dirtyFiles.
 *
 *  Pre-`reduce` deliberately: `CheckInput` carries only post-`reduce` ctx, whose diffstats are
 *  truncated at STAGE1_LIST_CAP, so deriving this later would silently shrink the join's file set. */
export function buildUnitFiles(units: Unit[], activities: Activity[], bucket: Bucketer): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (key: string, file: string) => {
    const arr = out.get(key) ?? (out.set(key, []), out.get(key)!);
    if (!arr.includes(file)) arr.push(file);
  };
  for (const u of units) out.set(composeUnitKey(u.repo, u.root), []);

  for (const a of activities) {
    if (a.kind !== "commit") continue;
    if (a.meta?.excluded) continue;                            // §3.1 — bot commits are not evidence of work
    const repo = a.repo;
    if (!repo) continue;
    for (const d of a.meta?.diffstat ?? []) {
      const key = bucket(`${repo}/${d.file}`);
      if (key !== null) add(key, d.file);
    }
  }
  for (const u of units) {
    const key = composeUnitKey(u.repo, u.root);
    for (const f of u.dirtyFiles ?? []) add(key, f);
  }
  return out;
}

const bump = (d: Partial<Record<DropReason, number>>, r: DropReason) => { d[r] = (d[r] ?? 0) + 1; };

/** ATTRIB — the membership test. A session claims a unit iff its segment paths intersect that unit's
 *  file set. Compared as UNIT KEYS, never as paths: each side has already been bucketed through the
 *  SAME shared function, so the raw path forms differ (segments hold absolute paths, unit files are
 *  repo-relative diffstat names) and only the keys are comparable. Bucket the two sides through
 *  different functions and they compute different keys, and ATTRIB fails silently.
 *  ⚠ NOT the coverage test — that one does compare paths, and has to reconstruct the absolute form
 *  to do it (see the strict-majority block below). */
function claimantsFor(unitKey: string, segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments.filter((s) => s.unitKey === unitKey);
}

/** Session-collapse: a session's segments for one unit are one claimant, however many days it spans. */
function collapseBySession(segs: TranscriptSegment[]): Map<string, TranscriptSegment[]> {
  const bySession = new Map<string, TranscriptSegment[]>();
  for (const s of segs) (bySession.get(s.sessionId) ?? bySession.set(s.sessionId, []).get(s.sessionId)!).push(s);
  return bySession;
}

/** Pick the surviving session's why-source.
 *
 *  ⚠ SEGMENT FALLBACK: the source is drawn from the session's EARLIEST in-window segment for the
 *  unit; if that segment has no qualifying turn, selection advances to that session's NEXT segment
 *  for the same unit, in chronological order, until one yields or none remain. Advancing within the
 *  SAME session is safe — it cannot mis-attribute. What is forbidden is borrowing a turn from a
 *  DIFFERENT session, or a later segment's turn for an earlier segment's edits. */
function sourceForSession(
  segs: TranscriptSegment[], firstEdit: Map<string, string>, candidates: (TurnRecord & { order: number })[],
): { turn: TurnRecord; seg: TranscriptSegment } | null {
  const ordered = [...segs].sort((a, b) => (firstEdit.get(segmentKey(a)) ?? "").localeCompare(firstEdit.get(segmentKey(b)) ?? ""));
  for (const seg of ordered) {
    const ts = firstEdit.get(segmentKey(seg));
    if (!ts) continue;
    const turn = turnForSegment(seg, ts, candidates);
    if (turn) return { turn, seg };
  }
  return null;
}

function earliestSession(bySession: Map<string, TranscriptSegment[]>, firstEdit: Map<string, string>): string {
  let best: { id: string; ts: string } | null = null;
  for (const [id, segs] of bySession) {
    const ts = segs.map((s) => firstEdit.get(segmentKey(s)) ?? "").filter(Boolean).sort()[0] ?? "";
    if (best === null || ts < best.ts || (ts === best.ts && id < best.id)) best = { id, ts };
  }
  return best!.id;
}

export function joinEvidence(input: JoinInput): JoinOutput {
  const { segments, firstEdit, candidates, units, activities, bucket } = input;
  const onAmbiguity: OnAmbiguity = input.onAmbiguity ?? "drop";
  const drops: Partial<Record<DropReason, number>> = {};
  const sources = new Map<string, TranscriptWhySource>();
  const sourcesStrictMajority = new Map<string, TranscriptWhySource>();
  const unitFiles = buildUnitFiles(units, activities, bucket);

  let unitsEligible = 0;
  const anchors: TranscriptAnchor[] = [];

  for (const u of units) {
    const key = composeUnitKey(u.repo, u.root);
    const files = unitFiles.get(key) ?? [];
    // Eligible = >=1 in-window activity AND non-empty unitFiles (§3.2). An ineligible unit is not a
    // miss; there is nothing to attribute to.
    if (files.length === 0) continue;
    unitsEligible++;

    const claimSegs = claimantsFor(key, segments);
    if (claimSegs.length === 0) { bump(drops, "no-segment"); continue; }

    const bySession = collapseBySession(claimSegs);

    // ── A9 curve 2 (strict majority), computed IN PARALLEL with conservative. Under the ADOPTED
    // union both maps can contribute rendered whys (via whySourceFor). Requires that >0.5 of the
    // unit's files be covered by the session. Two overlapping sets can BOTH exceed 0.5, so >=2
    // qualifiers is itself a drop (no entry).
    // ⚠ COVERAGE IS COMPARED ON FULL REPO-RELATIVE PATHS, NOT BASENAMES, and the distinction is a
    // correctness one rather than a style one. The two sides arrive in DIFFERENT FORMS — segment
    // paths are ABSOLUTE (`tool_use.input.file_path`, transform.ts) while `unitFiles` holds
    // repo-relative diffstat names (buildUnitFiles above) — and the original code bridged that by
    // comparing `split("/").pop()` on both sides. Leaf-only matching does not implement the rule
    // this very comment states (">0.5 of the unit's FILES"): it implements ">0.5 of its BASENAMES".
    //
    // Those differ exactly when a unit holds two files with the same leaf, which is common —
    // `index.ts`, `types.ts`, `README.md`, `STATE.md`. A session that touched ONE of them was
    // credited for BOTH, so coverage was inflated and a session covering ≤50% could clear the bar.
    // Reproduced 2026-08-11 by three independent reviewers: unit files [a/index.ts, b/index.ts],
    // session S1 edited only a/index.ts (true coverage 0.5, which must NOT qualify) → strict
    // adopted S1's turn as the why on a MULTI-CLAIMANT unit. Under the A9 union that entry is
    // RENDERED, so this shipped the exact error the tiebreak comment above calls the expensive one:
    // quoting the user's words from a session that did not do the majority of the work.
    //
    // The repo prefix is recoverable because `key` IS `${repo}\x00${root}` (subprojects.ts), so the
    // absolute form of a unit file is `${repo}/${file}` — the same string `buildUnitFiles` handed
    // the bucketer. Both sides go through `normSlash` so a Windows-shaped segment path cannot miss.
    const repoOfUnit = key.split("\x00")[0]!;
    const majority = [...bySession.entries()].filter(([, segs]) => {
      const covered = new Set(segs.map((s) => s.paths).flat().map(normSlash));
      const hit = files.filter((f) => covered.has(normSlash(`${repoOfUnit}/${f}`))).length;
      return files.length > 0 && hit / files.length > 0.5;
    });

    // ── Accept filters shared by BOTH curves. ⚠ Under the A9 union, a filter on conservative alone
    // is a silent no-op for sole-claimant units that also qualify for majority: conservative drops
    // the why, strict still inserts it, whySourceFor ships the strict entry. Measured 2026-08-11:
    // isTaskShaped (T7.7) was only on curve 1, so task-instruction turns re-shipped after A9. Apply
    // the same stack on both, or the adopted curve undoes the gate.
    // DropReason accounting: only the conservative branch bumps (one count per unit-drop); strict
    // simply refuses to set — same as it did for credential/outcome before this fix.
    const acceptWhyText = (text: string): DropReason | null => {
      if (!ingestScan(text).ok) return "credential-hit";
      if (hasOutcomeVerb(text)) return "outcome-verb";
      // ── T7.7 (GATE-R3, option B): routine task instruction. Counted under `outcome-verb`
      // DELIBERATELY rather than inventing a bucket: DropReason is a closed enumerated set.
      if (isTaskShaped(text)) return "outcome-verb";
      return null;
    };

    // ⚠ STRICT-MAJORITY IS EVALUATED FIRST, AND THE ORDER IS LOAD-BEARING FOR THE §5 ACCOUNTING
    // IDENTITY — it is not a cosmetic reordering. A drop counter answers ONE question: "why did this
    // eligible unit produce no why?" Under the A9 union a unit conservative dropped can still yield
    // a why via strict-majority, so bumping unconditionally counted the SAME unit as both a drop and
    // a why and `unitsEligible == whys + drops` stopped holding. Measured 2026-08-11 on a 2-claimant
    // unit where one session covered 2/2 files: `{unitsEligible: 1, drops: {ambiguous: 1},
    // adoptedWhys: 1}` — 1 != 1 + 1. Knowing whether strict resolved is therefore a PRECONDITION of
    // deciding whether a conservative miss is a drop at all.
    if (majority.length === 1) {
      const picked = sourceForSession(bySession.get(majority[0]![0])!, firstEdit, candidates);
      // Same accept stack as conservative — see acceptWhyText above.
      if (picked && acceptWhyText(picked.turn.text) === null) {
        sourcesStrictMajority.set(key, {
          unitKey: key, text: picked.turn.text, anchor: makeAnchor({ ...picked.turn, unitKey: key }),
        });
      }
    }
    // The unit already yields a why under the ADOPTED curve, so nothing below is a loss to explain.
    const yieldsAnyway = sourcesStrictMajority.has(key);
    // ⚠ Per-curve YIELD is untouched by this: `whysConservative` / `whysStrictMajority` are map
    // sizes (scan.ts), so suppressing a DROP cannot distort them. What is deliberately given up is
    // the ability to read `drops.ambiguous` as "how often conservative found a unit ambiguous" — it
    // now means "...and no rule rescued it", which is the question the counter is actually for.
    const dropUnlessRescued = (r: DropReason) => { if (!yieldsAnyway) bump(drops, r); };

    // ── The conservative rule (curve 1): >=2 claiming sessions is AMBIGUOUS.
    let sessionId: string | null = null;
    if (bySession.size === 1) {
      sessionId = [...bySession.keys()][0]!;
    } else if (onAmbiguity === "keep-earliest") {
      sessionId = earliestSession(bySession, firstEdit);
    } else {
      dropUnlessRescued("ambiguous");
    }

    if (sessionId !== null) {
      const picked = sourceForSession(bySession.get(sessionId)!, firstEdit, candidates);
      if (!picked) {
        dropUnlessRescued("no-qualifying-turn");
      } else {
        const reject = acceptWhyText(picked.turn.text);
        if (reject) {
          dropUnlessRescued(reject);
        } else {
          const anchor = makeAnchor({ ...picked.turn, unitKey: key });
          anchors.push(anchor);
          sources.set(key, { unitKey: key, text: picked.turn.text, anchor });
        }
      }
    }
  }

  // ── T3.4a: the anchor RESOLUTION pass. Evaluated ONCE, after join AND escalation, so numerator
  // and denominator range over the same set. Building the composite (T3.2) happens before the join,
  // which is why its counters could not live there.
  //
  // ⚠ BOTH CURVES, and that is a CORRECTNESS fix, not bookkeeping. `anchors` was pushed to in the
  // conservative branch ONLY, so this pass validated conservative whys and silently skipped every
  // strict-majority one — meaning the "drop a why we cannot later verify" rule below, the one that
  // stops an unprovable quotation shipping, applied to exactly one of the two curves. Latent only
  // because strict-majority is dark; the day-21 telemetry points at ADOPTING it (conservative
  // 1,0,0,0 vs strict-majority 0,1,1,0 over four live days), and adopting it as-was would have
  // shipped quotations that bypassed the verification gate entirely.
  //
  // The counter told the same story and is what surfaced this: `anchorsAttempted` read 0 on two days
  // that recorded a strict-majority why. A why that never attempted an anchor cannot have been
  // anchored — the number was measuring a different stage than its name claimed.
  //
  // DEDUPED by composite identity: both curves can pick the SAME turn for the same unit, and
  // resolving it twice would double-bump `anchor-unresolvable`, breaking the §5 accounting identity
  // that every drop is counted once.
  const idOf = (a: TranscriptAnchor) => `${a.sessionId}\u0000${a.uuid}\u0000${a.unitKey}\u0000${a.textSha}`;
  const toResolve = new Map<string, TranscriptAnchor>();
  for (const a of anchors) toResolve.set(idOf(a), a);
  for (const v of sourcesStrictMajority.values()) toResolve.set(idOf(v.anchor), v.anchor);

  let anchorsResolved = 0;
  for (const a of toResolve.values()) {
    const r = resolveAnchor(a, candidates.map((c) => ({ sessionId: c.sessionId, uuid: c.uuid, tsUtc: c.tsUtc, text: c.text })));
    if (r.resolved) { anchorsResolved++; continue; }
    // A why we cannot later verify is worse than no why: drop it rather than ship an unprovable
    // quote. Applied to BOTH maps — whichever curve is live must get the same guarantee.
    for (const [k, v] of sources) if (idOf(v.anchor) === idOf(a)) sources.delete(k);
    for (const [k, v] of sourcesStrictMajority) if (idOf(v.anchor) === idOf(a)) sourcesStrictMajority.delete(k);
    // ⚠ UNIT-SCOPED, mirroring `dropUnlessRescued` above — the bump moved BELOW the deletions so it
    // can see the resulting state. A drop answers "why did this unit produce no why?", so a unit
    // that still yields under the OTHER curve is not one. Under the default `onAmbiguity: "drop"`
    // both curves necessarily share one anchor (sole claimant ⇒ same session ⇒ same turn) and this
    // is a no-op. Under `keep-earliest` they can pick DIFFERENT sessions, and the per-anchor bump
    // then counted a unit as both a why and a drop: measured 2026-08-11, `{unitsEligible: 1,
    // adoptedWhys: 1, drops: {anchor-unresolvable: 1}}` — 1 != 1 + 1. Reachable via `RunDeps`
    // (core.ts) and used live by `scripts/inspect-whys.ts`, i.e. by the diagnostic that READS these
    // counters. Two unresolvable anchors on one unit still bump exactly once: the first deletion
    // leaves the other curve holding the key, so only the second — which empties both — counts.
    if (!sources.has(a.unitKey) && !sourcesStrictMajority.has(a.unitKey)) {
      bump(drops, "anchor-unresolvable");
    }
  }

  return {
    sources, sourcesStrictMajority, unitFiles, drops, unitsEligible,
    // `toResolve.size`, not `anchors.length`: the denominator must range over every anchor actually
    // evaluated, or `anchorsResolved / anchorsAttempted` compares a numerator from both curves
    // against a denominator from one.
    anchorsAttempted: toResolve.size, anchorsResolved,
  };
}

/** T3.4 — the escalation trigger. Fires ONCE per run, when eligible units got no why from the main
 *  tier; the caller then re-runs the FULL join with the subagent tier's paths merged in.
 *  ⚠ Full re-join, not a patch: a subagent path can turn a one-claimant unit into an ambiguous one,
 *  and only re-running the whole join can see that. */
export function shouldEscalate(o: { unitsEligible: number; whys: number }): boolean {
  return o.unitsEligible > 0 && o.whys < o.unitsEligible;
}

export { localDayOf };
