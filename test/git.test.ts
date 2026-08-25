// test/git.test.ts
import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepo, commitFiles, branchCommit, mergeBranchWith } from "./fixtures/build-repo";
import { listCommits, listPrMerges, runGit, committerDaysWithCommits, uncommittedFiles, authorArgs, resolveAuthor, uncommittedFileList, resumptionSignals, gitSupportsSinceAsFilter, sinceAsFilterArgs, displayStatusEntry } from "../src/git";
import { localMidnight } from "../src/time";

// ---- High ③: windowed-scan helpers (bound the full-history `git log --all` walks) ----
test("gitSupportsSinceAsFilter: true for git >= 2.37, false below (and on garbage)", () => {
  expect(gitSupportsSinceAsFilter("git version 2.54.0")).toBe(true);
  expect(gitSupportsSinceAsFilter("git version 2.37.0")).toBe(true);        // exact floor
  expect(gitSupportsSinceAsFilter("git version 2.36.9")).toBe(false);       // just below
  expect(gitSupportsSinceAsFilter("git version 3.0.0")).toBe(true);
  expect(gitSupportsSinceAsFilter("git version 2.39.3 (Apple Git-146)")).toBe(true);
  expect(gitSupportsSinceAsFilter("not a version")).toBe(false);
});

test("sinceAsFilterArgs: [] when unsupported; a margined --since-as-filter when supported", () => {
  const cutoff = Date.UTC(2026, 6, 16, 12, 0, 0);
  expect(sinceAsFilterArgs(cutoff, false)).toEqual([]);                     // older git → unbounded fallback
  const args = sinceAsFilterArgs(cutoff, true);
  expect(args).toHaveLength(1);
  expect(args[0]!).toStartWith("--since-as-filter=");
  const iso = args[0]!.slice("--since-as-filter=".length);
  // the bound sits a safety margin (≥1 day) BEFORE the cutoff, so git can't drop an in-window commit
  expect(new Date(iso).getTime()).toBeLessThanOrEqual(cutoff - 864e5);
});

test("committerDaysWithCommits threads windowArgs into the git log invocation (wiring guard — catches an accidental spread removal)", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  const supported = gitSupportsSinceAsFilter(await runGit(["--version"], repo)); // env's real git
  const spy = spyOn(Bun, "spawn"); // calls through by default; records the argv of each git spawn
  try {
    await committerDaysWithCommits(repo, undefined, 4);
    const gitLogArgs = spy.mock.calls
      .map((c) => c[0] as unknown as string[])
      .filter((a) => Array.isArray(a) && a[0] === "git" && a.includes("log"));
    expect(gitLogArgs.length).toBeGreaterThan(0); // it did spawn a `git log`
    const bounded = gitLogArgs.some((a) => a.some((x) => typeof x === "string" && x.startsWith("--since-as-filter=")));
    expect(bounded).toBe(supported); // bounded iff git supports --since-as-filter; unbounded fallback otherwise
  } finally { spy.mockRestore(); }
});

test("listCommits returns only commits in [start,end) for the author, by committer date", async () => {
  // Build commit dates from LOCAL components (not fixed offsets) so commit-local-day and
  // window-local-day align in ANY runner timezone (was TZ-fragile with fixed -07:00 offsets).
  const repo = await buildRepo([
    { file: "a.txt", content: "a", isoDate: new Date(2026, 6, 6, 10, 0).toISOString() },                        // in window (local Jul 6)
    { file: "b.txt", content: "b", isoDate: new Date(2026, 6, 1, 10, 0).toISOString() },                        // before window
    { file: "c.txt", content: "c", isoDate: new Date(2026, 6, 6, 11, 0).toISOString(), email: "someone@else" }, // wrong author
  ]);
  const end = localMidnight(new Date(2026, 6, 7));   // Jul 7 00:00 local
  const start = localMidnight(new Date(2026, 6, 6)); // Jul 6 00:00 local
  const acts = await listCommits(repo, start, end, { emails: ["test@example.com"] });
  expect(acts.map(a => a.text)).toEqual(["add a.txt"]);
  expect(acts[0]!.event_id.length).toBeGreaterThan(0); // SHA
  expect(acts[0]!.kind).toBe("commit");
});

test("listCommits matches a Gmail-alias author email containing regex metacharacters (+)", async () => {
  // git log --author=<pattern> treats <pattern> as a REGEX; an unescaped `+` in the email
  // would mis-match and silently drop this commit. Regression for that escaping fix.
  const repo = await buildRepo([
    { file: "plus.txt", content: "p", isoDate: new Date(2026, 6, 6, 10, 0).toISOString(), email: "user+tag@example.com" },
  ]);
  const end = localMidnight(new Date(2026, 6, 7));   // Jul 7 00:00 local
  const start = localMidnight(new Date(2026, 6, 6)); // Jul 6 00:00 local
  const acts = await listCommits(repo, start, end, { emails: ["user+tag@example.com"] });
  expect(acts.map(a => a.text)).toEqual(["add plus.txt"]);
});

