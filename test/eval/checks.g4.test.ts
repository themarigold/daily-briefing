// test/eval/checks.g4.test.ts
import { test, expect } from "bun:test";
import { g4Denylist } from "../../src/eval/checks";
import type { CheckInput } from "../../src/eval/types";

// Minimal CheckInput fixture builder
function makeCheckInput(overrides: Partial<CheckInput>): CheckInput {
  return {
    caseName: "test-case",
    struct: { date: "2026-07-16", machineScope: "test", provider: "test", resume: [], recap: [], suggestions: [] },
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

test("G4: suggestion containing denylist path -> fail", () => {
  const input = makeCheckInput({
    struct: {
      date: "2026-07-16",
      machineScope: "test",
      provider: "test",
      resume: [],
      recap: [],
      suggestions: [{ text: "review uncommitted .claude/worktrees/x" }],
    },
    denylist: [".claude/worktrees/"],
  });
  const findings = g4Denylist(input);
  expect(findings.length).toBe(1);
  expect(findings[0]!.check).toBe("G4");
  expect(findings[0]!.rule).toBe("denylist");
  expect(findings[0]!.severity).toBe("fail");
  expect(findings[0]!.detail).toContain(".claude/worktrees/");
});

test("G4: clean suggestion with populated denylist -> no findings", () => {
  const input = makeCheckInput({
    struct: {
      date: "2026-07-16",
      machineScope: "test",
      provider: "test",
      resume: [],
      recap: [],
      suggestions: [{ text: "review the changes in src/" }],
    },
    denylist: [".claude/worktrees/", ".env"],
  });
  const findings = g4Denylist(input);
  expect(findings.length).toBe(0);
});

test("G4: empty denylist -> no findings", () => {
  const input = makeCheckInput({
    struct: {
      date: "2026-07-16",
      machineScope: "test",
      provider: "test",
      resume: [],
      recap: [],
      suggestions: [{ text: "review uncommitted .claude/worktrees/x" }],
    },
    denylist: [], doneToday: [],
  });
  const findings = g4Denylist(input);
  expect(findings.length).toBe(0);
});

test("G4: multiple suggestions, only denylisted one flagged", () => {
  const input = makeCheckInput({
    struct: {
      date: "2026-07-16",
      machineScope: "test",
      provider: "test",
      resume: [],
      recap: [],
      suggestions: [
        { text: "review the changes in src/" },
        { text: "check .claude/worktrees/ for pending work" },
        { text: "run tests in test/" },
      ],
    },
    denylist: [".claude/worktrees/"],
  });
  const findings = g4Denylist(input);
  expect(findings.length).toBe(1);
  expect(findings[0]!.detail).toContain(".claude/worktrees/");
  expect(findings[0]!.detail).toContain("check .claude/worktrees/ for pending work");
});
