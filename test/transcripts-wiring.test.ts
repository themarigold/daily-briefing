// Slice 1.5 M4 — the orchestrator body (T4.1) and its wiring into runCore (T4.2/T4.3/T4.4/T4.8/T4.9).
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCore } from "../src/core";
import { scanTranscripts, emptyEvidence, emptyCounters, DEFAULT_SCAN_CAP_MS, type TranscriptRunCounters } from "../src/transcripts/scan";
import { buildSession, humanTurn, assistantToolUse } from "./fixtures/session";
import { buildRepo } from "./fixtures/build-repo";
import type { Config } from "../src/types";

const yesterdayNoon = () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 1); return d.toISOString(); };
const stub = { generate: async () => "## RESUME\n- [x] r\n## RECAP\n- [x] d | evidence: HEADSHA\n## SUGGESTIONS\n- n" };
const tmp = () => mkdtempSync(join(tmpdir(), "dba-m4-"));
const W = { startUtc: "2026-07-29T00:00:00.000Z", endUtc: "2026-07-31T00:00:00.000Z" };
const CFG: Config = { provider: { cli: "claude", argv: [], promptVia: "stdin" } };

// ── T4.1: the cap, and the self-test's exclusion from it ─────────────────────────────────────────
test("T4.1: a cap trip DISCARDS all evidence rather than returning what it had", async () => {
  const root = tmp();
  const proj = join(root, "-proj");
  for (let i = 0; i < 8; i++) {
    buildSession({ dir: proj, sessionId: `s${i}`, lines: [
      humanTurn({ sessionId: `s${i}`, uuid: `u${i}`, ts: "2026-07-30T09:00:00.000Z", text: "a substantive turn about the unit work in progress here" }),
      assistantToolUse({ sessionId: `s${i}`, uuid: `a${i}`, ts: "2026-07-30T10:00:00.000Z", paths: ["/repo/a/x.ts"] }),
    ] });
  }
  // A clock that races past the cap after the self-test, so the trip is deterministic.
  let t = 0;
  const { evidence, degraded } = await scanTranscripts({
    root, window: W, repos: ["/repo"], cfg: CFG, activities: [], units: [], rootsByRepo: new Map(),
    capMs: 5, now: () => (t += 100),
  });
  expect(degraded).toContain("cap-tripped");
  // Partial evidence is the hazard the cap exists to prevent: a run that read 60% would emit whys
  // for the units it reached and silently omit the rest, reading as "no why" instead of "unfinished".
  expect(evidence.segments).toEqual([]);
  expect(evidence.sources.size).toBe(0);
});

test("T4.1: a SLOW self-test does not trip the cap — the clock starts after it", async () => {
  // ⚠ Charging the self-test to the cap would let a slow disk turn a health check into a fail-closed
  // discard of ALL evidence — the health check causing the outage it exists to detect.
  const root = tmp();
  let calls = 0;
  // The first N clock reads belong to the self-test window; the cap clock must not see them.
  const { degraded } = await scanTranscripts({
    root, window: W, repos: [], cfg: CFG, activities: [], units: [], rootsByRepo: new Map(),
    capMs: 1_000, now: () => { calls++; return calls === 1 ? 10_000_000 : 10_000_000 + calls; },
  });
  expect(degraded).not.toContain("cap-tripped");
});

test("T4.1: the default cap is a real bound, not effectively infinite", () => {
  expect(DEFAULT_SCAN_CAP_MS).toBeGreaterThan(1_000);
  expect(DEFAULT_SCAN_CAP_MS).toBeLessThanOrEqual(60_000);
});

