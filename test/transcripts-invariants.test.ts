// Slice 1.5 T4.5 — invariants 3, 4, 6 and 8, plus the INGEST half of 7.
// Slice 1.5 T4.6 — the prompt-equality test.
//
// Each goes RED when its guard is removed; where a guard is structural rather than a line of code,
// the test says which structure it depends on, so a later refactor that dissolves that structure
// fails here rather than silently voiding the invariant.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCore } from "../src/core";
import { scanTranscripts, emptyEvidence } from "../src/transcripts/scan";
import { textSha } from "../src/transcripts/anchor";
import { transformLines } from "../src/transcripts/transform";
import { ingestScan } from "../src/transcripts/credentials";
import { readJsonl, emptyTally } from "../src/transcripts/reader";
import { buildRepo } from "./fixtures/build-repo";
import { buildSession, buildRawSession, humanTurn, assistantToolUse, unrecognisedLine } from "./fixtures/session";
import type { Config } from "../src/types";

const yesterdayNoon = () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 1); return d.toISOString(); };
const stub = { generate: async () => "## RESUME\n- [x] r\n## RECAP\n- [x] d | evidence: HEADSHA\n## SUGGESTIONS\n- n" };
const tmp = () => mkdtempSync(join(tmpdir(), "dba-inv-"));
const W = { startUtc: "2026-07-29T00:00:00.000Z", endUtc: "2026-07-31T00:00:00.000Z" };
const CFG: Config = { provider: { cli: "claude", argv: [], promptVia: "stdin" } };

const withTranscripts = async (dir: string, extra: Partial<Parameters<typeof runCore>[1]> = {}) => {
  const cfg: Config = { repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30,
    transcripts: { enabled: true }, provider: { cli: "claude", argv: [], promptVia: "stdin" } };
  return runCore(cfg, { provider: stub, netProbe: async () => true, persistHealth: async () => {}, ...extra });
};

// ── Invariant 3: never extends the WINDOW ────────────────────────────────────────────────────────
// §3.1's margin widens the READ window, never the BULLET set. Bullets are enumerated from git
// activity only, so a transcript reaching further back must not add one.
test("inv3: the 24h read margin widens the READ window but never the bullet set", async () => {
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const gitOnly = await runCore(
    { repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30, provider: { cli: "claude", argv: [], promptVia: "stdin" } },
    { provider: stub, netProbe: async () => true });

  // A scan that returns evidence for a unit the git window never produced.
  const withScan = await withTranscripts(dir, {
    scan: async (o) => {
      const e = emptyEvidence(o.window);
      e.sources.set("/phantom\x00", { unitKey: "/phantom\x00", text: "a turn about work in a repo the window never saw",
        anchor: { sessionId: "s", uuid: "u", tsUtc: o.window.startUtc, textSha: textSha("a turn about work in a repo the window never saw"), unitKey: "/phantom\x00" } });
      return { evidence: e, degraded: [] };
    },
  });
  // Structural: `units` comes from resolveUnits over git activities; the scan cannot append to it.
  expect(withScan.units.map((u) => u.label).sort()).toEqual(gitOnly.units.map((u) => u.label).sort());
  expect(withScan.struct.recap.length).toBe(gitOnly.struct.recap.length);
  expect(withScan.struct.resume.length).toBe(gitOnly.struct.resume.length);
});

// ── Invariant 4: never participates in emptyWindow or blocked ────────────────────────────────────
test("inv4: transcripts never change the emptyWindow decision, and never run on that path", async () => {
  const root = tmp();
  buildSession({ dir: join(root, "-proj"), sessionId: "s1", lines: [
    humanTurn({ sessionId: "s1", uuid: "u1", ts: new Date().toISOString(), text: "a substantive turn that must not resurrect an empty window" }),
  ] });

  // ⚠ A repo is NOT usable for this fixture: `resumptionSignals` emits a branch activity for every
  // repo with a resolvable branch (git.ts), so `activities` is never empty for a scanned repo and
  // `emptyWindow` cannot be true. Established at C4. A zero-repo run is the honest empty-window case.
  let scanCalled = false;
  const empty = await runCore(
    { repos: [], excludeCommitPatterns: [], lookbackCapDays: 1, transcripts: { enabled: true, root },
      provider: { cli: "claude", argv: [], promptVia: "stdin" } },
    { provider: stub, netProbe: async () => true, persistHealth: async () => {},
      scan: async (o) => { scanCalled = true; return { evidence: emptyEvidence(o.window), degraded: [] }; } });
  expect(empty.emptyWindow).toBe(true);
  // The scan is inserted AFTER the emptyWindow return, so an empty day costs nothing — and RULE 1
  // depends on it, since a non-scanning run must write no day record.
  expect(scanCalled).toBe(false);

  // And on a NON-empty day the decision is identical with transcripts on vs off: the carve-out means
  // transcript evidence is not an input to it in either direction.
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const base = { repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30,
    provider: { cli: "claude", argv: [], promptVia: "stdin" } } as Config;
  const off = await runCore({ ...base, transcripts: { enabled: false } },
    { provider: stub, netProbe: async () => true, persistHealth: async () => {} });
  const on = await runCore({ ...base, transcripts: { enabled: true } }, {
    provider: stub, netProbe: async () => true, persistHealth: async () => {},
    scan: async (o) => ({ evidence: emptyEvidence(o.window), degraded: [] }) });
  expect(on.emptyWindow).toBe(off.emptyWindow);
  expect(on.blocked).toBe(off.blocked);
});

