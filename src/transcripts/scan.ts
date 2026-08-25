// Slice 1.5 — the transcript-scan orchestrator. The §4 contract types (T1.5) plus the BODY (T4.1).
//
// The types are the spec's §4 contract verbatim. They live here rather than in `types.ts` because
// `TranscriptEvidence` lives OUTSIDE `ReducedContext` (§3.7) and never reaches the prompt path —
// putting it in the frozen-contract file would invite exactly the coupling §3.7 rules out.

/** §3.2's ambiguity policy, injectable so MUT2 (the only detector that the drop is live) is
 *  buildable. Threaded by T4.2; the default is `"drop"`. */
export type OnAmbiguity = "drop" | "keep-earliest";

/** Enumerated codes, never free text — a warning is a code plus a count (§4).
 *  The first six are one per §3.2 substantive-turn stage IN PIPELINE ORDER, so the §5 accounting
 *  assertion can sum over a complete bucket set. Every code must have a writer task (see the plan's
 *  DropReason coverage table); a code with no writer is unreachable telemetry. */
export type DropReason =
  | "harness-wrapped" | "continuation-word" | "slash-command" | "turn-too-short"
  | "over-cap-turn" | "control-byte"
  | "no-segment" | "ambiguous" | "anchor-unresolvable" | "no-qualifying-turn"
  | "credential-hit" | "outcome-verb" | "path-unresolvable"
  | "unrecognised-shape" | "hardening-off" | "label-collision";

export const DROP_REASONS: readonly DropReason[] = [
  "harness-wrapped", "continuation-word", "slash-command", "turn-too-short",
  "over-cap-turn", "control-byte",
  "no-segment", "ambiguous", "anchor-unresolvable", "no-qualifying-turn",
  "credential-hit", "outcome-verb", "path-unresolvable",
  "unrecognised-shape", "hardening-off", "label-collision",
] as const;

/** The subset of `DROP_REASONS` counted ONCE PER ELIGIBLE UNIT — i.e. the only ones that share a
 *  denominator with `unitsEligible`, and therefore the only ones that may be summed against it.
 *
 *  ⚠ THIS EXISTS BECAUSE MIXING DENOMINATORS IS THE OBVIOUS MISTAKE HERE, and it is not a small one:
 *  on 2026-08-11 the same day record held `unitsEligible: 8` beside `unrecognised-shape: 32216` and
 *  `path-unresolvable: 468`. Those are per-LINE and per-PATH tallies from the scan stages; reading
 *  them as unit losses says the run lost four thousand times more units than it ever had. The six
 *  below sum to exactly `unitsEligible - adoptedWhys` (§5), which is the identity that makes a
 *  "where did the units go" answer meaningful at all.
 *
 *  ⚠ WRITERS, so this can be re-derived rather than trusted: every one is a `bump(drops, …)` or
 *  `dropUnlessRescued(…)` inside `joinEvidence`'s per-unit loop (join.ts) — `no-segment`,
 *  `ambiguous`, `no-qualifying-turn`, `anchor-unresolvable`, plus the two `acceptWhyText` returns
 *  (`credential-hit`, `outcome-verb`; `isTaskShaped` is deliberately counted under `outcome-verb`
 *  rather than given a bucket). ADD A UNIT-LEVEL DROP AND IT MUST BE ADDED HERE — the identity test
 *  in test/transcripts-join.test.ts is what fails if it is not. */
export const UNIT_DENOMINATED_DROPS: readonly DropReason[] = [
  "no-segment", "ambiguous", "no-qualifying-turn",
  "anchor-unresolvable", "credential-hit", "outcome-verb",
] as const;

export type UnitFileCountBucket = "1" | "2-3" | "4-7" | "8+";

/** What ONE scanning run emits. Structurally `TranscriptDay` minus `date`, kept as its own type so
 *  the day-record merge (§4 rule 2) cannot be skipped by plain assignment. */
