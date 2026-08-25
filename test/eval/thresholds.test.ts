// test/eval/thresholds.test.ts — verdictForRuns: the pure live-eval gate threshold policy
// (Task 10). Direction (exact, task-10 brief): a HARD-rule fail-finding (attribution/
// fabrication/denylist/evidence) in ANY of the N (=3) live runs of one gold case -> that rule
// resolves to "fail" -> gate FAIL. A SOFT-rule fail-finding (coverage/structure) in >=2/3 runs
// -> "fail"; in exactly 1/3 -> "flaky" (a warn signal, NOT a fail — gate still passes on that
// rule alone). warn-severity findings never fail the gate, on any rule.
import { test, expect } from "bun:test";
import { verdictForRuns } from "../../src/eval/thresholds";
import type { Finding } from "../../src/eval/types";

function f(rule: Finding["rule"], severity: Finding["severity"] = "fail", over: Partial<Finding> = {}): Finding {
  return { case: "c", check: "G1", rule, severity, detail: "d", ...over };
}

const HARD_RULES: Finding["rule"][] = ["attribution", "fabrication", "denylist", "evidence"];
const SOFT_RULES: Finding["rule"][] = ["coverage", "structure"];

test("all-clean: 3 runs with zero findings -> pass, empty perRule", () => {
  const { pass, perRule } = verdictForRuns([[], [], []]);
  expect(pass).toBe(true);
  expect(perRule).toEqual({});
});

for (const rule of HARD_RULES) {
  test(`hard-rule ${rule}: fail-finding in exactly 1/3 runs -> "fail" (gate FAILs)`, () => {
    const { pass, perRule } = verdictForRuns([[f(rule)], [], []]);
    expect(perRule[rule]).toBe("fail");
    expect(pass).toBe(false);
  });

  test(`hard-rule ${rule}: fail-finding in 3/3 runs -> "fail"`, () => {
    const { pass, perRule } = verdictForRuns([[f(rule)], [f(rule)], [f(rule)]]);
    expect(perRule[rule]).toBe("fail");
    expect(pass).toBe(false);
  });

  test(`hard-rule ${rule}: warn-severity in all 3 runs never fails the gate`, () => {
    const { pass, perRule } = verdictForRuns([[f(rule, "warn")], [f(rule, "warn")], [f(rule, "warn")]]);
    expect(perRule[rule]).toBe("pass");
    expect(pass).toBe(true);
  });
}

for (const rule of SOFT_RULES) {
  test(`soft-rule ${rule}: fail-finding in exactly 1/3 runs -> "flaky" (warn, gate still PASSes)`, () => {
    const { pass, perRule } = verdictForRuns([[f(rule)], [], []]);
    expect(perRule[rule]).toBe("flaky");
    expect(pass).toBe(true);
  });

  test(`soft-rule ${rule}: fail-finding in 2/3 runs -> "fail" (gate FAILs)`, () => {
    const { pass, perRule } = verdictForRuns([[f(rule)], [f(rule)], []]);
    expect(perRule[rule]).toBe("fail");
    expect(pass).toBe(false);
  });

  test(`soft-rule ${rule}: fail-finding in 3/3 runs -> "fail"`, () => {
    const { pass, perRule } = verdictForRuns([[f(rule)], [f(rule)], [f(rule)]]);
    expect(perRule[rule]).toBe("fail");
    expect(pass).toBe(false);
  });
}

test("mixed: hard-rule 1/3 fail + soft-rule 1/3 fail -> overall FAIL, but the soft rule alone stays flaky", () => {
  const { pass, perRule } = verdictForRuns([
    [f("attribution"), f("coverage")],
    [],
    [],
  ]);
  expect(perRule.attribution).toBe("fail");
  expect(perRule.coverage).toBe("flaky");
  expect(pass).toBe(false);
});

