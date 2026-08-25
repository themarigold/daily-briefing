// test/extractor.incomplete-read.test.ts
//
// C1/A1 — the swallow audit must extend PAST git.ts. Throwing IncompleteReadError from runGit is a
// NO-OP for its two motivating protections unless extractor's phase-1 frames let it through:
//
//   resolveAuthor's own fallbacks (git.ts), which return `{}`
//     resolveAuthor only touches git when cfg.author is ABSENT — exactly the case those fallbacks
//     fire in. Degrading to {} means NO AUTHOR FILTER, so every commit in the repo matches and
//     coworkers' commits get credited to the user. Fixing only git.ts achieves nothing here.
//     (Phase 1 briefly carried its own `.catch(() => cfg.author ?? {})` guard for this; it was
//     removed as dead code once the outer catch was proven to be the actual protection.)
//
//   extractor.ts  catch → `if (await gitDirExists(repo)) return { days: [], ... }`
//     An IncompleteReadError from committerDaysWithCommits lands in the unborn-HEAD branch. The
//     repo IS a git repo (only the pipe was held), so gitDirExists says true and it returns ZERO
//     DAYS with no issue and no warning — a fabricated quiet day, which then stamps the day. The
//     spec calls this outcome worse than the hang it replaces.
//
// Six review rounds all audited git.ts and stopped at its boundary; the seventh caught this. Later
// rounds then closed the per-command holds (config / log / rev-list) that a blanket hold can't isolate.
import { test, expect, spyOn } from "bun:test";
import { gitActivity } from "../src/extractor";
import { IncompleteReadError } from "../src/git";
import { buildRepo } from "./fixtures/build-repo";
import { blockedDelivery } from "../src/core";
import { isInaccessible } from "../src/protectedPath";
import type { Config } from "../src/types";

function stream(chunks: string[], eof: boolean): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); if (eof) c.close(); } });
}
function fake(chunks: string[], eof: boolean) {
  return {
    stdout: stream(chunks, eof), stderr: stream([], true),
    exited: Promise.resolve(0), exitCode: 0, signalCode: null, kill() {},
  } as unknown as ReturnType<typeof Bun.spawn>;
}
/** A spawn whose stdout ERRORS instead of never EOF-ing — the OTHER cause of an IncompleteReadError.
 *  Its `reason` differs from a held pipe's, which is the whole point of plumbing `reason` through. */
function erroring() {
  const enc = new TextEncoder();
  return {
    stdout: new ReadableStream({
      start(c) { c.enqueue(enc.encode("partial")); c.error(new Error("EIO: i/o error, read")); },
    }),
    stderr: stream([], true),
    exited: Promise.resolve(0), exitCode: 0, signalCode: null, kill() {},
  } as unknown as ReturnType<typeof Bun.spawn>;
}

/** Faithful to the real failure: the hold is REPO-SCOPED (an fsmonitor/backgrounding hook in that
 *  repo), so `git --version` — which gitActivity's preflight runs from homedir() — still EOFs
 *  normally. A blanket mock would instead trip the preflight and never reach the code under test. */
function heldSpawn(cmd: string[]) {
  return cmd.includes("--version") ? fake(["git version 2.54.0\n"], true) : fake(["partial"], false);
}

const cfg = (over: Partial<Config> = {}): Config =>
  ({ repos: [], tokenBudget: { maxChars: 200000 }, provider: { cli: "true", argv: [], promptVia: "stdin" }, ...over }) as Config;

test("an incomplete read BLOCKS THE STAMP — a warning alone is not enough", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => heldSpawn(cmd)) as any);
  try {
    const { activities, issues } = await gitActivity(cfg(), [repo]);
    expect(activities).toHaveLength(0);
    // THE property that matters, asserted directly rather than via "something was said". A warning
    // with no issue leaves blockedDelivery false → emptyWindow → a quiet-day briefing that STAMPS
    // the day and never retries: the fabricated quiet day A1 calls worse than the hang.
    expect(issues.some(isInaccessible)).toBe(true);
    expect(blockedDelivery(activities.length, issues)).toBe(true);
  } finally { spy.mockRestore(); }
});

