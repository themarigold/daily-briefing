// test/core.drift-propagation.test.ts — drift must reach the ITEMS it invalidates, not just the footer.
//
// WHY THIS EXISTS. Day-20 audit (2026-08-04) of the delivered briefing: the footer said the vault
// working tree was "now clean (auto-committed?)" while SUGGESTIONS #1 still instructed committing
// those exact files. The tool detected its own staleness and then recommended the stale action
// anyway. A reader working top-down follows the instruction and never reaches the correction, so the
// top suggestion was vacuous at read time — which is the one class of briefing content that is
// ACTIVELY misleading rather than merely incomplete.
//
// The pre-existing pins (`test/main.test.ts:340`, `test/integration.test.ts:195`) only ever asserted
// that the WARNING STRING appears. Every test here would pass with the annotation deleted, which is
// exactly how the gap survived — so these are the discriminating cases.
import { test, expect } from "bun:test";
import type { Activity } from "../src/types";
import {
  computeWorkingTreeDrift, driftWarnings, annotateStaleSuggestions, workingTreeDriftWarnings,
  mentionsPath, STALE_NOTE,
} from "../src/core";

const dirty = (repo: string, files: string): Activity => ({
  source: "git", kind: "uncommitted", event_id: `${repo}:u`, repo,
  text: `Uncommitted changes: ${files}`,
});
const sug = (...t: string[]) => t.map((text) => ({ text }));

// ── the measurement ──────────────────────────────────────────────────────────────────────────────

test("resolved = files that WERE dirty and no longer are", async () => {
  const d = await computeWorkingTreeDrift([dirty("/r", "a.md, b.md, c.md")], ["/r"],
    async () => "b.md");
  expect(d).toHaveLength(1);
  expect(d[0]!.resolved.sort()).toEqual(["a.md", "c.md"]);   // b.md is STILL dirty — not resolved
});

test("a fully-clean repo resolves everything it was carrying", async () => {
  const d = await computeWorkingTreeDrift([dirty("/r", "a.md, b.md")], ["/r"], async () => "");
  expect(d[0]!.resolved.sort()).toEqual(["a.md", "b.md"]);
  expect(d[0]!.now).toBe("");
});

test("no drift and unverifiable drift both yield NOTHING to propagate", async () => {
  const same = await computeWorkingTreeDrift([dirty("/r", "a.md")], ["/r"], async () => "a.md");
  expect(same).toEqual([]);
  const failed = await computeWorkingTreeDrift([dirty("/r", "a.md")], ["/r"],
    async () => { throw new Error("git exploded"); });
  expect(failed).toEqual([]);                 // unverifiable → silent, never a false "already done"
});

// ── the propagation (the actual fix) ─────────────────────────────────────────────────────────────

test("a suggestion naming a RESOLVED file is annotated", async () => {
  const drifts = await computeWorkingTreeDrift(
    [dirty("/vault", "0 - Daily Notes/2026-08-03.md")], ["/vault"], async () => "");
  const out = annotateStaleSuggestions(
    sug("Commit the pending vault edits in `0 - Daily Notes/2026-08-03.md`."), drifts);
  expect(out[0]!.text).toContain(STALE_NOTE);
});

test("⚠ a suggestion naming a file that is STILL DIRTY is NOT annotated", async () => {
  // THE discriminating case for the `resolved` set. Annotating on `was` instead of `was - now` marks
  // live work as already-done — a false "ignore this", which is worse than the bug being fixed:
  // the reader skips a real next step. A `resolved: fileList(d.was)` mutant passes every other test
  // in this file and fails only here.
  const drifts = await computeWorkingTreeDrift(
    [dirty("/r", "keep.md, done.md")], ["/r"], async () => "keep.md");
  const out = annotateStaleSuggestions(sug("Finish the work in keep.md"), drifts);
  expect(out[0]!.text).not.toContain(STALE_NOTE);
});

