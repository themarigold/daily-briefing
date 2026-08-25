// test/extractor.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepo, branchCommit, mergeBranchWith } from "./fixtures/build-repo";
import { resumptionSignals, runGit } from "../src/git";
import { gitActivity } from "../src/extractor";
import { blockedDelivery } from "../src/core";
import { eventIdFor } from "../src/eventId";

const yesterdayISO = () => new Date(Date.now() - 864e5).toISOString(); // ~yesterday, always prior local day

test("resumptionSignals reports uncommitted changes and current branch", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  await Bun.write(`${repo}/a.txt`, "changed");        // dirty
  await Bun.write(`${repo}/new.txt`, "new");          // untracked
  const sigs = await resumptionSignals(repo);
  const kinds = sigs.map((s) => s.kind).sort();
  expect(kinds).toContain("branch");
  expect(kinds).toContain("uncommitted");
  const unc = sigs.find((s) => s.kind === "uncommitted")!;
  expect(unc.event_id.length).toBeGreaterThan(0);
  expect(String(unc.text)).toContain("a.txt");
});

// helper: run git with controlled commit dates (for stash date tests)
async function gitEnv(args: string[], cwd: string, env: Record<string, string>) {
  const p = Bun.spawn(["git", ...args], { cwd, env: { ...process.env, ...env } as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
}

test("resumptionSignals timestamps the branch with the tip's committer date, not run time (§5.2 drift)", async () => {
  const iso = new Date(Date.now() - 3 * 864e5).toISOString(); // 3 days ago — clearly not "now"
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: iso }]);
  const branch = (await resumptionSignals(repo)).find((s) => s.kind === "branch");
  expect(branch).toBeDefined();
  // git commit dates are second-granular (%cI); compare at seconds, not the fixture's ms.
  const secs = (t: string) => Math.floor(new Date(t).getTime() / 1000);
  expect(secs(branch!.timestamp!)).toBe(secs(iso));
});

test("resumptionSignals sets the branch dirty flag from the working tree (§5.2 drift)", async () => {
  const iso = new Date(Date.now() - 3 * 864e5).toISOString();
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: iso }]);
  const clean = (await resumptionSignals(repo)).find((s) => s.kind === "branch");
  expect(clean?.meta?.dirty).toBe(false);
  await Bun.write(`${repo}/a.txt`, "changed");
  const dirty = (await resumptionSignals(repo)).find((s) => s.kind === "branch");
  expect(dirty?.meta?.dirty).toBe(true);
});

test("resumptionSignals timestamps a stash with the stash's own date, not run time (§5.2 drift)", async () => {
  const iso = new Date(Date.now() - 3 * 864e5).toISOString();
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: iso }]);
  await Bun.write(`${repo}/a.txt`, "changed");
  const stashDate = new Date(Date.now() - 2 * 864e5).toISOString(); // 2 days ago
  await gitEnv(["stash"], repo, { GIT_COMMITTER_DATE: stashDate, GIT_AUTHOR_DATE: stashDate });
  const stash = (await resumptionSignals(repo)).find((s) => s.kind === "stash");
  expect(stash).toBeDefined();
  // stash commit dates are second-granular (%cI); compare at seconds, not the fixture's ms.
  const secs = (t: string) => Math.floor(new Date(t).getTime() / 1000);
  expect(secs(stash!.timestamp!)).toBe(secs(stashDate));
});

test("resumptionSignals captures a stash", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  await Bun.write(`${repo}/a.txt`, "changed");
  await runGit(["stash"], repo);
  const sigs = await resumptionSignals(repo);
  expect(sigs.some((s) => s.kind === "stash")).toBe(true);
});

test("resumptionSignals renders a detached HEAD as 'Detached HEAD at <sha7>', not 'On branch HEAD'", async () => {
  // `git rev-parse --abbrev-ref HEAD` literally returns "HEAD" when detached; rendering that
  // verbatim produces the confusing "On branch HEAD (ahead 0, behind 0)".
  const repo = await buildRepo([
    { file: "a.txt", content: "a", isoDate: yesterdayISO() },
    { file: "b.txt", content: "b", isoDate: yesterdayISO() },
  ]);
  const sha = (await runGit(["rev-parse", "HEAD"], repo)).trim();
  await runGit(["checkout", "-q", sha], repo); // detach onto a raw SHA
  const branch = (await resumptionSignals(repo)).find((s) => s.kind === "branch");
  expect(branch).toBeDefined();
  expect(branch!.text).toBe(`Detached HEAD at ${sha.slice(0, 7)}`);
  expect(String(branch!.text)).not.toContain("On branch HEAD");
});

test("eventIdFor derives a stable, per-kind id", () => {
  expect(eventIdFor({ source: "git", kind: "branch", repo: "/r", target: "main", meta: { tip: "abc" } }))
    .toBe("/r:branch:main:abc");
  expect(eventIdFor({ source: "git", kind: "stash", repo: "/r", target: "stash@{0}", meta: { sha: "deadbeef" } }))
    .toBe("/r:stash:stash@{0}:deadbeef"); // spec §5.3: ref + its SHA, so a reused ref doesn't collide across pushes
  const u1 = eventIdFor({ source: "git", kind: "uncommitted", repo: "/r", text: "a" });
  const u2 = eventIdFor({ source: "git", kind: "uncommitted", repo: "/r", text: "a" });
  expect(u1).toBe(u2); // deterministic
});

