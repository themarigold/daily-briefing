import { test, expect } from "bun:test";
import { extractCitedShas, missingSameDay, coverageGaps, unresolvedFromBatch, factsFromActivities, lastBriefing, buildAuditPrompt, sameDayCommits, branchLinesFromBriefing, branchAtGeneration, branchAxisLine, generationInstant, regenFailureMessage, groundingVerdict, degradedReadLine, unreadableReposLine, groundTruthUnavailableLine, classifyReadFailure, gitUnavailableLine, bucketPathIssues, accessDeniedLine, bucketFailures, degradationLines, degradationBuckets, evalRow, collectDegradation, unknownFailureLine } from "../src/audit";
import type { Activity } from "../src/types";
import { activityLine } from "../src/generator"; // D4a: the shared-evidence invariant spans both renderers
import type { Unit } from "../src/subprojects";

test("extractCitedShas catches short (6-char) garbled SHAs in a SHA-citation list — the fabrication the tool exists to catch", () => {
  const line = "Built it (ff15ca0, 1faa71d, ffee140, 2ee1... (2ee140), bd65eed, 868f3ac)";
  const shas = extractCitedShas(line);
  expect(shas).toContain("2ee140");
  expect(shas).toContain("ff15ca0");
  expect(shas).toContain("bd65eed");
});

test("extractCitedShas pulls evidence-clause SHAs but NOT hex embedded in a filename (0001_init.sql, feed.json, cafe.ts)", () => {
  expect(extractCitedShas("added auth | evidence: a1b2c3d4 (src/auth.ts)")).toEqual(["a1b2c3d4"]);
  expect(extractCitedShas("ran migration (0001_init.sql)")).toEqual([]); // 0001 is part of a filename, not a SHA
  expect(extractCitedShas("touched (feed.json) and (cafe.ts)")).toEqual([]);
});

test("extractCitedShas does NOT mine hex out of parenthetical PROSE", () => {
  expect(extractCitedShas("[repo] Refactored (2024 planning, faced a decade of debt)")).toEqual([]);
});

test("extractCitedShas skips the app's own grounding-guard disclosure so it isn't re-flagged as fabricated", () => {
  expect(extractCitedShas("⚠ 1 cited SHA(s) didn't resolve to a real commit and were removed: deadbeef")).not.toContain("deadbeef");
});

test("extractCitedShas dedupes and lowercases within a citation list", () => {
  expect(extractCitedShas("(AB12CD3, ab12cd3)")).toEqual(["ab12cd3"]);
});

test("lastBriefing returns the most recent briefing when the log has accumulated several (launchd appends)", () => {
  const log = "☀️  Morning briefing — 2026-07-08  (m)\nold body\n\n☀️  Morning briefing — 2026-07-09  (m)\nnew body";
  const last = lastBriefing(log);
  expect(last).toContain("2026-07-09");
  expect(last).not.toContain("old body");
});

test("lastBriefing returns text unchanged for a single briefing", () => {
  const one = "☀️  Morning briefing — 2026-07-09  (m)\nbody";
  expect(lastBriefing(one)).toBe(one);
});

// ⚠ THE HEADER RENAME OF 2026-08-17 IS A PARSER COMPATIBILITY PROBLEM, AND THE FAILURE MODE IS
// SILENT. `☀️  Morning briefing —` became `☀️  Briefing —` (render.ts:29), but `briefing.log` and
// every archived briefing under `<state>/briefings/` still carry the OLD text. `lastBriefing` falls
// back to returning the WHOLE text when it matches no header — so a matcher narrowed to the new
// spelling would hand the audit a concatenation of every briefing ever written, with no error and no
// flag. The two tests above already pin the OLD format; these pin the NEW one and the MIXED log that
// every real machine now has.
// ⚠ THIS NEEDS **TWO** BRIEFINGS, AND THE REASON IS THE WHOLE TRAP IN THIS FILE. A single-briefing
// case CANNOT FAIL IN EITHER DIRECTION: no header match falls through to `return text`, and for one
// briefing the whole text IS the right answer, so `toBe(input)` passes even when the matcher is
// broken. MEASURED — the first draft asserted exactly that and SURVIVED a mutation narrowing the
// matcher to the old spelling only (126 pass, 0 fail). Only a second briefing makes the fallback and
// the correct answer differ.
test("lastBriefing accepts the POST-RENAME header (2026-08-17 first-wake scope)", () => {
  const log = "☀️  Briefing — 2026-08-18  (m)\nfirst body\n\n☀️  Briefing — 2026-08-19  (m)\nsecond body";
  const last = lastBriefing(log);
  expect(last).toContain("second body");
  expect(last).not.toContain("first body");   // dies if the matcher stops seeing the new spelling
});

// ⚠ MEASURED, NOT ASSUMED — the obvious version of this test CANNOT FAIL, and the first draft of it
// shipped that way until a mutation run caught it. Narrowing the matcher to the new spelling only and
// running this file killed the PRE-EXISTING two-old-headers test at line 33, and left the draft
// GREEN. Two reasons, both worth knowing before editing:
//   • old-then-new (the realistic append order) still finds the NEW header, so the slice is correct
//     under the mutation — the old header never needed matching.
//   • a lone OLD header falls through to the whole-text fallback, which for a single briefing IS the
//     right answer — so `toContain(body)` passes either way. That draft assertion was vacuous.
// What discriminates is the ORDER: a new header followed by an old one. Contrived as a log, but it is
// a property test of the matcher, not a scenario — it fails iff the old spelling stops matching.
test("lastBriefing finds the OLD header even when a NEW one precedes it (both spellings, property)", () => {
  const log = "☀️  Briefing — 2026-08-18  (m)\nnew body\n\n☀️  Morning briefing — 2026-08-16  (m)\nold body";
  const last = lastBriefing(log);
  expect(last).toContain("old body");
  expect(last).not.toContain("new body");   // dies if [Bb] narrows to B — the whole point
});

test("missingSameDay returns the day's commit SHAs the briefing did NOT reflect (bounded prefix)", () => {
  const day = ["4d0082c6ab11", "ef8c43c9de22", "6de0fee30033"];
  expect(missingSameDay(day, "You did stuff (ef8c43c9) and more (6de0fee3).")).toEqual(["4d0082c6ab11"]);
});

test("coverageGaps returns repos with working state that the briefing never names (word-bounded)", () => {
  expect(coverageGaps(
    [{ repo: "/Users/me/dev/chef-repo", labels: ["chef-repo"] }, { repo: "/Users/me/Desktop/secret-proj", labels: ["secret-proj"] }],
    "resume the chef-repo add_widget work",
  )).toEqual([{ repo: "/Users/me/Desktop/secret-proj", labels: ["secret-proj"] }]);
});

test("coverageGaps: a split repo whose sub-project label appears is NOT flagged", () => {
  const rws = [{ repo: "/x/personal_code", labels: ["personal_code", "daily_briefing_application"] }];
  const text = "▶ [daily_briefing_application] uncommitted: a.ts";
  expect(coverageGaps(rws, text)).toEqual([]); // covered by the unit label, though "personal_code" never appears
});

test("coverageGaps: parent-qualified label matched verbatim (no basename strip)", () => {
  const rws = [{ repo: "/x/r", labels: ["A/api"] }];
  expect(coverageGaps(rws, "[A/api] resume").length).toBe(0);
  expect(coverageGaps(rws, "[api] resume").length).toBe(1); // "A/api" not present → still a gap
});

test("unresolvedFromBatch: a SHA missing in EVERY repo is unresolved; resolved/ambiguous anywhere clears it", () => {
  const cited = ["2ee140", "ff15ca0", "a1b2c3"];
  const repoA = ["2ee140 missing", "ff15ca08f00 commit 42", "a1b2c3 missing"]; // ff resolves here
  const repoB = ["2ee140 missing", "ff15ca0 missing", "a1b2c3 ambiguous"];      // a1b2c3 ambiguous → not fabricated
  expect(unresolvedFromBatch(cited, [repoA, repoB])).toEqual(["2ee140"]);       // only 2ee140 missing everywhere
  expect(unresolvedFromBatch([], [])).toEqual([]);
});

test("factsFromActivities groups by repo, flags working-state repos, and caps the commit list", () => {
  const acts: Activity[] = [
    { source: "git", kind: "commit", event_id: "a1b2c3d4", repo: "/r1", text: "c1" },
    { source: "git", kind: "uncommitted", event_id: "u1", repo: "/r1", text: "Uncommitted: x.ts" },
    { source: "git", kind: "commit", event_id: "e5f6a7b8", repo: "/r2", text: "c2" },
  ];
  const { text, reposWithState } = factsFromActivities(acts, [], [], 30);
  expect(reposWithState).toEqual([{ repo: "/r1", labels: ["r1"] }]); // only /r1 has working state
  expect(text).toContain("/r1");
  expect(text).toContain("a1b2c3d"); // short sha in the summary
});

test("factsFromActivities: a dirty sub-project-only repo gets its parent-qualified label from the FULL repos list (day-to-day-flip guard)", () => {
  const units: Unit[] = [{ repo: "/x/A/dupe", root: "packages/api", label: "api", hasResumptionState: true, hasWindowContent: true, resumptionNote: "uncommitted: a", dirtyFiles: ["packages/api/a.ts"], latestCommitTime: null }];
  const acts: Activity[] = [{ source: "git", kind: "uncommitted", event_id: "u", repo: "/x/A/dupe", meta: { uncommittedFiles: ["packages/api/a.ts"] } }];
  const { reposWithState } = factsFromActivities(acts, units, ["/x/A/dupe", "/y/A/dupe"], 30); // same-basename sibling in the repos list
  const entry = reposWithState.find((r) => r.repo === "/x/A/dupe")!;
  expect(entry.labels).toContain("A/dupe"); // repoLabelFor(repo, repos) → parent-qualified vs the sibling, NOT bare "dupe" (no catch-all unit to read from)
});

test("buildAuditPrompt embeds the briefing, git facts, popup (when configured), and deterministic flags; asks for adversarial review", () => {
  const p = buildAuditPrompt({ briefing: "APP-BRIEFING", gitFacts: "GROUND-TRUTH", popup: "POPUP", popupConfigured: true, deterministic: ["fabricated SHA: 2ee140"] });
  expect(p).toContain("APP-BRIEFING");
  expect(p).toContain("GROUND-TRUTH");
  expect(p).toContain("POPUP");
  expect(p).toContain("VS POPUP");   // heading present when configured
  expect(p).toContain("2ee140");
  expect(p.toLowerCase()).toContain("adversarial");
});

test("buildAuditPrompt: popup configured but unavailable → NOTES it (doesn't invent contents) [Tier-5]", () => {
  const p = buildAuditPrompt({ briefing: "B", gitFacts: "G", popup: null, popupConfigured: true, deterministic: [] });
  expect(p.toLowerCase()).toMatch(/unavailable|not available|no popup|stale/);
  expect(p).toContain("VS POPUP");
});

test("buildAuditPrompt: popup NOT configured → OMITS the popup block AND the VS POPUP heading [Tier-5]", () => {
  const p = buildAuditPrompt({ briefing: "B", gitFacts: "G", popup: null, deterministic: [] }); // no popupConfigured
  expect(p).not.toContain("POPUP");                 // no popup block or heading
  expect(p).not.toMatch(/unavailable|stale/i);      // no phantom "limitation" note
  expect(p).toContain("3. IMPROVEMENT OPPORTUNITIES"); // renumbered (VS POPUP was #3)
});

test("buildAuditPrompt: asks the judge to flag over-suppressed / verification-only SUGGESTIONS", () => {
  const p = buildAuditPrompt({ briefing: "b", gitFacts: "g", popup: null, deterministic: [] });
  expect(p).toMatch(/OVER-SUPPRESSION/);
  expect(p).toMatch(/verification-only/);
});

