// test/eval/checks.g1.test.ts
import { test, expect } from "bun:test";
import { g1Attribution } from "../../src/eval/checks";
import type { CheckInput } from "../../src/eval/types";
import type { ReducedContext, Activity, BriefingStruct } from "../../src/types";
import type { Unit } from "../../src/subprojects";

// Two distinct real 40-char SHAs used across fixtures.
const SHA_A = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"; // prefix a1b2c3d
const PREFIX_A = SHA_A.slice(0, 7);
const SHA_C = "c1c2c3c4c5c6c7c8c9c0c1c2c3c4c5c6c7c8c9c0"; // prefix c1c2c3c
const PREFIX_C = SHA_C.slice(0, 7);
const SHA_D = "d1d2d3d4d5d6d7d8d9d0d1d2d3d4d5d6d7d8d9d0"; // prefix d1d2d3d
const PREFIX_D = SHA_D.slice(0, 7);

function makeUnit(over: Partial<Unit> & Pick<Unit, "repo" | "root" | "label">): Unit {
  return {
    hasResumptionState: false,
    hasWindowContent: true,
    resumptionNote: "",
    dirtyFiles: [],
    latestCommitTime: null,
    ...over,
  };
}

function commitActivity(sha: string, repo: string): Activity {
  return { source: "git", kind: "commit", event_id: sha, repo, text: "commit" };
}

function makeCheckInput(overrides: Partial<CheckInput>): CheckInput {
  const struct: BriefingStruct = {
    date: "2026-07-16",
    machineScope: "test",
    provider: "test",
    resume: [],
    recap: [],
    suggestions: [],
    ...(overrides.struct ?? {}),
  };
  const { struct: _ignored, ...rest } = overrides;
  return {
    caseName: "test-case",
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
    ...rest,
    struct,
  };
}

// --- (a) evidence: zero SHAs -> evidence fail ---
test("G1 evidence: bullet with zero evidence SHAs -> evidence fail", () => {
  const input = makeCheckInput({
    struct: {
      date: "d", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [{ repo: "accountant_ai", text: "did a thing", evidence: "" }],
    },
    // empty ctx -> no coverage findings to muddy the assertion
  });
  const findings = g1Attribution(input);
  const evFails = findings.filter((f) => f.rule === "evidence" && f.severity === "fail");
  expect(evFails.length).toBe(1);
  expect(evFails[0]!.check).toBe("G1");
});

// --- (a) evidence: two SHAs -> evidence fail ---
test("G1 evidence: bullet with two evidence SHAs -> evidence fail", () => {
  const input = makeCheckInput({
    struct: {
      date: "d", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [{ repo: "accountant_ai", text: "did a thing", evidence: `${PREFIX_A} ${PREFIX_C}` }],
    },
    gitShaSet: new Set([SHA_A, SHA_C]),
  });
  const findings = g1Attribution(input);
  const evFails = findings.filter((f) => f.rule === "evidence" && f.severity === "fail");
  expect(evFails.length).toBe(1);
});

// --- (b) Day-8: commit ground-truth unit A, bullet cites DIFFERENT unit B's label -> attribution fail ---
test("G1 attribution: commit owned by A cited under B's label -> attribution fail (Day-8)", () => {
  const unitA = makeUnit({ repo: "/r", root: "accountant_ai", label: "accountant_ai" });
  const unitB = makeUnit({ repo: "/r", root: "quant_stocks", label: "quant_stocks" });
  const ctx: ReducedContext = {
    repos: [{ repo: "/r", summary: "1 commit", activities: [commitActivity(SHA_A, "/r")] }],
  };
  const input = makeCheckInput({
    struct: {
      date: "d", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [{ repo: "quant_stocks", text: "did a thing", evidence: PREFIX_A }],
    },
    ctx,
    units: [unitA, unitB],
    gitShaSet: new Set([SHA_A]),
    shaToUnit: new Map([[SHA_A, { repo: "/r", root: "accountant_ai" }]]),
  });
  const findings = g1Attribution(input);
  const attrFails = findings.filter((f) => f.rule === "attribution" && f.severity === "fail");
  expect(attrFails.length).toBe(1);
  expect(attrFails[0]!.check).toBe("G1");
  // coverage is satisfied (cited exactly once) — no coverage fail
  expect(findings.filter((f) => f.rule === "coverage").length).toBe(0);
});

// --- (b) Day-8 literal shape: cross-cutting commit ground-truthed to the CATCH-ALL (root:null)
// mislabeled onto a different, real named unit -> attribution fail ---
test("G1 attribution: catch-all commit (root:null) cited under a named unit's label -> attribution fail (Day-8 literal)", () => {
  const catchAll = makeUnit({ repo: "/r", root: null, label: "personal_code" });
  const named = makeUnit({ repo: "/r", root: "accountant_ai", label: "accountant_ai" });
  const ctx: ReducedContext = {
    repos: [{ repo: "/r", summary: "1 commit", activities: [commitActivity(SHA_D, "/r")] }],
  };
  const input = makeCheckInput({
    struct: {
      date: "d", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [{ repo: "accountant_ai", text: "cross-cutting change", evidence: PREFIX_D }],
    },
    ctx,
    units: [catchAll, named],
    gitShaSet: new Set([SHA_D]),
    shaToUnit: new Map([[SHA_D, { repo: "/r", root: null }]]),
  });
  const findings = g1Attribution(input);
  const attrFails = findings.filter((f) => f.rule === "attribution" && f.severity === "fail");
  expect(attrFails.length).toBe(1);
  expect(attrFails[0]!.check).toBe("G1");
  // coverage is satisfied (cited exactly once) — no coverage fail
  expect(findings.filter((f) => f.rule === "coverage").length).toBe(0);
});