// ⚠ FOUND AT C4. `paths` is CUMULATIVE and `buildSegments` runs again after escalation over the
// whole array, so threading the drops record through BOTH passes counted every depth-1
// path-unresolvable twice. Measured: 3 distinct unresolvable paths reported as 5. This corrupts the
// telemetry that is 1.5a's only deliverable, and only an ESCALATING fixture can catch it — a
// non-escalating run calls buildSegments once and reports correctly either way.
test("T4.1: path-unresolvable is not double-counted when escalation re-runs the join [C4]", async () => {
  const root = tmp();
  const proj = join(root, "-proj");
  const sess = join(proj, "s1");
  buildSession({ dir: proj, sessionId: "s1", lines: [
    humanTurn({ sessionId: "s1", uuid: "u1", ts: "2026-07-30T09:00:00.000Z", text: "a substantive turn explaining the work being started here" }),
    assistantToolUse({ sessionId: "s1", uuid: "a1", ts: "2026-07-30T10:00:00.000Z", paths: ["/nowhere/x.ts", "/nowhere/y.ts"] }),
  ] });
  // A subagent file, so the eligible-but-unclaimed unit forces escalation and the SECOND pass runs.
  buildSession({ dir: join(sess, "subagents"), sessionId: "sa1", lines: [
    assistantToolUse({ sessionId: "sa1", uuid: "a2", ts: "2026-07-30T10:00:00.000Z", paths: ["/nowhere/z.ts"], isSidechain: true }),
  ] });
  const unit = { repo: "/repo", root: null, label: "r", hasResumptionState: false, hasWindowContent: true,
    resumptionNote: "", dirtyFiles: ["a.ts"], latestCommitTime: null };
  const { evidence } = await scanTranscripts({
    root, window: W, repos: ["/repo"], cfg: CFG, activities: [], units: [unit],
    rootsByRepo: new Map([["/repo", []]]),
  });
  expect(evidence.counters.escalated).toBe(true);                    // the second pass really ran
  expect(evidence.counters.drops["path-unresolvable"]).toBe(3);      // x, y, z — not 5
});

// ⚠ The WRITER receipt for pre-mortem risk 4. The accumulation test in transcripts-join covers
// mergeRun; this covers the thing that feeds it. A shape with a correct merge and no producer is
// still structurally always zero — which is exactly how this counter shipped until the final harden
// loop caught it.
test("T4.1: a scan that produces a why also populates the start→commit histogram [risk-4 writer]", async () => {
  const root = tmp();
  const proj = join(root, "-proj");
  const repo = "/repo";
  // Session starts at 08:00, edits at 09:00; the unit's commit lands at 12:00 => a 4h delta.
  buildSession({ dir: proj, sessionId: "s1", lines: [
    humanTurn({ sessionId: "s1", uuid: "u1", ts: "2026-07-30T08:00:00.000Z",
      text: "I am switching the join to a membership test because the plurality vote mis-attributes" }),
    assistantToolUse({ sessionId: "s1", uuid: "a1", ts: "2026-07-30T09:00:00.000Z", paths: [`${repo}/a/x.ts`] }),
  ] });
  const unit = { repo, root: "a", label: "a", hasResumptionState: false, hasWindowContent: true,
    resumptionNote: "", dirtyFiles: [], latestCommitTime: null };
  const activities = [{
    source: "git" as const, kind: "commit" as const, event_id: "c1", repo,
    timestamp: "2026-07-30T12:00:00.000Z", text: "c",
    meta: { diffstat: [{ file: "a/x.ts", added: 1, removed: 0 }] },
  }];
  const { evidence } = await scanTranscripts({
    root, window: { startUtc: "2026-07-29T00:00:00.000Z", endUtc: "2026-07-31T00:00:00.000Z" },
    repos: [repo], cfg: CFG, activities, units: [unit],
    rootsByRepo: new Map([[repo, ["a"]]]),
  });
  expect(evidence.sources.size).toBe(1);          // the premise — without a why there is nothing to bucket
  const total = Object.values(evidence.counters.startToCommitHours).reduce((a, b) => a + b, 0);
  expect(total).toBe(1);
  expect(evidence.counters.startToCommitHours["4-12"]).toBe(1);   // 08:00 -> 12:00 is 4h
});