export type TranscriptRunCounters = {
  filesScanned: number; linesRead: number; linesSkipped: number;
  parseFailures: number;
  segments: number; segmentsAfterCollapse: number;
  anchorsAttempted: number; anchorsResolved: number;
  /** Distinct sessions with >=1 event in the read window. REQUIRED: "qualifying day" is defined
   *  over it, and it SUMS across runs. */
  sessionsInWindow: number;
  unitsEligible: number;          // >=1 in-window activity AND non-empty unitFiles (§3.2)
  whysBeforeEscalation: number;   // conservative-rule whys from the main tier alone
  whysConservative: number;       // A9 curve 1
  whysStrictMajority: number;     // A9 curve 2
  /** Bucketed by |unitFiles| — the UNIT's file count, NOT commit size: a unit-day has no commit
   *  size, which is what made A9 unanswerable when this was keyed on commit-shaped buckets. */
  byUnitFileCount: Record<UnitFileCountBucket, { eligible: number; conservative: number; strictMajority: number }>;
  drops: Record<DropReason, number>;
  escalated: boolean; escalationSkipped: boolean; capTripped: boolean;
  /** ⚠ Pre-mortem risk 4. The session-start -> first-commit delta, in HOURS, as a histogram. This is
   *  what MEASURES whether the read-window margin is right instead of guessing it — the plan chose
   *  24 h, and without this counter that choice could never be checked against reality. A histogram,
   *  never raw instants: the health file is not a sink. */
  startToCommitHours: Record<"0-1" | "1-4" | "4-12" | "12-24" | "24+", number>;
  /** ⚠ Pre-mortem risk 5. Units whose `norm(label)` collides — distinct from
   *  `drops["label-collision"]`, which counts only collisions that COST a why. This counts the
   *  colliding units themselves, which is what tells 1.5b how often the keying decision bites at all.
   *  Written by the projection in core.ts. */
  labelCollisions: number;
};

export type TranscriptSegment = {
  sessionId: string;
  unitKey: string;          // `${repo}\x00${root ?? ""}` — subprojects.ts's form
  localDay: string;         // YYYY-MM-DD, local time
  // ⚠ ABSOLUTE, verbatim from `tool_use.input.file_path`/`.notebook_path` (BOTH — `PATH_FIELDS`,
  // transform.ts; naming only the first would be this same class one level down) — NOT repo-relative, which this said until
  // 2026-08-11. `buildSegments` stores `p.path` unchanged (segments.ts). The strict-majority
  // coverage test depends on that: it rebuilds `${repo}/${file}` from the unit side precisely
  // BECAUSE this side is absolute (join.ts). A reader who believed the old comment would compare the
  // two forms directly, get zero overlap, and "fix" it by stripping the prefix off the wrong side.
  paths: string[];          // deduped (§3.2)
};

export type TranscriptAnchor = {
  sessionId: string;
  uuid: string;
  tsUtc: string;
  textSha: string;          // SHA-256 of message.content VERBATIM, pre-cap/trim/normalise (§3.2)
  unitKey: string;
};

export type TranscriptWhySource = {
  unitKey: string;
  text: string;             // the <=600-char anchored source turn — the ONLY emittable value
  anchor: TranscriptAnchor;
};

/** Produced by 1.5a, consumed by 1.5b. Lives OUTSIDE ReducedContext (§3.7).
 *  Every field is produced by the pre-generation scan+join, with ONE named exception: the `whys`
 *  projection (§3.5) runs after `generateBriefing` and is what detects label collisions, so it is a
 *  second writer of `counters.drops["label-collision"]`. Nothing else is mutated post-scan. */
export type TranscriptEvidence = {
  /** The window the SCAN actually used. G5's `freshness` compares against this, not the git window —
   *  §3.1's margin makes them different. */
  window: { startUtc: string; endUtc: string };
  /** RAW segments, pre-collapse. Collapse by sessionId happens at join time (§3.2). */
  segments: TranscriptSegment[];
  /** The file set ATTRIB joined against, per unitKey. REQUIRED here rather than derived at check
   *  time: `CheckInput` carries only post-`reduce` ctx, whose diffstats are truncated. */
  unitFiles: Map<string, string[]>;
  /** Keyed by unitKey. At most one per unit (§3.5), conservative rule. */
  sources: Map<string, TranscriptWhySource>;
  /** A9: the same map under strict-majority. Both curves feed the adopted union (whySourceFor). */
  sourcesStrictMajority: Map<string, TranscriptWhySource>;
  /** THIS RUN's counters — never written straight into a day record (§4 rule 2). */
  counters: TranscriptRunCounters;
};

export function emptyDrops(): Record<DropReason, number> {
  return Object.fromEntries(DROP_REASONS.map((r) => [r, 0])) as Record<DropReason, number>;
}

export function emptyCounters(): TranscriptRunCounters {
  const bucket = () => ({ eligible: 0, conservative: 0, strictMajority: 0 });
  return {
    filesScanned: 0, linesRead: 0, linesSkipped: 0, parseFailures: 0,
    segments: 0, segmentsAfterCollapse: 0,
    anchorsAttempted: 0, anchorsResolved: 0,
    sessionsInWindow: 0, unitsEligible: 0,
    whysBeforeEscalation: 0, whysConservative: 0, whysStrictMajority: 0,
    byUnitFileCount: { "1": bucket(), "2-3": bucket(), "4-7": bucket(), "8+": bucket() },
    drops: emptyDrops(),
    escalated: false, escalationSkipped: false, capTripped: false,
    startToCommitHours: { "0-1": 0, "1-4": 0, "4-12": 0, "12-24": 0, "24+": 0 },
    labelCollisions: 0,
  };
}

