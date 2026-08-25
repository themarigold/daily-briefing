// test/eval/checks.g3.test.ts
import { test, expect } from "bun:test";
import { g3Structure } from "../../src/eval/checks";
import type { CheckInput, Finding } from "../../src/eval/types";
import type { ReducedContext, Activity } from "../../src/types";

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

test("G3: missing RESUME header when !emptyWindow -> fail", () => {
  const input = makeCheckInput({
    rawText: "## RECAP\n- test\n## SUGGESTIONS\n- test\n",
    emptyWindow: false,
  });
  const findings = g3Structure(input);
  expect(findings.length).toBe(1);
  expect(findings[0]!.rule).toBe("structure");
  expect(findings[0]!.severity).toBe("fail");
  expect(findings[0]!.detail).toContain("RESUME");
});

test("G3: missing RECAP header when !emptyWindow -> fail", () => {
  const input = makeCheckInput({
    rawText: "## RESUME\n- test\n## SUGGESTIONS\n- test\n",
    emptyWindow: false,
  });
  const findings = g3Structure(input);
  expect(findings.length).toBe(1);
  expect(findings[0]!.rule).toBe("structure");
  expect(findings[0]!.severity).toBe("fail");
  expect(findings[0]!.detail).toContain("RECAP");
});

test("G3: missing SUGGESTIONS header when !emptyWindow -> fail", () => {
  const input = makeCheckInput({
    rawText: "## RESUME\n- test\n## RECAP\n- test\n",
    emptyWindow: false,
  });
  const findings = g3Structure(input);
  expect(findings.length).toBe(1);
  expect(findings[0]!.rule).toBe("structure");
  expect(findings[0]!.severity).toBe("fail");
  expect(findings[0]!.detail).toContain("SUGGESTIONS");
});

test("G3: missing RECAP header when ctx has commit activity -> fail", () => {
  const activity: Activity = {
    source: "git",
    kind: "commit",
    event_id: "abc123",
    repo: "/r",
    text: "test commit",
  };
  const ctx: ReducedContext = {
    repos: [{ repo: "/r", summary: "1 commit", activities: [activity] }],
  };
  // Missing RECAP header with commits should fail
  const input = makeCheckInput({
    rawText: "## RESUME\n- [api] resumed\n## SUGGESTIONS\n- next item\n",
    ctx,
    emptyWindow: false,
  });
  const findings = g3Structure(input);
  expect(findings.some((f) => f.detail.toUpperCase().includes("RECAP"))).toBe(true);
});

test("G3: empty RECAP that abuts next header (parser mis-bound slice) -> fail", () => {
  // RED (pre-fix): section(rawText, "RECAP") mis-bounds this fully-empty RECAP —
  // the header's trailing \n consumes the only newline, the lazy capture's
  // (?=\n##\s|$) lookahead can't fire at the next "## SUGGESTIONS" header, so it
  // swallows that section's content instead: section() returns
  // ["## SUGGESTIONS", "do y"] (non-empty) even though RECAP itself is empty.
  // GREEN (post-fix): the RECAP-empty guard also treats a first line starting
  // with "##" as empty, so this is correctly flagged as a structure fail.
  const activity: Activity = {
    source: "git",
    kind: "commit",
    event_id: "abc123",
    repo: "/r",
    text: "test commit",
  };
  const ctx: ReducedContext = {
    repos: [{ repo: "/r", summary: "1 commit", activities: [activity] }],
  };
  const input = makeCheckInput({
    rawText: "## RESUME\n- x\n## RECAP\n## SUGGESTIONS\n- do y\n",
    ctx,
    emptyWindow: false,
  });
  const findings = g3Structure(input);
  expect(
    findings.some((f) => f.rule === "structure" && f.severity === "fail" && f.detail.toUpperCase().includes("RECAP"))
  ).toBe(true);
});