// ⚠ FOUND IN HARDEN ROUND 3. The §5 accounting identity was asserted only over `selectAll` — which
// PRODUCTION NEVER CALLS. scan.ts runs its own per-turn loop, and that loop had already carried a
// real double-tally bug (out-of-window and self-prompt turns were counted into the six buckets)
// which the selectAll-based test could not have caught. This asserts the buckets over the loop the
// product actually runs.
test("T4.1: the six pipeline drop buckets are tallied correctly by the REAL scan loop [r3]", async () => {
  const root = tmp();
  const proj = join(root, "-proj");
  const IN = "2026-07-30T09:00:00.000Z";
  const OUT = "2020-01-01T09:00:00.000Z";          // outside the window — must be counted NOWHERE
  const { PROMPT_HEADER } = await import("../src/generator");
  const mk = (uuid: string, ts: string, text: string) => humanTurn({ sessionId: "s1", uuid, ts, text });

  buildSession({ dir: proj, sessionId: "s1", lines: [
    mk("u1", IN, "<task-notification>" + "x".repeat(80) + "</task-notification>"),  // harness-wrapped
    mk("u2", IN, "yes"),                                                            // continuation-word
    mk("u3", IN, "/clear"),                                                         // slash-command
    mk("u4", IN, "short"),                                                          // turn-too-short
    mk("u5", IN, "y".repeat(700)),                                                  // over-cap-turn
    mk("u6", IN, "z".repeat(60) + "\n" + "z".repeat(60)),                           // control-byte
    mk("u7", IN, "a genuinely substantive turn explaining why the join drops"),      // qualifies
    // ⚠ Neither of these may reach ANY bucket: one is out of window, one is our own prompt.
    mk("u8", OUT, "yes"),
    mk("u9", IN, PROMPT_HEADER + " …the rest of our own prompt…"),
  ] });

  const { evidence } = await scanTranscripts({
    root, window: { startUtc: "2026-07-29T00:00:00.000Z", endUtc: "2026-07-31T00:00:00.000Z" },
    repos: ["/repo"], cfg: CFG, activities: [], units: [], rootsByRepo: new Map(),
  });
  const d = evidence.counters.drops;
  for (const code of ["harness-wrapped", "continuation-word", "slash-command", "turn-too-short", "over-cap-turn", "control-byte"] as const) {
    expect(d[code]).toBe(1);      // exactly one each — an out-of-window "yes" would make continuation-word 2
  }
});

// ── T4.4: every degradation route reaches struct.warnings, not just telemetry ────────────────────
// ⚠ §3.8 makes each trigger's SINK non-negotiable. Routing a degradation to telemetry alone is
// exactly the silent decay this tier forbids.
const degradedRun = async (degraded: string[]) => {
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const cfg: Config = { repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30,
    transcripts: { enabled: true }, provider: { cli: "claude", argv: [], promptVia: "stdin" } };
  return runCore(cfg, {
    provider: stub, netProbe: async () => true,
    persistHealth: async () => {},
    scan: async (o) => ({ evidence: emptyEvidence(o.window), degraded: degraded as never }),
  });
};

test("T4.4: each degradation route emits a LOUD warning AND yields git-only", async () => {
  for (const [code, needle] of [
    ["cap-tripped", "time budget"],
    ["self-test-mismatch", "self-test FAILED"],
    ["parse-failure-rate", "could not parse enough"],
    ["subsystem-throw", "transcript scan failed"],
  ] as const) {
    const r = await degradedRun([code]);
    expect((r.struct.warnings ?? []).some((w) => w.includes(needle))).toBe(true);
    expect(r.transcripts).toBeUndefined();     // git-only — never a partial evidence set
    expect(r.struct.recap.length).toBeGreaterThan(0);  // …and the briefing still renders (invariant 8)
  }
});

test("T4.4: a clean scan carries its evidence out and adds no warning", async () => {
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const cfg: Config = { repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30,
    transcripts: { enabled: true }, provider: { cli: "claude", argv: [], promptVia: "stdin" } };
  const r = await runCore(cfg, {
    provider: stub, netProbe: async () => true, persistHealth: async () => {},
    scan: async (o) => ({ evidence: emptyEvidence(o.window), degraded: [] }),
  });
  expect(r.transcripts).toBeDefined();
  expect((r.struct.warnings ?? []).some((w) => w.includes("git-only"))).toBe(false);
});