// audit 2026-07-10 #3 (judge false positive): the judge flagged a correct file claim as "fabricated"
// because ground truth showed only SHA+subject while the app's prompt includes --numstat file lists.
// The ground truth must carry the same file evidence the briefing saw.
test("factsFromActivities includes per-commit file lists from diffstat", () => {
  const { text } = factsFromActivities([
    { source: "git", kind: "commit", event_id: "62004259aaaa", repo: "/r", text: "chore(m3): live-(b) result",
      meta: { diffstat: [{ file: "extraction/data/measure/dualread_live_b.json", added: 652, removed: 0 }] } },
  ], [], [], 30);
  expect(text).toContain("dualread_live_b.json");
});

// Slice 1.5 T0.4 — the audit is the EVAL instrument, and T0.2 (which inverted the git layer's
// bot-commit drop into a `meta.excluded` tag so those commits could still vote for a sub-project
// root) left this the one consumer that never learned to skip them. Caught at checkpoint C0, before
// the branch merged, so no EVAL.md row was affected.
test("factsFromActivities excludes meta.excluded bot commits from the judge's ground truth [T0.4]", () => {
  const acts: Activity[] = [
    { source: "git", kind: "commit", event_id: "aaaaaaa1", repo: "/r", text: "real work",
      timestamp: "2026-07-30T09:00:00.000Z", meta: { diffstat: [{ file: "a.ts", added: 1, removed: 0 }] } },
    { source: "git", kind: "commit", event_id: "bbbbbbb2", repo: "/r", text: "vault backup: 2026-07-30",
      timestamp: "2026-07-30T11:00:00.000Z", meta: { diffstat: [{ file: "b.md", added: 1, removed: 0 }], excluded: true } },
  ];
  const { text } = factsFromActivities(acts, [], ["/r"], 30);
  expect(text).toContain("real work");
  expect(text).not.toContain("vault backup:");
  // The COUNT is the load-bearing half: it is the number the judge is told the briefing "SHOULD
  // recap", so an off-by-one here is what penalises a correct briefing.
  expect(text).toContain("in-window commits (1) the briefing SHOULD recap:");
  // …and the excluded commit must not sneak in via the file list either.
  expect(text).not.toContain("b.md");
});

// ---- Tier-5 batch 8: same-day audit false positives (merge commits + post-generation) ----
// git-log row: %h \x1f %cI \x1f %P \x1f %s. Build dates from LOCAL components so localDateStr(cISO)==bDate in any TZ.
const iso = (h: number, m: number) => new Date(2026, 6, 18, h, m).toISOString(); // local 2026-07-18 HH:MM
const row = (h: string, cISO: string, parents: string, subj: string) => [h, cISO, parents, subj].join("\x1f");

test("sameDayCommits: keeps merges OUT of shas (they are not recap commits) and drops bot commits, exact local-day only [Tier-5]", () => {
  const out = [
    row("aaaaaa1", iso(9, 0), "p1", "real work"),                 // keep
    row("bbbbbb2", iso(9, 5), "p1 p2", "Merge pull request #1"),  // 2 parents → merge → out of shas (see prMerges)
    row("cccccc3", iso(9, 10), "p1", "vault backup: nightly"),    // bot → drop
    row("dddddd4", new Date(2026, 6, 17, 9, 0).toISOString(), "p1", "yesterday"), // wrong day → drop
    row("eeeeee5", iso(9, 20), "", "root commit"),               // 0 parents (root) → keep
    row("ffffff6", iso(9, 25), "p1 p2 p3", "octopus merge"),     // 3 parents → merge → out of shas (see otherMerges)
  ].join("\n");
  const { shas, postGeneration } = sameDayCommits(out, "2026-07-18", [/^vault backup:/]);
  expect(shas).toEqual(["aaaaaa1", "eeeeee5"]);
  expect(postGeneration).toEqual([]);
});

test("sameDayCommits: commits at/after the generation instant are split out, not counted as missed [Tier-5]", () => {
  const genAt = new Date(2026, 6, 18, 7, 20).getTime(); // briefing generated 07:20
  const out = [
    row("bef0re1", iso(7, 0), "p1", "before generation"),  // 07:00 < 07:20 → same-day candidate
    row("atstamp", iso(7, 20), "p1", "exactly at the stamp"), // 07:20:00 == stamp → post-gen (>= boundary)
    row("after02", iso(9, 0), "p1", "after generation"),   // 09:00 > 07:20 → post-generation
  ].join("\n");
  const { shas, postGeneration } = sameDayCommits(out, "2026-07-18", [], genAt);
  expect(shas).toEqual(["bef0re1"]);
  expect(postGeneration.length).toBe(2);                   // at-stamp + after
  expect(postGeneration.map((l) => l.split(" ")[0])).toEqual(["atstamp", "after02"]);
});

// ── Defect A (EVAL.md freeze block, fixed 2026-08-14; merge SPLIT added after review) ────────────
// Both halves matter. Folding merges into `shas` over-reports same-day blindness; omitting them
// entirely reproduces the false "fabricated" HIGH the judge returned on days 27, 28 and 29. And
// lumping non-PR merges in with PR merges invites the MIRROR-IMAGE false finding — the judge seeing a
// merge the ground truth says the app renders, not finding it, and reporting an omission the app
// structurally cannot make.
test("sameDayCommits: PR merges and other merges are split, and neither reaches shas [Tier-5]", () => {
  const out = [
    row("aaaaaa1", iso(9, 0), "p1", "real work"),
    row("bbbbbb2", iso(9, 5), "p1 p2", "Merge pull request #213 from themarigold/feat/ap-m6-carry-forward"),
    row("ccccc10", iso(9, 8), "p1 p2", "Merge branch 'main' into fix/eval-mint-script-lock"), // NOT a PR merge
    row("ffffff6", iso(9, 25), "p1 p2 p3", "octopus merge"),                                  // NOT a PR merge
    row("ddddd11", iso(9, 30), "p1 p2", "vault backup: merge"),   // bot filter wins over the merge branch
  ].join("\n");
  const { shas, lines, prMerges, otherMerges } = sameDayCommits(out, "2026-07-18", [/^vault backup:/]);
  expect(shas).toEqual(["aaaaaa1"]);                    // blindness count UNCHANGED by this fix
  expect(lines.length).toBe(1);
  expect(prMerges).toEqual(["bbbbbb2 Merge pull request #213 from themarigold/feat/ap-m6-carry-forward"]);
  // The regression this split exists for: these are surfaced by NO app channel, so they must never sit
  // under a heading claiming the app renders them.
  expect(otherMerges).toEqual([
    "ccccc10 Merge branch 'main' into fix/eval-mint-script-lock",
    "ffffff6 octopus merge",
  ]);
});

test("sameDayCommits: a merge AFTER the generation instant goes to postGeneration tagged (merge) [Tier-5]", () => {
  const genAt = new Date(2026, 6, 18, 7, 20).getTime();
  const out = [
    row("bef0rem", iso(7, 0), "p1 p2", "Merge pull request #1 from o/feat-a"),  // before → prMerges
    row("afterme", iso(9, 0), "p1 p2", "Merge pull request #2 from o/feat-b"),  // after  → postGeneration
  ].join("\n");
  const { shas, prMerges, postGeneration } = sameDayCommits(out, "2026-07-18", [], genAt);
  expect(shas).toEqual([]);
  expect(prMerges).toEqual(["bef0rem Merge pull request #1 from o/feat-a"]);
  expect(postGeneration).toEqual(["afterme Merge pull request #2 from o/feat-b (merge)"]);
});

// ── Defect B (EVAL.md freeze block, fixed 2026-08-14) ────────────────────────────────────────────
// The first implementation inferred branch comparability from `git reflog` and was wrong in BOTH
// directions (see the note above `branchAtGeneration` in src/audit.ts). These tests pin the property
// that replaced it: the generation-time fact comes from the briefing's own rendered branch line.
const briefingWith = (...bullets: string[]) => [
  "☀️  Morning briefing — 2026-08-14",
  "",
  "▶ Where you left off  (morning floor 07:20 · state as of 07:45)",
  ...bullets,
  "",
  "▶ What you did",
  "   • [app] did a thing (abc1234)",
].join("\n");

test("branchLinesFromBriefing: mines ONLY real branch lines, never model prose [Tier-5]", () => {
  const b = briefingWith(
    "   • [app] On branch main (ahead 0, behind 0)",
    "   • [plugin] On branch feat/x (no upstream)",
    "   • [vault] Detached HEAD at abc1234",
    // Resume bullets share the `• [label] …` shape and are free model prose. A loose pattern mines
    // this one as branch state and hands the judge a fabricated fact.
    "   • [app] On branch work continues — resume by reading the runbook",
  );
  const m = branchLinesFromBriefing(b);
  expect(m.get("app")).toBe("On branch main (ahead 0, behind 0)");
  expect(m.get("plugin")).toBe("On branch feat/x (no upstream)");
  expect(m.get("vault")).toBe("Detached HEAD at abc1234");
  expect(m.size).toBe(3);                                  // the prose bullet was NOT mined
});

test("branchAtGeneration: stated / not-notable / unguarded — and absence only counts when the briefing was read [Tier-5]", () => {
  const m = branchLinesFromBriefing(briefingWith("   • [app] On branch main (ahead 2, behind 1)"));
  expect(branchAtGeneration(m, "app")).toEqual({ kind: "stated", text: "On branch main (ahead 2, behind 1)" });
  // The app renders a line IFF isBranchNotable — so absence IS the generation-time verdict.
  expect(branchAtGeneration(m, "other")).toEqual({ kind: "not-notable" });
  // …but only when there was a briefing to read. null must never degrade to "not-notable".
  expect(branchAtGeneration(null, "app").kind).toBe("unguarded");
});

test("branchAxisLine: only 'stated' and 'not-notable' license a comparison; unguarded is flagged [Tier-5]", () => {
  const stated = branchAxisLine("app", "/r/app", { kind: "stated", text: "On branch main (ahead 0, behind 0)" });
  const notNotable = branchAxisLine("app", "/r/app", { kind: "not-notable" });
  const un = branchAxisLine("app", "/r/app", { kind: "unguarded", why: "the delivered briefing could not be read" });
  expect(stated).toContain("On branch main (ahead 0, behind 0)");
  expect(notNotable).toContain("do not score it as an omission");
  expect(un).toContain("UNGUARDED");
  expect(un).toContain("⚠");
  // Non-injective `repoLabel` (config.ts) is why the full path is carried too — two repos can share a
  // label, and this file records that filtering on a non-injective key deleted a diagnosis twice.
  for (const l of [stated, notNotable, un]) expect(l).toContain("/r/app");
});

test("generationInstant: parses 'state as of HH:MM' on bDate; null when absent/unparseable [Tier-5]", () => {
  expect(generationInstant("▶ Where you left off  (state as of 07:20)", "2026-07-18"))
    .toBe(new Date(2026, 6, 18, 7, 20).getTime());
  expect(generationInstant("no stamp anywhere", "2026-07-18")).toBeNull();
  expect(generationInstant("state as of 07:20", "not-a-date")).toBeNull();
});

test("factsFromActivities: a repo dirty ONLY with .claude/worktrees infra files is NOT flagged as having state [Tier-A]", () => {
  const acts: Activity[] = [
    { source: "git", kind: "uncommitted", event_id: "u1", repo: "/infra", meta: { uncommittedFiles: [".claude/worktrees/x/a.ts"] } },
    { source: "git", kind: "uncommitted", event_id: "u2", repo: "/real", meta: { uncommittedFiles: ["src/main.ts"] } },
    { source: "git", kind: "stash", event_id: "s1", repo: "/stashed", target: "stash@{0}", meta: { sha: "abc1234" } },
  ];
  const { reposWithState } = factsFromActivities(acts, [], [], 30);
  expect(reposWithState.map((r) => r.repo).sort()).toEqual(["/real", "/stashed"]); // infra-only excluded; real + stash kept
});

