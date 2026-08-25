// test/harden.warnings.test.ts
//
// C1/B8 — dynamic warnings must reach the briefing. Two classes exist: STATIC ones (argv conflicts, the
// cwd-ladder rung) are known before the provider runs and already ride core's `warnings[]`. DYNAMIC
// ones — probe anomalies, and later the flag-rejection ladder's outcome — are only known DURING
// `generate()`, which happens after core has assembled its list. Without an explicit merge they are
// simply lost, and a "hardening disabled, then failed anyway" morning is logged as a bare ProviderError
// with no hint of why.
//
// WHY NOT JUST PUSH ONTO THE SHARED ARRAY: `generator.ts` passes `warnings: meta.warnings` BY REFERENCE,
// so `struct.warnings` initially aliases core's array — but it then REASSIGNS `struct.warnings = [...]`
// when a cited SHA fails verification, detaching the alias. That reassignment is conditional, so
// aliasing survives on some mornings and not others: a late push would land in the briefing or vanish
// depending on whether a SHA happened to fail that day. Non-deterministic, so the merge must be explicit.
import { test, expect } from "bun:test";
import { runCore } from "../src/core";
import { buildRepo } from "./fixtures/build-repo";
import { ProviderError, type Config } from "../src/types";

const yesterdayNoon = () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 1); return d.toISOString(); };
const BRIEF = "## RESUME\n- [x] resume\n## RECAP\n- [x] did it | evidence: HEADSHA\n## SUGGESTIONS\n- next";
const mkCfg = (repos: string[]): Config => ({
  repos, excludeCommitPatterns: [], lookbackCapDays: 30,
  provider: { cli: "echo", argv: [], promptVia: "stdin" },
});

/** A provider shaped like `hardenedProvider`'s return: it accumulates warnings DURING generate(). */
function warningProvider(warnings: string[], opts: { fail?: boolean; times?: number } = {}) {
  const runtimeWarnings: string[] = [];
  return {
    runtimeWarnings,
    generate: async () => {
      // Pushed on EVERY attempt, exactly as a probe anomaly would be under withRetry's 3 attempts.
      runtimeWarnings.push(...warnings);
      if (opts.fail) throw new ProviderError("nonzero-exit", "simulated provider failure");
      return BRIEF;
    },
  };
}

test("B8: a dynamic warning raised during generate() reaches struct.warnings", async () => {
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const provider = warningProvider(["hardening not injected: probe anomaly"]);
  const r = await runCore(mkCfg([dir]), { provider, netProbe: async () => true });
  expect(r.struct.warnings ?? []).toContain("hardening not injected: probe anomaly");
});

test("B8: dynamic warnings are DEDUPED — withRetry can raise the same one on every attempt", async () => {
  // Three attempts pushing an identical anomaly must not print it three times in the briefing.
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const provider = warningProvider(["dup warning", "dup warning", "dup warning"]);
  const r = await runCore(mkCfg([dir]), { provider, netProbe: async () => true });
  const hits = (r.struct.warnings ?? []).filter((w) => w === "dup warning");
  expect(hits).toHaveLength(1);
});

test("B8: dynamic warnings survive generator's struct.warnings REASSIGNMENT", async () => {
  // The aliasing hazard, made concrete: a cited SHA that fails verification makes generator DROP it and
  // REASSIGN struct.warnings, detaching any aliased array. The dynamic warning must still be present
  // afterwards, which is only true if the merge is explicit.
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  // A HEX short-sha, not a placeholder: generator only treats SHA-shaped tokens as citations, so
  // `HEADSHA` would be ignored and the reassignment this test exists to provoke would never fire.
  const withBadSha = "## RESUME\n- [x] resume\n## RECAP\n- [x] did it | evidence: abc1234\n## SUGGESTIONS\n- next";
  const provider = { runtimeWarnings: [] as string[], generate: async function () { this.runtimeWarnings.push("must survive reassignment"); return withBadSha; } };
  const r = await runCore(mkCfg([dir]), { provider, netProbe: async () => true });
  const w = r.struct.warnings ?? [];
  expect(w.some((x) => x.includes("didn't resolve"))).toBe(true);   // the reassignment DID fire
  expect(w).toContain("must survive reassignment");                 // ...and the dynamic warning survived it
});

test("B8: on provider FAILURE the dynamic warnings ride out on the ProviderError", async () => {
  // The most valuable case: "hardening was disabled, and then the call failed anyway". Without this the
  // shell logs a bare ProviderError and the operator never learns hardening was off.
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const provider = warningProvider(["hardening disabled: CLI rejected a flag"], { fail: true });
  const e: unknown = await runCore(mkCfg([dir]), { provider, netProbe: async () => true, retryDelaysMs: [], sleep: async () => {} })
    .then(() => { throw new Error("expected the run to reject"); }, (err: unknown) => err);
  expect(e).toBeInstanceOf(ProviderError);
  expect((e as ProviderError).warnings ?? []).toContain("hardening disabled: CLI rejected a flag");
});

test("B8: a plain Provider with no runtimeWarnings is unaffected (no crash, no phantom warnings)", async () => {
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const plain = { generate: async () => BRIEF };
  const r = await runCore(mkCfg([dir]), { provider: plain, netProbe: async () => true });
  expect(r.struct).toBeDefined();
  // Asserted as emptiness, not `every(...)`: `every` on an empty array is vacuously true, so it would
  // have passed no matter what the merge did. This brief cites no SHA-shaped evidence and the provider
  // carries no runtimeWarnings, so the correct result is NO warnings at all.
  expect(r.struct.warnings ?? []).toEqual([]);
});