test("a rule that only ever produces warn findings (never fail) resolves to pass", () => {
  const { pass, perRule } = verdictForRuns([[f("structure", "warn")], [], []]);
  expect(perRule.structure).toBe("pass");
  expect(pass).toBe(true);
});

test("multiple findings for the same rule within one run still count as one run toward the threshold", () => {
  const { pass, perRule } = verdictForRuns([[f("coverage"), f("coverage")], [], []]);
  expect(perRule.coverage).toBe("flaky");
  expect(pass).toBe(true);
});

test("clean run interleaved with a failing one still resolves per-rule correctly (2/3 coverage fail)", () => {
  const { pass, perRule } = verdictForRuns([[f("coverage")], [], [f("coverage")]]);
  expect(perRule.coverage).toBe("fail");
  expect(pass).toBe(false);
});

// ── G5 tiering (2026-08-04, user-directed eval-integrity change) ──────────────────────────────────
//
// WHY THIS BLOCK EXISTS. `eval/types.ts` widened `Finding["rule"]` from six members to twelve when
// G5 landed; `thresholds.ts` kept classifying six. All six G5 rules therefore routed through the
// else-branch — under a comment asserting that branch was unreachable — so the gate policy for the
// checks that quote the USER'S OWN WORDS back at them was inherited from a fallback, never chosen,
// and no test exercised a G5 rule reaching verdictForRuns at all.
import { HARD_RULES as HARD_TIER, SOFT_RULES as SOFT_TIER } from "../../src/eval/thresholds";

const G5_RULES = ["anchor", "freshness", "why-attribution", "scope", "verbatim", "surface"] as const;

test("every G5 rule is HARD — one occurrence fails the gate", () => {
  for (const r of G5_RULES) expect(HARD_TIER.has(r)).toBe(true);
});

test("the tiers are DISJOINT and cover all FOURTEEN rule names", () => {
  // The compile-time Record in thresholds.ts is the real guard (omitting a rule breaks tsc); this
  // pins the count so a rule silently RETIERED to soft is also visible.
  //
  // 12 -> 13 on 2026-08-10 when G6 `redundancy` landed, then 13 -> 14 the same day for G7 `recency`
  // (both user-directed, eval-integrity class). ⚠ THIS TEST DOING ITS JOB IS WHY THE NUMBER MOVED:
  // it failed on each new rule, which is the deliberate look it exists to force. Bumping it is
  // correct ONLY alongside a considered tier entry in thresholds.ts — never as a reflex to make the
  // suite green.
  expect(HARD_TIER.size + SOFT_TIER.size).toBe(14);
  expect([...HARD_TIER].filter((r) => SOFT_TIER.has(r))).toEqual([]);
  expect([...SOFT_TIER].sort()).toEqual(["coverage", "recency", "redundancy", "structure"]);
});

test("⚠ a G5 fail in ONE of three runs fails the gate (hard), unlike a soft rule", async () => {
  // THE discriminating case, and the one that makes the tiering real rather than declarative.
  // ⚠ The two tests above DO also catch a retier (measured: 3 fail in total) — an earlier version of
  // this comment claimed they would not, which was simply wrong. This one still earns its place for a
  // different reason: it is the only one that pins the CONSEQUENCE rather than the classification —
  // 1-of-3 becoming "flaky" means the gate PASSES a run in which the briefing misquoted the user.
  const one = (rule: string) =>
    [[{ case: "c", check: "G5", rule, severity: "fail", detail: "d" }], [], []] as never;
  expect(verdictForRuns(one("verbatim")).pass).toBe(false);
  expect(verdictForRuns(one("verbatim")).perRule["verbatim"]).toBe("fail");
  // contrast: the same 1-of-3 shape on a genuinely soft rule is "flaky" and does NOT fail
  expect(verdictForRuns(one("coverage")).pass).toBe(true);
  expect(verdictForRuns(one("coverage")).perRule["coverage"]).toBe("flaky");
});