test("gitActivity surfaces an in-window commit through the shared window (not just a resumption signal)", async () => {
  const good = await buildRepo([{ file: "y.txt", content: "y", isoDate: yesterdayISO() }]);
  const cfg = { provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  const { activities } = await gitActivity(cfg, [good]);
  // asserts the window-union + committer-date extraction actually worked, not just the always-present branch signal
  expect(activities.some((a) => a.kind === "commit" && a.text?.includes("y.txt"))).toBe(true);
});

test("gitActivity skips a non-git dir into warnings, keeps a good repo", async () => {
  const good = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cfg = { provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  const { activities, warnings } = await gitActivity(cfg, [good, "/definitely/not/a/repo"]);
  expect(warnings.some((w) => w.includes("/definitely/not/a/repo"))).toBe(true);
  expect(activities.length).toBeGreaterThan(0);
});

test("gitActivity classifies an injected TCC-blocked repo as tcc-denied, warns with the FDA fix, and keeps other repos", async () => {
  const good = await buildRepo([{ file: "y.txt", content: "y", isoDate: yesterdayISO() }]);
  const blocked = "/Users/me/Desktop/blocked-repo";
  const cfg = { provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  const probe = async (repo: string) => (repo === blocked ? ({ code: "EPERM" } as NodeJS.ErrnoException) : null);
  const { activities, warnings, issues } = await gitActivity(cfg, [good, blocked], {
    probe, platform: "darwin", protectedRoots: ["/Users/me/Desktop"],
  });
  expect(issues.some((i) => i.kind === "tcc-denied" && i.path === blocked)).toBe(true);
  expect(warnings.some((w) => w.includes(blocked) && /Full Disk Access|Files & Folders/.test(w))).toBe(true);
  expect(activities.some((a) => a.kind === "commit" && a.text?.includes("y.txt"))).toBe(true);
});

test("gitActivity surfaces an unreadable (EACCES) repo as a non-TCC warning and continues", async () => {
  const good = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const bad = "/some/eacces/dir";
  const cfg = { provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  const probe = async (repo: string) => (repo === bad ? ({ code: "EACCES" } as NodeJS.ErrnoException) : null);
  const { activities, warnings, issues } = await gitActivity(cfg, [good, bad], { probe, platform: "darwin" });
  expect(issues.some((i) => i.kind === "unreadable" && i.path === bad)).toBe(true);
  expect(warnings.some((w) => w.includes(bad) && !/Full Disk Access|Files & Folders/.test(w))).toBe(true);
  expect(activities.length).toBeGreaterThan(0);
});

test("gitActivity returns tcc-denied repos in issues (drives the all-blocked check) with no activities when all blocked", async () => {
  const blocked = "/Users/me/Documents/only-repo";
  const cfg = { provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  const probe = async () => ({ code: "EPERM" } as NodeJS.ErrnoException);
  const { activities, issues } = await gitActivity(cfg, [blocked], {
    probe, platform: "darwin", protectedRoots: ["/Users/me/Documents"],
  });
  expect(issues.length).toBe(1);
  expect(issues[0]!.kind).toBe("tcc-denied");
  expect(activities.length).toBe(0);
});

test("resumptionSignals doesn't throw on an unborn-HEAD repo (zero commits): still reports uncommitted, best-effort branch, no stash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dba-empty-repo-"));
  await runGit(["init", "-q", "-b", "main"], dir);
  await runGit(["config", "user.name", "Test"], dir);
  await runGit(["config", "user.email", "test@example.com"], dir);
  await Bun.write(`${dir}/staged.txt`, "work in progress");
  await runGit(["add", "."], dir);
  const sigs = await resumptionSignals(dir);
  expect(sigs.some((s) => s.kind === "uncommitted")).toBe(true);
  expect(sigs.some((s) => s.kind === "stash")).toBe(false);
  // branch name is best-effort via symbolic-ref even with no commits; if it resolves it's "main"
  const branchSig = sigs.find((s) => s.kind === "branch");
  if (branchSig) expect(branchSig.target).toBe("main");
});

test("gitActivity surfaces uncommitted work from a valid repo with ZERO commits (unborn HEAD), and does not mislabel it not-git", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dba-empty-repo-"));
  await runGit(["init", "-q", "-b", "main"], dir);
  await runGit(["config", "user.name", "Test"], dir);
  await runGit(["config", "user.email", "test@example.com"], dir);
  await Bun.write(`${dir}/staged.txt`, "work in progress");
  await runGit(["add", "."], dir); // staged, but no commit exists yet
  const cfg = { provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  const { activities, warnings } = await gitActivity(cfg, [dir]);
  expect(activities.some((a) => a.kind === "uncommitted" && a.repo === dir)).toBe(true);
  expect(warnings.some((w) => w.includes("not-git") && w.includes(dir))).toBe(false);
});

test("gitActivity returns today's commits in `today` (excluded from the window, bot-filtered)", async () => {
  const repo = await buildRepo([{ file: "t.txt", content: "t", isoDate: new Date().toISOString() }]); // committed TODAY
  const cfg = { provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  const { today, activities } = await gitActivity(cfg, [repo]);
  expect(today.some((a) => a.kind === "commit" && a.text === "add t.txt")).toBe(true); // today section has it
  expect(activities.some((a) => a.kind === "commit")).toBe(false);                     // window excludes today
});

test("gitActivity surfaces today's PR-merge in mergedToday, kept OUT of activities/today (no unit pollution)", async () => {
  const iso = new Date().toISOString(); // TODAY
  const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: iso }]);
  await branchCommit(repo, "feat-y", "y.txt", iso);
  await mergeBranchWith(repo, "feat-y", "Merge pull request #77 from acme/feat/y", iso);
  const cfg = { provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  const { activities, today, mergedToday } = await gitActivity(cfg, [repo]);
  expect(mergedToday.map((m) => ({ prNum: m.prNum, branch: m.branch }))).toEqual([{ prNum: "77", branch: "feat/y" }]);
  expect(mergedToday[0]!.timestamp).toBeTruthy();
  expect(Number.isNaN(Date.parse(mergedToday[0]!.timestamp))).toBe(false);
  // A merge carries no --numstat, so it must NOT enter the Activity streams that feed resolveUnits.
  expect(today.some((a) => /Merge pull request/.test(a.text ?? ""))).toBe(false);
  expect(activities.some((a) => /Merge pull request/.test(a.text ?? ""))).toBe(false);
});

test("gitActivity: missing git binary → blocking issue + 'install git' warning, not a silent 'not a repo' + stamp [Tier-3 #12]", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cfg = { provider: { cli: "claude", argv: [], promptVia: "stdin" as const } };
  const r = await gitActivity(cfg as any, [repo], { gitCheck: async () => false }); // simulate git not installed
  expect(r.activities).toHaveLength(0);
  expect(r.issues.some((i) => i.kind === "unreadable")).toBe(true);   // inaccessible → blocks the stamp
  expect(r.warnings.join(" ")).toMatch(/git isn.t runnable/i);
  expect(blockedDelivery(0, r.issues)).toBe(true);                    // → run() returns 1, does NOT stamp today
});