test("a held repo alongside a HEALTHY one still delivers — only an empty run blocks", async () => {
  // The asymmetry blockedDelivery gives for free: partial data is better than no briefing, so one
  // bad repo must not block delivery; a run with nothing left to say must.
  //
  // The hold must be REPO-SCOPED to test this at all. An earlier version of this test built only the
  // healthy repo and mocked nothing, so it asserted "a healthy repo delivers" — trivially true, and
  // it passed with the entire fix reverted. Key the mock on the spawn `cwd` (not on argv, which
  // cannot distinguish two repos running the same commands) and let the healthy repo really run.
  const held = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  const healthy = await buildRepo([{ file: "b.txt", content: "b", isoDate: new Date(Date.now() - 864e5).toISOString() }]);
  const realSpawn = Bun.spawn;   // captured BEFORE the spy, or the passthrough recurses
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], opts?: { cwd?: string }) =>
    opts?.cwd === held ? fake(["partial"], false) : realSpawn(cmd as never, opts as never)) as never);
  try {
    const { activities, issues } = await gitActivity(cfg(), [held, healthy]);
    expect(activities.length).toBeGreaterThan(0);                    // the healthy repo still contributed
    expect(issues.some(isInaccessible)).toBe(true);                  // the held one IS flagged
    expect(blockedDelivery(activities.length, issues)).toBe(false);  // ...yet the briefing still goes out
  } finally { spy.mockRestore(); }
});

test("phase 2 (git status / stash — where an fsmonitor hook actually fires first) also blocks", async () => {
  // resumptionSignals runs `git status`, which is what INVOKES an fsmonitor hook — so on the real
  // pathology the hold often manifests in phase 2 first, where a bare `catch {}` used to turn it
  // into a vague "partial failure reading repo" with no issue at all.
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  // Everything except status/stash really runs: the old fixture returned `git version 2.54.0` for
  // EVERY other command, so resolveAuthor resolved the author to that literal string and
  // committerDaysWithCommits parsed version output as a log. Harmless to the asserted property, but
  // the cwd-keyed passthrough the sibling tests use is strictly more faithful.
  const realSpawn = Bun.spawn;
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], opts?: { cwd?: string }) =>
    cmd.includes("status") || cmd.includes("stash")
      ? fake(["partial"], false) : realSpawn(cmd as never, opts as never)) as never);
  try {
    const { activities, issues, warnings } = await gitActivity(cfg(), [repo]);
    expect(issues.some(isInaccessible)).toBe(true);
    expect(blockedDelivery(activities.length, issues)).toBe(true);   // the property the name claims
    expect(warnings.join(" ")).toContain("holding git's output pipe open");   // phase 2's reason, plumbed
    // Anchor on the substantive claim, not the hedged cause hint: the
    // wrong diagnoses ("partial failure reading repo", "not on PATH") contain neither, but only this
    // phrase survives a rewording of the cause hint.
    expect(warnings.join(" ")).toContain("could not be read to completion");
  } finally { spy.mockRestore(); }
});

test("phase 2 KEEPS the partials it already gathered — a held listCommits still delivers", async () => {
  // The phase-2 catch returns `acts`/`td`/`merged` as gathered, and its comment calls that
  // load-bearing ("runGit now only returns on a COMPLETE read, so anything it handed back is whole").
  // Nothing tested it: the other phase-2 tests hold `status` — resumptionSignals' FIRST call — so they
  // arrive with `acts` already empty and cannot distinguish "keeps partials" from "drops them".
  // Measured: replacing them with [] survives all 456 tests. And it is not cosmetic — dropping them
  // takes activityCount to 0, which flips blockedDelivery from deliver-a-partial-briefing to BLOCK,
  // i.e. the wrong side of this branch's central asymmetry. Hold `--numstat`, which only listCommits
  // passes, so resumptionSignals completes and banks real signals first.
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  const realSpawn = Bun.spawn;
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], opts?: { cwd?: string }) =>
    cmd.includes("--numstat") ? fake(["partial"], false) : realSpawn(cmd as never, opts as never)) as never);
  try {
    const { activities, issues } = await gitActivity(cfg(), [repo]);
    expect(issues.some(isInaccessible)).toBe(true);                   // the held read IS surfaced
    expect(activities.length).toBeGreaterThan(0);                     // ...and the banked signals survive
    expect(blockedDelivery(activities.length, issues)).toBe(false);   // so the briefing still goes out
  } finally { spy.mockRestore(); }
});

