// test/fixtures/build-repo.ts — makes a throwaway git repo with commits at chosen committer dates.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function git(args: string[], cwd: string, env: Record<string,string> = {}) {
  const p = Bun.spawn(["git", ...args], { cwd, env: { ...process.env, ...env } as any, stdout: "pipe", stderr: "pipe" });
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
}

async function gitOut(args: string[], cwd: string, env: Record<string,string> = {}): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, env: { ...process.env, ...env } as any, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
  return out;
}

/** commits: [{ file, content, isoDate, email }] committed in order at the given committer+author date. */
export async function buildRepo(commits: { file: string; content: string; isoDate: string; email?: string }[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dba-repo-"));
  await git(["init", "-q", "-b", "main"], dir);
  await git(["config", "user.name", "Test"], dir);
  await git(["config", "user.email", "test@example.com"], dir);
  for (const c of commits) {
    await Bun.write(join(dir, c.file), c.content);
    await git(["add", "."], dir);
    const email = c.email ?? "test@example.com";
    await git(["commit", "-q", "-m", `add ${c.file}`], dir, {
      GIT_AUTHOR_DATE: c.isoDate, GIT_COMMITTER_DATE: c.isoDate,
      GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email,
    });
  }
  return dir;
}

/** Stage + commit MULTIPLE files in ONE real commit (in an existing repo, e.g. from buildRepo or a
 *  hand-init'd dir) — so a consumer's diffstat-plurality logic (unitForCommit's majority-root vote)
 *  is exercised against a REAL `listCommits()` diffstat, not a hand-built `Activity.meta.diffstat`
 *  array. Returns the new commit's SHA. */
export async function commitFiles(
  repo: string,
  files: string[],
  opts: { content?: string; message?: string; isoDate?: string; email?: string } = {},
): Promise<string> {
  const isoDate = opts.isoDate ?? new Date().toISOString();
  const email = opts.email ?? "test@example.com";
  for (const f of files) {
    await Bun.write(join(repo, f), opts.content ?? f);
  }
  await git(["add", "."], repo);
  const message = opts.message ?? `commit ${files.length} file(s)`;
  await git(["commit", "-q", "-m", message], repo, {
    GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate,
    GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email,
  });
  return (await gitOut(["rev-parse", "HEAD"], repo)).trim();
}

/** Create `branch` off the current HEAD, commit one file on it at `isoDate`, then check `base` back out.
 *  Composable with mergeBranchWith to build a real merge commit for merge-handling tests. */
export async function branchCommit(
  repo: string, branch: string, file: string, isoDate: string, base = "main", email = "test@example.com",
): Promise<void> {
  await git(["checkout", "-q", "-b", branch], repo);
  await Bun.write(join(repo, file), file);
  await git(["add", "."], repo);
  await git(["commit", "-q", "-m", `work on ${file}`], repo, {
    GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email,
  });
  await git(["checkout", "-q", base], repo);
}

/** Merge `branch` into the current branch (--no-ff, real merge commit) with an EXPLICIT subject at
 *  `isoDate` — lets a test forge a GitHub "Merge pull request #N from …" subject or a `git pull`
 *  "Merge remote-tracking branch …" noise subject. */
export async function mergeBranchWith(
  repo: string, branch: string, subject: string, isoDate: string, email = "test@example.com",
): Promise<void> {
  await git(["merge", "--no-ff", "-m", subject, branch], repo, {
    GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email,
  });
}
