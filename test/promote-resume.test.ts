// test/promote-resume.test.ts — S1 "resume-promotion" (EVAL day 43).
//
// MEASURED DEFECT, two consecutive mornings: a RESUME bullet ended with an explicit next action
// ("Resume: audit day-42 briefing next", "…resume by committing them or confirming they're meant to
// stay local") and that action never appeared under "Suggested next". Day-43 judge: "any Resume:
// action must become suggestion #1 or the block is redundant."
//
// Pinned at THREE levels, because an extracted function's own tests let its call site regress
// invisibly (the precedent is the account-failover review, cited in generator.suggestion-filter):
//   1. the pure function        — promoteResumeActions
//   2. the pipeline seam        — generateBriefing (where clusterRecap is applied), including the
//                                 guards-then-promote-then-guards ORDER, both directions
//   3. the two downstream consumers — render's provenance label, postcheck's channel skip
//
// ⚠ THE BOUNDARY CASES BELOW ARE MUTATION KILLS, not decoration. A first round of tests passed
// against COVERED_CONTAINMENT 0.5→0.99, MIN_ACTION_CHARS 10→6, and slice-to-sentence→slice-to-end:
// every constant was unpinned. Each `boundary:` test exists to fail on one specific mutant, and the
// containment numbers are MEASURED against src/postcheck's own contentTokens/containment, not
// estimated (an earlier fixture "obviously" covering scored 3 shared tokens and would have been
// silently un-covered by the two-gate rule).
import { test, expect } from "bun:test";
import { promoteResumeActions, generateBriefing } from "../src/generator";
import { renderBriefing } from "../src/render";
import { checkSuggestionRestatement } from "../src/postcheck";
import type { ReducedContext, Provider, BriefingStruct } from "../src/types";

const R = (text: string, repo = "/r1"): BriefingStruct["resume"][number] => ({ repo, text });
const S = (text: string) => ({ text });

// ── 1. Extraction: the marker, its sentence-start rule, and the capture's bounds ─────────────────

test("promoteResumeActions promotes BOTH measured forms: 'Resume: X' and 'resume by X'", () => {
  const out = promoteResumeActions([S("add tests for reduce.ts")], [
    R("wrapped the day-42 pass. Resume: audit day-42 briefing next"),
    R("the files are still uncommitted — resume by committing them or confirming they're meant to stay local", "/r2"),
  ]);
  // PREPENDED, not appended: "must become suggestion #1 or the block is redundant".
  expect(out.map((s) => s.text)).toEqual([
    "audit day-42 briefing next",
    "committing them or confirming they're meant to stay local",
    "add tests for reduce.ts",
  ]);
  expect(out.map((s) => s.promoted)).toEqual([true, true, undefined]);
});

test("promoteResumeActions takes the LAST marker, not the first", () => {
  // A bullet may narrate a previous resume point before stating the current one. Both markers here
  // are sentence-initial, so this isolates last-wins from the sentence-start rule below.
  const out = promoteResumeActions([], [
    R("Resume: rebase the old branch. Resume: publish the installer manifest."),
  ]);
  expect(out).toEqual([{ text: "publish the installer manifest", promoted: true }]);
});

test("promoteResumeActions requires the marker to OPEN a sentence", () => {
  const out = promoteResumeActions([S("add tests for reduce.ts")], [
    // Mid-sentence marker = a REJECTED action. Promoting this would recommend the thing the bullet
    // explicitly says was abandoned — a wrong claim, not merely an odd-reading one.
    R("I noted Resume: publish the manifest but then changed my mind and dropped it"),
    // `resume by` used as a DATE, the false positive the old header conceded and this rule kills.
    R("the migration is paused and will resume by Friday afternoon at the latest", "/r2"),
    // No marker at all — the section is literally named RESUME, so the bare word cannot be the test.
    R("left the extractor half-refactored; I'll resume the audit tomorrow once CI is green", "/r3"),
  ]);
  expect(out).toEqual([{ text: "add tests for reduce.ts" }]);
});

test("boundary: the capture stops at the first sentence terminator, not at end of string", () => {
  // Kills the slice-to-end mutant: that variant promotes both sentences as one bullet.
  const out = promoteResumeActions([], [
    R("Resume: publish the installer manifest. Then archive the day-42 fixtures and notify the team."),
  ]);
  expect(out).toEqual([{ text: "publish the installer manifest", promoted: true }]);
  expect(out[0]!.text).not.toContain("archive");
});

test("a terminator mid-token (v1.2, day-42.) does not end the capture early", () => {
  const out = promoteResumeActions([], [R("Resume: tag v1.2 and push the release branch")]);
  expect(out).toEqual([{ text: "tag v1.2 and push the release branch", promoted: true }]);
});

