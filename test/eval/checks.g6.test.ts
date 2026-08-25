// test/eval/checks.g6.test.ts
//
// G6 (redundancy) — the eval-harness side of the 2026-08-10 restatement defect.
//
// ⚠ THE FIXTURES ARE THE REAL DELIVERED BRIEFING, verbatim, not invented prose. Same text as
// test/postcheck.test.ts. That is deliberate: this rule exists because the harness scored that exact
// briefing a clean pass, so the test has to prove it no longer would. A synthetic fixture could
// pass while the real failure still slipped through.
import { test, expect } from "bun:test";
import { g6Redundancy, CHECKS } from "../../src/eval/checks";
import { SOFT_RULES, HARD_RULES, verdictForRuns } from "../../src/eval/thresholds";
import type { CheckInput, Finding } from "../../src/eval/types";

function makeCheckInput(overrides: Partial<CheckInput>): CheckInput {
  return {
    caseName: "test-case",
    struct: { date: "2026-08-10", machineScope: "test", provider: "test", resume: [], recap: [], suggestions: [] },
    rawText: "",
    promptText: "",
    ctx: { repos: [] },
    units: [],
    emptyWindow: false,
    gitShaSet: new Set(),
    fileInventory: new Set(),
    shaToUnit: new Map(),
    commitMessages: new Map(),
    denylist: [], doneToday: [],
    ...overrides,
  };
}

// Verbatim from the briefing delivered 2026-08-10 07:34.
const REAL_RESUME = [
  { repo: "vault_autolog", text: "Left off having recovered quota-lost nights and recorded branch drift in the eval log (today's `fix(autolog): recover quota-lost nights, and record branch drift`) — resume by deciding what to do about the recorded drift." },
  { repo: "quant_stocks", text: "Left off documenting exp009's `quintile_gross20` net/gross mislabel as a known (unfixed) defect (commit `9e357c6`, Aug 9) — the fix itself hasn't been made yet." },
];
const REAL_SUGGESTIONS = [
  { text: "Fix the `quintile_gross20` net/gross mislabel in exp009 that `quant_stocks/STATE.md` currently records as a known-but-unfixed defect." },
  { text: "Decide what to do about the branch drift vault_autolog's eval log recorded today — it was logged, not resolved." },
];

test("G6: the REAL 2026-08-10 briefing — both suggestions flagged as restatements", () => {
  const findings = g6Redundancy(makeCheckInput({
    struct: { date: "2026-08-10", machineScope: "test", provider: "test", resume: REAL_RESUME, recap: [], suggestions: REAL_SUGGESTIONS },
  }));
  expect(findings.length).toBe(2);
  for (const f of findings) {
    expect(f.check).toBe("G6");
    expect(f.rule).toBe("redundancy");
    // ⚠ warn, NOT fail. This rule is observational until the threshold is calibrated on days 26-28.
    // If this assertion ever flips, it must be a deliberate eval-integrity decision — see thresholds.ts.
    expect(f.severity).toBe("warn");
  }
  expect(findings[0]!.detail).toContain("quant_stocks");
  expect(findings[1]!.detail).toContain("vault_autolog");
});

test("G6: a briefing whose suggestions are genuinely new work -> no findings", () => {
  const findings = g6Redundancy(makeCheckInput({
    struct: {
      date: "2026-08-10", machineScope: "test", provider: "test", recap: [],
      resume: REAL_RESUME,
      suggestions: [{ text: "Recruit an external tester for the downloadable CLI before the wider release." }],
    },
  }));
  expect(findings.length).toBe(0);
});

test("G6: empty suggestions or empty resume -> no findings, no throw", () => {
  expect(g6Redundancy(makeCheckInput({
    struct: { date: "2026-08-10", machineScope: "test", provider: "test", recap: [], resume: REAL_RESUME, suggestions: [] },
  })).length).toBe(0);
  expect(g6Redundancy(makeCheckInput({
    struct: { date: "2026-08-10", machineScope: "test", provider: "test", recap: [], resume: [], suggestions: REAL_SUGGESTIONS },
  })).length).toBe(0);
});

test("G6 is wired into CHECKS — an unwired check scores nothing, which is the G5-vacuity failure", () => {
  expect(CHECKS).toContain(g6Redundancy);
});

test("redundancy is tiered SOFT, and warn findings cannot fail the gate", () => {
  expect(SOFT_RULES.has("redundancy")).toBe(true);
  expect(HARD_RULES.has("redundancy")).toBe(false);
});

test("⚠ the gate stays PASSING on redundancy warns — this is the deferred-gating decision, pinned", () => {
  // Three runs, every one of them flagging redundancy at warn severity. `verdictForRuns` counts only
  // severity:"fail", so the rule appears in perRule as "pass" and the gate does not fail. This is the
  // 2026-08-10 user-directed decision made mechanical: observe now, gate after calibration.
  const warn: Finding[] = [{ case: "c", check: "G6", rule: "redundancy", severity: "warn", detail: "d" }];
  const v = verdictForRuns([warn, warn, warn]);
  expect(v.perRule["redundancy"]).toBe("pass");
  expect(v.pass).toBe(true);
});

test("⚠ but a FAIL-severity redundancy in 2 of 3 runs WOULD fail the gate — the soft-tier policy is live", () => {
  // Proves the tier is wired, not merely declared: if severity is ever raised to "fail", the soft
  // 2-of-3 rule applies immediately. Without this, "SOFT" could be a comment with nothing behind it.
  const fail: Finding[] = [{ case: "c", check: "G6", rule: "redundancy", severity: "fail", detail: "d" }];
  const clean: Finding[] = [];
  expect(verdictForRuns([fail, fail, clean]).perRule["redundancy"]).toBe("fail");
  expect(verdictForRuns([fail, clean, clean]).perRule["redundancy"]).toBe("flaky");
});