// ⚠ FOUND IN THE FINAL HARDEN LOOP. `evaluateTriggers` existed with NO CALL SITE, so §3.8's
// zero-yield trigger — whose entire purpose is detecting that the pipeline has silently stopped
// matching — never ran. It cannot be evaluated from one run's counters (it is defined over N=3
// consecutive QUALIFYING days), which is why it lives at the persist step where the history is in hand.
test("T4.4: the zero-yield trigger fires from HISTORY and emits a struct.warnings line [call-site]", async () => {
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const cfg: Config = { repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30,
    transcripts: { enabled: true }, provider: { cli: "claude", argv: [], promptVia: "stdin" } };

  const { emptyHealth, mergeRun } = await import("../src/transcripts/health");
  // Two prior QUALIFYING days (sessions found, zero whys). Today's run makes three.
  let prior = emptyHealth();
  for (const d of ["2026-07-28", "2026-07-29"]) {
    prior = mergeRun(prior, d, { ...emptyCounters(), sessionsInWindow: 2, whysConservative: 0 });
  }
  const r = await runCore(cfg, {
    provider: stub, netProbe: async () => true, persistHealth: async () => {}, priorHealth: prior,
    scan: async (o) => {
      const e = emptyEvidence(o.window);
      e.counters.sessionsInWindow = 2;      // a qualifying day…
      e.counters.whysConservative = 0;      // …that yielded nothing
      return { evidence: e, degraded: [] };
    },
  });
  expect((r.struct.warnings ?? []).some((w) => w.includes("consecutive days"))).toBe(true);

  // A quiet day is NOT decay: with no sessions found, the day is skipped and the streak does not
  // reach the threshold.
  const quiet = await runCore(cfg, {
    provider: stub, netProbe: async () => true, persistHealth: async () => {}, priorHealth: emptyHealth(),
    scan: async (o) => ({ evidence: emptyEvidence(o.window), degraded: [] }),
  });
  expect((quiet.struct.warnings ?? []).some((w) => w.includes("consecutive days"))).toBe(false);
});

// ── T4.2: the config warning finally has a reader (the C1 finding) ───────────────────────────────
test("T4.2: a malformed transcripts block warns in the run AND the briefing still renders", async () => {
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const cfg = { repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30,
    transcripts: 42, provider: { cli: "claude", argv: [], promptVia: "stdin" } } as unknown as Config;
  const r = await runCore(cfg, { provider: stub, netProbe: async () => true, persistHealth: async () => {} });
  expect(r.warnings.some((w) => w.includes("transcripts"))).toBe(true);
  expect(r.struct.recap.length).toBeGreaterThan(0);   // degrade, never throw
});

// ── T4.8: the A4 suppression notice ──────────────────────────────────────────────────────────────
test("T4.8: transcripts enabled + a non-claude CLI ⇒ an explicit notice, not a silent no-op", async () => {
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const cfg: Config = { repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30,
    transcripts: { enabled: true }, provider: { cli: "codex", argv: [], promptVia: "stdin" } };
  const r = await runCore(cfg, { provider: stub, netProbe: async () => true, persistHealth: async () => {} });
  // A silent no-op is the worse failure: the user enabled a feature and would never learn why
  // nothing appeared.
  expect(r.warnings.some((w) => w.includes("not a Claude Code CLI"))).toBe(true);
  expect(r.transcripts).toBeUndefined();
});

// ── T4.9: the health write runs, and only for a run that actually scanned ────────────────────────
test("T4.9: RULE 1 keys on whether the scan RAN, not on whether evidence survived [C4]", async () => {
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const base: Config = { repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30,
    transcripts: { enabled: true }, provider: { cli: "claude", argv: [], promptVia: "stdin" } };

  const written: { date: string; counters: TranscriptRunCounters }[] = [];
  const run = (scan: Parameters<typeof runCore>[1]["scan"]) => runCore(base, {
    provider: stub, netProbe: async () => true,
    persistHealth: async (date, counters) => { written.push({ date, counters }); }, scan,
  });

  await run(async (o) => ({ evidence: emptyEvidence(o.window), degraded: [] }));
  expect(written.length).toBe(1);

  // ⚠ A DEGRADED run still scanned, so it still writes — and its counters are exactly what diagnose
  // the degradation. Keying this on "is there evidence" made every degradation invisible in
  // telemetry (found at C4: a cap-tripped run persisted nothing at all).
  written.length = 0;
  await run(async (o) => {
    const e = emptyEvidence(o.window);
    e.counters.capTripped = true;
    e.counters.filesScanned = 42;
    return { evidence: e, degraded: ["cap-tripped"] as never };
  });
  expect(written.length).toBe(1);
  expect(written[0]!.counters.capTripped).toBe(true);      // the signal that the cap is too tight
  expect(written[0]!.counters.filesScanned).toBe(42);

  // …but a run that never scanned writes nothing. That is what RULE 1 actually protects: a
  // non-scanning run stamping an all-zero record would zero the day under last-run-wins and fire the
  // zero-yield trigger every single day.
  written.length = 0;
  await runCore({ ...base, transcripts: { enabled: false } }, {
    provider: stub, netProbe: async () => true,
    persistHealth: async (date, counters) => { written.push({ date, counters }); },
  });
  expect(written.length).toBe(0);
});