test("G3: empty SUGGESTIONS when ctx is non-empty -> fail", () => {
  const ctx: ReducedContext = {
    repos: [{ repo: "/r", summary: "uncommitted", activities: [] }],
  };
  const input = makeCheckInput({
    rawText: "## RESUME\n- test\n## RECAP\n- test\n## SUGGESTIONS\n",
    ctx,
    emptyWindow: false,
  });
  const findings = g3Structure(input);
  expect(findings.length).toBe(1);
  expect(findings[0]!.rule).toBe("structure");
  expect(findings[0]!.detail).toContain("SUGGESTIONS");
  expect(findings[0]!.detail).toContain("non-empty");
});

test("G3: empty SUGGESTIONS that abuts a following ## header (parser mis-bound slice) -> fail", () => {
  // RED (pre-fix): section(rawText, "SUGGESTIONS") mis-bounds this fully-empty SUGGESTIONS —
  // the header's trailing \n consumes the only newline, the lazy capture's (?=\n##\s|$)
  // lookahead can't fire at the next "## NOTES" header, so it swallows that section's
  // content instead: section() returns ["## NOTES", "some chatter"] (non-empty) even though
  // SUGGESTIONS itself is empty.
  // GREEN (post-fix): the SUGGESTIONS-empty guard also treats a first line starting with
  // "##" as empty, so this is correctly flagged as a structure fail.
  const ctx: ReducedContext = {
    repos: [{ repo: "/r", summary: "uncommitted", activities: [] }],
  };
  const input = makeCheckInput({
    rawText: "## RESUME\n- test\n## RECAP\n- test\n## SUGGESTIONS\n## NOTES\nsome chatter\n",
    ctx,
    emptyWindow: false,
  });
  const findings = g3Structure(input);
  expect(
    findings.some(
      (f) => f.rule === "structure" && f.severity === "fail" && f.detail.toUpperCase().includes("SUGGESTIONS")
    )
  ).toBe(true);
});

test("G3: well-formed rawText with all headers and non-empty sections -> no findings", () => {
  const activity: Activity = {
    source: "git",
    kind: "commit",
    event_id: "abc123",
    repo: "/r",
    text: "test commit",
  };
  const ctx: ReducedContext = {
    repos: [{ repo: "/r", summary: "1 commit", activities: [activity] }],
  };
  const input = makeCheckInput({
    rawText: "## RESUME\n- [api] resumed work\n## RECAP\n- [api] added auth | evidence: abc123def\n## SUGGESTIONS\n- review test coverage\n",
    ctx,
    emptyWindow: false,
  });
  const findings = g3Structure(input);
  expect(findings.length).toBe(0);
});

test("G3: emptyWindow:true skips header requirement", () => {
  const input = makeCheckInput({
    rawText: "(no activity in the window)",
    emptyWindow: true,
  });
  const findings = g3Structure(input);
  expect(findings.length).toBe(0);
});

test("G3: emptyWindow:true with ctx still requires SUGGESTIONS non-empty if ctx non-empty", () => {
  const ctx: ReducedContext = {
    repos: [{ repo: "/r", summary: "uncommitted", activities: [] }],
  };
  const input = makeCheckInput({
    rawText: "## SUGGESTIONS\n",
    ctx,
    emptyWindow: true,
  });
  const findings = g3Structure(input);
  expect(findings.length).toBe(1);
  expect(findings[0]!.detail).toContain("SUGGESTIONS");
});

test("G3: Finding has correct structure", () => {
  const input = makeCheckInput({
    caseName: "my-case",
    rawText: "## RECAP\n## SUGGESTIONS\n",
    emptyWindow: false,
  });
  const findings = g3Structure(input);
  expect(findings.length).toBeGreaterThan(0);
  const f = findings[0]!;
  expect(f.case).toBe("my-case");
  expect(f.check).toBe("G3");
  expect(f.rule).toBe("structure");
  expect(f.severity).toBe("fail");
  expect(typeof f.detail).toBe("string");
});
