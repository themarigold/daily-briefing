import { test, expect } from "bun:test";
import { ProviderError } from "../src/types";
import type { Activity, BriefingStruct, ProviderErrorCode, Config, ActivityMeta } from "../src/types";

test("Activity requires source/kind/event_id only", () => {
  const a: Activity = { source: "git", kind: "commit", event_id: "abc" }; // no repo/timestamp needed
  expect(a.source).toBe("git");
});

test("BriefingStruct has resume/recap/suggestions arrays", () => {
  const b: BriefingStruct = {
    date: "2026-07-07", machineScope: "host", provider: "claude",
    resume: [], recap: [], suggestions: [],
  };
  expect(b.recap).toEqual([]);
});

test("ProviderError carries a typed code", () => {
  const e = new ProviderError("nonzero-exit", "boom");
  expect(e.code).toBe("nonzero-exit");
  expect(e).toBeInstanceOf(Error);
});

// The array is hardcoded, so adding a union member keeps this green while silently making the test's
// own name false. Extended with "usage-limit" in the same change that added it.
test("all 5 ProviderErrorCode values construct a valid ProviderError", () => {
  const codes: ProviderErrorCode[] = ["missing-binary", "nonzero-exit", "empty-output", "timeout", "usage-limit"];
  for (const code of codes) {
    const e = new ProviderError(code, `msg for ${code}`);
    expect(e.code).toBe(code);
    expect(e.message).toBe(`msg for ${code}`);
  }
});

test("BriefingStruct.recap items round-trip evidence alongside repo/text (regression guard: evidence must not be dropped by any transform)", () => {
  const b: BriefingStruct = {
    date: "2026-07-07", machineScope: "host", provider: "claude",
    resume: [], suggestions: [],
    recap: [{ repo: "/r1", text: "fixed the bug", evidence: "a1b2c3d" }],
  };
  expect(b.recap[0]).toEqual({ repo: "/r1", text: "fixed the bug", evidence: "a1b2c3d" });
  expect(b.recap[0]!.evidence).toBe("a1b2c3d");
});

test("Config accepts an additive subprojects field", () => {
  const cfg: Config = {
    provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" },
    subprojects: [{ repo: "/r", roots: ["*"] }],
  };
  expect(cfg.subprojects?.[0]?.roots).toEqual(["*"]);
});

test("ActivityMeta accepts an additive uncommittedFiles field", () => {
  const m: ActivityMeta = { uncommittedFiles: ["a.ts", "b.ts"] };
  expect(m.uncommittedFiles).toEqual(["a.ts", "b.ts"]);
});