test("unrelated suggestions are untouched, and the array is not reordered", async () => {
  const drifts = await computeWorkingTreeDrift([dirty("/r", "done.md")], ["/r"], async () => "");
  const out = annotateStaleSuggestions(sug("Ship the release", "Commit done.md", "Reply to email"), drifts);
  expect(out.map((s) => s.text.includes(STALE_NOTE))).toEqual([false, true, false]);
});

test("⚠ a BARE LEAF does not match — full paths only, deliberately", async () => {
  // Reversed 2026-08-04 after a fuzz pass measured 28 false positives in 1836 prose cases, ALL of
  // this shape: a resolved `quant_stocks/STATE.md` annotating "rewrite the STATE.md in
  // daily_briefing_application". 36 duplicate basenames across 757 tracked files here. Matching a
  // bare leaf cannot distinguish them, and a false "already done" makes the reader skip real work —
  // which this file's own tests call worse than the bug being fixed. False negatives are the safe
  // direction, so the leaf fallback was removed rather than narrowed.
  const drifts = await computeWorkingTreeDrift(
    [dirty("/r", "1 - Projects/quant_stocks/STATE.md")], ["/r"], async () => "");
  expect(annotateStaleSuggestions(sug("Update STATE.md and move on"), drifts)[0]!.text)
    .not.toContain(STALE_NOTE);
  expect(annotateStaleSuggestions(sug("Update 1 - Projects/quant_stocks/STATE.md"), drifts)[0]!.text)
    .toContain(STALE_NOTE);            // the path the prompt actually printed still matches
});

test("annotation is IDEMPOTENT — a second pass must not stack the note", async () => {
  const drifts = await computeWorkingTreeDrift([dirty("/r", "a.md")], ["/r"], async () => "");
  const once = annotateStaleSuggestions(sug("Commit a.md"), drifts);
  const twice = annotateStaleSuggestions(once, drifts);
  expect(twice[0]!.text).toBe(once[0]!.text);
  // ⚠ Count by SPLIT, not `new RegExp(STALE_NOTE)`: the note now contains "(committed, stashed or
  // reverted)", and unescaped parens turn it into a capture group that matches different text.
  expect(twice[0]!.text.split(STALE_NOTE)).toHaveLength(2);   // exactly one occurrence
});

test("no drift ⇒ the SAME array instance back (no needless copy on the common path)", async () => {
  const s = sug("Ship the release");
  expect(annotateStaleSuggestions(s, [])).toBe(s);
});

test("⚠ it ANNOTATES, never DROPS — the count is preserved", async () => {
  // Deliberate design choice, pinned so a later "just filter them out" refactor has to argue with a
  // test. The match is a substring test on model prose: a suggestion can name a resolved file
  // incidentally while still proposing real work.
  const drifts = await computeWorkingTreeDrift([dirty("/r", "a.md")], ["/r"], async () => "");
  const out = annotateStaleSuggestions(sug("Commit a.md", "Also rewrite a.md's header"), drifts);
  expect(out).toHaveLength(2);
});

// ── the warning text is unchanged by the refactor ────────────────────────────────────────────────

test("workingTreeDriftWarnings still emits the exact legacy string", async () => {
  // The public signature and output are preserved — `main.ts` re-exports this and two suites assert
  // on the literal prefix. The refactor split the measurement out beneath it; it must not show.
  const w = await workingTreeDriftWarnings([dirty("/r", "a.md")], ["/r"], async () => "");
  expect(w).toHaveLength(1);
  expect(w[0]).toContain("working-tree changed while generating: [r]");
  expect(w[0]).toContain(`was "a.md"`);
  expect(w[0]).toContain("now clean (auto-committed?)");
  expect(w[0]).toContain(`re-verify "Where you left off" before acting`);
  expect(w).toEqual(driftWarnings(await computeWorkingTreeDrift([dirty("/r", "a.md")], ["/r"], async () => "")));
});