test("a hold on ONLY `git config` still blocks — the no-author-filter degradation, isolated", async () => {
  // The scenario this file's header names as motivating, but which no test reached: resolveAuthor
  // touches git ONLY when cfg.author is absent, so a hold confined to `git config` used to degrade to
  // `{}` = NO AUTHOR FILTER (every commit in the repo matches, crediting coworkers) while `git log`
  // succeeded normally and the run looked healthy. A blanket hold can't isolate this — `git log`
  // would be held too and raise the issue one call later, which is why reverting the guard broke
  // nothing. Hold `config` alone and let everything else really run.
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  const realSpawn = Bun.spawn;
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], opts?: { cwd?: string }) =>
    cmd.includes("config") ? fake(["partial"], false) : realSpawn(cmd as never, opts as never)) as never);
  try {
    const { activities, issues, warnings } = await gitActivity(cfg(), [repo]);
    expect(issues.some(isInaccessible)).toBe(true);
    expect(blockedDelivery(activities.length, issues)).toBe(true);   // the property the name claims
    expect(warnings.join(" ")).toContain("could not be read to completion");
  } finally { spy.mockRestore(); }
});

test("a FAILED READ is diagnosed as such in the warning — not as a held pipe", async () => {
  // The payoff of plumbing `reason` through, and the one thing no test asserted: deleting the
  // interpolations or blanking either reason string survived all 458 tests, so the run would block
  // correctly while telling the user to hunt a git hook that was never involved. Drive a stream that
  // ERRORS (not one that is held) and require the warning to name the real cause.
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  const realSpawn = Bun.spawn;
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], opts?: { cwd?: string }) =>
    cmd.includes("config") ? erroring() : realSpawn(cmd as never, opts as never)) as never);
  try {
    const { issues, warnings } = await gitActivity(cfg(), [repo]);
    expect(issues.some(isInaccessible)).toBe(true);                            // still blocks
    expect(warnings.join(" ")).toContain("the pipe read itself failed (EIO");   // the REAL cause
    expect(warnings.join(" ")).not.toContain("holding git's output pipe open"); // not the wrong one
  } finally { spy.mockRestore(); }
});

test("phase 2 KEEPS today's commits too, not just the pre-window ones", async () => {
  // "KEEPS the partials" was proven for `activities` only: `today` → [] survived all 458 tests,
  // because every other scenario holds at or before listCommits, leaving `td` empty when the catch
  // runs. Hold `--merges` (unique to listPrMerges, the LAST call) so listCommits completes first and
  // banks a same-day commit — dropping it would silently strip "Today so far" from a delivered
  // briefing. (`mergedToday` is NOT testable here: listPrMerges only populates on success, so it is
  // necessarily empty in the catch.)
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  const realSpawn = Bun.spawn;
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], opts?: { cwd?: string }) =>
    cmd.includes("--merges") ? fake(["partial"], false) : realSpawn(cmd as never, opts as never)) as never);
  try {
    const { today, issues } = await gitActivity(cfg(), [repo]);
    expect(issues.some(isInaccessible)).toBe(true);   // the held listPrMerges IS surfaced
    expect(today.length).toBeGreaterThan(0);          // ...and today's commit survived the catch
  } finally { spy.mockRestore(); }
});

test("a hold on ONLY `rev-list --left-right` (ahead/behind) still blocks, not read as 'no upstream'", async () => {
  // git.ts's ahead/behind probe has a bare `catch` because "no upstream configured" is the normal
  // case. An IncompleteReadError landing there looked exactly like a missing upstream — silently
  // reporting ahead=0/behind=0 on a repo whose real divergence could not be read. No other test
  // reaches this line: the phase-2 tests hold `status`/`stash`, which throw first.
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  const realSpawn = Bun.spawn;
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], opts?: { cwd?: string }) =>
    cmd.includes("rev-list") ? fake(["partial"], false) : realSpawn(cmd as never, opts as never)) as never);
  try {
    const { activities, issues } = await gitActivity(cfg(), [repo]);
    expect(issues.some(isInaccessible)).toBe(true);
    // Assert the DELIVERY decision, not just that an issue exists — blocking is the property the name
    // claims, and it also pins that no fabricated "ahead 0 / behind 0" branch signal got delivered.
    expect(blockedDelivery(activities.length, issues)).toBe(true);
  } finally { spy.mockRestore(); }
});

