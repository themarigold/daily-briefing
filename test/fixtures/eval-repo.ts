// test/fixtures/eval-repo.ts — builds a synthetic git repo from a RepoSpec (src/eval/types.ts)
// for the eval harness: one commit per CommitSpec (dated by committer date, which is what the
// briefing window keys on), an out-of-window setup commit for the workspace manifest + uncommitted
// placeholders, and untracked files for `uncommitted` paths.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RepoSpec } from "../../src/eval/types";

const GIT_ISOLATION_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

async function git(args: string[], cwd: string, env: Record<string, string> = {}): Promise<void> {
  const p = Bun.spawn(["git", ...args], {
    cwd, env: { ...process.env, ...GIT_ISOLATION_ENV, ...env } as any, stdout: "pipe", stderr: "pipe",
  });
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
}

async function gitOut(args: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(["git", ...args], {
    cwd, env: { ...process.env, ...GIT_ISOLATION_ENV, ...env } as any, stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
  return out;
}

/** Absolute-instant ISO date `daysAgo` days before now, pinned to local noon (avoids DST/midnight
 *  edge cases while still landing unambiguously in the intended committer-local day).
 *
 *  ⚠ `minutesAfter` exists for ONE reason and it is load-bearing for the `recency` rule (G7): noon is
 *  an EXACT pin, so two commits with the same `daysAgo` get BYTE-IDENTICAL timestamps. A rule whose
 *  whole question is "did RESUME anchor on the newest same-day work?" cannot be exercised by a
 *  fixture in which no same-day commit is newer than another. Default 0 keeps every existing case's
 *  timestamps unchanged — this must stay additive, because several cases assert on commit ordering. */
function dateFor(daysAgo: number, minutesAfter = 0): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  d.setMinutes(d.getMinutes() + minutesAfter);
  return d.toISOString();
}

/** Builds a throwaway git repo per `spec` and returns:
 *  - `dir`: the repo path
 *  - `shaToUnit`: each authored commit's SHA → the repo + its spec's `expectUnit`
 *  - `commitMessages`: each authored commit's SHA → its commit message
 *  - `shaToDaysAgo`: each authored commit's SHA → its `daysAgo` (so run-case integrity can
 *    require in-window SHAs in ctx and same-day SHAs in today/todaySuppress — not both)
 *  The setup commit (workspace manifest + `.gitkeep` placeholders) is dated far outside any
 *  realistic lookback window (`dateFor(40)`) so it never enters the scored window itself. */
export async function buildEvalRepo(spec: RepoSpec): Promise<{
  dir: string;
  shaToUnit: Map<string, { repo: string; root: string | null }>;
  commitMessages: Map<string, string>;
  shaToDaysAgo: Map<string, number>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "dba-eval-repo-"));
  await git(["init", "-q", "-b", "main"], dir);
  await git(["config", "user.name", "Eval Bot"], dir);
  await git(["config", "user.email", "eval@example.com"], dir);

  // Setup commit: workspace manifest files + one .gitkeep per immediate parent dir of each
  // `uncommitted` path (so `git status --porcelain` — no `-u` — lists the leaf path un-collapsed,
  // not the collapsed ancestor). Dated OUT of window so it can't poison shaToUnit / the ctx window.
  const setupFiles: string[] = [];
  for (const [path, content] of Object.entries(spec.workspaceManifest ?? {})) {
    await Bun.write(join(dir, path), content);
    setupFiles.push(path);
  }
  for (const path of spec.uncommitted ?? []) {
    const keep = join(dirname(path), ".gitkeep");
    await Bun.write(join(dir, keep), "");
    setupFiles.push(keep);
  }
  if (setupFiles.length > 0) {
    await git(["add", "--", ...setupFiles], dir);
    const setupDate = dateFor(40);
    await git(["commit", "-q", "-m", "eval: setup"], dir, {
      GIT_AUTHOR_DATE: setupDate, GIT_COMMITTER_DATE: setupDate,
    });
  }

  const shaToUnit = new Map<string, { repo: string; root: string | null }>();
  const commitMessages = new Map<string, string>();
  const shaToDaysAgo = new Map<string, number>();
  for (const c of spec.commits) {
    for (const f of c.files) {
      await Bun.write(join(dir, f), c.content ?? f);
    }
    // A no-files commit is a REAL shape (`git commit --allow-empty`, e.g. "chore: trigger CI") and it
    // is the one that breaks D4a's date placement, because generator.ts's files suffix is conditional.
    // The fixture could not build one: `git add --` with no paths stages nothing and exits 0, then
    // `git commit` fails "nothing to commit" (exit 1) and this helper throws.
    if (c.files.length > 0) await git(["add", "--", ...c.files], dir);
    const message = c.message ?? `commit ${c.files.join(", ")}`;
    const commitDate = dateFor(c.daysAgo, c.minutesAfter ?? 0);
    await git(["commit", "-q", ...(c.files.length ? [] : ["--allow-empty"]), "-m", message], dir, {
      GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate,
    });
    const sha = (await gitOut(["rev-parse", "HEAD"], dir)).trim();
    shaToUnit.set(sha, { repo: dir, root: c.expectUnit });
    commitMessages.set(sha, message);
    shaToDaysAgo.set(sha, c.daysAgo);
  }

  // Untracked files last, so they never end up staged/committed by an earlier `git add`.
  for (const path of spec.uncommitted ?? []) {
    await Bun.write(join(dir, path), "uncommitted");
  }

  return { dir, shaToUnit, commitMessages, shaToDaysAgo };
}