test("committer-date windowing catches a cherry-picked commit with an OLD author date", async () => {
  // root.txt (no old.txt) → old.txt on main. Branch `feature` from root so the pick is NOT empty
  // (branching from the old.txt commit itself would make cherry-pick a no-op and create no commit).
  const src = await buildRepo([
    { file: "root.txt", content: "r", isoDate: new Date(2026, 4, 1, 10, 0).toISOString() },
    { file: "old.txt", content: "old", isoDate: new Date(2026, 5, 1, 10, 0).toISOString() },
  ]);
  const oldSha = (await runGit(["rev-parse", "HEAD"], src)).trim();  // the old.txt commit
  await runGit(["checkout", "-q", "-b", "feature", "HEAD~1"], src);  // branch from root, before old.txt
  const now = new Date();
  const p = Bun.spawn(["git", "cherry-pick", "-x", oldSha], { cwd: src,
    env: { ...process.env, GIT_COMMITTER_DATE: now.toISOString() } as any, stdout: "pipe", stderr: "pipe" });
  await p.exited;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(start.getTime() + 864e5);
  const acts = await listCommits(src, start, end, { emails: ["test@example.com"] });
  // The cherry-pick lands today by committer date even though author date is June 1.
  expect(acts.some((a) => a.text?.includes("old.txt"))).toBe(true);
});

test("committer-date windowing catches a rebased/amended commit whose AUTHOR date is old", async () => {
  const now = new Date();
  const repo = await buildRepo([
    { file: "work.txt", content: "w", isoDate: new Date(2026, 0, 1, 10, 0).toISOString() }, // old author date
  ]);
  // Model a rebase-forward: committer date := now, author date stays old (what git rebase does).
  const amend = Bun.spawn(["git", "commit", "--amend", "--no-edit"], {
    cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: now.toISOString() } as any,
    stdout: "pipe", stderr: "pipe",
  });
  await amend.exited;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(start.getTime() + 864e5);
  const acts = await listCommits(repo, start, end, { emails: ["test@example.com"] });
  expect(acts.some((a) => a.text?.includes("work.txt"))).toBe(true); // in window by committer date
});

test("listCommits sees a commit on a branch you've since switched away from (--all, not HEAD-only)", async () => {
  const repo = await buildRepo([
    { file: "root.txt", content: "r", isoDate: new Date(2026, 6, 6, 9, 0).toISOString() },
  ]);
  await runGit(["checkout", "-q", "-b", "feature"], repo);
  await Bun.write(`${repo}/feature.txt`, "f");
  await runGit(["add", "."], repo);
  const featureDate = new Date(2026, 6, 6, 11, 0).toISOString(); // pinned, so no local-day-boundary flakiness
  const commit = Bun.spawn(["git", "commit", "-q", "-m", "add feature.txt"], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: featureDate, GIT_COMMITTER_DATE: featureDate } as any,
    stdout: "pipe", stderr: "pipe",
  });
  await commit.exited;
  const featureSha = (await runGit(["rev-parse", "HEAD"], repo)).trim();
  await runGit(["checkout", "-q", "main"], repo); // switch away — feature branch commit is not on HEAD's history
  const end = localMidnight(new Date(2026, 6, 7));
  const start = localMidnight(new Date(2026, 6, 6));
  const acts = await listCommits(repo, start, end, { emails: ["test@example.com"] });
  expect(acts.some((a) => a.event_id === featureSha)).toBe(true);
});

test("listCommits displays an intermediate-directory rename brace form correctly (src/{old => new}/file.ts)", async () => {
  // Numstat renders this rename as "src/{old_auth => new_auth}/session.ts" — a brace collapsed
  // around just the differing segment, with a real suffix ("/session.ts") AFTER the closing
  // brace. displayFile() must reconstruct "src/new_auth/session.ts", not leave a stray "}" or
  // drop the "src/" prefix.
  const repo = await buildRepo([
    { file: "src/old_auth/session.ts", content: "x", isoDate: new Date(2026, 6, 5, 10, 0).toISOString() },
  ]);
  await runGit(["mv", "src/old_auth", "src/new_auth"], repo);
  const iso = new Date(2026, 6, 6, 10, 0).toISOString();
  const commit = Bun.spawn(["git", "commit", "-q", "-m", "rename dir"], {
    cwd: repo,
    env: {
      ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso,
      GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_EMAIL: "test@example.com",
    } as any,
    stdout: "pipe", stderr: "pipe",
  });
  await commit.exited;
  const start = localMidnight(new Date(2026, 6, 6));
  const end = localMidnight(new Date(2026, 6, 7));
  const acts = await listCommits(repo, start, end, { emails: ["test@example.com"] });
  const rename = acts.find((a) => a.text === "rename dir");
  expect(rename).toBeDefined();
  expect((rename!.meta as any)?.diffstat?.[0]?.file).toBe("src/new_auth/session.ts");
});

