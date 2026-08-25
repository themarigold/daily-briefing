// test/eval/sha-shape-convergence.test.ts — the eval's SHA-candidate miners use the SHARED shape test.
//
// WHY THIS FILE EXISTS. `src/sha.ts` says it is "the ONE commit-SHA shape test … so the two can NEVER
// disagree". That was false for about a month: `eval/checks.ts` carried a THIRD copy that never
// imported it and applied NO `[a-f]` requirement, so any all-digit hex run in an evidence field —
// a date, a timestamp, a PR number — became a `fail`-severity G2 FABRICATION verdict, while the
// generator's `verifyEvidence` and the audit's `extractCitedShas` both correctly ignored it.
// `proseCandidates` in the same file already guarded against exactly that, so the two miners
// disagreed with each other as well.
//
// These tests go through `g2Fabrication` rather than the (unexported) miners, so they pin the
// VERDICT, not an implementation detail — a future rewrite of the miners is free, a re-divergence
// that resurrects the false FAIL is not.
import { test, expect } from "bun:test";
import { isShaShaped } from "../../src/sha";
import { CHECKS } from "../../src/eval/checks";
import type { CheckInput } from "../../src/eval/types";
import type { BriefingStruct } from "../../src/types";

const REAL = "4fa7227d0e64c870391749cf137d3e3fc071f800";

/** Minimal CheckInput carrying one recap bullet, enough to reach g2Fabrication. */
function inputWith(evidence: string, prose = "did a thing"): CheckInput {
  const struct = {
    recap: [{ repo: "app", text: prose, evidence }],
    resume: [], suggestions: [], warnings: [], provider: "test",
  } as unknown as BriefingStruct;
  return {
    caseName: "sha-shape", struct,
    rawText: "", promptText: "",
    ctx: { repos: [] } as unknown as CheckInput["ctx"],
    units: [], emptyWindow: false,
    gitShaSet: new Set([REAL]),
    fileInventory: new Set<string>(),
    shaToUnit: new Map(), commitMessages: new Map([[REAL, "feat: real commit"]]),
    denylist: [], doneToday: [],
  } as unknown as CheckInput;
}

const fabrications = (evidence: string, prose?: string) =>
  CHECKS.flatMap((c) => c(inputWith(evidence, prose)))
    .filter((f) => f.check === "G2" && f.rule === "fabrication");

test("an all-digit token in EVIDENCE is not a fabrication — the false FAIL this convergence fixes", () => {
  // THE regression. `20260716` is a date; it is not a SHA by `sha.ts`'s definition and never was.
  // Before convergence this produced: severity "fail", rule "fabrication", on a HARD rule — an
  // incorrect ❌ EVAL row for a briefing that did nothing wrong.
  // MUTATION this kills: drop `isShaShaped` from `evidenceCandidates`.
  expect(fabrications(`${REAL} 20260716`)).toEqual([]);
  expect(fabrications("20260716")).toEqual([]);
  expect(fabrications("1234567")).toEqual([]);          // 7 digits — a PR number or a count
});

test("the two miners in checks.ts now AGREE — an all-digit token is inert in evidence and in prose", () => {
  // They disagreed before: `proseCandidates` skipped all-digit runs, `evidenceCandidates` did not.
  // Same token, same file, opposite verdicts depending only on which field it landed in.
  expect(fabrications("20260716")).toEqual([]);                    // evidence side
  expect(fabrications(REAL, "shipped 20260716 and 1234567")).toEqual([]);  // prose side
});

test("a genuinely fabricated SHA-SHAPED token IS still a fabrication (the guard is not over-broad)", () => {
  // The whole check must keep working. `deadbeef` is hex, has letters, is 8 chars — SHA-shaped by
  // `sha.ts` — and resolves to nothing.
  // MUTATION this kills: making `evidenceCandidates` return [] unconditionally, which would
  // otherwise satisfy every assertion above.
  const f = fabrications("deadbeef");
  expect(f.length).toBeGreaterThan(0);
  expect(f[0]!.severity).toBe("fail");
  expect(f[0]!.detail).toContain("deadbeef");
});

