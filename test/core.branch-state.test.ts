// test/core.branch-state.test.ts — branch state, code-rendered into "Where you left off".
//
// WHY THIS EXISTS (day-21 audit, 2026-08-06). `personal_code` sat on `chore/sign-live-policy`. The
// briefing never said so, and framed the loose `policy.toml` edit as an item23 tail — advising the
// reader to commit it "tying it to that work". It was a signing chore. The branch name alone would
// have flipped that guidance from wrong to right.
//
// The line was NOT missing from the pipeline: `git.ts` produced it and it reached the prompt, in the
// repo-level catch-all block, while the resume item was written against a SUB-PROJECT unit. The model
// never made the join. That is why this is code-rendered rather than a prompt instruction — an
// instruction asks the model to retry a join it already failed.
import { test, expect } from "bun:test";
import { branchStateLines } from "../src/core";
import type { Activity } from "../src/types";

const br = (repo: string, target: string, text: string, meta: Record<string, unknown> = {}): Activity =>
  ({ source: "git", kind: "branch", event_id: `${repo}:b`, repo, target, text, meta });

const onMain = (extra: Record<string, unknown> = {}) =>
  br("/r", "main", "On branch main (ahead 0, behind 0)",
     { aheadBehind: { ahead: 0, behind: 0 }, hasUpstream: true, isDefaultBranch: true, ...extra });

test("a NON-DEFAULT branch is always reported — the day-21 case", () => {
  const a = br("/r", "chore/sign-live-policy", "On branch chore/sign-live-policy (no upstream)",
    { aheadBehind: { ahead: 0, behind: 0 }, hasUpstream: false, isDefaultBranch: false });
  expect(branchStateLines([a], ["/r"])).toEqual([{ repo: "r", text: "On branch chore/sign-live-policy (no upstream)" }]);
});

test("the default branch, in sync, is SILENT — no daily noise", () => {
  expect(branchStateLines([onMain()], ["/r"])).toEqual([]);
});

test("⚠ the default branch DIVERGED still reports — B3 requires the numbers", () => {
  // THE case that killed "suppress every default-branch line". Day-16: the app asserted "in sync
  // with origin" against `ahead 12, behind 12`. Suppressing on default-branch alone would restore
  // exactly that silence. The predicate is "is there anything worth saying", not "is it default".
  const diverged = br("/r", "main", "On branch main (ahead 12, behind 12)",
    { aheadBehind: { ahead: 12, behind: 12 }, hasUpstream: true, isDefaultBranch: true });
  expect(branchStateLines([diverged], ["/r"])).toHaveLength(1);
});

test("⚠ the default branch with NO UPSTREAM reports — 0/0 there is not parity", () => {
  // `git rev-list ...@{u}` exits 128 with no upstream (MEASURED) and git.ts swallows it, so
  // ahead/behind stay 0 — byte-identical to genuine parity. Suppressing on the zeros alone would
  // hide a branch that was never pushed anywhere.
  const local = br("/r", "main", "On branch main (no upstream)",
    { aheadBehind: { ahead: 0, behind: 0 }, hasUpstream: false, isDefaultBranch: true });
  expect(branchStateLines([local], ["/r"])).toHaveLength(1);
});

test("DETACHED HEAD is always reported, whatever else is true", () => {
  // ⚠ The fixture makes EVERY OTHER CLAUSE SILENT — default, in sync, upstream present — so only the
  // `!detached` term can be doing the work. The first version set isDefaultBranch:false AND
  // hasUpstream:false, so two other clauses already fired and dropping `!detached &&` left the suite
  // green (MEASURED). `git.ts` cannot currently emit this combination (it forces isDefaultBranch
  // false for a detached HEAD), but `branchStateLines` is exported and takes arbitrary Activities,
  // so the guard is real defence and now has a discriminating pin.
  const d = br("/r", "HEAD", "Detached HEAD at 1a2b3c4",
    { aheadBehind: { ahead: 0, behind: 0 }, hasUpstream: true, isDefaultBranch: true });
  expect(branchStateLines([d], ["/r"])).toHaveLength(1);
});

test("non-branch activities are ignored, and repo labels are applied", () => {
  const commit: Activity = { source: "git", kind: "commit", event_id: "c", repo: "/r", text: "x" };
  const a = br("/one/deep/alpha", "feature/x", "On branch feature/x (ahead 1, behind 0)",
    { aheadBehind: { ahead: 1, behind: 0 }, hasUpstream: true, isDefaultBranch: false });
  const out = branchStateLines([commit, a], ["/one/deep/alpha"]);
  expect(out).toHaveLength(1);
  expect(out[0]!.repo).toBe("alpha");
});

test("a branch activity with no text is skipped rather than rendering an empty bullet", () => {
  const a = { ...br("/r", "x", ""), text: undefined } as Activity;
  expect(branchStateLines([a], ["/r"])).toEqual([]);
});

test("⚠ MISSING metadata must not be read as 'default and in sync'", () => {
  // An older Activity (or a hand-built one) carries no isDefaultBranch/hasUpstream. Defaulting those
  // to the suppressing values would silently hide every branch line — the exact failure being fixed.
  // `isDefaultBranch === true` is required explicitly, so absence reports.
  const bare = br("/r", "main", "On branch main (ahead 0, behind 0)");
  expect(branchStateLines([bare], ["/r"])).toHaveLength(1);
});
