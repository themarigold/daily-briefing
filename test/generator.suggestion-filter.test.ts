// test/generator.suggestion-filter.test.ts — Task 8's post-parse infra-path suggestion filter:
// generateBriefing must strip any SUGGESTIONS bullet referencing .claude/worktrees/ (Claude Code's
// own agent scratch dir) while leaving normal suggestions untouched.
import { test, expect } from "bun:test";
import { generateBriefing } from "../src/generator";
import type { ReducedContext, Provider } from "../src/types";

const ctx: ReducedContext = { repos: [] };

test("generateBriefing strips a SUGGESTIONS bullet that references .claude/worktrees/", async () => {
  const stub: Provider = {
    generate: async () =>
      [
        "## RESUME",
        "- [/r1] resume",
        "## RECAP",
        "- [/r1] did work | evidence: a1b2c3",
        "## SUGGESTIONS",
        "- review uncommitted .claude/worktrees/x",
        "- open the PR for feature/auth",
      ].join("\n"),
  };
  const b = await generateBriefing(ctx, stub, { date: "2026-07-13", machineScope: "host", provider: "claude" }, []);
  expect(b.suggestions.some((s) => s.text.includes(".claude/worktrees/"))).toBe(false);
  expect(b.suggestions.some((s) => s.text.includes("open the PR for feature/auth"))).toBe(true);
  expect(b.suggestions.length).toBe(1);
});

test("generateBriefing leaves suggestions untouched when none reference an infra path", async () => {
  const stub: Provider = {
    generate: async () =>
      [
        "## RESUME",
        "- [/r1] resume",
        "## RECAP",
        "- [/r1] did work | evidence: a1b2c3",
        "## SUGGESTIONS",
        "- open the PR for feature/auth",
        "- add tests for the new module",
      ].join("\n"),
  };
  const b = await generateBriefing(ctx, stub, { date: "2026-07-13", machineScope: "host", provider: "claude" }, []);
  expect(b.suggestions.length).toBe(2);
  expect(b.suggestions[0]!.text).toContain("open the PR for feature/auth");
  expect(b.suggestions[1]!.text).toContain("add tests for the new module");
});

// ── Already-merged-PR guard (EVAL day 36) ─────────────────────────────────────────────────────────
// The merge channel and the suggestion generator do not read each other, so the model can recommend
// acting on #N while the same document renders "🔀 Merged #N". Both the pure predicate AND the
// generateBriefing call site are pinned — the account-failover review proved an extracted function's
// tests alone let the call site regress invisibly (restoring the original bug kept the suite green).
import { dropMergedPrSuggestions, buildPrompt } from "../src/generator";

test("dropMergedPrSuggestions drops a suggestion citing a merged PR and reports the number", () => {
  const r = dropMergedPrSuggestions(
    [{ text: "merge #297 once CI is green" }, { text: "add tests for reduce.ts" }],
    [{ text: "🔀 Merged #297 (feat/x) (abc1234)" }],
  );
  expect(r.kept.map((s) => s.text)).toEqual(["add tests for reduce.ts"]);
  expect(r.droppedPrs).toEqual(["297"]);
});

test("dropMergedPrSuggestions keeps everything when no merge lines exist", () => {
  const suggestions = [{ text: "merge #297 once CI is green" }];
  const r = dropMergedPrSuggestions(suggestions, []);
  expect(r.kept).toEqual(suggestions);
  expect(r.droppedPrs).toEqual([]);
});

test("dropMergedPrSuggestions keeps a suggestion citing a NON-merged number", () => {
  const r = dropMergedPrSuggestions(
    [{ text: "follow up on #123" }],
    [{ text: "🔀 Merged #297 (feat/x) (abc1234)" }],
  );
  expect(r.kept.length).toBe(1);
  expect(r.droppedPrs).toEqual([]);
});

test("dropMergedPrSuggestions does not treat a bare '#297' in a non-merge line as merged", () => {
  const r = dropMergedPrSuggestions(
    [{ text: "merge #297 once CI is green" }],
    [{ text: "worked on #297 review comments" }],   // no 🔀 Merged marker → not a merge line
  );
  expect(r.kept.length).toBe(1);
});

const mergedPrStub = (suggestions: string[]): Provider => ({
  generate: async () =>
    [
      "## RESUME",
      "- [/r1] resume",
      "## RECAP",
      "- [/r1] did work | evidence: a1b2c3",
      "## SUGGESTIONS",
      ...suggestions.map((s) => `- ${s}`),
    ].join("\n"),
});

test("generateBriefing drops a suggestion naming a PR merged in the same-day `today` channel, and WARNS", async () => {
  const b = await generateBriefing(ctx, mergedPrStub(["merge #297 once CI is green", "add tests for reduce.ts"]), {
    date: "2026-08-25", machineScope: "host", provider: "claude",
    today: [{ repo: "r1", text: "🔀 Merged #297 (feat/x) (abc1234)" }],
  }, []);
  expect(b.suggestions.map((s) => s.text)).toEqual(["add tests for reduce.ts"]);
  expect((b.warnings ?? []).some((w) => w.includes("already-merged PR") && w.includes("#297"))).toBe(true);
});

test("generateBriefing also reads the window-foot `windowMerges` channel", async () => {
  const b = await generateBriefing(ctx, mergedPrStub(["review and merge #310"]), {
    date: "2026-08-25", machineScope: "host", provider: "claude",
    windowMerges: [{ repo: "r1", text: "🔀 Merged #310 (fix/y) (Aug 24)  (def5678)" }],
  }, []);
  expect(b.suggestions.length).toBe(0);
  expect((b.warnings ?? []).some((w) => w.includes("#310"))).toBe(true);
});

test("generateBriefing adds NO warning and drops nothing when no suggestion names a merged PR", async () => {
  const b = await generateBriefing(ctx, mergedPrStub(["add tests for reduce.ts"]), {
    date: "2026-08-25", machineScope: "host", provider: "claude",
    today: [{ repo: "r1", text: "🔀 Merged #297 (feat/x) (abc1234)" }],
  }, []);
  expect(b.suggestions.length).toBe(1);
  expect((b.warnings ?? []).some((w) => w.includes("already-merged"))).toBe(false);
});

// ── Negative-claim scoping (EVAL day 36) — prompt-side rule ──────────────────────────────────────
// "nothing pending here" was verified over one thread and generalised to a whole repo. The rule is
// prompt text, so the pin is presence + the load-bearing phrases (the exact prose may be tuned).
test("buildPrompt carries the negative-claim scoping rule", () => {
  const p = buildPrompt({ repos: [] }, []);
  expect(p).toContain("NEGATIVE claim");
  expect(p).toContain("never generalise from one thread or file to the whole repo");
});