test("listCommits still displays a plain 'old => new' rename (no common prefix/suffix) correctly", async () => {
  const repo = await buildRepo([
    { file: "old.txt", content: "x", isoDate: new Date(2026, 6, 5, 10, 0).toISOString() },
  ]);
  await runGit(["mv", "old.txt", "new.txt"], repo);
  const iso = new Date(2026, 6, 6, 10, 0).toISOString();
  const commit = Bun.spawn(["git", "commit", "-q", "-m", "rename file"], {
    cwd: repo,
    env: {
      ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso,
      GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_EMAIL: "test@example.com",
    } as any,
    stdout: "pipe", stderr: "pipe",
  });
  await commit.exited;
  const start = localMidnight(new Date(2026, 6, 6));
  const end = localMidnight(new Date(2026, 6, 7));
  const acts = await listCommits(repo, start, end, { emails: ["test@example.com"] });
  const rename = acts.find((a) => a.text === "rename file");
  expect(rename).toBeDefined();
  expect((rename!.meta as any)?.diffstat?.[0]?.file).toBe("new.txt");
});

test("listCommits still displays a trailing-brace rename (dir/{old => new}, no suffix) correctly", async () => {
  const repo = await buildRepo([
    { file: "dir/old.txt", content: "x", isoDate: new Date(2026, 6, 5, 10, 0).toISOString() },
  ]);
  await runGit(["mv", "dir/old.txt", "dir/new.txt"], repo);
  const iso = new Date(2026, 6, 6, 10, 0).toISOString();
  const commit = Bun.spawn(["git", "commit", "-q", "-m", "rename in dir"], {
    cwd: repo,
    env: {
      ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso,
      GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_EMAIL: "test@example.com",
    } as any,
    stdout: "pipe", stderr: "pipe",
  });
  await commit.exited;
  const start = localMidnight(new Date(2026, 6, 6));
  const end = localMidnight(new Date(2026, 6, 7));
  const acts = await listCommits(repo, start, end, { emails: ["test@example.com"] });
  const rename = acts.find((a) => a.text === "rename in dir");
  expect(rename).toBeDefined();
  expect((rename!.meta as any)?.diffstat?.[0]?.file).toBe("dir/new.txt");
});

test("committerDaysWithCommits returns local-midnight epoch-ms per commit day, excluding commits older than sinceDaysAgo", async () => {
  const day1 = new Date(2026, 6, 5, 9, 0);  // within cap
  const day2 = new Date(2026, 6, 6, 14, 0); // within cap, different day
  const tooOld = new Date(2025, 0, 1, 9, 0); // way outside cap
  const repo = await buildRepo([
    { file: "old.txt", content: "o", isoDate: tooOld.toISOString() },
    { file: "d1.txt", content: "1", isoDate: day1.toISOString() },
    { file: "d2.txt", content: "2", isoDate: day2.toISOString() },
  ]);
  const sinceDaysAgo = Math.ceil((Date.now() - day1.getTime()) / 864e5) + 1; // just covers day1, excludes tooOld
  const days = await committerDaysWithCommits(repo, { emails: ["test@example.com"] }, sinceDaysAgo);
  expect(days.has(localMidnight(day1).getTime())).toBe(true);
  expect(days.has(localMidnight(day2).getTime())).toBe(true);
  expect(days.has(localMidnight(tooOld).getTime())).toBe(false);
});