// --- (b) correct attribution -> no finding ---
test("G1 attribution: commit owned by A cited under A's label -> no finding", () => {
  const unitA = makeUnit({ repo: "/r", root: "accountant_ai", label: "accountant_ai" });
  const unitB = makeUnit({ repo: "/r", root: "quant_stocks", label: "quant_stocks" });
  const ctx: ReducedContext = {
    repos: [{ repo: "/r", summary: "1 commit", activities: [commitActivity(SHA_A, "/r")] }],
  };
  const input = makeCheckInput({
    struct: {
      date: "d", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [{ repo: "accountant_ai", text: "did a thing", evidence: PREFIX_A }],
    },
    ctx,
    units: [unitA, unitB],
    gitShaSet: new Set([SHA_A]),
    shaToUnit: new Map([[SHA_A, { repo: "/r", root: "accountant_ai" }]]),
  });
  const findings = g1Attribution(input);
  expect(findings.length).toBe(0);
});

// --- (b) label matching NO unit -> warn (benign wording variance) ---
test("G1 attribution: bullet [label] matching no unit -> warn, not fail", () => {
  const unitA = makeUnit({ repo: "/r", root: "accountant_ai", label: "accountant_ai" });
  const unitB = makeUnit({ repo: "/r", root: "quant_stocks", label: "quant_stocks" });
  const ctx: ReducedContext = {
    repos: [{ repo: "/r", summary: "1 commit", activities: [commitActivity(SHA_A, "/r")] }],
  };
  const input = makeCheckInput({
    struct: {
      date: "d", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [{ repo: "some-freeform-name", text: "did a thing", evidence: PREFIX_A }],
    },
    ctx,
    units: [unitA, unitB],
    gitShaSet: new Set([SHA_A]),
    shaToUnit: new Map([[SHA_A, { repo: "/r", root: "accountant_ai" }]]),
  });
  const findings = g1Attribution(input);
  const attr = findings.filter((f) => f.rule === "attribution");
  expect(attr.length).toBe(1);
  expect(attr[0]!.severity).toBe("warn");
});

// --- (c) in-window commit cited by no bullet -> coverage fail ---
test("G1 coverage: in-window commit cited by no bullet -> coverage fail", () => {
  const ctx: ReducedContext = {
    repos: [{ repo: "/r", summary: "1 commit", activities: [commitActivity(SHA_C, "/r")] }],
  };
  const input = makeCheckInput({
    struct: {
      date: "d", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [], // nothing cites SHA_C
    },
    ctx,
    gitShaSet: new Set([SHA_C]),
    shaToUnit: new Map([[SHA_C, { repo: "/r", root: null }]]),
  });
  const findings = g1Attribution(input);
  const covFails = findings.filter((f) => f.rule === "coverage" && f.severity === "fail");
  expect(covFails.length).toBe(1);
  expect(covFails[0]!.check).toBe("G1");
});

// --- (c) in-window commit cited by 2+ bullets -> coverage fail ---
test("G1 coverage: in-window commit cited by two bullets -> coverage fail", () => {
  const unit = makeUnit({ repo: "/r", root: null, label: "r" });
  const ctx: ReducedContext = {
    repos: [{ repo: "/r", summary: "1 commit", activities: [commitActivity(SHA_C, "/r")] }],
  };
  const input = makeCheckInput({
    struct: {
      date: "d", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [
        { repo: "r", text: "a", evidence: PREFIX_C },
        { repo: "r", text: "b", evidence: PREFIX_C },
      ],
    },
    ctx,
    units: [unit],
    gitShaSet: new Set([SHA_C]),
    shaToUnit: new Map([[SHA_C, { repo: "/r", root: null }]]),
  });
  const findings = g1Attribution(input);
  const covFails = findings.filter((f) => f.rule === "coverage" && f.severity === "fail");
  expect(covFails.length).toBe(1);
});

// --- (d) warned-stripped bullet (evidence undefined + matching warning) -> warn, not fail ---
test("G1 evidence: warned-stripped bullet (undefined evidence + didn't-resolve warning) -> warn", () => {
  const input = makeCheckInput({
    struct: {
      date: "d", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [{ repo: "accountant_ai", text: "did a thing", evidence: undefined }],
      warnings: ["evidence token zzz didn't resolve; stripped"],
    },
  });
  const findings = g1Attribution(input);
  const evFindings = findings.filter((f) => f.rule === "evidence");
  expect(evFindings.length).toBe(1);
  expect(evFindings[0]!.severity).toBe("warn");
  expect(findings.filter((f) => f.severity === "fail").length).toBe(0);
});

// --- integrity: in-window cited SHA absent from shaToUnit -> throws mis-authored-case ---
test("G1 integrity: cited in-window SHA absent from shaToUnit -> throws mis-authored case", () => {
  const ctx: ReducedContext = {
    repos: [{ repo: "/r", summary: "1 commit", activities: [commitActivity(SHA_A, "/r")] }],
  };
  const input = makeCheckInput({
    struct: {
      date: "d", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [{ repo: "accountant_ai", text: "did a thing", evidence: PREFIX_A }],
    },
    ctx,
    gitShaSet: new Set([SHA_A]),
    shaToUnit: new Map(), // SHA_A is in-window but MISSING from ground truth
  });
  expect(() => g1Attribution(input)).toThrow(`mis-authored case: ${SHA_A}`);
});