test("extractCitedShas: a prose paren earlier on the line does NOT shield a later citation paren (greedy-paren fix) [Tier-B]", () => {
  // separate parens: one prose, one a fabricated-SHA citation — the greedy first-'(' to last-')' span
  // used to merge them into a non-citation blob and miss the fake SHA.
  expect(extractCitedShas("[r] Did the thing (see the plan doc) and cited (2ee140)")).toContain("2ee140");
  // a legit multi-SHA list with a NESTED aside still mines all of them (balanced walk keeps them together)
  expect(extractCitedShas("Built it (ff15ca0, (2ee140), bd65eed)").sort()).toEqual(["2ee140", "bd65eed", "ff15ca0"]);
});

test("extractCitedShas: unbalanced / empty parens don't crash and behave sanely (topLevelParenGroups edges) [Tier-B]", () => {
  expect(extractCitedShas("cited (2ee140 but never closed")).toEqual([]); // unbalanced '(' → no closed group → nothing mined (parity with the old greedy match)
  expect(extractCitedShas("empty () parens here")).toEqual([]);           // empty group → skipped, no crash
  expect(extractCitedShas("evidence: a1b2c3d")).toEqual(["a1b2c3d"]);     // no parens → the evidence: group still mines
});

test("extractCitedShas: a hex-shaped PROSE WORD after a valid SHA is NOT mined as a fabricated citation (isShaShaped, shared with the generator) [Tier-D]", () => {
  // The generator (Tier-A verifyEvidence/isShaShaped) deliberately KEEPS prose like "added"/"cafe" in
  // rendered evidence — they aren't SHAs. The audit's token miner must apply the SAME shape test, or a
  // valid `evidence: <sha> (added helper)` re-flags "added" as `fabricated added` in the deterministic
  // report + the EVAL row — exactly the false-alarm class Tier-A killed in the generator, relocated here.
  expect(extractCitedShas("- Refactor. evidence: 2ee0ae5 (added helper)")).toEqual(["2ee0ae5"]);
  expect(extractCitedShas("evidence: a1b2c3d (cafe menu)")).toEqual(["a1b2c3d"]);
  // …but a genuinely SHA-shaped (digit+letter) token is STILL mined so a garbled/fabricated SHA is caught:
  expect(extractCitedShas("evidence: 2ee0ae5 (2ee140 note)")).toContain("2ee140");
});

const OK = { code: 1, complete: true, spawned: true, signal: null };

test("regenFailureMessage: names TRUNCATION when the read was incomplete, and explains the -1", () => {
  // F2. When the generator's pipe is held past the flush window, `run()` reports `complete: false`
  // and forces `code: -1`. The operator sees only this message, so it must distinguish "generation
  // failed" from "generation may have SUCCEEDED but we could not read all of it" — the actions
  // differ (investigate the generator vs. simply re-run the audit).
  const m = regenFailureMessage({ ...OK, code: -1, complete: false }, "");
  expect(m).toContain("(generation exit=-1)");   // parenthesised: `toContain("exit=-1")` also matches "exit=-112"
  expect(m).toContain("may be truncated");
  expect(m).toContain("re-run");
  expect(m).toContain("refusing to overwrite the log");
});

test("regenFailureMessage: a COMPLETE read that merely failed says nothing about truncation", () => {
  // Pins the conditional. Emitting the truncation clause unconditionally would survive the test above
  // while telling the operator to re-run the audit for a generator that genuinely exited nonzero.
  const m = regenFailureMessage(OK, "");
  expect(m).toContain("(generation exit=1)");
  expect(m).not.toContain("truncated");
  expect(m).not.toContain("re-run");
});

test("regenFailureMessage: a SPAWN FAILURE is not reported as truncation, and does not advise a re-run", () => {
  // `run()` returns `{code: -1, complete: false}` for BOTH a held pipe and `Bun.spawn` throwing, so a
  // consumer reading `complete` alone tells an operator whose binary is missing that the output "may
  // be truncated — re-run the audit", which will fail identically. `spawned` is what separates them.
  const m = regenFailureMessage({ code: -1, complete: false, spawned: false, signal: null },
                                "Error: ENOENT: no such file or directory");
  expect(m).toContain("could not be started");
  expect(m).not.toContain("truncated");
  expect(m).not.toContain("re-run");
  expect(m).toContain("ENOENT");
});

test("regenFailureMessage: a SIGNAL death names the signal instead of hiding behind exit=1", () => {
  // A signal-killed child EOFs its pipes, so `complete` is true and the truncation clause is
  // (correctly) suppressed — leaving `exit=1`, indistinguishable from an ordinary failure. An
  // OOM-killed generator is a different problem from a generator that ran and failed.
  const m = regenFailureMessage({ code: 1, complete: true, spawned: true, signal: "SIGKILL" }, "");
  expect(m).toContain("SIGKILL");
  expect(m).toContain("killed");
});

test("regenFailureMessage: the stderr detail is appended when present, omitted when blank", () => {
  expect(regenFailureMessage(OK, "provider timed out after 90s")).toContain("provider timed out after 90s");
  // ABSOLUTE assertion, not a comparison of the function to itself: `toBe(regenFailureMessage(1,true,""))`
  // pins only CONSISTENCY, so emitting the separator unconditionally left both sides equal and passed
  // while the dangling " — ;" it was written to forbid shipped.
  expect(regenFailureMessage(OK, "   ")).toBe(
    "could not obtain today's briefing (generation exit=1); refusing to overwrite the log");
  expect(regenFailureMessage(OK, "  padded  ")).toContain("— padded;");   // trimmed, no stray spaces
});

// --- degraded-read reporting (F2 review HIGHs) -------------------------------------------------
// Making `run()` fail closed stopped the hang but did NOT stop the audit from speaking confidently
// about data it never read. Both findings were reproduced against real repos: a held pipe on one
// repo's `git log` made the report say "clean: all cited SHAs resolve, no same-day miss" with a ✅
// EVAL row (BETTER-looking than the healthy run), and a held pipe on `cat-file` made nine REAL
// commits be listed as `FABRICATED SHA(s)` with a ❌ row.

test("groundingVerdict: a degraded read NEVER yields a confident FABRICATED verdict", () => {
  // The unsound inference: a SHA that resolves in no READABLE repo may simply live in the repo we
  // could not read. Reporting that as fabrication invents a hallucination accusation and writes ❌
  // into EVAL.md — the single worst output this tool can produce, since the rows are the record.
  const v = groundingVerdict({ citedCount: 9, unresolved: ["670a475", "d4b3416"], verified: true, degradedRepos: ["personal_code"] });
  expect(v.ground).toBe("UNKNOWN");
  expect(v.emoji).toBe("?");
  expect(v.line).not.toContain("FABRICATED");
  expect(v.line).toContain("personal_code");   // names WHICH repo went unread
  expect(v.line).toContain("670a475");         // still surfaces the SHAs, as unverified rather than fake
});

test("groundingVerdict: with every repo readable, a genuine fabrication is still reported as FAIL", () => {
  // The degradation guard must not blunt the check it guards — this is the case the audit exists for.
  const v = groundingVerdict({ citedCount: 9, unresolved: ["2ee140"], verified: true, degradedRepos: [] });
  expect(v.ground).toBe("FAIL");
  expect(v.emoji).toBe("❌");
  expect(v.line).toContain("FABRICATED");
  expect(v.line).toContain("2ee140");
});

test("groundingVerdict: all clean and fully readable is PASS with no line", () => {
  const v = groundingVerdict({ citedCount: 9, unresolved: [], verified: true, degradedRepos: [] });
  expect(v.ground).toBe("PASS");
  expect(v.emoji).toBe("✅");
  expect(v.line).toBeNull();
});

test("groundingVerdict: clean-but-degraded is NOT a PASS — absence of evidence is not evidence", () => {
  // The subtler half of the same bug: zero unresolved SHAs across the repos we COULD read says
  // nothing about the one we could not, so a ✅ here is exactly the over-confident row to avoid.
  const v = groundingVerdict({ citedCount: 9, unresolved: [], verified: true, degradedRepos: ["Notes Vault"] });
  expect(v.ground).toBe("UNKNOWN");
  expect(v.emoji).toBe("?");
  expect(v.line).toContain("Notes Vault");
});

test("groundingVerdict: nothing cited is n/a, and no repo readable stays UNKNOWN", () => {
  expect(groundingVerdict({ citedCount: 0, unresolved: [], verified: true, degradedRepos: [] }).ground).toBe("n/a");
  const none = groundingVerdict({ citedCount: 4, unresolved: [], verified: false, degradedRepos: [] });
  expect(none.ground).toBe("UNKNOWN");
  expect(none.line).toContain("UNKNOWN");
});

test("degradedReadLine: names the repos and says the same-day count is a LOWER BOUND", () => {
  // Why this must reach `deterministic` and not just the judge prompt: under --no-judge the judge
  // prompt is never built, so a degraded audit was 100% silent — and the deterministic section is
  // the one labelled "code — reliable".
  const l = degradedReadLine(["personal_code", "Notes Vault"]);
  expect(l).toContain("personal_code");
  expect(l).toContain("Notes Vault");
  expect(l).toMatch(/lower bound/i);
  expect(degradedReadLine([])).toBeNull();
});


test("regenFailureMessage: OUR OWN timeout is named, and does NOT advise a re-run", () => {
  // A timeout kill arrives as {code:-1, complete:false, signal:"SIGKILL"} — which matched the
  // truncation branch and said "re-run the audit", i.e. burn another full ceiling to be killed again.
  const m = regenFailureMessage({ code: -1, complete: false, spawned: true, signal: "SIGKILL", timedOut: true }, "");
  expect(m).toContain("time limit");
  expect(m).not.toContain("re-run the audit");
  expect(m).toContain("raise it");
});

test("regenFailureMessage: an EXTERNAL signal kill is still distinguished from our own ceiling", () => {
  const m = regenFailureMessage({ code: 1, complete: true, spawned: true, signal: "SIGKILL", timedOut: false }, "");
  expect(m).toContain("SIGKILL");
  expect(m).toMatch(/as far as it can tell|not by the audit/);
  // Pin the ADVICE, not the words — for the third time in this file a word-presence assertion was
  // wrong, because the external-kill wording legitimately mentions the time limit in order to DENY
  // it. What must differ is the remedy: only the timedOut branch tells you to raise the ceiling.
  expect(m).not.toMatch(/raise it/);
});

test("regenFailureMessage: a CLEAN exit that still failed says the briefing wasn't for today", () => {
  // The fourth event reaching this message: exit 0, complete, but the header date didn't match.
  // Previously rendered as a bare "(generation exit=0)" with no cause at all.
  const m = regenFailureMessage({ code: 0, complete: true, spawned: true, signal: null, timedOut: false }, "");
  expect(m).toContain("no briefing dated today");
});