test("promoteResumeActions SKIPS an over-long capture rather than truncating it", () => {
  // A truncated action is a half-instruction; this channel's value is that it never mangles text.
  const long = new Array(60).fill("audit").join(" ");   // 359 chars, no terminator
  expect(long.length).toBeGreaterThan(300);
  expect(promoteResumeActions([], [R(`Resume: ${long}`)])).toEqual([]);
});

test("boundary: an action of 9 chars is ignored, 10 chars is promoted", () => {
  // Kills the MIN_ACTION_CHARS 10→6 mutant.
  expect(promoteResumeActions([], [R("Resume: fix build")])).toEqual([]);            // "fix build"  = 9
  expect(promoteResumeActions([], [R("Resume: fix builds")]))                        // "fix builds" = 10
    .toEqual([{ text: "fix builds", promoted: true }]);
});

test("promoteResumeActions ignores empty captures and strips trailing . ! ? ,", () => {
  expect(promoteResumeActions([], [
    R("nothing more to say. Resume:"),
    R("Resume:    ", "/r2"),
    R("resume by ", "/r3"),
  ])).toEqual([]);
  expect(promoteResumeActions([], [R("Resume: publish the installer manifest,")]))
    .toEqual([{ text: "publish the installer manifest", promoted: true }]);
  expect(promoteResumeActions([], [R("Resume: publish the installer manifest!")]))
    .toEqual([{ text: "publish the installer manifest", promoted: true }]);
});

// ── 2. Coverage: the TWO-GATE rule (containment AND shared-token floor) ──────────────────────────

test("boundary: coverage brackets COVERED_CONTAINMENT tightly — 0.5714 suppresses, 0.4545 promotes", () => {
  // The two fixtures bracket the constant into (0.4545, 0.5714], so 0.45, 0.6, 0.7 and 0.99 all die.
  // An earlier pair (0.667 / 0.444) left the whole 0.45–0.66 band alive — the ratio was "pinned" by
  // numbers far from the bar, which is the same not-really-measured failure this suite exists to
  // catch. Every value below is MEASURED against src/postcheck's contentTokens/containment.
  //
  // MEASURED: |A|=7 |S|=7 shared=4 -> 0.5714. Just ABOVE the bar: covered, so nothing is promoted.
  const covered = promoteResumeActions([S("audit the day-42 briefing output before the standup call")], [
    R("Resume: audit the day-42 briefing output and file the eval row"),
  ]);
  expect(covered).toEqual([{ text: "audit the day-42 briefing output before the standup call" }]);

  // MEASURED: |A|=11 |S|=11 shared=5 -> 0.4545. Just BELOW the bar, WITH the token floor satisfied
  // (5 >= 4), so it is the ratio doing the work here and not the floor.
  const notCovered = promoteResumeActions(
    [S("audit the day-42 briefing output before the design team sync with product, marketing and legal")],
    [R("Resume: audit the day-42 briefing output and file the eval row for manual review before standup")],
  );
  expect(notCovered.length).toBe(2);
  expect(notCovered[0]!.promoted).toBe(true);
});

test("a 2-token suggestion cannot suppress a promotion on ONE shared word", () => {
  // MEASURED: "run tests" vs the action -> shared=1, containment=0.500. The ratio alone clears the
  // bar; the absolute floor (MIN_SHARED_TOKENS, read from postcheck) is what makes it evidence.
  // Without the floor this real promotion vanishes on the word "run".
  const out = promoteResumeActions([S("run tests")], [
    R("Resume: publish the installer manifest and run the release checklist"),
  ]);
  expect(out.length).toBe(2);
  expect(out[0]).toEqual({ text: "publish the installer manifest and run the release checklist", promoted: true });
});

test("promoteResumeActions does not promote the same action twice from two bullets", () => {
  // ⚠ Caught by TEXT equality, not tokens: this action has only 3 topical tokens, so an identical
  // duplicate can never reach the shared-token floor and the ratio gate alone would emit it twice.
  const out = promoteResumeActions([], [
    R("Resume: audit day-42 briefing next"),
    R("Resume: audit day-42 briefing next", "/r2"),
  ]);
  expect(out.length).toBe(1);
});

test("promoteResumeActions caps promotions at 2 per briefing", () => {
  const out = promoteResumeActions([], [
    R("Resume: audit the day-42 briefing output"),
    R("Resume: rerun the extractor fixtures locally", "/r2"),
    R("Resume: publish the installer manifest", "/r3"),
  ]);
  // Bounded output: resume bullets can be many (one per unit, plus Tier-1 backfills), and a wall of
  // code-built lines would bury the model's own suggestions.
  expect(out.map((s) => s.text)).toEqual([
    "audit the day-42 briefing output",
    "rerun the extractor fixtures locally",
  ]);
});