// ⚠ The evidence is discarded on degradation; the TELEMETRY is not. §3.8's "discard and warn"
// discards the evidence, never the counters that explain why.
test("T4.1: a degraded scan empties the derived sets but KEEPS its counters [C4]", async () => {
  const root = tmp();
  const proj = join(root, "-proj");
  buildSession({ dir: proj, sessionId: "s1", lines: [
    humanTurn({ sessionId: "s1", uuid: "u1", ts: "2026-07-30T09:00:00.000Z", text: "a substantive turn about the work in progress here" }),
    assistantToolUse({ sessionId: "s1", uuid: "a1", ts: "2026-07-30T10:00:00.000Z", paths: ["/repo/a/x.ts"] }),
  ] });
  let t = 0;
  const { evidence, degraded } = await scanTranscripts({
    root, window: W, repos: ["/repo"], cfg: CFG, activities: [], units: [], rootsByRepo: new Map(),
    capMs: 1, now: () => (t += 1000),
  });
  expect(degraded).toContain("cap-tripped");
  expect(evidence.sources.size).toBe(0);        // evidence discarded
  expect(evidence.segments).toEqual([]);
  expect(evidence.counters.capTripped).toBe(true);   // …telemetry survives
});

// ⚠ T4.9's decidable-at-C4 receipt: a synthetic POST-SCAN mutation of counters.drops must reach the
// persisted record. `label-collision` itself is written by T7.3 (M7), so asserting on that code here
// could neither pass nor fail.
//
// ⚠ STATED LIMIT OF THIS RECEIPT, measured rather than assumed. It pins that the write happens after
// the SCAN's counters are final — nothing stronger. Red-checked: moving the write up to immediately
// after `await scanPromise` leaves this GREEN, because the mutation below runs during generation,
// which is earlier still. The claim T4.9's comment actually makes — that the write runs after the
// `whys` PROJECTION — is not decidable until that projection exists, and the plan already assigns it
// to **T7.6** as a named task with its own red-when-moved receipt. Do not read this test as covering
// it.
test("T4.9: a post-scan counters mutation still reaches the persisted record", async () => {
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const cfg: Config = { repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30,
    transcripts: { enabled: true }, provider: { cli: "claude", argv: [], promptVia: "stdin" } };
  let seen: TranscriptRunCounters | null = null;
  const evidence = emptyEvidence({ startUtc: W.startUtc, endUtc: W.endUtc });
  const r = await runCore(cfg, {
    provider: {
      generate: async (p) => {
        // Mutate DURING generation — i.e. after the scan produced its counters, which is where the
        // `whys` projection will later run.
        evidence.counters.drops["label-collision"] = 3;
        return stub.generate();
      },
    },
    netProbe: async () => true,
    persistHealth: async (_d, counters) => { seen = counters; },
    scan: async () => ({ evidence, degraded: [] }),
  });
  expect(r.transcripts).toBeDefined();
  expect(seen!.drops["label-collision"]).toBe(3);   // the write happens AFTER, so the mutation survives
});

// ── T4.3: the in-flight scan must never escape as an unhandled rejection ────────────────────────
test("T4.3: a provider throw does not leak an unhandled rejection from the in-flight scan", async () => {
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const cfg: Config = { repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30,
    transcripts: { enabled: true }, provider: { cli: "claude", argv: [], promptVia: "stdin" } };

  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    await expect(runCore(cfg, {
      // The provider throws immediately; the await on the scan is therefore NEVER reached.
      provider: { generate: async () => { throw new Error("provider down"); } },
      netProbe: async () => true, retryDelaysMs: [], sleep: async () => {},
      persistHealth: async () => {},
      scan: async () => { throw new Error("scan blew up mid-flight"); },
    })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));   // let any rejection surface
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  // Neutralised AT CREATION with .catch, not at the await — otherwise this crashes the process on a
  // path that is otherwise a clean exit-1.
  expect(unhandled).toEqual([]);
});