test("listCommits TAGS (not drops) commits whose subject matches an exclude pattern (bot/auto commits)", async () => {
  const inWin = new Date(2026, 6, 6, 10, 0).toISOString();
  const repo = await buildRepo([{ file: "real.txt", content: "r", isoDate: inWin }]);
  // add a 'vault backup:' auto-commit in the same window, same author
  await Bun.write(`${repo}/backup.txt`, "b");
  const g = async (args: string[], env: Record<string, string> = {}) => {
    const p = Bun.spawn(["git", "-C", repo, ...args], { env: { ...process.env, ...env } as Record<string, string>, stdout: "pipe", stderr: "pipe" });
    await p.exited;
  };
  await g(["add", "."]);
  await g(["commit", "-q", "-m", "vault backup: 2026-07-06 10:05:00"], { GIT_AUTHOR_DATE: inWin, GIT_COMMITTER_DATE: inWin });
  const start = localMidnight(new Date(2026, 6, 6)), end = localMidnight(new Date(2026, 6, 7));
  const author = { emails: ["test@example.com"] };
  const withBot = await listCommits(repo, start, end, author);
  const noBot = await listCommits(repo, start, end, author, [/^vault backup:/]);
  expect(withBot.some((a) => (a.text ?? "").startsWith("vault backup:"))).toBe(true);
  // Slice 1.5 T0.2 INVERTED the old drop: the bot commit is RETAINED and tagged, so it can still vote
  // for a sub-project root and mark window content. Every consumer downstream of `resolveUnits` skips
  // it on `meta.excluded` — see core.ts's `realActivities`.
  const bot = noBot.find((a) => (a.text ?? "").startsWith("vault backup:"));
  expect(bot).toBeDefined();
  expect(bot!.meta?.excluded).toBe(true);
  // ...and with NO exclude patterns the same commit carries no tag — the flag tracks the pattern, not the subject.
  expect(withBot.find((a) => (a.text ?? "").startsWith("vault backup:"))!.meta?.excluded).toBeUndefined();
  const real = noBot.find((a) => a.text === "add real.txt");
  expect(real).toBeDefined();
  expect(real!.meta?.excluded).toBeUndefined();
  // committerDaysWithCommits must ALSO exclude bot days — else a bot-only day collapses the window (#1)
  const daysWithBot = await committerDaysWithCommits(repo, author, 400);
  const daysNoBot = await committerDaysWithCommits(repo, author, 400, [/^vault backup:/]);
  const botDay = localMidnight(new Date(2026, 6, 6)).getTime();
  expect(daysWithBot.has(botDay)).toBe(true);  // bot commit counts as a commit-day without the filter
  expect(daysNoBot.has(botDay)).toBe(true);     // still true here — there's ALSO a real commit that day
  // a repo with ONLY a bot commit that day → no commit-day once filtered
  const botOnly = await buildRepo([]);
  await Bun.write(`${botOnly}/x.txt`, "x");
  const g2 = async (args: string[], env: Record<string, string> = {}) => { const p = Bun.spawn(["git", "-C", botOnly, ...args], { env: { ...process.env, ...env } as Record<string, string>, stdout: "pipe", stderr: "pipe" }); await p.exited; };
  await g2(["add", "."]); await g2(["commit", "-q", "-m", "vault backup: only"], { GIT_AUTHOR_DATE: inWin, GIT_COMMITTER_DATE: inWin });
  expect((await committerDaysWithCommits(botOnly, author, 400, [/^vault backup:/])).size).toBe(0);
});

test("listCommits excludes merge commits — bare 'Merge pull request …' bullets pad the recap with no file changes (audit 2026-07-11)", async () => {
  const iso = (h: number) => new Date(2026, 6, 6, h, 0).toISOString();
  const gitAt = async (repo: string, args: string[], at: string) => {
    const p = Bun.spawn(["git", "-C", repo, ...args], {
      env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at,
        GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_EMAIL: "test@example.com" } as Record<string, string>,
      stdout: "pipe", stderr: "pipe" });
    await p.exited;
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
  };
  const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: iso(9) }]);
  await runGit(["checkout", "-q", "-b", "feature"], repo);
  writeFileSync(join(repo, "feat.txt"), "f");
  await gitAt(repo, ["add", "."], iso(10));
  await gitAt(repo, ["commit", "-q", "-m", "add feat.txt"], iso(10));
  await runGit(["checkout", "-q", "main"], repo);
  await gitAt(repo, ["merge", "--no-ff", "-m", "Merge pull request #1 from feature", "feature"], iso(11));

  const start = localMidnight(new Date(2026, 6, 6)), end = localMidnight(new Date(2026, 6, 7));
  const acts = await listCommits(repo, start, end, { emails: ["test@example.com"] });
  const subjects = acts.map((a) => a.text);
  expect(subjects).toContain("add base.txt");            // real work kept
  expect(subjects).toContain("add feat.txt");            // real work kept
  expect(subjects.some((s) => (s ?? "").startsWith("Merge pull request"))).toBe(false); // merge collapsed out
  // committerDaysWithCommits still counts the day (conservative — no window regression):
  const days = await committerDaysWithCommits(repo, { emails: ["test@example.com"] }, 400);
  expect(days.has(localMidnight(new Date(2026, 6, 6)).getTime())).toBe(true);
});

// Dirty a file and `git stash` it with the given committer/author date.
async function stashAt(repo: string, date: Date): Promise<void> {
  writeFileSync(join(repo, "a.txt"), "changed");
  const p = Bun.spawn(["git", "stash"], { cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: date.toISOString(), GIT_COMMITTER_DATE: date.toISOString() } as Record<string, string>,
    stdout: "pipe", stderr: "pipe" });
  await p.exited;
}

test("listCommits excludes refs/stash entries — a stash is resumption state, not commits you made (phantom 'WIP on…' bug)", async () => {
  const now = new Date();
  const repo = await buildRepo([
    { file: "a.txt", content: "a", isoDate: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0).toISOString() },
  ]);
  await stashAt(repo, now);
  const start = localMidnight(now);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  const acts = await listCommits(repo, start, end, { emails: ["test@example.com"] });
  expect(acts.map((a) => a.text)).toEqual(["add a.txt"]); // no "WIP on …" / "index on …"
});