// ── Invariant 6: fail-closed on anything unrecognised ────────────────────────────────────────────
test("inv6: unrecognised line type, block type, tool name and malformed JSON are all skipped and counted", async () => {
  const dir = tmp();
  // Malformed JSON.
  const broken = buildRawSession({ dir, fileName: "broken.jsonl", raw: '{"type":"user","message":{"content":"cut off\n{"type":"user"}\n' });
  const tally = emptyTally();
  const parsed: unknown[] = [];
  for await (const o of readJsonl(broken, tally)) parsed.push(o);
  expect(tally.parseFailures).toBeGreaterThan(0);   // counted, not thrown

  const drops = { "unrecognised-shape": 0 } as Record<string, number>;
  const out = transformLines([
    unrecognisedLine({ sessionId: "s", ts: W.startUtc }),                        // unknown line type
    { type: "ai-title", title: "hallucinated" },                                 // explicitly not-readable
    { type: "assistant", sessionId: "s", uuid: "u", timestamp: W.startUtc, isSidechain: false,
      message: { role: "assistant", content: [{ type: "thinking", thinking: "internal" }] } },  // unknown block type
    { type: "assistant", sessionId: "s", uuid: "u2", timestamp: W.startUtc, isSidechain: false,
      message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "SomeToolCCAddsNextWeek", input: { file_path: "/r/a.ts" } }] } },
  ], "/root/-p/s.jsonl", "depth1", drops as never);
  expect(drops["unrecognised-shape"]).toBe(2);      // the two unknown LINE types
  expect(out.paths).toEqual([]);                    // unknown TOOL name yields nothing — allowlist, not denylist
  expect(out.turns).toEqual([]);                    // unknown BLOCK type yields nothing
});

// ── Invariant 7, INGEST half: credential-scanned fail-closed ────────────────────────────────────
test("inv7-ingest: a credential-bearing turn is DROPPED at ingest, not redacted", async () => {
  const dirty = "re-run with AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY to reproduce";
  expect(ingestScan(dirty)).toEqual({ ok: false, reason: "credential-hit" });
  // ⚠ Under quotation a redacted span would ship as `you wrote: "…[redacted]"` — advertising a
  // secret's existence and location while adding nothing. Dropping is both safer and more useful.
  expect(ingestScan("an ordinary turn about the join logic")).toEqual({ ok: true });
});

// ── Invariant 8: never breaks, blocks, or delays the git briefing ───────────────────────────────
test("inv8: a scan that THROWS still yields a complete git briefing", async () => {
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const r = await withTranscripts(dir, { scan: async () => { throw new Error("scan exploded"); } });
  expect(r.struct.recap.length).toBeGreaterThan(0);
  expect(r.struct.resume.length).toBeGreaterThan(0);
  expect(r.transcripts).toBeUndefined();
});

test("inv8: a scan that HANGS past the cap does not hang the briefing", async () => {
  const root = tmp();
  const proj = join(root, "-proj");
  for (let i = 0; i < 6; i++) {
    buildSession({ dir: proj, sessionId: `s${i}`, lines: [
      assistantToolUse({ sessionId: `s${i}`, uuid: `a${i}`, ts: "2026-07-30T10:00:00.000Z", paths: ["/repo/a/x.ts"] }),
    ] });
  }
  let t = 0;
  const started = performance.now();
  const { degraded } = await scanTranscripts({
    root, window: W, repos: ["/repo"], cfg: CFG, activities: [], units: [], rootsByRepo: new Map(),
    capMs: 1, now: () => (t += 5_000),
  });
  // The cap is what bounds it; without one a pathological corpus would run for the whole morning.
  expect(degraded).toContain("cap-tripped");
  expect(performance.now() - started).toBeLessThan(5_000);
});

