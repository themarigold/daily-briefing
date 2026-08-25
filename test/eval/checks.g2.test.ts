// test/eval/checks.g2.test.ts
import { test, expect } from "bun:test";
import { g2Fabrication, resolvePrefix } from "../../src/eval/checks";
import type { CheckInput } from "../../src/eval/types";
import type { ReducedContext, Activity, BriefingStruct } from "../../src/types";

// A real 40-char SHA used across fixtures.
const REAL_SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
const REAL_PREFIX = REAL_SHA.slice(0, 7); // "a1b2c3d"

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

// --- resolvePrefix unit ---
test("resolvePrefix: unique prefix resolves to full SHA", () => {
  const set = new Set([REAL_SHA]);
  expect(resolvePrefix(REAL_PREFIX, set)).toBe(REAL_SHA);
});

test("resolvePrefix: non-matching / too-short / ambiguous -> null", () => {
  const set = new Set([REAL_SHA, "a1b2c3daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
  expect(resolvePrefix("deadbeef", set)).toBeNull(); // no match
  expect(resolvePrefix("a1b2c", set)).toBeNull(); // too short (<7)
  expect(resolvePrefix("a1b2c3d", set)).toBeNull(); // ambiguous (2 matches)
});

// --- regression pin: the strict eval gate ALREADY catches a backtick-wrapped fabricated SHA — its
//     evidenceCandidates uses a maximal-hex-run, so backticks just bound the run (independent of the
//     generator-side verifyEvidence fix). Pins that this independent auditor stays robust to formatting. ---
test("G2: a BACKTICK-WRAPPED fabricated evidence SHA is still detected (maximal-hex-run candidate extraction)", () => {
  const input = makeCheckInput({
    struct: {
      date: "2026-07-16", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [{ repo: "/r", text: "Did a thing", evidence: "`deadbeef`" }],
    },
    gitShaSet: new Set([REAL_SHA]),
    commitMessages: new Map([[REAL_SHA, "Real commit message"]]),
  });
  expect(g2Fabrication(input).some((f) => f.severity === "fail")).toBe(true);
});

// --- (a) fabricated SHA in evidence, not in gitShaSet, not in own commit msg -> fail ---
test("G2: fabricated evidence SHA absent from gitShaSet AND own commit message -> fail", () => {
  const input = makeCheckInput({
    struct: {
      date: "2026-07-16", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [{ repo: "/r", text: "Did a thing", evidence: "deadbeef" }],
    },
    gitShaSet: new Set([REAL_SHA]),
    commitMessages: new Map([[REAL_SHA, "Real commit message"]]),
  });
  const findings = g2Fabrication(input);
  const fails = findings.filter((f) => f.severity === "fail");
  expect(fails.length).toBe(1);
  expect(fails[0]!.check).toBe("G2");
  expect(fails[0]!.rule).toBe("fabrication");
  expect(fails[0]!.detail).toContain("deadbeef");
});

// --- (b) message-quoted fake SHA in OWN bullet prose -> exempt -> pass ---
test("G2: fake SHA quoted from own commit message in own prose -> exempt (no fail)", () => {
  const fake = "cafed00"; // not a real SHA prefix, but quoted in the commit message
  const input = makeCheckInput({
    struct: {
      date: "2026-07-16", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [{ repo: "/r", text: `Reverted the bad commit ${fake} as noted`, evidence: REAL_PREFIX }],
    },
    gitShaSet: new Set([REAL_SHA]),
    commitMessages: new Map([[REAL_SHA, `Revert of ${fake} which broke CI`]]),
  });
  const findings = g2Fabrication(input);
  expect(findings.filter((f) => f.severity === "fail").length).toBe(0);
});

// --- (c) path in prose not in that commit's diffstat but present in fileInventory -> warn ---
test("G2: path claimed in prose absent from commit diffstat but in fileInventory -> warn", () => {
  const activity: Activity = {
    source: "git",
    kind: "commit",
    event_id: REAL_SHA,
    repo: "/r",
    text: "commit",
    meta: { diffstat: [{ file: "src/actuallyChanged.ts", added: 5, removed: 1 }] },
  };
  const ctx: ReducedContext = {
    repos: [{ repo: "/r", summary: "1 commit", activities: [activity] }],
  };
  const input = makeCheckInput({
    struct: {
      date: "2026-07-16", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [{ repo: "/r", text: "Refactored src/other.ts thoroughly", evidence: REAL_PREFIX }],
    },
    ctx,
    gitShaSet: new Set([REAL_SHA]),
    commitMessages: new Map([[REAL_SHA, "Refactor"]]),
    fileInventory: new Set(["src/other.ts", "other.ts", "src/actuallyChanged.ts", "actuallyChanged.ts"]),
  });
  const findings = g2Fabrication(input);
  const warns = findings.filter((f) => f.severity === "warn");
  expect(warns.length).toBe(1);
  expect(warns[0]!.detail).toContain("other.ts");
  expect(findings.filter((f) => f.severity === "fail").length).toBe(0);
});

// --- (d) relocated token: exemption is citing-bullet-scoped, not global -> fail ---
test("G2: token relocated from commit A's message into commit B's bullet -> still fails (exemption not global)", () => {
  const shaA = "1111111111111111111111111111111111abcd"; // message contains the fake token
  const shaB = "2222222222222222222222222222222222efab"; // cited bullet's own commit — message does NOT contain it
  const fake = "cafed00"; // fabricated token: not a prefix of shaA/shaB, only in shaA's message
  const input = makeCheckInput({
    struct: {
      date: "2026-07-16", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [
        { repo: "/r", text: `Followed up on ${fake} fix`, evidence: shaB.slice(0, 7) },
      ],
    },
    gitShaSet: new Set([shaA, shaB]),
    commitMessages: new Map([
      [shaA, `revert ${fake} which broke the build`],
      [shaB, "real work"],
    ]),
  });
  const findings = g2Fabrication(input);
  const fails = findings.filter((f) => f.severity === "fail");
  expect(fails.length).toBe(1);
  expect(fails[0]!.check).toBe("G2");
  expect(fails[0]!.rule).toBe("fabrication");
  expect(fails[0]!.detail).toContain(fake);
});

// --- (c2) BARE real filename (no `/`) not in cited commit's diffstat but in fileInventory -> warn ---
// Regression guard: this is exactly the case the reviewer flagged — the `/`-requiring path-shape
// gate that was added inadvertently silenced this, reintroducing the silent-ignore Option C closed.
test("G2: BARE real filename (no slash) claimed, absent from commit diffstat, in fileInventory -> warn (regression guard)", () => {
  const activity: Activity = {
    source: "git",
    kind: "commit",
    event_id: REAL_SHA,
    repo: "/r",
    text: "commit",
    meta: { diffstat: [{ file: "src/actuallyChanged.ts", added: 5, removed: 1 }] },
  };
  const ctx: ReducedContext = {
    repos: [{ repo: "/r", summary: "1 commit", activities: [activity] }],
  };
  const input = makeCheckInput({
    struct: {
      date: "2026-07-16", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [{ repo: "/r", text: "Also touched foo.ts while at it", evidence: REAL_PREFIX }],
    },
    ctx,
    gitShaSet: new Set([REAL_SHA]),
    commitMessages: new Map([[REAL_SHA, "Refactor"]]),
    fileInventory: new Set(["foo.ts", "src/actuallyChanged.ts", "actuallyChanged.ts"]),
  });
  const findings = g2Fabrication(input);
  const warns = findings.filter((f) => f.severity === "warn");
  expect(warns.length).toBe(1);
  expect(warns[0]!.detail).toContain("foo.ts");
  expect(warns[0]!.detail).toContain("exists elsewhere in repo");
  expect(findings.filter((f) => f.severity === "fail")).toEqual([]);
});

// --- (c3) BARE NONEXISTENT filename (no `/`, not in inventory, not in diffstat) -> no finding ---
test("G2: BARE nonexistent filename (no slash, not in repo) -> no finding (too ambiguous)", () => {
  const activity: Activity = {
    source: "git",
    kind: "commit",
    event_id: REAL_SHA,
    repo: "/r",
    text: "commit",
    meta: { diffstat: [{ file: "src/actuallyChanged.ts", added: 5, removed: 1 }] },
  };
  const ctx: ReducedContext = {
    repos: [{ repo: "/r", summary: "1 commit", activities: [activity] }],
  };
  const input = makeCheckInput({
    struct: {
      date: "2026-07-16", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [{ repo: "/r", text: "Also touched ghost.ts while at it", evidence: REAL_PREFIX }],
    },
    ctx,
    gitShaSet: new Set([REAL_SHA]),
    commitMessages: new Map([[REAL_SHA, "Refactor"]]),
    fileInventory: new Set(["src/actuallyChanged.ts", "actuallyChanged.ts"]),
  });
  const findings = g2Fabrication(input);
  expect(findings).toEqual([]);
});

// --- (c4) SLASHED nonexistent path (not in inventory, not in diffstat) -> warn (unchanged) ---
test("G2: slashed nonexistent path (not in repo) -> warn (path-shape confidence, unchanged)", () => {
  const activity: Activity = {
    source: "git",
    kind: "commit",
    event_id: REAL_SHA,
    repo: "/r",
    text: "commit",
    meta: { diffstat: [{ file: "src/actuallyChanged.ts", added: 5, removed: 1 }] },
  };
  const ctx: ReducedContext = {
    repos: [{ repo: "/r", summary: "1 commit", activities: [activity] }],
  };
  const input = makeCheckInput({
    struct: {
      date: "2026-07-16", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [{ repo: "/r", text: "Also touched src/ghost.ts while at it", evidence: REAL_PREFIX }],
    },
    ctx,
    gitShaSet: new Set([REAL_SHA]),
    commitMessages: new Map([[REAL_SHA, "Refactor"]]),
    fileInventory: new Set(["src/actuallyChanged.ts", "actuallyChanged.ts"]),
  });
  const findings = g2Fabrication(input);
  const warns = findings.filter((f) => f.severity === "warn");
  expect(warns.length).toBe(1);
  expect(warns[0]!.detail).toContain("src/ghost.ts");
  expect(warns[0]!.detail).toContain("no such file in the repo");
  expect(findings.filter((f) => f.severity === "fail")).toEqual([]);
});

// --- (c5) numeric "extension" (docs/v2.1) -> no finding (letter-initial gate excludes it) ---
test("G2: docs/v2.1 (numeric pseudo-extension) -> no finding (not a candidate file token)", () => {
  const activity: Activity = {
    source: "git",
    kind: "commit",
    event_id: REAL_SHA,
    repo: "/r",
    text: "commit",
    meta: { diffstat: [{ file: "src/actuallyChanged.ts", added: 5, removed: 1 }] },
  };
  const ctx: ReducedContext = {
    repos: [{ repo: "/r", summary: "1 commit", activities: [activity] }],
  };
  const input = makeCheckInput({
    struct: {
      date: "2026-07-16", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [{ repo: "/r", text: "Bumped the docs/v2.1 release notes", evidence: REAL_PREFIX }],
    },
    ctx,
    gitShaSet: new Set([REAL_SHA]),
    commitMessages: new Map([[REAL_SHA, "Refactor"]]),
    fileInventory: new Set(["src/actuallyChanged.ts", "actuallyChanged.ts"]),
  });
  const findings = g2Fabrication(input);
  expect(findings).toEqual([]);
});

// --- (e) all-digit prose run of length 12-40 (e.g. epoch-ms timestamp) -> not a candidate -> no fabrication ---
test("G2: 13-digit all-digit prose token (epoch-ms timestamp) -> not a fabrication candidate", () => {
  const input = makeCheckInput({
    struct: {
      date: "2026-07-16", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [{ repo: "/r", text: "processed 1760000000000 records", evidence: REAL_PREFIX }],
    },
    gitShaSet: new Set([REAL_SHA]),
    commitMessages: new Map([[REAL_SHA, "Process records"]]),
  });
  const findings = g2Fabrication(input);
  expect(findings.filter((f) => f.severity === "fail")).toEqual([]);
});

// --- (f) genuine hex fabrication token (has [a-f], doesn't resolve) still fails (skip narrowed to all-digit only) ---
test("G2: non-resolving hex token with [a-f] -> still fails (all-digit skip doesn't swallow hex tokens)", () => {
  const input = makeCheckInput({
    struct: {
      date: "2026-07-16", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [{ repo: "/r", text: "reverted deadbee1 as a follow-up", evidence: REAL_PREFIX }],
    },
    gitShaSet: new Set([REAL_SHA]),
    commitMessages: new Map([[REAL_SHA, "Process records"]]),
  });
  const findings = g2Fabrication(input);
  const fails = findings.filter((f) => f.severity === "fail");
  expect(fails.length).toBe(1);
  expect(fails[0]!.detail).toContain("deadbee1");
});

// --- secondary signal: struct.warnings "didn't resolve" -> warn ---
test("G2: struct.warnings 'didn't resolve' entry -> secondary warn", () => {
  const input = makeCheckInput({
    struct: {
      date: "2026-07-16", machineScope: "t", provider: "t", resume: [], suggestions: [],
      recap: [], warnings: ["evidence token xyz didn't resolve; stripped"],
    },
  });
  const findings = g2Fabrication(input);
  expect(findings.some((f) => f.severity === "warn")).toBe(true);
});