test("committerDaysWithCommits does not count a stash-only day as a commit-day (window skew)", async () => {
  const now = new Date();
  const old = new Date(now.getTime() - 10 * 864e5);
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: old.toISOString() }]);
  await stashAt(repo, now);
  const days = await committerDaysWithCommits(repo, { emails: ["test@example.com"] }, 30);
  expect(days.has(localMidnight(now).getTime())).toBe(false); // stash-only day must not count
  expect(days.has(localMidnight(old).getTime())).toBe(true);  // real commit-day still counts
});

test("uncommittedFiles returns discrete paths incl. one containing ', '", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dba-unc-"));
  await runGit(["init", "-q", "-b", "main"], dir);
  await runGit(["config", "user.email", "t@e.com"], dir);
  await runGit(["config", "user.name", "T"], dir);
  writeFileSync(join(dir, "weird, name.txt"), "x");
  writeFileSync(join(dir, "b.txt"), "y");
  const files = await uncommittedFiles(dir);
  expect(files).toContain("weird, name.txt");
  expect(files).toContain("b.txt");
  // wrapper still returns the identical joined string
  expect(await uncommittedFileList(dir)).toBe(files.slice().sort().join(", "));
});

test("resumptionSignals stores meta.uncommittedFiles on the uncommitted activity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dba-unc2-"));
  await runGit(["init", "-q", "-b", "main"], dir);
  await runGit(["config", "user.email", "t@e.com"], dir);
  await runGit(["config", "user.name", "T"], dir);
  writeFileSync(join(dir, "a.txt"), "x");
  await runGit(["add", "."], dir);
  await runGit(["commit", "-q", "-m", "init"], dir);
  writeFileSync(join(dir, "a.txt"), "changed");
  const acts = await resumptionSignals(dir);
  const unc = acts.find((a) => a.kind === "uncommitted");
  expect(unc?.meta?.uncommittedFiles).toEqual(["a.txt"]);
});

test("resumptionSignals: real ahead-N via a bare 'remote' + push -u + a local-only commit, on a CLEAN tree", async () => {
  // Design's named-uncovered git path: a real ahead/behind, computed by git itself against a
  // real upstream — not a hand-built meta.aheadBehind.
  const bareDir = mkdtempSync(join(tmpdir(), "dba-bare-"));
  await runGit(["init", "-q", "--bare", "-b", "main"], bareDir);
  const repo = await buildRepo([
    { file: "a.txt", content: "a", isoDate: new Date(2026, 6, 6, 9, 0).toISOString() },
  ]);
  await runGit(["remote", "add", "origin", bareDir], repo);
  await runGit(["push", "-q", "-u", "origin", "main"], repo);
  // A local-only commit, never pushed → exactly 1 ahead, 0 behind, tree stays clean.
  await commitFiles(repo, ["b.txt"], { isoDate: new Date(2026, 6, 6, 10, 0).toISOString() });

  const acts = await resumptionSignals(repo);
  expect(acts.some((a) => a.kind === "uncommitted")).toBe(false); // clean tree — no uncommitted activity
  const branch = acts.find((a) => a.kind === "branch");
  expect(branch).toBeDefined();
  expect(branch!.meta?.aheadBehind).toEqual({ ahead: 1, behind: 0 });
  expect(branch!.meta?.dirty).toBe(false);
});

test("listPrMerges: parses GitHub PR-merge subjects (pr# + owner-stripped branch), excludes pull-noise merges + non-merge commits", async () => {
  const day = (h: number) => new Date(2026, 6, 6, h, 0).toISOString(); // Jul 6 local
  const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: day(9) }]);
  // A real GitHub PR landing: feature branch → --no-ff merge with GitHub's default subject.
  await branchCommit(repo, "feat-cool", "f.txt", day(10));
  await mergeBranchWith(repo, "feat-cool", "Merge pull request #42 from acme/feat/cool-thing", day(11));
  // A `git pull` noise merge (the padding PR #66 removed) — must NOT be surfaced.
  await branchCommit(repo, "side", "s.txt", day(12));
  await mergeBranchWith(repo, "side", "Merge remote-tracking branch 'origin/main'", day(13));

  const start = localMidnight(new Date(2026, 6, 6));
  const end = localMidnight(new Date(2026, 6, 7));
  const merges = await listPrMerges(repo, start, end, { emails: ["test@example.com"] });
  // Only the PR-merge, parsed: pr#42, branch "feat/cool-thing" (owner "acme/" stripped). Noise + plain commits excluded.
  expect(merges.map((m) => ({ prNum: m.prNum, branch: m.branch }))).toEqual([{ prNum: "42", branch: "feat/cool-thing" }]);
  expect(merges[0]!.sha.length).toBeGreaterThan(0);
});