export function emptyEvidence(window: { startUtc: string; endUtc: string }): TranscriptEvidence {
  return {
    window,
    segments: [],
    unitFiles: new Map(),
    sources: new Map(),
    sourcesStrictMajority: new Map(),
    counters: emptyCounters(),
  };
}

export type ScanOptions = {
  root: string;
  window: { startUtc: string; endUtc: string };
  repos: string[];
  cfg: import("../types").Config;
  activities: import("../types").Activity[];
  units: import("../subprojects").Unit[];
  rootsByRepo: Map<string, string[]>;
  onAmbiguity?: OnAmbiguity;
  /** Run-level wall-clock cap. Tripping it DISCARDS everything (see below). */
  capMs?: number;
  /** Injected clock, so the cap is testable without sleeping. */
  now?: () => number;
};

/** The run-level cap. A scan that overruns is not partially useful: partial evidence is exactly the
 *  hazard the cap exists to prevent, so a trip discards ALL of it (§3.8). */
export const DEFAULT_SCAN_CAP_MS = 20_000;

/** Discard the EVIDENCE while KEEPING the telemetry.
 *
 *  ⚠ §3.8 says a cap trip "discards and warns" — it discards the *evidence*, never the counters that
 *  explain why. Returning `emptyEvidence()` on a degradation zeroes `capTripped`, `filesScanned` and
 *  `linesRead`, so the one signal that would tell an operator the cap is too tight becomes
 *  structurally unreachable — the same "counter with no reader" class the DropReason coverage table
 *  exists to prevent. Measured at C4: a cap-tripped run reported `capTripped: false, filesScanned: 0`.
 *  The derived sets are emptied; the counters ride out intact. */
function discardEvidence(e: TranscriptEvidence): TranscriptEvidence {
  return { ...e, segments: [], unitFiles: new Map(), sources: new Map(), sourcesStrictMajority: new Map() };
}

export type ScanOutcome = {
  evidence: TranscriptEvidence;
  /** Enumerated degradation codes for the caller to route (§3.8). Never free text. */
  degraded: ("cap-tripped" | "self-test-mismatch" | "parse-failure-rate" | "subsystem-throw")[];
};

/** T4.1 — the orchestrator BODY.
 *
 *  Order: bundled self-test → discover → read → transform → discriminate → select → segment →
 *  anchor → join.
 *
 *  ⚠ THE SELF-TEST RUNS FIRST AND ITS COST IS EXCLUDED FROM THE CAP CLOCK. Charging it to the cap
 *  would let a slow disk turn a health check into a fail-closed discard of ALL evidence — the health
 *  check causing the outage it exists to detect. The clock therefore starts AFTER it.
 *
 *  ⚠ A cap trip discards everything rather than returning what it had. Partial evidence is the
 *  precise hazard: a run that read 60% of the corpus would emit whys for the units it happened to
 *  reach and silently omit the rest, which reads as "these units had no why" instead of "the scan
 *  did not finish". */