test("gitActivity is deterministic and repo-ordered under concurrency (multi-repo) [Tier-5]", async () => {
  const cfg = { provider: { cli: "c", argv: [], promptVia: "stdin" as const } };
  const repos: string[] = [];
  for (let i = 0; i < 5; i++) {
    repos.push(await buildRepo([{ file: `f${i}.txt`, content: `c${i}`, isoDate: yesterdayISO() }]));
  }
  const run1 = await gitActivity(cfg, repos);
  const run2 = await gitActivity(cfg, repos);
  // every repo is represented
  for (const r of repos) expect(run1.activities.some((a) => a.repo === r)).toBe(true);
  // a repo's activities are contiguous, so first-appearance order must match the INPUT order —
  // the concurrent scan merges results in repo order, not completion order.
  const firstIdx = repos.map((r) => run1.activities.findIndex((a) => a.repo === r));
  expect(firstIdx).toEqual([...firstIdx].sort((a, b) => a - b));
  // and the whole output is stable run-to-run (no race-dependent ordering)
  const shape = (r: typeof run1) => r.activities.map((a) => `${a.repo}:${a.event_id}`);
  expect(shape(run2)).toEqual(shape(run1));
});

test("gitActivity dedupes commits shared by a linked worktree (no double-recap), keeps the worktree's own working state [Tier-A]", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const wtBase = mkdtempSync(join(tmpdir(), "dba-wt-"));
  const wt = join(wtBase, "worktree");
  await runGit(["worktree", "add", "-b", "feature", wt], repo); // shares repo's object store + refs
  await Bun.write(join(repo, "a.txt"), "changed");             // stash a change in the MAIN checkout
  await runGit(["stash"], repo);                               // refs/stash is a SHARED ref (both see it)
  await Bun.write(join(wt, "wip.txt"), "wip");                 // distinct in-progress state in the worktree
  const cfg = { provider: { cli: "c", argv: [], promptVia: "stdin" as const } };
  const { activities } = await gitActivity(cfg, [repo, wt]);
  // the commit is reachable from BOTH checkouts (git log --all) but must appear exactly ONCE
  expect(activities.filter((a) => a.kind === "commit").length).toBe(1);
  // refs/stash is shared across worktrees → the same stash must also appear ONCE
  expect(activities.filter((a) => a.kind === "stash").length).toBe(1);
  // the worktree's own uncommitted state is genuinely per-worktree → NOT deduped, still surfaced
  const wtDirty = activities.filter((a) => a.kind === "uncommitted" && a.repo === wt);
  expect(wtDirty.length).toBe(1);
  expect(String(wtDirty[0]!.text)).toContain("wip.txt");
});
