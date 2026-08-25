// test/eval/checks.g7.test.ts
//
// G7 (recency) — the eval-harness side of the OTHER half of the 2026-08-10 defect. G6 covers
// redundancy; this covers RESUME anchoring on stale same-day work.
//
// ⚠ The live gold case (`same-day-recency`) can only guarantee the check RUNS with real same-day
// data — making it fire needs the model to anchor on the older subject, which is the very
// non-determinism being measured. THESE are the deterministic proof that it fires.
import { test, expect } from "bun:test";
import { g7Recency, CHECKS } from "../../src/eval/checks";
import { SOFT_RULES, HARD_RULES, verdictForRuns } from "../../src/eval/thresholds";
import { GOLD_CASES } from "../../src/eval/cases";
import type { CheckInput, Finding } from "../../src/eval/types";
import type { DoneItem } from "../../src/types";

const ms = (hhmm: string) => Date.parse(`2026-08-10T${hhmm}:00Z`);

function makeCheckInput(overrides: Partial<CheckInput>): CheckInput {
  return {
    caseName: "test-case",
    struct: { date: "2026-08-10", machineScope: "test", provider: "test", resume: [], recap: [], suggestions: [] },
    rawText: "", promptText: "", ctx: { repos: [] }, units: [], emptyWindow: false,
    gitShaSet: new Set(), fileInventory: new Set(), shaToUnit: new Map(),
    commitMessages: new Map(), denylist: [], doneToday: [],
    ...overrides,
  };
}

const DONE: DoneItem[] = [
  { label: "app", subject: "fix(app): the EARLIER same-day commit", whenMs: ms("12:00") },
  { label: "app", subject: "fix(app): the LATER same-day commit", whenMs: ms("13:30") },
];

test("G7: RESUME anchored on the OLDER same-day commit -> one warn finding", () => {
  const findings = g7Recency(makeCheckInput({
    doneToday: DONE,
    struct: {
      date: "2026-08-10", machineScope: "test", provider: "test", recap: [], suggestions: [],
      resume: [{ repo: "app", text: "Left off at `fix(app): the EARLIER same-day commit` — pick it up there." }],
    },
  }));
  expect(findings.length).toBe(1);
  expect(findings[0]!.check).toBe("G7");
  expect(findings[0]!.rule).toBe("recency");
  // ⚠ warn, NOT fail — observational, decided with G6. Flipping this is an eval-integrity decision.
  expect(findings[0]!.severity).toBe("warn");
  expect(findings[0]!.detail).toContain("LATER same-day commit");
});

test("G7: RESUME anchored on the NEWEST same-day commit -> no findings", () => {
  const findings = g7Recency(makeCheckInput({
    doneToday: DONE,
    struct: {
      date: "2026-08-10", machineScope: "test", provider: "test", recap: [], suggestions: [],
      resume: [{ repo: "app", text: "Left off at `fix(app): the LATER same-day commit` — pick it up there." }],
    },
  }));
  expect(findings.length).toBe(0);
});

test("⚠ G7 NO-OPS when the CASE has no same-day commits — not when the struct looks quiet", () => {
  // The Collision-5 failure mode. Every gold case except `same-day-recency` is built from
  // `daysAgo: 1` only, so this is the state the check is in for 7 of 8 cases.
  const quiet = makeCheckInput({
    doneToday: [],
    struct: {
      date: "2026-08-10", machineScope: "test", provider: "test", recap: [], suggestions: [],
      resume: [{ repo: "app", text: "Left off at `fix(app): the EARLIER same-day commit` — there." }],
    },
  });
  expect(g7Recency(quiet).length).toBe(0);
  // ⚠ There is deliberately NO `doneToday: undefined` case here: the field is REQUIRED on
  // CheckInput, so omitting it is a tsc error rather than a silent vacuity — see the comment on the
  // field. The runtime `?.` in the predicate is belt-and-braces for JS callers, not a reachable path.
});

test("⚠ AT LEAST ONE gold case carries same-day commits — without one G7 is vacuous everywhere", () => {
  // This is the test that would have caught shipping the rule with no fixture at all. If it ever
  // reads 0, G7 is running against nothing on every case and a green suite means nothing.
  const withSameDay = GOLD_CASES.filter((c) => c.build.commits.some((k) => k.daysAgo === 0));
  expect(withSameDay.length).toBeGreaterThanOrEqual(1);
  expect(withSameDay.map((c) => c.name)).toContain("same-day-recency");
});

test("⚠ the same-day case has two DISTINCT same-day timestamps — noon is an exact pin", () => {
  // Without `minutesAfter` both same-day commits land on the identical instant and "newest" has no
  // meaning. This pins the fixture property the whole rule rests on.
  const c = GOLD_CASES.find((g) => g.name === "same-day-recency")!;
  const sameDay = c.build.commits.filter((k) => k.daysAgo === 0);
  expect(sameDay.length).toBe(2);
  expect(new Set(sameDay.map((k) => k.minutesAfter ?? 0)).size).toBe(2);
});

test("G7 is wired into CHECKS", () => {
  expect(CHECKS).toContain(g7Recency);
});

test("recency is tiered SOFT, and warn findings cannot fail the gate", () => {
  expect(SOFT_RULES.has("recency")).toBe(true);
  expect(HARD_RULES.has("recency")).toBe(false);
  const warn: Finding[] = [{ case: "c", check: "G7", rule: "recency", severity: "warn", detail: "d" }];
  const v = verdictForRuns([warn, warn, warn]);
  expect(v.perRule["recency"]).toBe("pass");
  expect(v.pass).toBe(true);
});

test("⚠ but a FAIL-severity recency in 2 of 3 runs WOULD fail the gate — the soft policy is live", () => {
  const fail: Finding[] = [{ case: "c", check: "G7", rule: "recency", severity: "fail", detail: "d" }];
  expect(verdictForRuns([fail, fail, []]).perRule["recency"]).toBe("fail");
  expect(verdictForRuns([fail, [], []]).perRule["recency"]).toBe("flaky");
});