test("listPrMerges: window-filters by committer date (a merge before [start,end) is excluded)", async () => {
  const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: new Date(2026, 6, 1, 9, 0).toISOString() }]);
  await branchCommit(repo, "feat-x", "x.txt", new Date(2026, 6, 1, 10, 0).toISOString());
  await mergeBranchWith(repo, "feat-x", "Merge pull request #7 from o/feat/x", new Date(2026, 6, 1, 11, 0).toISOString()); // Jul 1
  const start = localMidnight(new Date(2026, 6, 6)); // window Jul 6 — merge is Jul 1
  const end = localMidnight(new Date(2026, 6, 7));
  expect(await listPrMerges(repo, start, end, { emails: ["test@example.com"] })).toEqual([]);
});

test("runGit bounds every git call with a Bun.spawn timeout + SIGKILL (a hung mount can't block forever) [Tier-3 #7]", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  const spy = spyOn(Bun, "spawn");
  try {
    await runGit(["--version"], repo);
    const gitCall = spy.mock.calls.find((c) => Array.isArray(c[0]) && (c[0] as string[])[0] === "git");
    const opts = gitCall?.[1] as { timeout?: number; killSignal?: unknown } | undefined;
    expect(opts?.timeout).toBeGreaterThan(0);        // wired (would be undefined without the fix)
    expect(opts?.killSignal).toBe("SIGKILL");
  } finally { spy.mockRestore(); }
});

test("authorArgs filters empty entries — an empty email must NOT become --author= (which matches EVERY commit) [Tier-5]", () => {
  expect(authorArgs({ emails: [""] })).toEqual([]);
  expect(authorArgs({ emails: ["", "  "], names: [""] })).toEqual([]);
  expect(authorArgs({ emails: ["a@b.com", ""] })).toEqual(["--fixed-strings", "--author=a@b.com"]);
});

test("resolveAuthor: an all-empty author config falls back to the repo's git identity, not 'match everyone' [Tier-5]", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  // {emails:[""]} must NOT count as "an author is explicitly set" — otherwise the git-config fallback
  // is skipped and authorArgs then yields no filter = every committer credited. Fall back to user.email.
  expect(await resolveAuthor(repo, { emails: [""] })).toEqual({ emails: ["test@example.com"] });
  expect(await resolveAuthor(repo, { emails: ["  "], names: [""] })).toEqual({ emails: ["test@example.com"] });
  // A real identity is still honored as-is (and a mixed config is passed through for authorArgs to clean).
  expect(await resolveAuthor(repo, { emails: ["me@x.com"] })).toEqual({ emails: ["me@x.com"] });
  expect(await resolveAuthor(repo, { emails: ["me@x.com", ""] })).toEqual({ emails: ["me@x.com", ""] });
});

test("uncommittedFiles runs git status with core.optionalLocks=false (won't race an IDE's index.lock) [Tier-5]", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  const spy = spyOn(Bun, "spawn");
  try {
    await uncommittedFiles(repo);
    const statusArgs = spy.mock.calls.map((c) => c[0] as unknown as string[]).find((a) => Array.isArray(a) && a[0] === "git" && a.includes("status"));
    expect(statusArgs?.join(" ")).toContain("core.optionalLocks=false");
  } finally { spy.mockRestore(); }
});

// ---- Tier-5 batch 4: git.ts correctness/perf lows ----
const isoAgo = (days: number) => new Date(Date.now() - days * 864e5).toISOString();

test("displayStatusEntry: quote-aware rename split — a ' -> ' inside a quoted old path doesn't garble the new name [Tier-5]", () => {
  // old path contains ' -> ' (so git C-quotes it); the real separator is AFTER the closing quote
  expect(displayStatusEntry('"weird -> name.txt" -> renamed.txt')).toBe("renamed.txt");
  // both sides quoted AND both contain ' -> '
  expect(displayStatusEntry('"a -> b.txt" -> "c -> d.txt"')).toBe("c -> d.txt");
  // plain unquoted rename
  expect(displayStatusEntry("old.txt -> new.txt")).toBe("new.txt");
  // quoted new name is unquoted
  expect(displayStatusEntry('old.txt -> "new name.txt"')).toBe("new name.txt");
  // non-rename entry (no separator) passes through
  expect(displayStatusEntry("plain.txt")).toBe("plain.txt");
});

test("listCommits decodes a C-quoted numstat RENAME path (order: normalize-then-unquote, not the reverse) [Tier-5]", async () => {
  // A filename with a `"` IS C-quoted by numstat, and a quoted RENAME row is `"old" => "new"` with
  // each side independently quoted — the case that distinguishes the two orderings. unquoting the
  // whole field first mangles it to `"q"uote2.txt`; normalizing (new-side) first then unquoting gives
  // the clean `q"uote2.txt`.
  const repo = await buildRepo([{ file: 'q"uote.txt', content: "x", isoDate: isoAgo(2) }]);
  await runGit(["mv", 'q"uote.txt', 'q"uote2.txt'], repo);
  const d = isoAgo(1);
  const commit = Bun.spawn(["git", "commit", "-q", "-m", "rename quoted"], {
    cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d } as any, stdout: "pipe", stderr: "pipe",
  });
  await commit.exited;
  const acts = await listCommits(repo, new Date(Date.now() - 5 * 864e5), new Date(Date.now() + 864e5), { emails: ["test@example.com"] });
  const files = acts.flatMap((a) => a.meta?.diffstat?.map((d) => d.file) ?? []);
  expect(files).toContain('q"uote2.txt');                   // fully decoded new path
  expect(files.some((f) => f.startsWith('"'))).toBe(false); // NOT the mangled `"q"uote2.txt`
});