test("a real, resolving SHA is never a fabrication", () => {
  expect(fabrications(REAL)).toEqual([]);
  expect(fabrications(REAL.slice(0, 7))).toEqual([]);   // abbreviated, still resolves
});

test("the shared predicate is what decides it — pinned directly, both directions", () => {
  // If `sha.ts`'s own rules are re-tuned, this file should fail LOUDLY rather than let the eval
  // silently inherit a different admission rule than the generator and the audit.
  expect(isShaShaped("20260716")).toBe(false);   // all-digit -> not a SHA
  expect(isShaShaped("1234567")).toBe(false);
  expect(isShaShaped("deadbeef")).toBe(true);    // 7+ all-letter hex -> plausible
  expect(isShaShaped("4fa7227")).toBe(true);
  expect(isShaShaped("cafe")).toBe(false);       // short all-letter word
});

test("a REAL all-digit SHA is still found as evidence — extraction must not use the shape test", () => {
  // THE REGRESSION a gold case caught, pinned directly rather than left to `monorepo-detect` to
  // notice by luck. Git abbreviations are hex, so ~4% of 7-char prefixes are all digits — commit
  // `4760499` in that fixture is one. `sha.ts` deliberately treats pure-digit tokens as NON-SHAs
  // (its documented, accepted false-negative), which is right when deciding whether to
  // grounding-CHECK a token and wrong when deciding whether one EXISTS.
  //
  // My first version of this convergence applied `isShaShaped` to EXTRACTION, and G1 then reported
  // "cites 0 evidence SHAs (expected exactly 1)" plus an uncited in-window commit — two `fail`s on a
  // briefing that was entirely correct. MUTATION this kills: filter `evidenceCandidates` by
  // `isShaShaped` instead of filtering at the fabrication decision.
  const allDigitSha = "4760499" + "0".repeat(33);
  const struct = {
    recap: [{ repo: "app", text: "did a thing", evidence: allDigitSha.slice(0, 7) }],
    resume: [], suggestions: [], warnings: [], provider: "test",
  } as unknown as BriefingStruct;
  const input = {
    caseName: "all-digit-sha", struct, rawText: "", promptText: "",
    ctx: { repos: [] } as unknown as CheckInput["ctx"],
    units: [], emptyWindow: false,
    gitShaSet: new Set([allDigitSha]),
    fileInventory: new Set<string>(),
    shaToUnit: new Map(), commitMessages: new Map([[allDigitSha, "feat: real"]]),
    denylist: [], doneToday: [],
  } as unknown as CheckInput;
  const findings = CHECKS.flatMap((c) => c(input));
  // It must NOT be reported as "0 evidence SHAs", and must NOT be a fabrication.
  expect(findings.filter((f) => f.rule === "evidence" && /cites 0 evidence/.test(f.detail))).toEqual([]);
  expect(findings.filter((f) => f.check === "G2" && f.rule === "fabrication")).toEqual([]);
});

test("DOCUMENTED RESIDUAL: the 7-char floor is deliberate, so a short garble stays invisible here", () => {
  // NOT a bug being pinned in place — a measured trade-off, asserted so that "converge the floor too"
  // is a deliberate future decision rather than something someone does thinking it is free.
  // `2ee140` IS SHA-shaped by the shared predicate (4-40, has a letter, has a digit)…
  expect(isShaShaped("2ee140")).toBe(true);
  // …but the evidence miner's 7-char floor means it is not even a candidate here. Lowering that
  // floor to 4 was measured to admit `0a1b` from `migrations/0a1b_init.sql`, `ade4f` from
  // `src/db/ade4f.sql`, and `e2e4` from a test name — three NEW false-FAIL classes in exchange for
  // catching this one. The generator's and the audit's miners still catch the short-garble class.
  expect(fabrications("2ee140")).toEqual([]);
});