test("a hold on ONLY `git log` blocks — it must not stamp a briefing built from unreadable history", async () => {
  // The third per-command hold, and the one still uncovered: an IncompleteReadError from
  // committerDaysWithCommits lands in the inner catch, whose rethrow keeps it out of the unborn-HEAD
  // branch. Without that rethrow the repo stays in `readable`, phase 2's resumption signals count as
  // activity, and the run DELIVERS and STAMPS with history it could not read — measured divergence:
  // blocked true (correct) vs blocked false (stamps). The phase-2 issue alone doesn't save it, which
  // is precisely why no existing test noticed.
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  const realSpawn = Bun.spawn;
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], opts?: { cwd?: string }) =>
    cmd.includes("log") ? fake(["partial"], false) : realSpawn(cmd as never, opts as never)) as never);
  try {
    const { activities, issues, warnings } = await gitActivity(cfg(), [repo]);
    expect(blockedDelivery(activities.length, issues)).toBe(true);
    expect(warnings.join(" ")).toContain(`skipped ${repo}`);   // phase 1 dropped it, not phase 2
  } finally { spy.mockRestore(); }
});

test("the incomplete-read repo is NOT reported as readable (so it can't be silently credited)", async () => {
  // Assert the SHAPE, not "something mentioning the repo was reported". The weaker form this replaces
  // still passed when phase 1 was mutated to return `readable: { repo, author }` ALONGSIDE the issue —
  // which re-admits the held repo to phase 2 and makes it creditable again. Exactly one issue and one
  // warning, both phase 1's, is what proves it was dropped from `readable`: had it stayed, phase 2
  // would have hit the same held pipe and appended its own "partial read of" pair.
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => heldSpawn(cmd)) as any);
  try {
    const { warnings, issues } = await gitActivity(cfg(), [repo]);
    expect(issues).toEqual([{ path: repo, kind: "unreadable" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`skipped ${repo}`);   // phase 1's wording, not phase 2's
  } finally { spy.mockRestore(); }
});

test("a genuinely empty repo (unborn HEAD) yields NO issue — an incomplete read must stay distinguishable from it", async () => {
  // The pre-existing behaviour this fix must not break. Verified by A/B against unmodified git.ts:
  // an unborn-HEAD repo produces one `branch` activity (resumptionSignals treats a brand-new repo
  // with staged work as a real "here's where I left off" state) and — crucially — ZERO issues.
  // That is exactly why an incomplete read must NOT be routed down this branch.
  const empty = await buildRepo([]);
  const { issues, warnings } = await gitActivity(cfg(), [empty]);
  expect(issues).toHaveLength(0);
  expect(warnings).toHaveLength(0);
});

test("a healthy repo still produces activity (no regression on the happy path)", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date(Date.now() - 864e5).toISOString() }]);
  const { activities, issues } = await gitActivity(cfg(), [repo]);
  expect(issues).toHaveLength(0);
  expect(activities.length).toBeGreaterThan(0);
});

test("a machine-wide held pipe is diagnosed as such — NOT as \"git isn't runnable\"", async () => {
  // A swallow site outside git.ts, found while building this PR: gitActivity's preflight USED TO do
  // `runGit(["--version"], homedir()).catch(() => false)`, so an incomplete read reported git as
  // missing and sent the user to reinstall a git that works fine. The blocking outcome was right
  // (no stamp, retry); the diagnosis was not, and a wrong diagnosis is the same class of silent
  // degradation this whole PR exists to remove. It now returns three outcomes and carries the
  // error's own `reason` (see gitAvailable) — this test pins that.
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  const spy = spyOn(Bun, "spawn").mockImplementation((() => fake(["partial"], false)) as any); // blanket hold, incl. --version
  try {
    const { issues, warnings } = await gitActivity(cfg(), [repo]);
    expect(issues.some(isInaccessible)).toBe(true);                  // still BLOCKING — mere presence of
                                                                    // an issue wouldn't prove that
    expect(warnings.join(" ")).not.toContain("not on PATH");        // the wrong diagnosis
    expect(warnings.join(" ")).toContain("could not be read to completion");   // the right one
    expect(warnings.join(" ")).toContain("holding git's output pipe open");     // the probe's reason, plumbed
  } finally { spy.mockRestore(); }
});

test("IncompleteReadError is exported and identifiable across module boundaries", () => {
  const e = new IncompleteReadError(["log"], "/tmp");
  expect(e).toBeInstanceOf(IncompleteReadError);
  expect(e.name).toBe("IncompleteReadError");
});