test("resumptionSignals reads all stashes in ONE git call — no N+1 `git show` per stash [Tier-5]", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: isoAgo(1) }]);
  await Bun.write(join(repo, "a.txt"), "one"); await runGit(["stash", "-q"], repo);
  await Bun.write(join(repo, "a.txt"), "two"); await runGit(["stash", "-q"], repo);
  const spy = spyOn(Bun, "spawn");
  try {
    const sigs = await resumptionSignals(repo);
    const gitShows = spy.mock.calls.filter((c) => {
      const a = c[0] as string[];
      return a[0] === "git" && a.includes("show");
    }).length;
    expect(gitShows).toBeLessThanOrEqual(1); // only HEAD's shaAndDate uses `git show`; NOT one per stash
    const stashes = sigs.filter((s) => s.kind === "stash");
    expect(stashes.length).toBe(2);
    expect(stashes[0]!.target).toMatch(/^stash@\{\d+\}$/);
    expect(stashes[0]!.meta!.sha).toBeTruthy();
    expect(stashes[0]!.timestamp).toBeTruthy();
    expect(stashes[0]!.text).toMatch(/^stash@\{\d+\}: /); // reconstructed "stash@{N}: <subject>" shape
  } finally {
    spy.mockRestore();
  }
});

test("listCommits / committerDaysWithCommits exclude commits reachable only from refs/remotes (fetched from another machine) [Tier-5]", async () => {
  const repo = await buildRepo([
    { file: "local.txt", content: "l", isoDate: isoAgo(2) },
    { file: "remote.txt", content: "r", isoDate: isoAgo(1) },
  ]);
  // A git note creates a commit under refs/notes/* (authored by the local identity, dated now) that
  // --all would otherwise walk — exercises the --exclude=refs/notes/* half of the change.
  await runGit(["notes", "add", "-m", "a note", "HEAD"], repo);
  // Move the 2nd commit to a remote-tracking ref and rewind local — it now exists ONLY under refs/remotes.
  await runGit(["update-ref", "refs/remotes/origin/main", "HEAD"], repo);
  await runGit(["reset", "-q", "--hard", "HEAD~1"], repo);
  const author = { emails: ["test@example.com"] };
  const acts = await listCommits(repo, new Date(Date.now() - 5 * 864e5), new Date(Date.now() + 864e5), author);
  const subjects = acts.map((a) => a.text ?? "");
  expect(subjects.some((s) => s.includes("local.txt"))).toBe(true);   // local work kept
  expect(subjects.some((s) => s.includes("remote.txt"))).toBe(false); // fetched work (refs/remotes) excluded
  expect(subjects.some((s) => /Notes added/i.test(s))).toBe(false);   // git-notes commit (refs/notes) excluded
  // the fetched day must also not enter the shared window's commit-day set
  const days = await committerDaysWithCommits(repo, author, 5);
  expect(days.has(localMidnight(new Date(Date.now() - 2 * 864e5)).getTime())).toBe(true);  // local day counted
  expect(days.has(localMidnight(new Date(Date.now() - 1 * 864e5)).getTime())).toBe(false); // fetched day not counted
});

// ── day-21: upstream vs parity, and default-branch resolution (real git, no stubs) ───────────────
test("a branch with NO UPSTREAM says so — it must not render as '(ahead 0, behind 0)'", async () => {
  // ⚠ MEASURED: `git rev-list ...@{u}` exits 128 with no upstream, and git.ts swallows that, leaving
  // ahead/behind at 0 — byte-identical to genuine parity. So a purely local branch used to render
  // "(ahead 0, behind 0)", which reads as "in sync with origin": a FALSE SYNC CLAIM, the day-16 B3
  // family. Driven through real git because the bug lives in the interaction with git's exit code,
  // and a fixture that hands `hasUpstream` in would assert nothing about production.
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  await Bun.$`git -C ${repo} checkout -q -b feature/local-only`.quiet();
  const acts = await resumptionSignals(repo);
  const b = acts.find((a) => a.kind === "branch");
  expect(b).toBeDefined();
  expect(b!.text).toContain("no upstream");
  expect(b!.text).not.toContain("ahead 0, behind 0");
  expect(b!.meta?.hasUpstream).toBe(false);
});