test("⚠ an untracked DIRECTORY (trailing slash) must not annotate everything", async () => {
  // ⚠ HISTORICAL, and now only defensive. This guarded the empty BASENAME of an untracked directory
  // ("?? sub/" -> basename ""), back when basenames were added to `names`. Round 4 removed basename
  // matching entirely, so `names` holds only `meta.uncommittedFiles` entries, which are never empty —
  // the `.filter(Boolean)` can no longer fire and dropping it now survives the suite. Kept as
  // defence in depth (an empty name would spin `mentionsPath`), and this test is retained as a
  // characterisation of the directory case rather than as a pin on that guard. Labelled rather than
  // deleted so the change of status is visible.
  const drifts = await computeWorkingTreeDrift([dirty("/r", "sub/")], ["/r"], async () => "");
  expect(drifts[0]!.resolved).toEqual(["sub/"]);
  const out = annotateStaleSuggestions(sug("Ship the release", "Reply to email"), drifts);
  expect(out.map((s) => s.text.includes(STALE_NOTE))).toEqual([false, false]);
});

test("⚠ a comma in a filename must not shatter into prose-matching tokens", async () => {
  // `was` is recovered from rendered prose and re-split on ","; a path containing a comma yields
  // short tokens ("has,comma.md" -> ["has", "comma.md"]) and a 3-char token matches ordinary
  // English. `meta.uncommittedFiles` carries the real array, so the structured list is preferred.
  const a: Activity = {
    source: "git", kind: "uncommitted", event_id: "r:u", repo: "/r",
    text: "Uncommitted changes: has,comma.md",
    meta: { uncommittedFiles: ["has,comma.md"] },
  };
  const drifts = await computeWorkingTreeDrift([a], ["/r"], async () => "");
  expect(drifts[0]!.resolved).toEqual(["has,comma.md"]);
  expect(annotateStaleSuggestions(sug("Rewrite what has changed"), drifts)[0]!.text)
    .not.toContain(STALE_NOTE);
});

test("⚠ ORDERING: the annotation runs AFTER the G5 block, not before", async () => {
  // Load-bearing, and invisible in behaviour. G5's `surface` check tests `whyValues.has(s.text)` —
  // byte equality against the BARE anchored turn — so appending STALE_NOTE before G5 runs makes a why
  // that leaked into SUGGESTIONS stop matching, silently defeating the check. MEASURED on a probe
  // struct: 1 `surface` finding unannotated, 0 annotated. `parseWhy` does not backstop it (a bare why
  // carries no frame, so it returns null).
  //
  // A source-order assertion because the constraint is positional: both orders produce an identical
  // briefing on every input that has no leaked why, so no behavioural fixture can separate them.
  const src = await Bun.file(new URL("../src/core.ts", import.meta.url)).text();
  const g5 = src.indexOf("const { g5Whys } = await import(");
  const annotate = src.indexOf("struct.suggestions = annotateStaleSuggestions(");
  // ⚠ The "still before render" half was VACUOUS as first written: it looked for `renderBriefing(`
  // in core.ts, which appears ZERO times (rendering happens in the caller), so `render === -1` and
  // the guarded assertion never executed while its comment claimed it pinned the constraint.
  // Anchored instead on the health-JSON write, which core.ts documents as running after the whys
  // projection and which is genuinely downstream of the annotation.
  const downstream = src.indexOf("T4.9: the health-JSON WRITE call site");
  expect(g5).toBeGreaterThan(-1);
  expect(annotate).toBeGreaterThan(-1);
  expect(downstream).toBeGreaterThan(-1);
  expect(annotate).toBeGreaterThan(g5);            // after the eval gate…
  expect(annotate).toBeLessThan(downstream);       // …and still upstream of the run's tail
});

