// src/eval/cases.ts — the gold cases run by the eval harness (src/eval/run-case.ts).
//
// Authoring rules (harness-enforced — see run-case.ts's bidirectional integrity asserts):
//   1. ALL in-window commits within a single case MUST share ONE `daysAgo` value >= 1.
//      `windowStart` (src/time.ts) walks back only to the FIRST prior commit-day, so mixing
//      `daysAgo` values >= 1 would silently drop the earlier commit(s) out of window.
//   2. `daysAgo: 0` is allowed and is the SAME-DAY bucket (today / todaySuppress), not the window.
//      Integrity requires those SHAs in today/todaySuppress, not in post-reduce ctx. Needed by G7.
import type { GoldCase } from "./types";

export const GOLD_CASES: GoldCase[] = [
  // day1-fabrication — a commit MESSAGE containing a fake-looking SHA-shaped token
  // ("deadbee1234"). Exercises G2's quoting exemption: echo faithfully re-emits the commit
  // message as the recap bullet's prose, the token doesn't resolve against the real git SHA
  // set, but it IS a substring of the citing bullet's own commit message — so it's exempt, not
  // a fabrication. Single catch-all unit (no subprojectRoots) → expectUnit: null.
  {
    name: "day1-fabrication",
    failureMode:
      "false positive: a SHA-shaped token quoted verbatim from the commit's own message gets misflagged as G2 fabrication instead of recognized as exempt",
    build: {
      commits: [
        {
          files: ["src/legacy/decoy.ts"],
          content: "export const decoy = true;\n",
          daysAgo: 1,
          message: "revert deadbee1234",
          expectUnit: null,
        },
      ],
    },
  },

  // day8-tie — the Day-8 regression guard. A single cross-cutting commit touches EQUAL file
  // counts in two sub-project roots (one file under packages/a, one under packages/b) →
  // unitForCommit's plurality vote ties → catch-all (null), NOT an arbitrary lexicographic pick.
  // With the shipped tie→catch-all fix, echo cites it under the catch-all label and G1
  // attribution passes; a regression that re-buckets it to one of the roots would fail G1.
  {
    name: "day8-tie",
    failureMode:
      "regression: a cross-cutting commit with a tied plurality vote across two roots must bucket to the repo catch-all, not an arbitrary root",
    build: {
      commits: [
        {
          files: ["packages/a/index.ts", "packages/b/index.ts"],
          daysAgo: 1,
          message: "chore: sync shared config across packages",
          expectUnit: null,
        },
      ],
    },
    subprojectRoots: ["packages/a", "packages/b"],
  },

  // nested-root — a nested subproject root (packages/app/plugin under packages/app). A commit
  // under the nested child buckets to the DEEPEST matching root (rootOf picks the longest
  // prefix), not the parent. A sibling commit that only touches the parent root buckets there.
  // Real nested subdirectory paths + a repeated basename (index.ts under both roots) exercise
  // fileInventory's basename-keyed lookups (run-case.ts adds both full path and basename).
  {
    name: "nested-root",
    failureMode:
      "attribution: a commit under a nested child root must bucket to the deepest matching root, not its parent",
    build: {
      commits: [
        {
          files: ["packages/app/plugin/index.ts"],
          daysAgo: 1,
          message: "feat(plugin): add plugin entrypoint",
          expectUnit: "packages/app/plugin",
        },
        {
          files: ["packages/app/index.ts"],
          daysAgo: 1,
          message: "feat(app): add app entrypoint",
          expectUnit: "packages/app",
        },
      ],
    },
    subprojectRoots: ["packages/app", "packages/app/plugin"],
  },

  // monorepo-detect — no explicit subprojectRoots: a package.json `workspaces` manifest drives
  // auto-detection (detectJs in src/subprojects.ts). Two commits under distinct packages/*
  // globs-expanded roots; expectUnit is the detected root for each.
  {
    name: "monorepo-detect",
    failureMode:
      "workspace auto-detection: a package.json `workspaces` glob must resolve subproject roots without an explicit subprojectRoots config",
    build: {
      workspaceManifest: { "package.json": '{"workspaces":["packages/*"]}' },
      commits: [
        {
          files: ["packages/foo/index.ts"],
          daysAgo: 1,
          message: "feat(foo): initial scaffold",
          expectUnit: "packages/foo",
        },
        {
          files: ["packages/bar/index.ts"],
          daysAgo: 1,
          message: "feat(bar): initial scaffold",
          expectUnit: "packages/bar",
        },
      ],
    },
  },

  // day5-worktrees — a healthy in-window commit (single catch-all unit → expectUnit: null) plus
  // an uncommitted path under .claude/worktrees/. The infra path is filtered at the UNIT SOURCE (resolveUnits, #14) so it never enters the
  // prompt/SUGGESTIONS at all; generateBriefing.s post-parse SUGGESTIONS filter is defense in depth. See gold.test.ts.
  {
    name: "day5-worktrees",
    failureMode:
      "denylist: SUGGESTIONS must not resurface a .claude/worktrees/ path (guarded by generateBriefing's INFRA_DENYLIST post-parse filter)",
    build: {
      commits: [
        {
          files: ["src/feature.ts"],
          content: "export const feature = 1;\n",
          daysAgo: 1,
          message: "feat: add feature module",
          expectUnit: null,
        },
      ],
      uncommitted: [".claude/worktrees/x"],
    },
  },
  // D4a: a commit with NO diffstat. generator.ts's files suffix is conditional, so this line carries
  // the trailing date with no " — files:" marker before it — the shape that leaks the date into the
  // RECAP bullet if echo.ts's matchCommitLine strips only at the files marker. Real shape:
  // `git commit --allow-empty` ("chore: trigger CI").
  {
    name: "no-files-date",
    failureMode:
      "D4a leak: with no diffstat there is no ' — files:' marker, so activityLine's trailing date lands inside the RECAP bullet text instead of being stripped",
    build: {
      commits: [
        { files: [], daysAgo: 1, message: "chore: trigger CI", expectUnit: null },
      ],
    },
  },

  // ── Slice 1.5b (T8.6) — the transcript-carrying gold case.
  //
  // ⚠ This is invariants 1 and 2's SOLE NON-VACUITY VEHICLE. Every other assertion of them runs
  // against a hand-built struct; this is the only one where a why travels the WHOLE real path —
  // discover -> read -> transform -> select -> segment -> anchor -> join -> projection -> render —
  // and then has the invariants checked against what actually came out.
  //
  // ⚠ Carrying `transcripts` also flips the feature on for this case. `run-case.ts` builds its
  // Config inline with the field absent, so the default (false) would yield zero whys, every G5
  // check would no-op on an empty evidence set, and the case would look green while asserting
  // nothing at all.
  {
    name: "transcript-why",
    failureMode:
      "a quoted why is attributed to the wrong unit, rendered against a bullet that does not exist, or leaks into SUGGESTIONS/today",
    build: {
      commits: [
        {
          files: ["src/join.ts"],
          content: "export const join = true;\n",
          daysAgo: 1,
          message: "rework the join",
          expectUnit: null,
        },
      ],
    },
    transcripts: {
      turns: [
        {
          // Deliberately intent-shaped and under the 600-char cap: an outcome verb would trip G5's
          // `scope`, and an over-cap turn would be rejected before it could ever become a why.
          text: "I am reworking the join to use a membership test, because the plurality vote keeps mis-attributing commits that span two roots",
          minutesBeforeEdit: 5,
          editsFiles: ["src/join.ts"],
        },
      ],
    },
  },

  // same-day-recency — THE ONLY CASE WITH SAME-DAY COMMITS, and that is its entire job.
  //
  // ⚠ Every other case is built purely from `daysAgo: 1`, so `todaySuppress` is EMPTY for all of
  // them and G7 (`recency`) no-ops on every one. Without this case the rule would ship structurally
  // vacuous — the exact failure Collision 5 documents for G5's predicate — and a green suite would
  // read as "recency is covered" when nothing had exercised it.
  //
  // Shape: one in-window commit so RECAP/SUGGESTIONS have material (G3 fails an empty briefing), plus
  // TWO same-day commits on the same unit, 90 minutes apart. `minutesAfter` is required because
  // `dateFor` pins to noon EXACTLY — without it both same-day commits carry byte-identical
  // timestamps and "did RESUME anchor on the newest?" has no answer to be right or wrong about.
  //
  // ⚠ WHAT THIS CASE DOES AND DOES NOT PROVE. It guarantees the check RUNS with real same-day data.
  // It CANNOT deterministically produce a finding: that needs the live model to anchor a RESUME
  // bullet on the older subject, which is exactly the non-determinism being measured. The
  // deterministic proof that the detector fires lives in test/eval/checks.g7.test.ts and
  // test/postcheck.test.ts. Same division as G6.
  {
    name: "same-day-recency",
    failureMode:
      "regression: a RESUME bullet anchors on an OLDER same-day commit while a newer one for the same unit sits in the DONE block the model was handed",
    build: {
      commits: [
        {
          files: ["packages/app/window.ts"],
          daysAgo: 1,
          message: "feat(app): the in-window work RECAP covers",
          expectUnit: "packages/app",
        },
        {
          files: ["packages/app/early.ts"],
          daysAgo: 0,
          minutesAfter: 0,
          message: "fix(app): the EARLIER same-day commit — anchoring here is the defect",
          expectUnit: "packages/app",
        },
        {
          files: ["packages/app/late.ts"],
          daysAgo: 0,
          minutesAfter: 90,
          message: "fix(app): the LATER same-day commit — the correct anchor",
          expectUnit: "packages/app",
        },
      ],
    },
    subprojectRoots: ["packages/app"],
  },
];