// ── 3. The pipeline seam (generateBriefing) ──────────────────────────────────────────────────────

const ctx: ReducedContext = { repos: [] };

const stub = (resume: string[], suggestions: string[]): Provider => ({
  generate: async () =>
    [
      "## RESUME",
      ...resume.map((r) => `- ${r}`),
      "## RECAP",
      "- [/r1] did work | evidence: a1b2c3",
      "## SUGGESTIONS",
      ...suggestions.map((s) => `- ${s}`),
    ].join("\n"),
});

const meta = { date: "2026-08-28", machineScope: "host", provider: "claude" };

test("generateBriefing promotes a resume action to the FRONT of SUGGESTIONS", async () => {
  const b = await generateBriefing(
    ctx,
    stub(["[/r1] wrapped the day-42 pass. Resume: audit day-42 briefing next"], ["add tests for reduce.ts"]),
    meta, [],
  );
  expect(b.suggestions.map((s) => s.text)).toEqual(["audit day-42 briefing next", "add tests for reduce.ts"]);
  expect(b.suggestions[0]!.promoted).toBe(true);
});

test("generateBriefing leaves suggestions untouched when no resume bullet carries an action marker", async () => {
  const b = await generateBriefing(
    ctx,
    stub(["[/r1] left the extractor half-refactored; I'll resume the audit tomorrow"], ["add tests for reduce.ts"]),
    meta, [],
  );
  expect(b.suggestions).toEqual([{ text: "add tests for reduce.ts" }]);
});

// ── 3a. ORDER, direction ONE: a suggestion about to be DROPPED must not suppress the promotion ───
// Both reproductions ended in an EMPTY "Suggested next" — the model's only suggestion was removed by
// a guard, and the promotion that should have replaced it had already been suppressed by that same
// doomed suggestion. The guards therefore run BEFORE promotion coverage is computed.

test("ORDER: an INFRA-DENYLISTED suggestion does not suppress the promotion (block is not left empty)", async () => {
  const b = await generateBriefing(
    ctx,
    stub(
      ["[/r1] Resume: audit the day-42 briefing output and file the eval row"],
      ["audit the day-42 briefing output in .claude/worktrees/wt-s1"],   // covers the action, then dies
    ),
    meta, [],
  );
  expect(b.suggestions.map((s) => s.text)).toEqual(["audit the day-42 briefing output and file the eval row"]);
  expect(b.suggestions[0]!.promoted).toBe(true);
});

test("ORDER: a MERGED-PR suggestion does not suppress the promotion (block is not left empty)", async () => {
  const b = await generateBriefing(
    ctx,
    stub(
      ["[/r1] Resume: audit the day-42 briefing output and file the eval row"],
      ["merge #297 and then audit the day-42 briefing output"],          // covers the action, then dies
    ),
    { ...meta, today: [{ repo: "r1", text: "🔀 Merged #297 (feat/x) (abc1234)" }] }, [],
  );
  expect(b.suggestions.map((s) => s.text)).toEqual(["audit the day-42 briefing output and file the eval row"]);
  expect(b.suggestions[0]!.promoted).toBe(true);
  expect((b.warnings ?? []).some((w) => w.includes("already-merged PR") && w.includes("#297"))).toBe(true);
});

// ── 3b. ORDER, direction TWO: a PROMOTED action faces the SAME guards ────────────────────────────

test("ORDER: the already-merged-PR guard also drops a PROMOTED action, and warns once", async () => {
  const b = await generateBriefing(
    ctx,
    stub(["[/r1] review is done. Resume: merge #297 once CI is green"], ["add tests for reduce.ts"]),
    { ...meta, today: [{ repo: "r1", text: "🔀 Merged #297 (feat/x) (abc1234)" }] }, [],
  );
  expect(b.suggestions.map((s) => s.text)).toEqual(["add tests for reduce.ts"]);
  expect(b.suggestions.some((s) => s.promoted)).toBe(false);
  const warns = (b.warnings ?? []).filter((w) => w.includes("already-merged PR"));
  expect(warns.length).toBe(1);                       // guards run twice; the warning is emitted once
  expect(warns[0]).toContain("1 suggestion(s)");      // and counts only what was actually removed
  expect(warns[0]).toContain("#297");
});

// ── 3c. ORDER, direction THREE (NEW-1): a doomed CANDIDATE must not eliminate a valid one ────────
// Selection (inter-candidate dedup, and the cap) runs only over guard-SURVIVING candidates. Running
// it first let a candidate that was about to be dropped knock out the one that should have shipped —
// the same empty-"Suggested next" outcome as 3a, one step later.