test("⚠ REGRESSION GUARD: a still-dirty file with a COMMA is not reported resolved", async () => {
  // Round 1 moved the `was` side to `meta.uncommittedFiles` but left `now` split on a bare ",", so
  // the two sides disagreed: `stillDirty` held {"has","comma.md"} while `wasFiles` held the whole
  // path, the still-dirty file fell out of the set-difference and was marked resolved. That marks
  // LIVE work "already committed" — the direction this file calls worse than the original bug.
  // `uncommittedFileList` joins with ", " (git.ts:422), so that is the separator to split on.
  const a: Activity = {
    source: "git", kind: "uncommitted", event_id: "r:u", repo: "/r",
    text: "Uncommitted changes: a.md, has,comma.md",
    meta: { uncommittedFiles: ["a.md", "has,comma.md"] },
  };
  const d = await computeWorkingTreeDrift([a], ["/r"], async () => "has,comma.md");
  expect(d[0]!.resolved).toEqual(["a.md"]);        // NOT ["a.md", "has,comma.md"]
  expect(annotateStaleSuggestions(sug("Finish the edit in has,comma.md"), d)[0]!.text)
    .not.toContain(STALE_NOTE);
});

test("⚠ path BOUNDARIES: a basename inside a longer filename must not match", async () => {
  // `core.ts` is a substring of `score.ts` — 77 such basename pairs exist in this workspace.
  const drifts = await computeWorkingTreeDrift([dirty("/r", "src/core.ts")], ["/r"], async () => "");
  expect(annotateStaleSuggestions(sug("Refactor src/score.ts next"), drifts)[0]!.text)
    .not.toContain(STALE_NOTE);
  expect(annotateStaleSuggestions(sug("Refactor src/core.ts next"), drifts)[0]!.text)
    .toContain(STALE_NOTE);                        // …but the real path still matches
  // ⚠ The bare leaf no longer matches, by design — see the full-path-only note in `core.ts`. This
  // assertion previously read `sug("Refactor core.ts next")` and expected a MATCH; it was inverted
  // when the basename fallback was removed, not deleted, so the change stays visible here.
  expect(annotateStaleSuggestions(sug("Refactor core.ts next"), drifts)[0]!.text)
    .not.toContain(STALE_NOTE);
});

test("⚠ path BOUNDARIES: a same-named file in ANOTHER project must not match", async () => {
  const drifts = await computeWorkingTreeDrift(
    [dirty("/r", "daily_briefing_application/STATE.md")], ["/r"], async () => "");
  expect(annotateStaleSuggestions(sug("Update quant_stocks/STATE.md and commit"), drifts)[0]!.text)
    .not.toContain(STALE_NOTE);
});

test("⚠ path BOUNDARIES: a resolved DIRECTORY must not match files under it", async () => {
  // git collapses untracked directories to "src/", which a bare `includes` matched against every
  // path beneath them. Round 1 guarded only the EMPTY basename, not the directory path itself.
  const drifts = await computeWorkingTreeDrift([dirty("/r", "src/")], ["/r"], async () => "");
  expect(annotateStaleSuggestions(sug("Write the parser in src/parser.ts"), drifts)[0]!.text)
    .not.toContain(STALE_NOTE);
});

test("⚠ REGRESSION GUARD: a SENTENCE-FINAL period must not defeat the match", async () => {
  // Round 2's boundary fix put "." in PATH_CHAR unconditionally, so "Commit done.md." — the single
  // most common shape a suggestion takes — silently MISSED, while every other punctuation matched.
  // All four boundary tests stayed green, because none of them ended a sentence on the filename.
  // The rule is "a dot continues a path only when a word char follows", so `done.md.bak` still misses.
  const drifts = await computeWorkingTreeDrift([dirty("/r", "done.md")], ["/r"], async () => "");
  const shapes = [
    "Commit done.md.", "Commit done.md, then ship", "Review done.md's header",
    "Files: done.md; then push", "Commit **done.md** now", "Commit (done.md) now",
    "Commit done.md", "Commit `done.md`",
  ];
  for (const t of shapes) {
    expect(annotateStaleSuggestions(sug(t), drifts)[0]!.text).toContain(STALE_NOTE);
  }
});