// ── T4.6: prompt equality ────────────────────────────────────────────────────────────────────────
// ⚠ TWO assertions, and the second is what makes the first mean anything: the prompt must be
// byte-identical with transcripts on vs off, AND the transcripts-on run must have produced ≥1
// `sources` entry. Equality alone passes trivially when the reader is stubbed out and finds nothing —
// which is exactly the regression this guards. Red-checked: deleting the `sources.set` below turns
// this RED.
//
// ⚠ The EQUALITY half cannot be red-checked by perturbing the prompt, and that is inherent rather
// than a gap: it compares on-vs-off within ONE build, so a change affecting both runs stays
// invisible (measured — appending a literal to the prompt header left this green). What it actually
// detects is transcript evidence LEAKING into the prompt, which today is prevented structurally —
// `TranscriptEvidence` lives outside `ReducedContext` (§3.7) and `buildPrompt` never receives it.
// If a future change threads evidence into the prompt path, this is what fails.
test("T4.6: the prompt is byte-identical with transcripts ON vs OFF, and the ON run really found evidence", async () => {
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const base = { repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30,
    provider: { cli: "claude", argv: [], promptVia: "stdin" } } as Config;

  const off = await runCore({ ...base, transcripts: { enabled: false } },
    { provider: stub, netProbe: async () => true, persistHealth: async () => {} });

  const on = await runCore({ ...base, transcripts: { enabled: true } }, {
    provider: stub, netProbe: async () => true, persistHealth: async () => {},
    scan: async (o) => {
      const e = emptyEvidence(o.window);
      const k = "/repo\x00";
      e.sources.set(k, { unitKey: k, text: "I switched the join to a membership test",
        anchor: { sessionId: "s1", uuid: "u1", tsUtc: o.window.startUtc, textSha: textSha("I switched the join to a membership test"), unitKey: k } });
      return { evidence: e, degraded: [] };
    },
  });

  // §3.7: TranscriptEvidence lives OUTSIDE ReducedContext and never reaches the prompt path.
  expect(on.promptText).toBe(off.promptText);
  // …and the ON run genuinely produced evidence, so the equality above is not vacuous.
  expect(on.transcripts).toBeDefined();
  expect(on.transcripts!.sources.size).toBeGreaterThanOrEqual(1);
});

// ── A9 UNION, END TO END — the regression guard for the #181/#182 HIGH ───────────────────────────
//
// ⚠ WHY THIS IS AN INTEGRATION TEST AND NOT A UNIT ONE. #181 adopted the union curve; `core.ts`
// projected whys from it, but G5 still resolved evidence from the CONSERVATIVE map alone, so a
// strict-majority-only why failed `why-attribution` as "not produced by the join" — a HARD rule —
// and core.ts's fail-closed handler then deleted EVERY why. The briefing rendered none on exactly
// the days the union was meant to add them.
//
// A full green suite (1105 tests) was compatible with that, because every G5 fixture seeded
// `ev.sources`: no test constructed the state the union introduced. #182 fixed both layers and
// unit-tested each. THIS pins that the two layers agree IN SITU — projection and validation must
// share one view of which whys exist, and only an end-to-end assertion can catch them diverging.
test("⚠ A9 union e2e: a STRICT-MAJORITY-only why survives the projection AND G5's fail-closed gate", async () => {
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const { unitKey } = await import("../src/subprojects");
  const key = unitKey(dir, null);
  const turn = "I am reworking the join because the plurality vote mis-attributes spanning commits";
  const at = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const res = await withTranscripts(dir, {
    scan: async (o) => {
      const e = emptyEvidence(o.window);
      // ⚠ ONLY the strict-majority map — the state no fixture built before #182.
      e.sourcesStrictMajority.set(key, {
        unitKey: key, text: turn,
        anchor: { sessionId: "s1", uuid: "u1", tsUtc: at, textSha: textSha(turn), unitKey: key },
      });
      // Two claimants: the reason conservative dropped this unit, and the shape that made the
      // single-claimant rule fail every strict-majority why until #182 split the branch.
      e.segments.push({ sessionId: "s1", unitKey: key, localDay: "d", paths: ["a.ts"] });
      e.segments.push({ sessionId: "s2", unitKey: key, localDay: "d", paths: ["b.ts"] });
      return { evidence: e, degraded: [] };
    },
  });

  // The why is RENDERED — not withheld. Pre-#182 `struct.whys` was deleted outright here.
  expect(res.struct.whys).toBeDefined();
  expect(Object.values(res.struct.whys ?? {})).toContain(turn);
  // And no user-facing withheld-quotations warning was emitted.
  expect((res.struct.warnings ?? []).join(" ")).not.toContain("failed a correctness check");
});
