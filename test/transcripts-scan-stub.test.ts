// Slice 1.5 T1.5 — the orchestrator STUB. Its contract is narrow on purpose: a well-formed EMPTY
// TranscriptEvidence. The real body is T4.1.
import { test, expect } from "bun:test";
import { scanTranscripts, emptyEvidence, emptyCounters, emptyDrops, DROP_REASONS } from "../src/transcripts/scan";
import type { Config } from "../src/types";

const W = { startUtc: "2026-07-29T00:00:00.000Z", endUtc: "2026-07-30T10:00:00.000Z" };

// T4.1 filled the stub, so this now asserts the EMPTY-INPUT path: an absent transcript root yields
// well-formed empty evidence and no degradation — a disabled or unused feature must look exactly
// like a healthy scan that found nothing.
test("T4.1: an absent transcript root yields well-formed empty evidence, not a degradation", async () => {
  const cfg: Config = { provider: { cli: "c", argv: [], promptVia: "stdin" } };
  const { evidence: e, degraded } = await scanTranscripts({
    root: "/nonexistent", window: W, repos: [], cfg, activities: [], units: [], rootsByRepo: new Map(),
  });
  expect(degraded).toEqual([]);
  expect(e.window).toEqual(W);
  expect(e.segments).toEqual([]);
  for (const m of [e.unitFiles, e.sources, e.sourcesStrictMajority]) {
    expect(m).toBeInstanceOf(Map);
    expect(m.size).toBe(0);
  }
  expect(e.counters).toEqual(emptyCounters());
});

// The §5 accounting assertion sums over a COMPLETE bucket set, so every code must be present and
// zeroed — a missing key reads as `undefined` in that sum, not as 0, and silently voids the check.
test("T1.5: every DropReason is present and zeroed, with no extras", () => {
  const d = emptyDrops();
  expect(Object.keys(d).sort()).toEqual([...DROP_REASONS].sort());
  expect(DROP_REASONS.length).toBe(16);
  expect(new Set(DROP_REASONS).size).toBe(16); // no duplicate codes
  expect(Object.values(d).every((v) => v === 0)).toBe(true);
});

test("T1.5: the four byUnitFileCount buckets exist and are zeroed", () => {
  const c = emptyCounters();
  expect(Object.keys(c.byUnitFileCount)).toEqual(["1", "2-3", "4-7", "8+"]);
  for (const b of Object.values(c.byUnitFileCount)) expect(b).toEqual({ eligible: 0, conservative: 0, strictMajority: 0 });
});

// Fresh objects per call, not a shared singleton: counters are accumulated into, so a shared default
// would leak one run's totals into the next.
test("T1.5: emptyCounters/emptyEvidence return fresh objects each call", () => {
  const a = emptyCounters(), b = emptyCounters();
  a.drops["ambiguous"] = 7; a.byUnitFileCount["1"].eligible = 3;
  expect(b.drops["ambiguous"]).toBe(0);
  expect(b.byUnitFileCount["1"].eligible).toBe(0);
  expect(emptyEvidence(W).sources).not.toBe(emptyEvidence(W).sources);
});