test("⚠ …but a dot FOLLOWED BY a word char still continues the path", async () => {
  // The other side of the same rule: `done.md` must not match a suggestion about `done.md.bak`.
  const drifts = await computeWorkingTreeDrift([dirty("/r", "done.md")], ["/r"], async () => "");
  expect(annotateStaleSuggestions(sug("Restore done.md.bak now"), drifts)[0]!.text)
    .not.toContain(STALE_NOTE);
});

test("⚠ HANG GUARD: the empty-name early return is present in the source", async () => {
  // `"abc".indexOf("", n)` CLAMPS to text.length instead of returning -1, so an empty name makes the
  // scan loop spin forever — in the unattended 07:20 launchd job that is a HANG, not a failed
  // briefing. Reachable input exists: git renders an untracked directory as "sub/", basename "".
  //
  // ⚠ THIS IS A SOURCE PIN, AND IT HAS TO BE. A runtime pin is IMPOSSIBLE here: the loop is
  // SYNCHRONOUS, so it blocks the single-threaded event loop and no `setTimeout`/`Promise.race`
  // watchdog can ever fire. The first version of this test used exactly that race and did not fail
  // when the guard was deleted — it wedged the whole suite instead (MEASURED: `bun test` produced no
  // "Ran N tests" line and had to be killed). A test that hangs CI is not a failing test.
  //
  // Behavioural coverage of the value: `mentionsPath("x", "")` returning false is asserted below via
  // the exported function, which is safe ONLY while the guard exists — so the source pin is what
  // protects that assertion from becoming an infinite loop rather than a red test.
  const src = await Bun.file(new URL("../src/core.ts", import.meta.url)).text();
  expect(src).toMatch(/if \(!name\) return false;/);
  expect(mentionsPath("Ship the release", "")).toBe(false);
});

test("⚠ a filename containing the SEPARATOR is not shattered", async () => {
  // `,` shattered "has,comma.md"; `", "` still shattered "x, y.md". Splitting is unfixable by choice
  // of separator — membership is now an anchored check against the joined string.
  const a: Activity = {
    source: "git", kind: "uncommitted", event_id: "r:u", repo: "/r",
    text: "Uncommitted changes: a.md, x, y.md",
    meta: { uncommittedFiles: ["a.md", "x, y.md"] },
  };
  const d = await computeWorkingTreeDrift([a], ["/r"], async () => "x, y.md");
  expect(d[0]!.resolved).toEqual(["a.md"]);        // "x, y.md" is STILL DIRTY
});

test("⚠ a SINGLE resolved path still does not lend its leaf — uniqueness was not enough", async () => {
  // The case that defeated the first fix. Uniqueness-within-`resolved` passes trivially when only
  // one path resolved, so the bare leaf was still added and still false-matched.
  const a: Activity = {
    source: "git", kind: "uncommitted", event_id: "r:u", repo: "/r",
    text: "Uncommitted changes: quant_stocks/STATE.md",
    meta: { uncommittedFiles: ["quant_stocks/STATE.md"] },
  };
  const d = await computeWorkingTreeDrift([a], ["/r"], async () => "");
  expect(annotateStaleSuggestions(sug("Write the accountant_ai STATE.md section"), d)[0]!.text)
    .not.toContain(STALE_NOTE);
});

test("⚠ an INFRA path never annotates — the model provably never saw it", async () => {
  // subprojects.ts strips infra paths before the prompt and generator.ts strips suggestions naming
  // them, so any match here is coincidental by construction.
  const a: Activity = {
    source: "git", kind: "uncommitted", event_id: "r:u", repo: "/r",
    text: "Uncommitted changes: .claude/worktrees/dba/src/core.ts",
    meta: { uncommittedFiles: [".claude/worktrees/dba/src/core.ts"] },
  };
  const d = await computeWorkingTreeDrift([a], ["/r"], async () => "");
  expect(d[0]!.resolved).toEqual([]);
  expect(annotateStaleSuggestions(sug("Refactor core.ts to split the renderer"), d)[0]!.text)
    .not.toContain(STALE_NOTE);
});

