// test/postcheck.wiring.test.ts — WHERE postcheck runs, not what it computes.
//
// postcheck's own rules are tested in test/postcheck.test.ts against hand-built structs. That suite
// was fully green on 2026-08-11 while the checks were, in production, structurally blind to half the
// RESUME section — because nothing tested the CALL SITE. This file is that missing half: it drives
// the real `runCore` and asserts the checks see the struct as DELIVERED.
import { test, expect } from "bun:test";
import { join } from "node:path";
import { runCore } from "../src/core";
import { buildRepo } from "./fixtures/build-repo";
import { ProviderError, type Config } from "../src/types";

const yesterdayNoon = () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 1); return d.toISOString(); };

const mkCfg = (repos: string[]): Config => ({
  repos, excludeCommitPatterns: [], lookbackCapDays: 30,
  provider: { cli: "echo", argv: [], promptVia: "stdin" },
});

/** Move HEAD onto a real branch and leave it there. `branchCommit` in the fixture checks its base
 *  back out, which is the opposite of what a branch-state test needs. */
async function checkoutNewBranch(repo: string, branch: string): Promise<void> {
  const p = Bun.spawn(["git", "checkout", "-q", "-b", branch], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`checkout -b ${branch}: ${await new Response(p.stderr).text()}`);
}

/** Run `fn` with console.error captured. postcheck is a stderr-only diagnostic by design — its
 *  output is the only observable it has, so capturing stderr IS the assertion surface. */
async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try { await fn(); } finally { console.error = real; }
  return lines;
}

test("⚠ REGRESSION: a suggestion restating the BRANCH-STATE line is caught — it was invisible until 2026-08-11", async () => {
  // THE LIVE MISS, reproduced. `struct.branchState` is assigned in core.ts AFTER `generateBriefing`
  // returns, and render puts those lines inside "▶ Where you left off" — so to a reader they are
  // RESUME bullets, while `checkSuggestionRestatement` only ever received `struct.resume`.
  //
  // Measured on the real 2026-08-11 briefing: containment 1.000 across 6 shared tokens — twice the
  // 0.45 threshold, the strongest score the metric can return — and postcheck printed nothing. That
  // was the first production morning postcheck ever ran, so day 26's calibration point read "clean"
  // on a morning that contained a textbook restatement.
  //
  // The branch name must be MULTI-TOKEN and that is not incidental: `On branch main (no upstream)`
  // yields only {branch, main, upstream}, and MIN_SHARED_TOKENS = 4 makes it structurally incapable
  // of firing. A single-word branch would give a green test that proves nothing.
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  await checkoutNewBranch(dir, "fix/escalation-poison-pill");

  const stub = {
    generate: async () =>
      "## RESUME\n- [x] resume\n" +
      "## RECAP\n- [x] did it | evidence: HEADSHA\n" +
      "## SUGGESTIONS\n- Open/push a PR for the `fix/escalation-poison-pill` branch — it still has no upstream.",
  };

  let result: Awaited<ReturnType<typeof runCore>> | undefined;
  const lines = await captureStderr(async () => {
    result = await runCore(mkCfg([dir]), { provider: stub, netProbe: async () => true });
  });

  // The premise: this run really did produce a branch-state line, and it is NOT in `struct.resume`.
  // Without this the test could pass for the wrong reason on a future change to branch suppression.
  const bs = result!.struct.branchState ?? [];
  expect(bs.length).toBe(1);
  expect(bs[0]!.text).toContain("no upstream");
  expect(result!.struct.resume.some((r) => r.text.includes("no upstream"))).toBe(false);

  const hits = lines.filter((l) => l.startsWith("postcheck [suggestion-restates]"));
  expect(hits.length).toBe(1);
  // `no upstream` appears ONLY in the branch-state line, never in the model's RESUME bullet — so
  // finding it in the matched-bullet half of the detail proves the branch line was what matched,
  // not merely that some finding fired.
  expect(hits[0]!).toContain("no upstream");
});

test("postcheck runs ONCE per delivered briefing, not once per provider attempt", async () => {
  // A side effect of the move, pinned so it cannot regress quietly. `generateBriefing` is the unit
  // `withRetry` retries; while the checks lived inside it, a morning that retried logged every
  // finding once per attempt — duplicates in the very log the promotion decision will be counted
  // from. At the `runCore` site they run once, on the struct that ships.
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  await checkoutNewBranch(dir, "fix/escalation-poison-pill");

  let attempts = 0;
  const flaky = {
    generate: async () => {
      attempts++;
      // ⚠ MUST be a ProviderError with a TRANSIENT code. `withRetry` rethrows anything else
      // immediately (provider.ts) — a plain `new Error` makes this test fail on the throw and pin
      // nothing about postcheck, which is exactly what a first draft of it did.
      if (attempts === 1) throw new ProviderError("nonzero-exit", "transient");
      return "## RESUME\n- [x] resume\n## RECAP\n- [x] did it | evidence: HEADSHA\n" +
        "## SUGGESTIONS\n- Open/push a PR for the `fix/escalation-poison-pill` branch — it still has no upstream.";
    },
  };

  const lines = await captureStderr(async () => {
    await runCore(mkCfg([dir]), { provider: flaky, netProbe: async () => true, retryDelaysMs: [0], sleep: async () => {} });
  });

  expect(attempts).toBe(2);                                            // the retry really happened
  expect(lines.filter((l) => l.startsWith("postcheck [")).length).toBe(1);  // …and logged one finding, not two
});

test("postcheck grades the ANNOTATED suggestion text, not the pre-annotation text", async () => {
  // The second late writer: `annotateStaleSuggestions` rewrites `struct.suggestions` in core.ts
  // after `generateBriefing` returns. At the old call site the text graded was not the text
  // delivered. This asserts the weaker but checkable half — what postcheck saw is byte-identical to
  // what shipped — by comparing the finding's quoted suggestion against the final struct.
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  await checkoutNewBranch(dir, "fix/escalation-poison-pill");

  const stub = {
    generate: async () =>
      "## RESUME\n- [x] resume\n## RECAP\n- [x] did it | evidence: HEADSHA\n" +
      "## SUGGESTIONS\n- Open/push a PR for the `fix/escalation-poison-pill` branch — it still has no upstream.",
  };

  let result: Awaited<ReturnType<typeof runCore>> | undefined;
  const lines = await captureStderr(async () => {
    result = await runCore(mkCfg([dir]), { provider: stub, netProbe: async () => true });
  });

  const hit = lines.find((l) => l.startsWith("postcheck [suggestion-restates]"))!;
  expect(hit).toBeDefined();
  // The delivered suggestion, clipped the way the detail clips it, must appear in the finding.
  const delivered = result!.struct.suggestions[0]!.text;
  expect(hit).toContain(delivered.slice(0, 60));
});