export async function scanTranscripts(opts: ScanOptions): Promise<ScanOutcome> {
  const now = opts.now ?? (() => Date.now());
  const capMs = opts.capMs ?? DEFAULT_SCAN_CAP_MS;
  const degraded: ScanOutcome["degraded"] = [];
  const evidence = emptyEvidence(opts.window);
  const c = evidence.counters;

  // ── Bundled self-test, BEFORE the clock starts.
  const { selfTest } = await import("./health");
  const { selectTurn } = await import("./select");
  if (!selfTest((t) => selectTurn(t).ok).ok) {
    degraded.push("self-test-mismatch");
    return { evidence, degraded };            // systematic failure => git-only, no evidence at all
  }

  const started = now();                       // ⚠ the cap clock starts HERE, after the self-test
  const overCap = () => now() - started > capMs;

  try {
    const { discoverDepth1, discoverSubagents, isSelfPrompt } = await import("./discover");
    const { readJsonl } = await import("./reader");
    const { transformLines } = await import("./transform");
    const { buildSegments, makeBucketer } = await import("./segments");
    const { joinEvidence, shouldEscalate, countAdoptedWhys, whySourcesAdopted } = await import("./join");

    const startMs = Date.parse(opts.window.startUtc);
    const endMs = Date.parse(opts.window.endUtc);
    const inWin = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) && t >= startMs && t <= endMs; };

    const bucket = await makeBucketer(opts.repos, opts.rootsByRepo, opts.cfg, opts.cfg.excludeRepos);

    // Depth-1 first. The subagent tier is ESCALATE-ON-EMPTY (§3.6), so it is not paid for here.
    const files: Discovered[] = (await discoverDepth1(opts.root, startMs)).map((path) => ({ path, tier: "depth1" as const }));
    let escalated = false;

    const paths: { sessionId: string; tsUtc: string; path: string }[] = [];
    const turns: { sessionId: string; uuid: string; tsUtc: string; text: string; order: number }[] = [];
    const sessionsSeen = new Set<string>();
    let order = 0;

    type Discovered = { path: string; tier: "depth1" | "subagent" };
    const ingest = async (batch: Discovered[]) => {
      for (const f of batch) {
        if (overCap()) { c.capTripped = true; return; }
        c.filesScanned++;
        const lines: Record<string, unknown>[] = [];
        for await (const o of readJsonl(f.path, c)) lines.push(o);
        const out = transformLines(lines, f.path, f.tier, c.drops);
        for (const p of out.paths) if (inWin(p.tsUtc)) { paths.push(p); sessionsSeen.add(p.sessionId); }
        for (const t of out.turns) {
          // ⚠ ONE pass, ONE selectTurn call. An earlier draft tallied the six stage drops in a
          // SECOND loop over every `out.turns` entry, which counted out-of-window and self-prompt
          // turns into the buckets — inflating exactly the telemetry 1.5a exists to produce, and
          // breaking the §5 accounting identity against `examined`.
          if (!inWin(t.tsUtc)) continue;
          sessionsSeen.add(t.sessionId);
          if (isSelfPrompt(t.text)) continue;                 // never ingest our own prompts
          const r = selectTurn(t.text);
          if (!r.ok) { c.drops[r.reason]++; continue; }       // the six pipeline stages
          turns.push({ ...t, order: order++ });
        }
      }
    };

    await ingest(files);
    if (c.capTripped) { degraded.push("cap-tripped"); return { evidence: discardEvidence(evidence), degraded }; }

    // ⚠ NO drops record on the pre-escalation pass. `paths` is CUMULATIVE and `buildSegments` runs
    // again after escalation over the whole array, so threading `c.drops` here counts every depth-1
    // path-unresolvable TWICE. Measured at C4: 3 distinct unresolvable paths reported as 5. Only the
    // final pass — the one whose segments are actually used — writes the counter.
    let seg = buildSegments(paths, bucket);
    let joined = joinEvidence({
      segments: seg.segments, firstEdit: seg.firstEdit, candidates: turns,
      units: opts.units, activities: opts.activities, bucket, onAmbiguity: opts.onAmbiguity,
    });
    c.whysBeforeEscalation = joined.sources.size;

    // ── Escalation (T3.4): once per run, FULL re-join with the subagent tier merged in. A subagent
    // path can turn a one-claimant unit into an ambiguous one, so a patch would be unsound.
    // ⚠ CALLS the predicate rather than restating it. An inline copy here and the exported one in
    // join.ts were two implementations of a single decision rule — and this one feeds `escalated` /
    // `escalationSkipped`, so a drift between them would silently mis-record whether escalation was
    // even attempted. Decision-feeding computations get extracted at TWO copies, not three.
    // ⚠ COUNTS THE ADOPTED CURVE via `countAdoptedWhys` — one definition with whySourceFor's
    // tiebreak. Counting conservative alone overstates the shortfall and can spend a full subagent
    // re-scan on a run that already resolved everything.
    if (shouldEscalate({ unitsEligible: joined.unitsEligible, whys: countAdoptedWhys(joined) })) {
      if (overCap()) { c.escalationSkipped = true; }
      else {
        escalated = true;
        const sub: Discovered[] = (await discoverSubagents(opts.root, startMs)).map((path) => ({ path, tier: "subagent" as const }));
        await ingest(sub);
        if (c.capTripped) { degraded.push("cap-tripped"); return { evidence: discardEvidence(evidence), degraded }; }
        seg = buildSegments(paths, bucket, c.drops);   // the FINAL pass owns the counter
        joined = joinEvidence({
          segments: seg.segments, firstEdit: seg.firstEdit, candidates: turns,
          units: opts.units, activities: opts.activities, bucket, onAmbiguity: opts.onAmbiguity,
        });
      }
    }
    c.escalated = escalated;

    // If escalation never ran, the final pass above did not happen — so count here instead. Exactly
    // one of the two `buildSegments` calls ever writes `path-unresolvable`.
    if (!escalated) c.drops["path-unresolvable"] += seg.pathsUnresolvable;
    evidence.segments = seg.segments;
    evidence.unitFiles = joined.unitFiles;
    evidence.sources = joined.sources;
    evidence.sourcesStrictMajority = joined.sourcesStrictMajority;
    for (const [k, v] of Object.entries(joined.drops)) c.drops[k as DropReason] += v ?? 0;
    c.segments = seg.segments.length;
    c.segmentsAfterCollapse = new Set(seg.segments.map((s) => `${s.sessionId}\x00${s.unitKey}`)).size;
    c.sessionsInWindow = sessionsSeen.size;
    c.unitsEligible = joined.unitsEligible;
    c.anchorsAttempted = joined.anchorsAttempted;
    c.anchorsResolved = joined.anchorsResolved;
    c.whysConservative = joined.sources.size;
    c.whysStrictMajority = joined.sourcesStrictMajority.size;

    // ⚠ Pre-mortem risk 4's writer. For each unit that produced a why, measure how long BEFORE that
    // unit's earliest in-window commit the claiming session started. If the deltas cluster under a
    // few hours the 24 h margin is generous; if many land in "24+", the margin is too tight and is
    // silently costing whys. Guessing that is exactly what this counter exists to stop.
    const { bucketStartToCommit } = await import("./health");
    // ⚠ THE ADOPTED CURVE via `whySourcesAdopted` — same map the renderer and G5 use per-key.
    // Iterating `sources` alone silently excluded every strict-majority-only why from a distribution
    // that EXISTS TO TUNE the 24h margin (measured: conservative was 11 of a 23-why union).
    //
    // ⚠ FIRST COMMIT IS PER-UNIT, not repo-global. An earlier draft took the earliest activity in
    // `opts.activities` for every why — so unit B was measured against unit A's morning commit and
    // the 24h-margin histogram was garbage on multi-unit days. Same bucketer as join/buildUnitFiles.
    const earliestCommitByUnit = new Map<string, number>();
    for (const a of opts.activities) {
      if (a.kind !== "commit" || a.meta?.excluded || !a.timestamp || !a.repo) continue;
      const t = Date.parse(a.timestamp);
      if (!Number.isFinite(t)) continue;
      for (const d of a.meta?.diffstat ?? []) {
        const uk = bucket(`${a.repo}/${d.file}`);
        if (uk === null) continue;
        const cur = earliestCommitByUnit.get(uk);
        if (cur === undefined || t < cur) earliestCommitByUnit.set(uk, t);
      }
    }
    for (const [key, src] of whySourcesAdopted(joined)) {
      const sessionStart = [...paths, ...turns]
        .filter((x) => x.sessionId === src.anchor.sessionId)
        .map((x) => Date.parse(x.tsUtc)).filter(Number.isFinite).sort((a, b) => a - b)[0];
      const firstCommit = earliestCommitByUnit.get(key);
      if (sessionStart === undefined || firstCommit === undefined || firstCommit < sessionStart) continue;
      c.startToCommitHours[bucketStartToCommit((firstCommit - sessionStart) / 3_600_000)]++;
    }

    // Per-unit-file-count buckets — the denominator A9 is judged on.
    for (const [key, files] of joined.unitFiles) {
      if (files.length === 0) continue;
      const b = files.length === 1 ? "1" : files.length <= 3 ? "2-3" : files.length <= 7 ? "4-7" : "8+";
      c.byUnitFileCount[b].eligible++;
      if (joined.sources.has(key)) c.byUnitFileCount[b].conservative++;
      if (joined.sourcesStrictMajority.has(key)) c.byUnitFileCount[b].strictMajority++;
    }

    // ⚠ Parse-failure rate is evaluated PER RUN. A 40% parse-failure run that returned its 60%
    // would warn and then render whys from a corpus it demonstrably could not read.
    if (c.linesRead > 0 && c.parseFailures / c.linesRead > 0.1) {
      degraded.push("parse-failure-rate");
      return { evidence: discardEvidence(evidence), degraded };
    }
    return { evidence, degraded };
  } catch {
    // ANY subsystem throw => git-only. The transcript feature must never take the briefing down
    // (invariant 8), so the failure is absorbed here and surfaced as a code, not a stack.
    degraded.push("subsystem-throw");
    return { evidence: discardEvidence(evidence), degraded };
  }
}