test("⚠ a branch WITH an upstream reports hasUpstream true — the positive half", async () => {
  // Without this, deleting `hasUpstream = true` leaves every branch looking upstream-less and the
  // no-upstream test above still passes (it asserts false). MEASURED: that mutant survived until
  // this case existed. A real clone is the only way to get a genuine upstream.
  const origin = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  const clone = mkdtempSync(join(tmpdir(), "dba-clone-"));
  await Bun.$`git clone -q ${origin} ${clone}`.quiet();
  const b = (await resumptionSignals(clone)).find((a) => a.kind === "branch");
  expect(b?.meta?.hasUpstream).toBe(true);
  expect(b!.text).toContain("ahead 0, behind 0");     // a REAL parity claim, not a missing upstream
  expect(b!.text).not.toContain("no upstream");
  // …and a clone always has origin/HEAD, so the default-branch resolution uses it rather than the
  // heuristic — the path that makes this correct for `trunk`/`develop` users.
  expect(b?.meta?.isDefaultBranch).toBe(true);
});

test("⚠ origin/HEAD recognises a NON-conventional default (`trunk`) — the heuristic cannot", async () => {
  // THE test the origin/HEAD mechanism exists for, and it was missing: every prior fixture used a
  // `main` clone, which the main/master fallback also answers true for, so rewriting the ref name so
  // `symbolic-ref` never resolves left the whole mechanism dead with 1020 tests green (MEASURED).
  const origin = mkdtempSync(join(tmpdir(), "dba-trunk-origin-"));
  await Bun.$`git init -q --bare ${origin}`.quiet();
  // ⚠ The BARE repo's own HEAD must name trunk too. Without this the clone warns "remote HEAD refers
  // to nonexistent ref", checks nothing out, and origin/HEAD comes back UNSET — the fixture then
  // silently tests the fallback instead of the mechanism it is named for.
  await Bun.$`git -C ${origin} symbolic-ref HEAD refs/heads/trunk`.quiet();
  const seed = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  await Bun.$`git -C ${seed} branch -M trunk`.quiet();
  await Bun.$`git -C ${seed} remote add origin ${origin}`.quiet();
  await Bun.$`git -C ${seed} push -q -u origin trunk`.quiet();
  const clone = mkdtempSync(join(tmpdir(), "dba-trunk-clone-"));
  await Bun.$`git clone -q ${origin} ${clone}`.quiet();
  const onTrunk = (await resumptionSignals(clone)).find((a) => a.kind === "branch");
  expect(onTrunk?.target).toBe("trunk");
  expect(onTrunk?.meta?.isDefaultBranch).toBe(true);      // only origin/HEAD can know this
  await Bun.$`git -C ${clone} checkout -q -b feature/x`.quiet();
  const onFeature = (await resumptionSignals(clone)).find((a) => a.kind === "branch");
  expect(onFeature?.meta?.isDefaultBranch).toBe(false);   // …and it still says NO for a real feature branch
});

test("⚠ a STALE origin/HEAD does not override the heuristic — the master→main rename case", async () => {
  // `origin/HEAD` is written at clone time and NOT refreshed by `git fetch`. MEASURED: after an
  // upstream master→main rename, a pre-rename clone still reports `origin/master`, so letting it win
  // outright marked a user on `main` as non-default and produced a permanent daily false bullet —
  // worse than the hardcoded list it replaced. The union is what makes that impossible.
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  await Bun.$`git -C ${repo} branch -M main`.quiet();
  // Forge exactly the stale state: origin/HEAD naming a branch that is no longer the default.
  await Bun.$`git -C ${repo} update-ref refs/remotes/origin/master HEAD`.quiet();
  await Bun.$`git -C ${repo} symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master`.quiet();
  const b = (await resumptionSignals(repo)).find((a) => a.kind === "branch");
  expect(b?.target).toBe("main");
  expect(b?.meta?.isDefaultBranch).toBe(true);            // heuristic still answers, so: silent
});

test("a repo with no origin/HEAD falls back to the main/master heuristic", async () => {
  // The fallback is what makes `origin/HEAD` strictly a superset of a hardcoded list: when it is
  // unset (a repo created with `git init` rather than cloned) the worst case is exactly the
  // heuristic, never worse.
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  const onDefault = (await resumptionSignals(repo)).find((a) => a.kind === "branch");
  expect(onDefault?.meta?.isDefaultBranch).toBe(true);      // buildRepo's branch is main/master
  await Bun.$`git -C ${repo} checkout -q -b some/feature`.quiet();
  const onFeature = (await resumptionSignals(repo)).find((a) => a.kind === "branch");
  expect(onFeature?.meta?.isDefaultBranch).toBe(false);
  // …and the `master` half of the heuristic, which was untested (deleting it left the suite green).
  await Bun.$`git -C ${repo} checkout -q -b master`.quiet();
  const onMaster = (await resumptionSignals(repo)).find((a) => a.kind === "branch");
  expect(onMaster?.meta?.isDefaultBranch).toBe(true);
});