test("unreadableReposLine: a definite git failure is NOT called transient, and advises fixing config", () => {
  // A deleted path left in config exits nonzero on every run. Reported through degradedReadLine it
  // produced permanent "re-run before recording a row" advice that could never succeed — training the
  // operator to ignore DEGRADED, which then masks the genuine transient case.
  const l = unreadableReposLine(["stale_repo"])!;
  expect(l).toContain("stale_repo");
  // The property is the ADVICE, not the vocabulary. Twice now a word-presence assertion here has been
  // wrong: the line legitimately uses "transient" to DENY it, and "re-running" to say it will NOT
  // help. So pin the semantics — it must steer AWAY from a re-run (which cannot fix a path that no
  // longer exists; that futile loop is what teaches the operator to ignore DEGRADED) and toward the
  // config, and it must not borrow the transient line's instruction.
  expect(l).toMatch(/will not help|does not help|won't help/i);
  expect(l).not.toMatch(/re-run before recording/i);
  expect(l).toMatch(/config/i);
  expect(l).not.toContain("READ DEGRADED");   // and it must not masquerade as the transient line
  expect(unreadableReposLine([])).toBeNull();
});

test("degradedReadLine speaks only of TRUNCATED reads, and says it is transient", () => {
  const l = degradedReadLine(["personal_code"])!;
  expect(l).toMatch(/truncat/i);
  expect(l).toMatch(/transient/i);
  expect(l).toMatch(/lower bound/i);
});

test("groundTruthUnavailableLine: says the silence means nothing, and includes the cause", () => {
  // The report's most confident output was reachable from its least: a throw made every derived check
  // vacuously empty, so it printed "clean: … no same-day miss" with a checkmark row and 0 flags.
  const l = groundTruthUnavailableLine(new Error("EPERM reading /Users/x/repo"));
  expect(l).toContain("did NOT run");
  expect(l).toContain("EPERM");
  expect(l).toMatch(/INCOMPLETE/);
  expect(l).toMatch(/do not record/i);
});

test("groundingVerdict: a DEFINITIVELY unreadable repo also blocks the fabrication verdict", () => {
  // Caught by end-to-end fault injection, not by review: it is tempting to argue that a repo git
  // cannot read at all could hold no citations, "because the app reads the same repos with the same
  // git". That reasoning assumes SIMULTANEITY and is false — the briefing was generated earlier, when
  // the repo was readable, so its citations are real but now unverifiable. Both kinds of blindness
  // must reach UNKNOWN; only the remedy offered to the operator differs.
  const v = groundingVerdict({ citedCount: 9, unresolved: ["670a475"], verified: true, degradedRepos: ["stale_repo"] });
  expect(v.ground).toBe("UNKNOWN");
  expect(v.emoji).toBe("?");
  expect(v.line).not.toContain("FABRICATED");
});

test("classifyReadFailure: a TIMEOUT is transient, not a config problem", () => {
  // The case the first classifier got backwards, and the one its comment asserted could not happen.
  // A timeout kill EOFs the pipes (SIGKILL closes fds), so `complete` is true and `exitCode ?? 1`
  // yields a plain 1 — indistinguishable from a definite git failure on `code` alone. Routing it to
  // "fix or remove the config entry" tells the operator to delete a healthy repo over a slow mount.
  expect(classifyReadFailure({ code: 1, complete: true, spawned: true, signal: "SIGKILL", timedOut: true })).toBe("transient");
  expect(classifyReadFailure({ code: 1, complete: true, spawned: true, signal: "SIGKILL", timedOut: false })).toBe("transient");
});

test("classifyReadFailure: a SPAWN failure is a toolchain problem, never 'transient; re-run'", () => {
  // git missing from PATH returns code -1, which the first version read as a truncated read and
  // answered with permanent, un-clearable "re-run" advice — the exact conflation `spawned` exists to
  // prevent, honoured by the regeneration consumer and ignored by the git ones.
  expect(classifyReadFailure({ code: -1, complete: false, spawned: false, signal: null, timedOut: false })).toBe("toolchain");
});

test("classifyReadFailure: a truncated read is transient, a definite nonzero exit is a repo problem", () => {
  expect(classifyReadFailure({ code: -1, complete: false, spawned: true, signal: null, timedOut: false })).toBe("transient");
  expect(classifyReadFailure({ code: 128, complete: true, spawned: true, signal: null, timedOut: false })).toBe("repo");
});

test("the extractor's phase-2 partial-failure warning still matches the audit's pattern (anti-drift)", async () => {
  // The audit recognises that repo by parsing this warning, because the extractor emits NO PathIssue
  // for a generic phase-2 failure. Nothing about editing extractor.ts would otherwise prompt updating
  // the audit, so pin it against the real source — the mechanism test/posture.test.ts already uses.
  const src = await Bun.file(new URL("../src/extractor.ts", import.meta.url)).text();
  expect(src).toContain("partial failure reading repo: ${repo}");
  // …and the audit's regex must actually match what that template produces.
  expect("partial failure reading repo: /Users/me/dev/thing".match(/^partial failure reading repo: (.+)$/)?.[1])
    .toBe("/Users/me/dev/thing");
});

test("gitUnavailableLine: says the audit verified NOTHING, and is null when git was fine", () => {
  const l = gitUnavailableLine("Error: ENOENT: no such file or directory, posix_spawn 'git'")!;
  expect(l).toContain("GIT UNAVAILABLE");
  expect(l).toContain("ENOENT");
  expect(l).toMatch(/verified nothing/i);
  expect(gitUnavailableLine("")).toBeNull();
});

// --- wiring pins for scripts/audit.ts (F2 round 5) -----------------------------------------------
// MEASURED by the re-review: every round-3/4 fix to `main()` could be DELETED with all 655 tests
// green — the clean-suppression push, the shaBlind narrowing, the warnings loop, the classifier calls.
// The pure functions are well pinned; the ORCHESTRATION that decides what the report actually says
// was not, and that orchestration is where three of the four HIGHs lived.
//
// `scripts/audit.ts` ends in a bare `main().catch(...)`, so it cannot be imported and executed. Pin it
// by SOURCE SCAN — exactly what test/posture.test.ts does to `harden.ts`/`provider.ts`, and what the
// spawn-options assertion in test/proc.incomplete-read.test.ts does for the same "removable with a
// green suite" reason. A source scan is coarse, but its failure mode (a rename breaks the test) is
// loud, whereas the failure mode it replaces is a silently confident wrong audit.
const AUDIT_SRC = await Bun.file(new URL("../scripts/audit.ts", import.meta.url)).text();

test("degradationLines: a ground-truth THROW produces a line (so \"clean:\" is suppressed)", () => {
  // Round 3's HIGH, now pinned BEHAVIOURALLY. The source-scan version of this test was measured as
  // NOT load-bearing: deleting the push left it green, silently restoring the confident-clean report.
  // That is why the assembly moved into this importable function.
  const l = degradationLines({ groundingLine: null, groundTruthErr: new Error("EPERM"), truncated: [], access: [], unreadable: [], toolchainDetail: [] });
  expect(l.length).toBe(1);
  expect(l[0]).toContain("GROUND TRUTH UNAVAILABLE");
});

test("degradationLines: a healthy run produces NOTHING, so the clean line may print", () => {
  // The other direction, and the one that keeps the fix honest: if this ever returned a line
  // unconditionally, every audit would read as degraded and the signal would be worthless.
  expect(degradationLines({ groundingLine: null, groundTruthErr: null, truncated: [], access: [], unreadable: [], toolchainDetail: [] })).toEqual([]);
});

test("degradationLines: one repo never gets TWO contradictory remedies", () => {
  // Measured in this deployment's own flagship scenario: a TCC-denied repo reaches the extractor as
  // `tcc-denied` AND makes the audit's own `git -C repo …` exit 128 (a config-shaped answer), so the
  // report printed BOTH "grant Full Disk Access" and "fix or remove the config entry" for it.
  const l = degradationLines({ groundingLine: null, groundTruthErr: null, truncated: [], access: ["repo"], unreadable: ["repo"], toolchainDetail: [] });
  expect(l.length).toBe(1);
  expect(l[0]).toContain("ACCESS DENIED");
  expect(l.join(" ")).not.toContain("REPO UNREADABLE");
});

test("degradationLines: a truncated repo outranks both other kinds for the same repo", () => {
  // Transient wins: re-running is the cheapest correct advice, and a repo that IS readable must never
  // be described as a permissions or config problem.
  const l = degradationLines({ groundingLine: null, groundTruthErr: null, truncated: ["repo"], access: ["repo"], unreadable: ["repo"], toolchainDetail: [] });
  expect(l.length).toBe(1);
  expect(l[0]).toContain("READ DEGRADED");
});

test("degradationLines: each distinct kind gets its own line, in report order", () => {
  const l = degradationLines({
    groundTruthErr: new Error("boom"), groundingLine: null, truncated: ["t"], access: ["a"], unreadable: ["u"],
    unknown: ["k"], toolchainDetail: ["Error: ENOENT git"],
  });
  expect(l.map((x) => x.split(":")[0])).toEqual([
    "GROUND TRUTH UNAVAILABLE", "READ DEGRADED (truncated read)", "ACCESS DENIED", "REPO UNREADABLE",
    "READ FAILED (cause unknown)", "GIT UNAVAILABLE",
  ]);
});

test("bucketFailures: routes each kind to its own bucket", () => {
  // Replaces an inline ternary at two call sites; a measured mutation swapping two of its arms used to
  // leave the whole suite green while re-introducing "delete your healthy repo" advice for a timeout.
  const b = bucketFailures([
    { repo: "t", kind: "transient" }, { repo: "r", kind: "repo" }, { repo: "g", kind: "toolchain" },
  ]);
  expect(b).toEqual({ transient: ["t"], repo: ["r"], toolchain: ["g"] });
});

test("wiring: main() passes the REAL verdict emoji to evalRow, and builds no row inline", () => {
  // The one fact a pure test cannot reach: `evalRow` is correct, but main() could still hand it a
  // literal. MEASURED — `emoji: evalGround` -> `emoji: "✅"` left all 677 tests green while writing a
  // clean verdict into the record for a degraded run. Narrow, exact, and load-bearing for deletion.
  expect(AUDIT_SRC).toMatch(/emoji: evalGround,/);
  expect(AUDIT_SRC).toMatch(/evalRow\(\{/);
  // …and the row must not be re-inlined around it, which would bypass the filtered buckets.
  expect(AUDIT_SRC).not.toMatch(/`\| … \| \$\{bDate\}/);
});

test("wiring: main() actually spreads degradationLines into `deterministic`", () => {
  // The one wiring fact a pure test cannot cover: that the report CALLS this. Kept as a source scan
  // (scripts/audit.ts ends in a bare `main().catch` and cannot be imported), but now it is the ONLY
  // thing resting on a scan — the behaviour it guards is pinned above.
  expect(AUDIT_SRC).toMatch(/deterministic\.push\(\.\.\.degradationLines\(/);
});

test("wiring: the grounding verdict is fed shaBlind, which collectDegradation derives from cat-file alone", () => {
  // The merge this used to scan for is gone — `collectDegradation` owns it now, and the behavioural
  // test above pins that shaBlind excludes extractor- and day-derived blindness. What remains scannable
  // is only that main() feeds the verdict from that field and does not rebuild it inline.
  expect(AUDIT_SRC).toMatch(/const shaBlind = deg\.shaBlind;/);
  expect(AUDIT_SRC).toMatch(/groundingVerdict\(\{[^}]*degradedRepos:\s*shaBlind/);
});

test("wiring: BOTH git call sites classify from the whole outcome, not from `code`", () => {
  // Round 4's MEDIUMs. Reverting either call site to `code === -1 ? … : …` silently restores the
  // "delete your healthy repo" advice for a timeout and "re-run forever" for a missing binary.
  expect(AUDIT_SRC.match(/classifyReadFailure\(res\)/g)?.length).toBe(2);
  expect(AUDIT_SRC).not.toMatch(/code === -1 \? truncated/);
});

test("wiring: the degradation helpers are no longer called from the script at all", () => {
  // Superseded by the behavioural tests above. Kept, inverted, as a REGRESSION pin: these helpers must
  // stay behind `degradationLines`, because the moment one is called directly from the unimportable
  // script again, its cross-bucket filtering and ordering stop being covered by anything.
  for (const fn of ["degradedReadLine", "unreadableReposLine", "accessDeniedLine", "gitUnavailableLine"]) {
    expect(AUDIT_SRC).not.toMatch(new RegExp(`[^a-zA-Z]${fn}\\(`));
  }
});

test("bucketPathIssues: a TCC denial is an access problem, never 'transient; re-run'", () => {
  // Concretely reachable here: these repos live under ~/Desktop, a TCC-protected root, so an
  // unentitled binary would print "transient, re-run" for every repo every day — the exact
  // operator-training failure the transient/persistent split exists to prevent.
  const b = bucketPathIssues([{ path: "/Users/me/Desktop/repo", kind: "tcc-denied" }], []);
  expect(b.access).toEqual(["/Users/me/Desktop/repo"]);
  expect(b.transient).toEqual([]);
});

test("bucketPathIssues: `unreadable` splits on the warning — incomplete read vs persistent EPERM", () => {
  // The kind alone cannot separate these: the extractor emits `unreadable` BOTH for an
  // IncompleteReadError and, via classify(), for EPERM. Only the warning text distinguishes them.
  const transient = bucketPathIssues(
    [{ path: "/r", kind: "unreadable" }],
    ["partial read of /r: git's output could not be read to completion — a child process is holding the pipe"],
  );
  expect(transient.transient).toEqual(["/r"]);
  expect(transient.access).toEqual([]);

  const persistent = bucketPathIssues([{ path: "/r", kind: "unreadable" }], ["skipped repo (unreadable): /r"]);
  expect(persistent.access).toEqual(["/r"]);
  expect(persistent.transient).toEqual([]);
});

test("bucketPathIssues: a PHASE-1 incomplete read is transient too, not an access problem", () => {
  // The first version matched only phase 2's "partial read of X:" wording, so phase 1's "skipped X:"
  // — the SAME transient event, a held pipe during `git config`/`git log` — fell through to `access`
  // and was reported as a permanent permissions problem advising a Full Disk Access grant. The exact
  // inverse of the truth. Keyed on the clause both templates share.
  const b = bucketPathIssues(
    [{ path: "/r", kind: "unreadable" }],
    ["skipped /r: git's output could not be read to completion, so its history is not trustworthy — a child process is holding git's output pipe open"],
  );
  expect(b.transient).toEqual(["/r"]);
  expect(b.access).toEqual([]);
});

test("both extractor incomplete-read templates still match the audit's pattern (anti-drift)", async () => {
  // Same mechanism as the phase-2 warning pin: nothing about editing extractor.ts would prompt
  // updating this regex, and getting it wrong inverts the advice rather than merely losing it.
  const src = await Bun.file(new URL("../src/extractor.ts", import.meta.url)).text();
  expect(src).toContain("partial read of ${repo}: git's output could not be read to completion");
  expect(src).toContain("skipped ${repo}: git's output could not be read to completion");
  const re = /^(?:partial read of|skipped) (.+?): git's output could not be read to completion/;
  expect("partial read of /a: git's output could not be read to completion — x".match(re)?.[1]).toBe("/a");
  expect("skipped /b: git's output could not be read to completion, so its history is not trustworthy — x".match(re)?.[1]).toBe("/b");
});

test("bucketPathIssues: the git-probe sentinel is a TOOLCHAIN fact, not a repo with bad permissions", () => {
  // `{path: "git"}` is the extractor's probe sentinel, not a repo. In the access bucket it printed
  // "ACCESS DENIED: could not read git … grant Full Disk Access" right above the correct GIT
  // UNAVAILABLE line — contradictory advice, one half prescribing a TCC grant for a missing binary —
  // and put "git" among the repo names in the grounding verdict.
  const b = bucketPathIssues([{ path: "git", kind: "unreadable" }], ["git isn't runnable (not on PATH, or not installed) — …"]);
  expect(b.toolchain).toEqual(["git"]);
  expect(b.access).toEqual([]);
  expect(b.repo).toEqual([]);
  expect(b.transient).toEqual([]);
});

test("bucketPathIssues: not-found / not-a-repo are config answers", () => {
  const b = bucketPathIssues([{ path: "/gone", kind: "not-found" }, { path: "/plain", kind: "not-a-repo" }], []);
  expect(b.repo.sort()).toEqual(["/gone", "/plain"]);
});

test("accessDeniedLine: names the permission remedy and does NOT advise a re-run", () => {
  const l = accessDeniedLine(["repo"])!;
  expect(l).toMatch(/will not clear it|not a transient/i);
  expect(l).not.toMatch(/re-run before recording/i);
  expect(l).toMatch(/Full Disk Access|permissions/i);
  expect(accessDeniedLine([])).toBeNull();
});


test("degradationLines: the grounding verdict line is emitted by the SAME producer", () => {
  // Its push was the last piece of this block still inline. MEASURED: deleting
  // `deterministic.push(ground.line)` made the FABRICATED/UNKNOWN line vanish from the report and let
  // the "clean:" fallback print again, with all 672 tests green — the round-2 HIGH, one line away.
  const l = degradationLines({
    groundTruthErr: null, groundingLine: "FABRICATED SHA(s) cited but resolving to no commit in any repo: 2ee140",
    truncated: [], access: [], unreadable: [], toolchainDetail: [],
  });
  expect(l).toEqual(["FABRICATED SHA(s) cited but resolving to no commit in any repo: 2ee140"]);
});

test("evalRow: the verdict emoji is carried through, never hardcoded", () => {
  // MEASURED: replacing `${evalGround}` with a literal ✅ in the row wrote a clean verdict for a
  // degraded or fabricated run with the whole suite green. The row is the RECORD — this is the single
  // most consequential character the tool emits, and it had no pin at all.
  const base = { bDate: "2026-07-26", flagCount: 1, groundTruthFailed: false, truncated: [], access: [],
                 unreadable: [], fabricated: [], shaBlind: false, missedDay: 0, posture: "posture: full" };
  expect(evalRow({ ...base, emoji: "❌" })).toContain("| ❌ |");
  expect(evalRow({ ...base, emoji: "?" })).toContain("| ? |");
  expect(evalRow({ ...base, emoji: "✅" })).toContain("| ✅ |");
  expect(evalRow({ ...base, emoji: "❌" })).not.toContain("✅");
});

test("evalRow: one repo never gets two contradictory diagnoses IN THE RECORD", () => {
  // The body was deduped in round 6; the ROW was not, and it interpolated the RAW sets. A TCC-denied
  // repo (extractor: tcc-denied → access; the audit's own git: exit 128 → unreadable) therefore wrote
  // "access-denied: repo; unreadable: repo" into EVAL.md while the body correctly printed one line.
  const r = evalRow({ bDate: "d", emoji: "?", flagCount: 1, groundTruthFailed: false,
    truncated: [], access: ["repo"], unreadable: ["repo"], fabricated: [], shaBlind: true,
    missedDay: 0, posture: "p" });
  expect(r).toContain("access-denied: repo");
  expect(r).not.toContain("unreadable: repo");
});

test("evalRow: never records FABRICATED while blind, and does record it when fully read", () => {
  const blind = evalRow({ bDate: "d", emoji: "?", flagCount: 1, groundTruthFailed: false, truncated: ["t"],
    access: [], unreadable: [], fabricated: ["2ee140"], shaBlind: true, missedDay: 0, posture: "p" });
  expect(blind).not.toContain("fabricated");

  const seeing = evalRow({ bDate: "d", emoji: "❌", flagCount: 1, groundTruthFailed: false, truncated: [],
    access: [], unreadable: [], fabricated: ["2ee140"], shaBlind: false, missedDay: 0, posture: "p" });
  expect(seeing).toContain("fabricated 2ee140");
});

test("evalRow: a healthy run records no degradation markers at all", () => {
  const r = evalRow({ bDate: "2026-07-26", emoji: "✅", flagCount: 0, groundTruthFailed: false, truncated: [],
    access: [], unreadable: [], fabricated: [], shaBlind: false, missedDay: 0, posture: "posture: full" });
  expect(r).toBe("| … | 2026-07-26 | ✅ | ? |  |  | auto-audit: 0 flag(s); posture: full |");
});

// --- collectDegradation: the report's INPUTS, pinned like its output ----------------------------
// This function exists because a review measured the input wiring as the last unpinned surface, and
// then the cost arrived empirically: `truncated: allTruncated` -> `truncated: []` survived the full
// suite AND reached a commit, restoring the round-2 HIGH. Every test below kills a mutation that
// previously passed green.
const BN = (p: string) => p.split("/").pop()!;   // stand-in for repoLabel in tests that need no disambiguation
const NO_DAY = { transient: [], repo: [], toolchainDetail: [] };
const NO_SHA = { transient: [], repo: [], toolchain: [], toolchainDetail: [] };

test("collectDegradation: a truncated read from ANY source reaches the truncated bucket", () => {
  // The mutation that was accidentally committed dropped exactly this path.
  const fromDay = collectDegradation({ extractorIssues: [], extractorWarnings: [], day: { ...NO_DAY, transient: ["d"] }, sha: NO_SHA });
  expect(fromDay.truncated).toEqual(["d"]);

  const fromSha = collectDegradation({ extractorIssues: [], extractorWarnings: [], day: NO_DAY, sha: { ...NO_SHA, transient: ["s"] } });
  expect(fromSha.truncated).toEqual(["s"]);

  const fromIssue = collectDegradation({
    extractorIssues: [{ path: "/x/e", kind: "unreadable" }],
    extractorWarnings: ["skipped /x/e: git's output could not be read to completion — held pipe"],
    day: NO_DAY, sha: NO_SHA,
  });
  expect(fromIssue.truncated).toEqual(["/x/e"]);
});

test("collectDegradation: the phase-2 warning-only failure is UNKNOWN, not asserted as truncated", () => {
  // Deleting the warnings loop was one of the mutations measured surviving — that repo's working state
  // goes unread, so coverageGaps is vacuous for it and "all working-state repos named" can print. But
  // it must not be filed as `truncated` either: the warning is raised by a plain nonzero git exit
  // (a corrupt index, say), which is typically PERSISTENT, so "truncated read … Transient; re-run"
  // asserted the wrong cause AND the wrong remedy in the section headed "code — reliable".
  const d = collectDegradation({
    extractorIssues: [], extractorWarnings: ["partial failure reading repo: /Users/me/dev/thing"],
    day: NO_DAY, sha: NO_SHA,
  });
  expect(d.unknown).toEqual(["/Users/me/dev/thing"]);
  expect(d.truncated).toEqual([]);
});

test("collectDegradation + degradationLines: distinct repos survive a NON-INJECTIVE label", () => {
  // Round 9 labelled inside collectDegradation, so the cross-bucket filter compared LABELS. But
  // `repoLabel` qualifies with exactly one parent segment and is NOT injective: `/u/a/x/api` and
  // `/u/b/x/api` both render `x/api`. The truncated-wins rule then deleted the permanent failure's
  // diagnosis — byte-for-byte the bug round 9 existed to fix, one directory deeper. Filtering now
  // happens on FULL PATHS and the label is applied only at render, so a collision can at worst make
  // two lines read alike; it can never delete one.
  const collide = (_p: string) => "x/api";   // maximally non-injective, on purpose
  const d = collectDegradation({
    extractorIssues: [], extractorWarnings: [],
    day: NO_DAY, sha: { ...NO_SHA, transient: ["/u/a/x/api"], repo: ["/u/b/x/api"] },
  });
  expect(d.truncated).toEqual(["/u/a/x/api"]);
  expect(d.unreadable).toEqual(["/u/b/x/api"]);
  const lines = degradationLines({ groundTruthErr: null, groundingLine: null, label: collide, ...d });
  // BOTH diagnoses survive — the transient one AND the permanent one.
  expect(lines.some((l) => l.includes("READ DEGRADED"))).toBe(true);
  expect(lines.some((l) => l.includes("REPO UNREADABLE"))).toBe(true);
});

test("evalRow: a non-injective label cannot delete a diagnosis from the RECORD either", () => {
  const r = evalRow({ bDate: "d", emoji: "?", flagCount: 2, groundTruthFailed: false,
    truncated: ["/u/a/x/api"], access: [], unreadable: ["/u/b/x/api"], fabricated: [], shaBlind: true,
    missedDay: 0, posture: "p", label: (_p) => "x/api" });
  expect(r).toContain("DEGRADED (truncated: x/api)");
  expect(r).toContain("unreadable: x/api");
});

test("collectDegradation: shaBlind is cat-file-derived ONLY", () => {
  // Extractor- or day-derived blindness must not gate the fabrication verdict: a `git log` timeout
  // says nothing about whether cat-file could resolve a SHA.
  const d = collectDegradation({
    extractorIssues: [{ path: "/x/tcc", kind: "tcc-denied" }], extractorWarnings: [],
    day: { ...NO_DAY, transient: ["dayrepo"] },
    sha: { ...NO_SHA, transient: ["shaA"], repo: ["shaB"], toolchain: ["shaC"] },
    
  });
  expect(d.shaBlind.sort()).toEqual(["shaA", "shaB", "shaC"]);
  expect(d.shaBlind).not.toContain("dayrepo");
  expect(d.shaBlind).not.toContain("/x/tcc");
});

test("collectDegradation: the git-probe sentinel becomes toolchain detail, not a repo", () => {
  const d = collectDegradation({
    extractorIssues: [{ path: "git", kind: "unreadable" }],
    extractorWarnings: ["git isn't runnable (not on PATH, or not installed) — install git"],
    day: NO_DAY, sha: NO_SHA,
  });
  expect(d.toolchainDetail.join(" ")).toContain("isn't runnable");
  expect(d.access).toEqual([]);
  expect(d.unreadable).toEqual([]);
  expect(d.truncated).toEqual([]);
});

test("collectDegradation: a healthy run yields entirely empty buckets", () => {
  // If this ever returned anything, every audit would read as degraded and the signal would die.
  const d = collectDegradation({ extractorIssues: [], extractorWarnings: [], day: NO_DAY, sha: NO_SHA });
  expect(d).toEqual({ truncated: [], access: [], unreadable: [], unknown: [], toolchainDetail: [], shaBlind: [] });
});

test("wiring: main() labels degraded repos with repoLabel, not bare basename", () => {
  // The only fact a pure test cannot reach here: `collectDegradation` applies whatever label fn it is
  // given, so main() could still hand it `basename` and re-merge two same-basename repos into one
  // identity. MEASURED as surviving until this pin existed.
  expect(AUDIT_SRC).toMatch(/const label = \(p: string\) => repoLabel\(p, repos\);/);
  // …and it must be handed to BOTH renderers, since each formats repo names independently.
  expect(AUDIT_SRC).toMatch(/degradationLines\(\{ groundTruthErr, groundingLine: ground\.line, label,/);
  expect(AUDIT_SRC).toMatch(/\.\.\.deg, label,/);
});

test("wiring: main() builds its degradation inputs ONLY via collectDegradation", () => {
  // The last scan-covered fact. Narrow and load-bearing: the inline merges it replaced are exactly
  // where the accidentally-committed mutation lived.
  expect(AUDIT_SRC).toMatch(/const deg = collectDegradation\(\{ extractorIssues, extractorWarnings, day: dayBuckets, sha \}\);/);
  expect(AUDIT_SRC).toMatch(/degradationLines\(\{ groundTruthErr, groundingLine: ground\.line, label, \.\.\.deg \}\)/);
  expect(AUDIT_SRC).not.toMatch(/const allTruncated =/);   // the inline merge must not come back
});


test("evalRow: a proven fabrication is still listed when the GROUND TRUTH failed", () => {
  // A ground-truth throw does not blind cat-file. Gating the fabricated list on it made the row
  // contradict the body AND its own emoji: groundingVerdict returns ❌ FAIL, the body printed the
  // SHAs, and the row showed a bare ❌ with the list suppressed beside a DEGRADED marker that invites
  // the transcriber to discount it. Only `shaBlind` may gate this.
  const r = evalRow({ bDate: "d", emoji: "❌", flagCount: 2, groundTruthFailed: true, truncated: [],
    access: [], unreadable: [], fabricated: ["deadbee"], shaBlind: false, missedDay: 0, posture: "p" });
  expect(r).toContain("fabricated deadbee");
  expect(r).toContain("DEGRADED (ground truth unavailable)");
});

test("evalRow: a run that verified NOTHING is marked in the record", () => {
  // GIT UNAVAILABLE was the only degradation class with no row marker — the strongest one. Its row was
  // indistinguishable from a mild healthy no-citations row.
  const r = evalRow({ bDate: "d", emoji: "?", flagCount: 1, groundTruthFailed: false, truncated: [],
    access: [], unreadable: [], toolchainDetail: ["Error: ENOENT git"], fabricated: [], shaBlind: false,
    missedDay: 0, posture: "p" });
  expect(r).toContain("DEGRADED (git unavailable)");
});

test("unknownFailureLine: claims neither truncation nor transience", () => {
  const l = unknownFailureLine(["thing"])!;
  expect(l).toContain("cause unknown");
  expect(l).toMatch(/may or may not/i);
  expect(l).not.toMatch(/truncated read/i);
  expect(unknownFailureLine([])).toBeNull();
});

// --- pinning the surfaces the last two rounds CLAIMED to pin but did not ------------------------
// Each test below kills a mutation measured surviving the full 684-test suite. The pattern is now
// established: extracting a pure function makes behaviour testable, but only tests that assert the
// specific field actually pin it — "the inputs are pinned like the output" was false for the legs
// nobody asserted.

test("collectDegradation: the ACCESS leg is carried through", () => {
  // Mutation `access: []` survived everything. Consequence in the deployment's flagship scenario: a
  // TCC-denied repo under ~/Desktop loses its ACCESS DENIED diagnosis and — because its own `git -C`
  // exits 128 → day.repo — is told to "fix or remove the config entry" for a PERMISSIONS problem.
  // That is the exact remedy-inversion rounds 5 and 7 fixed, reachable again through an unpinned leg.
  const d = collectDegradation({
    extractorIssues: [{ path: "/x/tcc", kind: "tcc-denied" }], extractorWarnings: [],
    day: NO_DAY, sha: NO_SHA,
  });
  expect(d.access).toEqual(["/x/tcc"]);
});

test("collectDegradation: the UNREADABLE leg is carried through from every source", () => {
  const d = collectDegradation({
    extractorIssues: [{ path: "/x/gone", kind: "not-found" }], extractorWarnings: [],
    day: { ...NO_DAY, repo: ["/x/dayrepo"] }, sha: { ...NO_SHA, repo: ["/x/sharepo"] },
  });
  expect(d.unreadable.sort()).toEqual(["/x/dayrepo", "/x/gone", "/x/sharepo"]);
});

test("evalRow: EVERY degradation marker reaches the Notes cell", () => {
  // Each of these was individually removable with the whole suite green. The worst was the
  // ground-truth marker: extractor throws, cat-file reads clean, and the transcribed record became
  // `| ✅ | … auto-audit: 1 flag(s)` for a run whose body says "Do not record a row from it."
  const gt = evalRow({ bDate: "d", emoji: "?", flagCount: 1, groundTruthFailed: true, truncated: [],
    access: [], unreadable: [], fabricated: [], shaBlind: false, missedDay: 0, posture: "p" });
  expect(gt).toContain("DEGRADED (ground truth unavailable)");

  const tr = evalRow({ bDate: "d", emoji: "?", flagCount: 1, groundTruthFailed: false, truncated: ["t"],
    access: [], unreadable: [], fabricated: [], shaBlind: false, missedDay: 0, posture: "p" });
  expect(tr).toContain("DEGRADED (truncated: t)");

  const ac = evalRow({ bDate: "d", emoji: "?", flagCount: 1, groundTruthFailed: false, truncated: [],
    access: ["a"], unreadable: [], fabricated: [], shaBlind: false, missedDay: 0, posture: "p" });
  expect(ac).toContain("access-denied: a");

  const un = evalRow({ bDate: "d", emoji: "?", flagCount: 1, groundTruthFailed: false, truncated: [],
    access: [], unreadable: ["u"], fabricated: [], shaBlind: false, missedDay: 0, posture: "p" });
  expect(un).toContain("unreadable: u");

  const uk = evalRow({ bDate: "d", emoji: "?", flagCount: 1, groundTruthFailed: false, truncated: [],
    access: [], unreadable: [], unknown: ["k"], fabricated: [], shaBlind: false, missedDay: 0, posture: "p" });
  expect(uk).toContain("read-failed: k");
});

test("evalRow: the same-day miss count and the flag count are carried, not decorative", () => {
  const r = evalRow({ bDate: "d", emoji: "?", flagCount: 7, groundTruthFailed: false, truncated: [],
    access: [], unreadable: [], fabricated: [], shaBlind: false, missedDay: 3, posture: "p" });
  expect(r).toContain("auto-audit: 7 flag(s)");
  expect(r).toContain("missed 3 same-day");
});

test("wiring: main() feeds collectDegradation the REAL sources, not empty stand-ins", () => {
  // MEASURED: `dayBuckets = { transient: [], … }` survived the full suite — byte-for-byte the shape of
  // the mutation that reached a commit in round 7, one assignment upstream. The round-8 scan matched
  // `collectDegradation({` without inspecting its arguments, so every assignment feeding it stayed
  // freely mutable. Pin the arguments and the assignments, since main() cannot be imported.
  expect(AUDIT_SRC).toMatch(/extractorIssues = issues; extractorWarnings = warnings;/);
  expect(AUDIT_SRC).toMatch(/dayBuckets = \{ transient: d\.transient, repo: d\.repo, toolchainDetail: d\.toolchainDetail \}/);
  expect(AUDIT_SRC).toMatch(/collectDegradation\(\{ extractorIssues, extractorWarnings, day: dayBuckets, sha \}\)/);
});

// --- the last unpinned surfaces (round 10) -----------------------------------------------------
// Four MEDIUMs, each MEASURED surviving the full suite. Three of them are checks whose ABSENCE the
// report would then describe as "clean: all cited SHAs resolve, no same-day miss, all working-state
// repos named" — a confident claim about work the code no longer does. That is the same class every
// round since round 2 has closed for the degradation lines, never extended to the checks themselves.

test("wiring: the INPUTS to each check are real, not empty stand-ins", () => {
  // The tier above round 10's pins. MEASURED: each of these four assignments could be replaced with an
  // empty value while all 703 tests stayed green — and two of them make the report print the confident
  // `clean: all cited SHAs resolve, no same-day miss, all working-state repos named` for checks that
  // never ran, which is this branch's own definition of its costliest defect.
  //
  // Stated plainly rather than claimed as closure, because the last two rounds each said "now pinned"
  // one level below where the gap actually was: THIS tier is pinned, the tier above it (what feeds
  // `briefing`, and the config load) is not. Scan-pinning does not terminate — it only ends at the
  // dependency boundary, which is why the real fix is to inject main()'s dependencies and replace
  // these scans with behaviour. Filed as a follow-up; see the PR description.
  expect(AUDIT_SRC).toMatch(/const cited = extractCitedShas\(briefing\);/);
  expect(AUDIT_SRC).toMatch(/dayShas = d\.shas;/);
  expect(AUDIT_SRC).toMatch(/reposWithState = f\.reposWithState;/);
  // Updated 2026-08-04: informational entries are now excluded from the count, so the pin follows
  // the real expression. The property it guards is unchanged — flagCount must be DERIVED from the
  // deterministic list, never a literal.
  expect(AUDIT_SRC).toMatch(/flagCount: defectCount\(deterministic\),/);
});

test("wiring: the SHA check actually runs — its result is not a stand-in", () => {
  // MEASURED: replacing the `checkShas` call with a healthy empty object (verified: true, empty
  // buckets) survived the whole suite. `groundingVerdict` would then return PASS/✅ unconditionally
  // whenever SHAs are cited — the fabrication check, the audit's headline job, silently deleted.
  expect(AUDIT_SRC).toMatch(/const sha = await checkShas\(cited, repos\)\.catch\(/);
  expect(AUDIT_SRC).toMatch(/groundingVerdict\(\{ citedCount: cited\.length, unresolved, verified,/);
});

test("wiring: the regen acceptance gate still requires a trustworthy read", () => {
  // The CONSUMER half of the original F2 fix. `run()` forces code:-1 on an incomplete stdout, and the
  // SIGKILL case leaves complete:true relying on `?? 1` — so this gate is what stops a truncated
  // regeneration whose partial stdout still carries today's header from being graded as whole.
  // MEASURED: dropping `code === 0 &&` survived, and proc.ts's own tests only COMMENT that the
  // consumers gate on code.
  expect(AUDIT_SRC).toMatch(/if \(code === 0 && headerDate\(gen\) === today\)/);
});

test("wiring: the same-day and uncommitted checks are still performed and reported", () => {
  // MEASURED: emptying `missedDay`, or deleting the UNCOMMITTED-NOT-SURFACED push, each survived —
  // and the report then prints the "clean:" fallback, asserting both checks passed.
  expect(AUDIT_SRC).toMatch(/const missedDay = missingSameDay\(dayShas, briefing\);/);
  expect(AUDIT_SRC).toMatch(/if \(missedDay\.length\) deterministic\.push\(`SAME-DAY BLINDNESS:/);
  expect(AUDIT_SRC).toMatch(/const uncovered = coverageGaps\(reposWithState, briefing\);/);
  expect(AUDIT_SRC).toMatch(/if \(uncovered\.length\) deterministic\.push\(`UNCOMMITTED NOT SURFACED:/);
});

test("wiring: the judge's ground truth and the FYI line disambiguate same-basename repos", () => {
  // Round 9 fixed this identity class for the degradation buckets only. Two configured `/a/api` and
  // `/b/api` otherwise render identical `### api` headers in the section the judge is TOLD is ground
  // truth, and indistinguishable `api: <sha>` entries in the deterministic FYI line.
  expect(AUDIT_SRC).toMatch(/blocks\.push\(`### \$\{r\} — \$\{lines\.length\}/);
  expect(AUDIT_SRC).toMatch(/postGen\.push\(\.\.\.postGeneration\.map\(\(l\) => `\$\{repoLabel\(r, repos\)\}: \$\{l\}`\)\)/);
  expect(AUDIT_SRC).toMatch(/degradedRepos: shaBlind\.map\(label\)/);
});

test("degradationBuckets: `unknown` yields to every diagnosis we can actually name", () => {
  // MEASURED: removing this filter survived. A corrupt repo raises the extractor's "partial failure"
  // (→ unknown) AND fails the audit's own `git log` (→ unreadable), so the report and the row would
  // carry two contradictory diagnoses for it — the dual-remedy defect rounds 6 and 9 fixed for the
  // other bucket pairs, re-opened in the bucket round 9 added.
  const b = degradationBuckets({ truncated: [], access: [], unreadable: ["x"], unknown: ["x"] });
  expect(b.unreadable).toEqual(["x"]);
  expect(b.unknown).toEqual([]);
  expect(degradationBuckets({ truncated: ["y"], access: [], unreadable: [], unknown: ["y"] }).unknown).toEqual([]);
  expect(degradationBuckets({ truncated: [], access: ["z"], unreadable: [], unknown: ["z"] }).unknown).toEqual([]);
  // …but a repo known ONLY by the unknown route keeps its line.
  expect(degradationBuckets({ truncated: [], access: [], unreadable: [], unknown: ["k"] }).unknown).toEqual(["k"]);
});

test("collectDegradation: toolchain detail is carried from the day and sha legs too", () => {
  // Narrow window (extractor's probe succeeded, our own spawns failed) but it is the one that makes
  // GIT UNAVAILABLE and its row marker vanish entirely.
  const d = collectDegradation({
    extractorIssues: [], extractorWarnings: [],
    day: { ...NO_DAY, toolchainDetail: ["day: ENOENT"] },
    sha: { ...NO_SHA, toolchainDetail: ["sha: ENOENT"] },
  });
  expect(d.toolchainDetail.sort()).toEqual(["day: ENOENT", "sha: ENOENT"]);
});

test("the extractor's git-probe warning prefix still matches what the audit filters on (anti-drift)", async () => {
  // The three repo-path templates get source pins; this one did not, so a rewording of the probe's
  // warnings would silently empty `toolchainDetail` on the sentinel path.
  const src = await Bun.file(new URL("../src/extractor.ts", import.meta.url)).text();
  expect(src).toMatch(/"git isn't runnable/);
  expect(src).toMatch(/`git ran but its output could not be read/);
  // The filter lives in src/audit.ts (collectDegradation), not the script — scanning the script for it
  // was my own error, and a test that looks in the wrong file guards nothing.
  const auditSrc = await Bun.file(new URL("../src/audit.ts", import.meta.url)).text();
  expect(auditSrc).toMatch(/startsWith\("git "\)/);
});

test("evalRow: the label is applied to the Notes buckets, not ignored", () => {
  const r = evalRow({ bDate: "d", emoji: "?", flagCount: 1, groundTruthFailed: false,
    truncated: ["/deep/nested/path/repo"], access: [], unreadable: [], fabricated: [], shaBlind: true,
    missedDay: 0, posture: "p", label: (p) => `LBL(${p.split("/").pop()})` });
  expect(r).toContain("DEGRADED (truncated: LBL(repo))");
  expect(r).not.toContain("/deep/nested");
});


test("missingSameDay: a SHA prefix embedded mid-hash is NOT counted as cited", () => {
  // The bounded-prefix property its own doc comment claims ("not a coincidental mid-hash substring")
  // and nothing pinned: MEASURED, replacing the boundary assertion with a plain `includes()` survived
  // the full suite. False-negative direction only (a real miss goes unreported), but an untested
  // property asserted in a comment is the shape this branch keeps finding.
  const day = ["abc1234def"];
  // "abc1234" appears, but only INSIDE a longer hex run — not a citation of this commit.
  expect(missingSameDay(day, "see 99abc1234ff for context")).toEqual(["abc1234def"]);
  // …and a genuine citation still clears it.
  expect(missingSameDay(day, "landed abc1234 today")).toEqual([]);
});

// ---- D4a: the shared-evidence invariant between the two renderers ----
// The prompt (generator.activityLine) and the judge's ground truth (audit.factsFromActivities) must
// show the model and the judge the SAME evidence. The code calls this "byte-parity" at
// generator.ts:182, but the two lines are NOT byte-identical (different prefix, different SHA
// formatting) — the invariant is that the FILE SET and now the DATE agree. Only the prompt side was
// pinned before this (generator.test.ts, the 8-file cap test); nothing compared the two.
test("D4a: activityLine and factsFromActivities emit the SAME date and the SAME file set", () => {
  // TEN files, deliberately over the 8-file cap. With a 2-file fixture the cap is never exercised,
  // and the renderers can silently drift on it while this test still passes — measured: changing the
  // audit side to slice(0,3) left the whole suite green. The cap IS the invariant this test names.
  const files = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
  const a: Activity = {
    source: "git", kind: "commit", event_id: "abc1234def", repo: "/r", text: "subject",
    timestamp: "2026-07-29T22:25:47-07:00",
    meta: { diffstat: files.map((f) => ({ file: f, added: 1, removed: 0 })) },
  };
  const units: Unit[] = [{ repo: "/r", root: "", label: "r", hasResumptionState: false, hasWindowContent: true, resumptionNote: "", dirtyFiles: [], latestCommitTime: null }];
  const promptLine = activityLine(a);
  const judgeText = factsFromActivities([a], units, ["/r"]).text;
  // Same committer-local date on both sides — and specifically NOT the UTC roll-forward.
  expect(promptLine).toContain("2026-07-29");
  expect(judgeText).toContain("2026-07-29");
  expect(promptLine).not.toContain("2026-07-30");
  expect(judgeText).not.toContain("2026-07-30");
  // Compare the shared evidence tail DIRECTLY — first 8 files, the same overflow marker, same date.
  const tail = ` — files: ${files.slice(0, 8).join(", ")} (+2 more) — 2026-07-29`;
  expect(promptLine.endsWith(tail)).toBe(true);
  expect(judgeText.includes(tail)).toBe(true);
  // The 2 capped-off files must appear on NEITHER side.
  for (const f of ["f8.ts", "f9.ts"]) {
    expect(promptLine).not.toContain(f);
    expect(judgeText).not.toContain(f);
  }
});
test("D4a: the local-date rule holds at a POSITIVE offset too (TZ-proof guard)", () => {
  // Every other fixture uses -07:00, which happens to equal this machine's zone — so a mutation to
  // localDateStr(new Date(...)) (the machine-local convention audit.ts:48 uses on purpose) survives
  // locally and only fails under TZ=UTC. A positive offset closes that: no single machine zone can
  // satisfy both, so the guard no longer depends on where it runs.
  const a: Activity = { source: "git", kind: "commit", event_id: "abc1234", repo: "/r", text: "tokyo", timestamp: "2026-07-30T08:00:00+09:00" };
  expect(activityLine(a)).toContain("— 2026-07-30"); // committer-local, NOT the 2026-07-29 UTC date
  expect(activityLine(a)).not.toContain("2026-07-29");
});
test("D4a: factsFromActivities degrades silently when a commit has no timestamp", () => {
  const a: Activity = { source: "git", kind: "commit", event_id: "abc1234", repo: "/r", text: "subject" };
  const units: Unit[] = [{ repo: "/r", root: "", label: "r", hasResumptionState: false, hasWindowContent: true, resumptionNote: "", dirtyFiles: [], latestCommitTime: null }];
  expect(() => factsFromActivities([a], units, ["/r"])).not.toThrow();
  expect(factsFromActivities([a], units, ["/r"]).text).toContain("abc1234 subject");
});

// ---- D6-lite: the judge must stop treating a SHORTER suggestion list as a defect ----
// The change is ADDITIVE. rev 3 of the spec tried to REPLACE the over-suppression sentence with a
// two-category rubric, and day-18 #3 ("you may want to confirm … is covered") fell outside both —
// blinding the very instrument that grades this work. So the original sentence stays verbatim and
// only the carve-out is added.
test("buildAuditPrompt: keeps the vacuity mandate AND adds the shorter-list carve-out (D6-lite)", () => {
  const p = buildAuditPrompt({ briefing: "b", gitFacts: "g", popup: null, deterministic: [] });
  expect(p).toMatch(/OVER-SUPPRESSION/);        // unchanged — the judge can still see vacuity
  expect(p).toMatch(/verification-only/);        // unchanged
  expect(p).toMatch(/A SHORTER list is NOT itself a defect/);
});
test("buildAuditPrompt: the carve-out attaches to heading 2 in BOTH popup arms (D6-lite)", () => {
  // The insertion point matters: audit.ts's heading-2 line ENDS with a
  // ${popupConfigured ? "\n3. VS POPUP …" : ""} interpolation. Appending at end-of-line would push
  // the sentence AFTER that, so with --popup it would read as part of heading 3. Popup is off by
  // default, so a green suite would never catch it — hence both arms are asserted.
  for (const popup of [null, "some popup text"]) {
    const p = buildAuditPrompt({ briefing: "b", gitFacts: "g", popup, deterministic: [], popupConfigured: popup !== null } as Parameters<typeof buildAuditPrompt>[0]);
    const carve = p.indexOf("A SHORTER list is NOT itself a defect");
    const vsPopup = p.indexOf("VS POPUP");
    expect(carve).toBeGreaterThan(-1);
    expect(p.slice(0, carve)).toContain("OVER-SUPPRESSION"); // sits after the mandate it qualifies
    if (vsPopup !== -1) expect(carve).toBeLessThan(vsPopup); // …and BEFORE the popup heading
  }
});

// ── "resolvable but unreachable" WIRING (day-16 finding, closed 2026-08-04) ───────────────────────
//
// ⚠ WHY SOURCE-SCAN PINS. `test/audit.unreachable.test.ts` covers the pure function and never
// imports `scripts/audit`, so the whole wiring leg was deletable with a green suite: MEASURED —
// replacing `unreachable: unreachableFromRevList(...)` with `unreachable: []` left 981 pass / 0 fail,
// and separately deleting the entire report block left 981 pass / 0 fail. That is defect class (a)
// ("exists but nothing drives it"), the one this codebase hits most, and the drift half of the same
// branch DID pin its call site while this half did not. These follow the file's existing convention
// (`AUDIT_SRC` matchers, e.g. the `degradationLines` / `evalRow` pins above).
test("the rev-list reachability spawn is WIRED, not just defined", () => {
  expect(AUDIT_SRC).toMatch(/git\(\["-C", r, "rev-list", "--all"\]\)/);
  expect(AUDIT_SRC).toMatch(/reachable\.push\(/);
});

test("checkShas COMPUTES unreachable from the collected refs", () => {
  // Anchored on the call, not just the identifier: `unreachable: []` — the exact mutant that
  // survived — contains the field name but not the call.
  expect(AUDIT_SRC).toMatch(/unreachable: revListBlind\.length \? \[\] : unreachableFromRevList\(cited, unresolved, reachable\)/);
});

test("a PARTIAL rev-list failure suppresses the check instead of accusing", () => {
  // The false-accusation guard: repos have disjoint histories, so one failed rev-list alongside one
  // successful one would report every SHA from the failed repo as orphaned.
  expect(AUDIT_SRC).toMatch(/else revListBlind\.push\(r\);/);
  // …and the blindness is REPORTED, not merely obeyed: silence must not read as "checked, none found".
  expect(AUDIT_SRC).toMatch(/reachability check SKIPPED/);
});

test("the unreachable finding is REPORTED, and framed as NOT fabrication", () => {
  expect(AUDIT_SRC).toMatch(/if \(sha\.unreachable\.length\)/);
  expect(AUDIT_SRC).toMatch(/reachable from NO branch or tag/);
  // The framing is the point of the whole change — orphaned is a durability warning, fabricated is
  // an accusation of hallucination. Losing this phrase means losing the distinction.
  expect(AUDIT_SRC).toMatch(/NOT fabrication/);
});

test("the reachability lines are INFORMATIONAL — excluded from flagCount", () => {
  // ⚠ Both new lines must carry the INFO prefix. Without it they inflate `flagCount` and suppress
  // the "clean:" verdict on exactly the day this feature is meant to help — EVAL.md days 18 and 20
  // already record that instrument nit for the post-generation FYI line; these would make it routine.
  expect(AUDIT_SRC).toMatch(/\$\{INFO\}reachability check SKIPPED/);
  expect(AUDIT_SRC).toMatch(/\$\{INFO\}\$\{sha\.unreachable\.length\} cited SHA\(s\) resolve/);
  expect(AUDIT_SRC).toMatch(/const defectCount = \(lines: string\[\]\) => lines\.filter\(\(l\) => !l\.startsWith\(INFO\)\)\.length;/);
});

test("the rev-list blindness branch is REACHED, not merely present", () => {
  // The two pins above match string LITERALS, which still match when the branch is dead — so
  // `if (false)` survived them. Pin the branch itself.
  expect(AUDIT_SRC).toMatch(/if \(sha\.revListBlind\.length\)/);
});

test("the clean: verdict is gated on DEFECTS, not on total entries", () => {
  // Reverting this to `deterministic.length === 0` survived the suite — and it is precisely the
  // defect the INFO/defectCount split was introduced to fix: an informational-only day would lose
  // its "clean:" line while flagCount correctly read 0, so the report contradicted its own EVAL row.
  expect(AUDIT_SRC).toMatch(/defectCount\(deterministic\) === 0 \? \["- clean:/);
  // …and the two lines that are informational by their own wording carry the prefix.
  expect(AUDIT_SRC).toMatch(/\$\{INFO\}not a miss/);
  expect(AUDIT_SRC).toMatch(/\$\{INFO\}transcript quotations in this briefing/);
});

// ── the EVAL row must not claim a judge that never ran (day 23) ──────────────────────────────────
test("evalRow says JUDGE DID NOT RUN instead of a posture the reader will misread", () => {
  // ⚠ On 2026-08-08 the judge died twice with "out of usage credits" and the suggested row still read
  // `judge posture: full`. `posture` describes the hardening of the ATTEMPTED call — a question
  // adjacent to the one a reader scanning rows is asking. They would have taken that row as judged.
  //
  // SECOND defect of this exact family. The first was `flagCount = deterministic.length`, where an
  // informational line inflated a defect count (days 18/20, fixed in #142).
  const base = {
    bDate: "2026-08-08", emoji: "✅", flagCount: 0, groundTruthFailed: false,
    truncated: [], access: [], unreadable: [], fabricated: [], shaBlind: false,
    missedDay: 0, posture: "judge posture: full",
  };
  const failed = evalRow({ ...base, judgeRan: false });
  expect(failed).toContain("JUDGE DID NOT RUN");
  expect(failed).toContain("Act is unmeasured");
  // REPLACED, not appended: a row carrying both would still let a skimmer read "posture: full".
  expect(failed).not.toContain("judge posture: full");

  // …and a healthy run is untouched, in both the explicit and the absent form.
  expect(evalRow({ ...base, judgeRan: true })).toContain("judge posture: full");
  expect(evalRow(base)).toContain("judge posture: full");
});

test("the judgeRan wiring reads the judge's ACTUAL outcome, not a constant", () => {
  // Source pin: scripts/audit.ts cannot be imported (it runs main()). `judged` is set to
  // "(judge failed: …)" only in the catch, so keying on that prefix is what makes this real.
  expect(AUDIT_SRC).toMatch(/judgeRan: o\.noJudge \? undefined : !judged\.startsWith\("\(judge failed:"\)/);
  expect(AUDIT_SRC).toMatch(/judged = `\(judge failed: \$\{e\}\)`/);
});

// ── the judge gets its own model, and BOTH models are recorded (day 23) ──────────────────────────
test("the judge builds its provider from auditJudgeArgv, appended after provider.argv", () => {
  // ⚠ The judge is the INSTRUMENT; the briefing is what it measures. Sonnet generates, Opus judges —
  // you want the instrument at least as sharp as the thing it grades, and the judge's findings have
  // been this project's sharpest signal (day-21 branch misframing, day-22 self-referential blindness,
  // the suggestion duplication). Appended AFTER provider.argv so a repeated --model wins for the judge.
  expect(AUDIT_SRC).toMatch(/argv: \[\.\.\.cfg\.provider\.argv, \.\.\.cfg\.auditJudgeArgv\]/);
  // Pins what this guard is FOR — the judge gets its own cfg and its own long timeout — without pinning
  // the literal option-object text, which now also carries the account env for failover. An exact-string
  // match here would fail on any additive option and teach the next person to weaken the assertion
  // rather than read it.
  expect(AUDIT_SRC).toMatch(/hardenedProvider\(judgeCfg, \{[^}]*timeoutMs: 240_000/);
});

test("⚠ BOTH models are recorded in the EVAL row — provenance was previously unrecorded entirely", () => {
  // 23 rows existed and NONE named a model. The CLI default was whatever it happened to be that day
  // and could have moved silently, which makes the B4 comparison (day 18 ⚠️ → 19 ✅) unsound in
  // principle: if the model moved in the same window, the prompt cannot be credited. An eval whose
  // independent variable is unrecorded is not measuring what it claims.
  expect(AUDIT_SRC).toMatch(/models: brief=\$\{modelOf\(cfg\.provider\.argv\)\}, judge=\$\{modelOf\(/);
  expect(AUDIT_SRC).toMatch(/posture: `\$\{modelNote\}; \$\{auditPosture\}`/);
  // "cli-default" is the honest label when nothing is pinned — NOT a guessed model name.
  expect(AUDIT_SRC).toContain('"cli-default"');
});

test("⚠ modelOf reads the LAST --model — the judge's argv legitimately carries two", () => {
  // `auditJudgeArgv` is appended to `provider.argv`, so the judge's combined argv is
  // ["-p","--model","sonnet","--model","opus"] and the CLI takes the LAST (VERIFIED: that exact
  // invocation answers "opus"). `indexOf` reported judge=sonnet on 2026-08-09 while Opus was
  // demonstrably running — the provenance field reporting the wrong provenance, on its first live run.
  expect(AUDIT_SRC).toMatch(/const i = argv\.lastIndexOf\("--model"\);/);
  expect(AUDIT_SRC).not.toMatch(/const i = argv\.indexOf\("--model"\);/);
});

// ── Wiring pins for the two freeze-block fixes (added 2026-08-14, after review) ───────────────────
// MEASURED by the review, in a disposable copy: deleting the `branchAxisText(...)` call left the full
// suite BYTE-IDENTICAL (1140 pass / 2 pre-existing fail), and deleting the merges `blocks.push` did
// too. Both defect fixes were removable with a green suite — exactly the class this file's own
// round-5 note describes ("the ORCHESTRATION that decides what the report actually says was not
// [pinned], and that orchestration is where three of the four HIGHs lived"). The pure functions above
// are well covered; these pin that they are CALLED.
test("⚠ defect-A wiring: both merge blocks reach the judge's ground truth", () => {
  expect(AUDIT_SRC).toMatch(/sameDayCommits\(out, bDate, excludeRe, generatedBeforeMs\)/);
  expect(AUDIT_SRC).toMatch(/PR merge\(s\) on \$\{bDate\}/);
  // The SPLIT is the fix, not just the coverage — a single combined block was the reviewed defect.
  expect(AUDIT_SRC).toMatch(/other merge commit\(s\) on \$\{bDate\}/);
  expect(AUDIT_SRC).toMatch(/prMerges/);
  expect(AUDIT_SRC).toMatch(/otherMerges/);
});

test("⚠ defect-B wiring: branchAxisText is called with the BRIEFING and appended to gitFactsText", () => {
  expect(AUDIT_SRC).toMatch(/branchAxisText\(briefing, repos\)/);
  expect(AUDIT_SRC).toMatch(/gitFactsText = \[f\.text, branchAxisText\(briefing, repos\)\]/);
  // The reflog implementation was reviewed out because it answered the wrong question in both
  // directions. If it ever comes back, this fails loudly rather than silently re-shipping the defect.
  // Match the git ARGV, not the word: the comment above the function explains why the reflog
  // approach was removed, and asserting on the bare word made this pin fail on its own rationale.
  expect(AUDIT_SRC).not.toMatch(/"reflog"/);
  // `reposWithState` must be assigned BEFORE the append, so a throw cannot silently empty the
  // UNCOMMITTED-NOT-SURFACED coverage check that `degradedReadLine` promises.
  expect(AUDIT_SRC.indexOf("reposWithState = f.reposWithState;"))
    .toBeLessThan(AUDIT_SRC.indexOf("branchAxisText(briefing, repos)"));
});
