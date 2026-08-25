// test/git.local-work-refs.test.ts — WHICH refs count as "your work".
//
// `LOCAL_WORK_REFS` was `--all` minus three exclusions until 2026-08-11. `--all` means every ref
// under `refs/`, and third-party tools write there — so the exclusions were right about what to
// drop and wrong about how. This file pins the allowlist against the case that broke it live and
// against the two ways an allowlist can silently lose real work.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCommits, LOCAL_WORK_REFS } from "../src/git";

async function git(args: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
  return out.trim();
}

async function repoWithCommit(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dba-refs-"));
  await git(["init", "-q", "-b", "main"], dir);
  await git(["config", "user.name", "Test"], dir);
  await git(["config", "user.email", "test@example.com"], dir);
  await Bun.write(join(dir, "a.ts"), "x");
  await git(["add", "."], dir);
  await git(["commit", "-q", "-m", "real work"], dir);
  return dir;
}

const WIDE = { start: new Date(Date.now() - 30 * 86_400_000), end: new Date(Date.now() + 86_400_000) };
const subjects = async (dir: string) =>
  (await listCommits(dir, WIDE.start, WIDE.end, undefined, [])).map((c) => c.text ?? "");

test("⚠ REGRESSION: a STASH-SHAPED commit parked under a third-party ref namespace is not work", async () => {
  // THE LIVE CASE, reproduced by its real mechanism. Cline (an editor extension) writes checkpoints
  // to `refs/cline/checkpoints/<session>/<n>`, and they are stash-shaped. `--exclude=refs/stash`
  // could not see them, so the day-26 briefing shipped
  // `index on fix/escalation-poison-pill: 8cefd594 …` as a "Today so far" item BESIDE the real
  // commit it wraps. Verified on the real repo: `git for-each-ref --contains 1623e2cb` resolved to
  // exactly that cline ref.
  //
  // ⚠ The ref namespace here is arbitrary ON PURPOSE. The point is not that `refs/cline` is bad —
  // it is that an allowlist does not need to know the name. A subject-shaped filter
  // (`^(index|WIP) on `) would pass this test and still let the next tool's differently-shaped ref
  // straight through, which is why the fix is the ref set and not a regex.
  const dir = await repoWithCommit();
  await git(["stash", "push", "-u", "-q", "-m", "checkpoint"], dir).catch(() => {});
  await Bun.write(join(dir, "b.ts"), "staged");
  await git(["add", "."], dir);
  await git(["stash", "push", "-q", "-m", "cline checkpoint session=1"], dir);
  const stashSha = await git(["rev-parse", "refs/stash"], dir);
  // Park it OUTSIDE refs/stash, exactly as the extension does, then drop the stash ref so the only
  // thing keeping it alive is the foreign namespace.
  await git(["update-ref", "refs/cline/checkpoints/session1/1", stashSha], dir);
  await git(["stash", "drop", "-q"], dir).catch(() => {});

  const got = await subjects(dir);
  expect(got).toContain("real work");
  expect(got.some((s) => /^(index|WIP) on /.test(s))).toBe(false);
  expect(got.some((s) => s.includes("cline checkpoint"))).toBe(false);
});

test("⚠ a DETACHED HEAD's commits still count — the allowlist's most dangerous omission", async () => {
  // `--all` includes HEAD (git's docs: "all the refs in refs/, along with HEAD"). An allowlist of
  // `--branches --tags` alone drops it, and the loss is invisible: the briefing simply reports less
  // work with no error. MEASURED before this test was written — `--branches --tags` reported only
  // the branch commit on a detached checkout.
  const dir = await repoWithCommit();
  const sha = await git(["rev-parse", "HEAD"], dir);
  await git(["checkout", "-q", "--detach", sha], dir);
  await Bun.write(join(dir, "c.ts"), "y");
  await git(["add", "."], dir);
  await git(["commit", "-q", "-m", "detached work"], dir);

  const got = await subjects(dir);
  expect(got).toContain("detached work");
  expect(got).toContain("real work");
});

test("⚠ an UNBORN HEAD does not throw — `--ignore-missing` is load-bearing, not dressing", async () => {
  // `git init` with no commit: bare `HEAD` is an unknown revision and git exits 128 with
  // `fatal: ambiguous argument 'HEAD'`, where the old `--all` form exited 0 with empty output.
  // That is the brand-new-repo-with-staged-work case the extractor exists to reach. Without the
  // flag this test throws instead of returning [].
  expect(LOCAL_WORK_REFS).toContain("--ignore-missing");
  const dir = mkdtempSync(join(tmpdir(), "dba-unborn-"));
  await git(["init", "-q", "-b", "main"], dir);
  await git(["config", "user.name", "Test"], dir);
  await git(["config", "user.email", "test@example.com"], dir);
  expect(await subjects(dir)).toEqual([]);
});

test("remote-only commits are still excluded — by construction now, not by an exclusion", async () => {
  // The briefing claims LOCAL activity on THIS machine only. Under `--all` that took an explicit
  // `--exclude=refs/remotes/*`; the allowlist drops the whole namespace without naming it. Pinned
  // because "we no longer need that exclusion" is the kind of claim that should fail a test if wrong.
  const origin = await repoWithCommit();
  await Bun.write(join(origin, "d.ts"), "z");
  await git(["add", "."], origin);
  await git(["commit", "-q", "-m", "work from another machine"], origin);

  const clone = mkdtempSync(join(tmpdir(), "dba-clone-"));
  await git(["clone", "-q", "--no-checkout", origin, clone], tmpdir());
  await git(["config", "user.name", "Test"], clone);
  await git(["config", "user.email", "test@example.com"], clone);
  // ⚠ `git clone` CREATES A LOCAL BRANCH at the remote tip, so the newer commit starts out on
  // `refs/heads/main` and is legitimately local work. A first draft of this test stopped here and
  // failed for that reason — the code was right and the fixture was wrong. Branch off the older
  // commit, then DELETE `main`, so "work from another machine" survives only via refs/remotes.
  await git(["checkout", "-q", "-B", "local-only", "HEAD~1"], clone);
  await git(["branch", "-q", "-D", "main"], clone);

  const got = await subjects(clone);
  expect(got).toContain("real work");
  expect(got).not.toContain("work from another machine");
});