test("⚠ a period FOLLOWED BY MORE PROSE still matches (not just end-of-string)", async () => {
  // The eight sentence-final shapes all terminated at the filename, so a mutant reading "a dot
  // continues a path unless it is the last char of the WHOLE STRING" survived the suite while
  // breaking "Commit done.md. Then push." — at least as common as ending on the filename.
  const drifts = await computeWorkingTreeDrift([dirty("/r", "done.md")], ["/r"], async () => "");
  expect(annotateStaleSuggestions(sug("Commit done.md. Then push the branch."), drifts)[0]!.text)
    .toContain(STALE_NOTE);
});

test("⚠ a LATER occurrence matches when the first is blocked", async () => {
  // The scan loop's continuation was entirely unpinned: a single-occurrence mutant survived while
  // breaking "score.ts is fine, now do core.ts" — the first hit fails the boundary test, the second
  // passes, and only the loop finds it.
  const drifts = await computeWorkingTreeDrift([dirty("/r", "core.ts")], ["/r"], async () => "");
  expect(annotateStaleSuggestions(sug("score.ts is fine, now do core.ts"), drifts)[0]!.text)
    .toContain(STALE_NOTE);
});

test("⚠ PATH_CHAR's dash and underscore are load-bearing", async () => {
  // Both were unpinned: dropping either from PATH_CHAR left the suite green while opening a new
  // false positive, because a longer filename would then match a shorter resolved one.
  const drifts = await computeWorkingTreeDrift([dirty("/r", "done.md")], ["/r"], async () => "");
  for (const t of ["Commit x-done.md", "Commit x_done.md", "Restore done.md._old"]) {
    expect(annotateStaleSuggestions(sug(t), drifts)[0]!.text).not.toContain(STALE_NOTE);
  }
});

test("⚠ a MULTI-FILE `now` — the only shape production produces — resolves nothing", async () => {
  // THE COVERAGE HOLE. Every other `now` stub in this file is "" or a SINGLE file, so only
  // `joinedListHas`'s `joined === f` clause ever executed. Real `git status` lists several files,
  // where membership is decided by startsWith / endsWith / includes — and each of those three could
  // be replaced with `false` and survive the entire 1002-test suite. A regression in any one makes a
  // STILL-DIRTY file report as resolved, i.e. annotating live work as gone: the worst error class,
  // and the exact bug rounds 2 and 3 both shipped. This case exercises first, middle and last
  // position at once, which exhausts the possible positions.
  // ⚠ FOUR files, and the survivor set must retain a FIRST, a MIDDLE and a LAST — that is what makes
  // each of the three clauses load-bearing. A two-file `now` is not enough: first+last alone are
  // covered by startsWith/endsWith, and the `includes(", f, ")` clause survived a mutant on the
  // earlier version of this test. An `now === was` assertion is worse than useless here — it trips
  // the equality early-return before `joinedListHas` is ever called.
  const a: Activity = {
    source: "git", kind: "uncommitted", event_id: "r:u", repo: "/r",
    text: "Uncommitted changes: a.md, b.md, c.md, d.md",
    meta: { uncommittedFiles: ["a.md", "b.md", "c.md", "d.md"] },
  };
  const d = await computeWorkingTreeDrift([a], ["/r"], async () => "a.md, b.md, c.md");
  // a.md is FIRST in `now` (startsWith), b.md is MIDDLE (includes), c.md is LAST (endsWith) — all
  // three still dirty. Only d.md actually left the working tree.
  expect(d[0]!.resolved).toEqual(["d.md"]);
});