test("ORDER: a doomed candidate does not DEDUP-SUPPRESS its valid twin", async () => {
  // Candidate #1 names an infra path; #2 says the same thing without it (MEASURED overlap:
  // containment 1.000, shared 7 — so #1 covers #2 outright). Selecting first would pick #1, discard
  // #2 as a duplicate, then lose #1 to the denylist, leaving the block EMPTY.
  const b = await generateBriefing(
    ctx,
    stub(
      [
        "[/r1] Resume: audit the day-42 briefing output in .claude/worktrees/wt-s1 and file the eval row",
        "[/r2] Resume: audit the day-42 briefing output and file the eval row",
      ],
      [],
    ),
    meta, [],
  );
  expect(b.suggestions.map((s) => s.text)).toEqual(["audit the day-42 briefing output and file the eval row"]);
  expect(b.suggestions[0]!.promoted).toBe(true);
});

test("ORDER: doomed candidates do not CAP-STARVE a valid one", async () => {
  // Two merged-PR candidates would consume MAX_PROMOTIONS=2 and stop the loop before the third,
  // then both die in the PR guard — block EMPTY. (MEASURED: the three candidates do not cover one
  // another — 0.167 and 0.000 — so only the cap is under test here.)
  const b = await generateBriefing(
    ctx,
    stub(
      [
        "[/r1] Resume: merge #297 once the release checklist is signed off",
        "[/r2] Resume: merge #298 after the staging soak completes cleanly",
        "[/r3] Resume: audit the day-42 briefing output and file the eval row",
      ],
      [],
    ),
    {
      ...meta,
      today: [
        { repo: "r1", text: "🔀 Merged #297 (feat/x) (abc1234)" },
        { repo: "r2", text: "🔀 Merged #298 (fix/y) (def5678)" },
      ],
    },
    [],
  );
  expect(b.suggestions.map((s) => s.text)).toEqual(["audit the day-42 briefing output and file the eval row"]);
  expect(b.suggestions[0]!.promoted).toBe(true);
  expect((b.warnings ?? []).some((w) => w.includes("#297") && w.includes("#298"))).toBe(true);
});

test("ORDER: the infra denylist also drops a PROMOTED action", async () => {
  const b = await generateBriefing(
    ctx,
    stub(
      ["[/r1] agent scratch left over. Resume: clean up .claude/worktrees/wt-s1 before the next run"],
      ["add tests for reduce.ts"],
    ),
    meta, [],
  );
  expect(b.suggestions.map((s) => s.text)).toEqual(["add tests for reduce.ts"]);
});

// ── 4. Downstream consumers ──────────────────────────────────────────────────────────────────────

test("renderBriefing labels a promoted suggestion '(from resume)' and leaves a model one unlabelled", () => {
  const out = renderBriefing({
    date: "2026-08-28", machineScope: "mymac", provider: "claude",
    resume: [], recap: [],
    suggestions: [{ text: "audit day-42 briefing next", promoted: true }, { text: "add tests for reduce.ts" }],
  });
  expect(out).toContain("   • audit day-42 briefing next  (from resume)");
  expect(out).toContain("   • add tests for reduce.ts\n");
  expect(out.match(/\(from resume\)/g)?.length).toBe(1);
});

test("checkSuggestionRestatement SKIPS a promoted suggestion but still flags the identical model one", () => {
  const resume = [{ repo: "r1", text: "finish the extractor fixture refactor before the release" }];
  const text = "finish the extractor fixture refactor before the release";

  // Identical text via the CODE-BUILT channel: a restatement by construction, deliberately not graded
  // — and silent in the near-miss telemetry too, so the NEAR_MISS_FLOOR corpus is not poisoned with a
  // guaranteed-1.000 pair every morning.
  expect(checkSuggestionRestatement([{ text, promoted: true }], resume)).toEqual([]);

  // Identical text from the MODEL: still the #157 defect, still flagged.
  const flagged = checkSuggestionRestatement([{ text }], resume);
  expect(flagged.length).toBe(1);
  expect(flagged[0]!.rule).toBe("suggestion-restates");
  expect(flagged[0]!.info).toBeUndefined();
});

test("checkSuggestionRestatement grades the model's suggestions normally alongside a promoted one", () => {
  const resume = [{ repo: "r1", text: "finish the extractor fixture refactor before the release" }];
  const out = checkSuggestionRestatement(
    [
      { text: "finish the extractor fixture refactor before the release", promoted: true },
      { text: "finish the extractor fixture refactor before the release" },
      { text: "open the PR for feature/auth" },
    ],
    resume,
  );
  expect(out.map((f) => f.rule)).toEqual(["suggestion-restates"]);
});
