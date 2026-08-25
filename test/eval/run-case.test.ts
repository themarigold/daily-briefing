// test/eval/run-case.test.ts
import { test, expect } from "bun:test";
import { runCase } from "../../src/eval/run-case";
import { echoProvider } from "../../src/eval/echo";
import type { GoldCase } from "../../src/eval/types";

// A minimal, self-contained gold case: two in-window commits (single-unit repo, no
// subprojects manifest -> expectUnit: null) plus one uncommitted file. Deliberately does NOT
// import any Task-7 gold case or mutation helper — this test stands alone.
//
// Both commits are dated `daysAgo: 1` (same local day): the window-start walk-back
// (src/time.ts windowStart) stops at the FIRST prior local day with >=1 commit, so a commit on
// an EARLIER day than that is excluded from the window entirely (not "in-window", not "today").
// Same-day commits are the only way to get >1 commit reliably in-window for a minimal case.
const inlineCase: GoldCase = {
  name: "inline-clean-day",
  failureMode: "none (baseline sanity)",
  build: {
    commits: [
      { files: ["a.ts"], content: "export const a = 1;", daysAgo: 1, message: "add a", expectUnit: null },
      { files: ["b.ts"], content: "export const b = 2;", daysAgo: 1, message: "add b", expectUnit: null },
    ],
    uncommitted: ["c.ts"],
  },
};

test("runCase: clean run through the real pipeline passes with no fail findings", async () => {
  const { pass, findings } = await runCase(inlineCase, echoProvider());
  const fails = findings.filter((f) => f.severity === "fail");
  expect(fails).toEqual([]);
  expect(pass).toBe(true);
});

test("runCase: a mutate hook that fabricates a recap bullet's evidence SHA fails the run", async () => {
  const { pass, findings } = await runCase(inlineCase, echoProvider(), {
    mutate: (s) => ({
      ...s,
      recap: s.recap.map((b, idx) =>
        idx === 0 ? { ...b, evidence: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" } : b,
      ),
    }),
  });
  expect(pass).toBe(false);
  const fails = findings.filter((f) => f.severity === "fail");
  expect(fails.length).toBeGreaterThan(0);
  // The fabricated SHA doesn't resolve against the repo's real SHA set -> G2 fabrication fail;
  // and the real in-window commit it replaced is no longer cited -> G1 coverage fail.
  expect(fails.some((f) => f.check === "G2" && f.rule === "fabrication")).toBe(true);
  expect(fails.some((f) => f.check === "G1" && f.rule === "coverage")).toBe(true);
});
