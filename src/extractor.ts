// src/extractor.ts
import { readdir } from "node:fs/promises";
import type { Activity, Config } from "./types";
import { DEFAULT_LOOKBACK_CAP_DAYS, DEFAULT_EXCLUDE_COMMIT_PATTERNS, compileExcludePatterns } from "./config";
import { windowStart, localMidnight } from "./time";
import { committerDaysWithCommits, listCommits, listPrMerges, patchIds, resumptionSignals, resolveAuthor, gitDirExists, runGit, IncompleteReadError } from "./git";
import { classify, warnFor, type PathIssue, type GuardOpts } from "./protectedPath";
import { homedir } from "node:os";

// A repo-readability probe: returns an errno-ish error if the repo dir can't be
// enumerated, else null. Injectable so the tcc-denied path is testable without real
// TCC state. Default enumerates with readdir — a bare `stat` often succeeds under a
// TCC-gated folder, so we must actually read the directory to trip the denial (§5.11).
export type RepoProbe = (repo: string) => Promise<NodeJS.ErrnoException | null>;
export const fsProbe: RepoProbe = async (repo) => {
  try { await readdir(repo); return null; }
  catch (e) { return e as NodeJS.ErrnoException; }
};

export type ProbeOpts = GuardOpts & { probe?: RepoProbe; gitCheck?: () => Promise<boolean> };

// Is the `git` binary usable at all? A missing git is systemic (not "no repos") — detect it ONCE.
// Three outcomes, not two: an IncompleteReadError means git RAN FINE but its output could not be read
// to completion, so reporting "not on PATH" would send the user to reinstall a working git. Same
// blocking outcome, honest diagnosis. `unread` carries the error's own `reason`, so the warning names
// the ACTUAL cause (held pipe vs failed read) rather than asserting the more common one.
type GitProbe = { kind: "ok" } | { kind: "missing" } | { kind: "unread"; reason: string };
async function gitAvailable(opts?: ProbeOpts): Promise<GitProbe> {
  // The injected hook is a boolean by contract, so it can only express ok/missing — tests that need
  // the `unread` outcome mock Bun.spawn instead.
  if (opts?.gitCheck) return (await opts.gitCheck()) ? { kind: "ok" } : { kind: "missing" };
  // Probe from homedir() (always present), NOT process.cwd() — a deleted/inaccessible cwd would make
  // Bun.spawn throw and falsely report git missing, blocking a real user every run.
  return runGit(["--version"], homedir()).then((): GitProbe => ({ kind: "ok" }))
    .catch((e): GitProbe =>
      e instanceof IncompleteReadError ? { kind: "unread", reason: e.reason } : { kind: "missing" });
}

// "Probe each repo and classify what we can't read." Used by the init preflight (main.ts); the
// real run (gitActivity, below) does the same probe inline because it interleaves with git reads,
// but both funnel classification through the one `classify()` helper, so they can't diverge on how
// a blocked repo is labeled. Returns one PathIssue per unreadable repo (readable → nothing).
export async function probeRepos(repos: string[], opts?: ProbeOpts): Promise<PathIssue[]> {
  const probe = opts?.probe ?? fsProbe;
  const issues: PathIssue[] = [];
  for (const repo of repos) {
    const err = await probe(repo);
    if (err) issues.push(classify(repo, err, opts));
  }
  return issues;
}

// Repos are independent, so their git scans run concurrently with a small bound — a multi-repo
// morning's wall time becomes ~the slowest repo instead of the sum of all. Bounded to avoid a spawn
// storm (each repo fires several git subprocesses). It also contains blast radius: one repo blocked
// on dead I/O (a hung network mount) no longer serializes the whole run behind it.
const REPO_SCAN_CONCURRENCY = 8;

// Order-preserving bounded-concurrency map: results[i] always corresponds to items[i] regardless of
// completion order, so downstream merging stays deterministic — byte-identical to the old sequential
// walk. Workers pull from a shared cursor until the list is drained. NOTE: phase 1 deliberately
// rethrows a NON-IncompleteReadError (an unexpected bug) rather than classifying it — that aborts
// Promise.all while other workers run on, which is the intended fail-closed outcome: run() exits
// without stamping, so the day retries. Every EXPECTED error is still fully guarded, so this path
// is unreachable in normal operation; it is not the old "fn must not reject" invariant.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i]!, i);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

type MergedToday = { repo: string; prNum: string; branch: string; sha: string; timestamp: string; files: string[] };

export async function gitActivity(
  cfg: Config,
  repos: string[],
  opts?: ProbeOpts,
): Promise<{ activities: Activity[]; warnings: string[]; issues: PathIssue[]; today: Activity[]; mergedToday: MergedToday[]; windowMerges: MergedToday[]; windowStartUtc: string }> {
  // ⚠ `windowStartUtc` is RETURNED, not re-derived by the caller. §3.1's transcript read window is
  // [gitWindowStart - margin, now], and `windowStart()` is computed INSIDE this function, so without
  // exposing it `runCore` cannot construct that window at all. Deriving it from
  // `min(activity.timestamp)` is wrong by up to a day, because `windowStart` returns a LOCAL MIDNIGHT
  // and the earliest activity is whenever work happened to start.
  const cap = cfg.lookbackCapDays ?? DEFAULT_LOOKBACK_CAP_DAYS;
  const probe = opts?.probe ?? fsProbe;
  const now = new Date();
  const end = localMidnight(now);

  // #12: a missing `git` binary is a SYSTEMIC failure, not "no repos" — detect it ONCE up front, so we
  // don't misclassify every repo as "not a git repo" and then stamp the day done (a silently-wrong
  // first run on a machine without git: a fresh macOS xcode-select stub, a minimal Linux box). Return a
  // blocking (inaccessible) issue so run() does NOT stamp and retries once git is installed.
  const gitProbe: GitProbe = repos.length ? await gitAvailable(opts) : { kind: "ok" };
  if (gitProbe.kind !== "ok") {
    return {
      // No window was ever computed on this path (git is unrunnable), so report "now": the caller
      // constructs an empty read window from it rather than a spuriously wide one.
      windowStartUtc: new Date().toISOString(),
      activities: [], today: [], mergedToday: [], windowMerges: [], issues: [{ path: "git", kind: "unreadable" }],
      warnings: [gitProbe.kind === "missing"
        ? "git isn't runnable (not on PATH, or not installed) — the briefing reads local git history. Install git or fix its PATH. Today NOT marked done; it will retry once git works."
        : `git ran but its output could not be read to completion, so nothing could be read reliably — ${gitProbe.reason}. Today NOT marked done; it will retry.`],
    };
  }

  // 1) union of commit-days across all readable repos → drives the shared window.
  //    Resolve the effective author PER REPO (explicit config, else the repo's git identity).
  const commitDays = new Set<number>();
  const readable: { repo: string; author: { names?: string[]; emails?: string[] } }[] = [];
  const warnings: string[] = [];
  const issues: PathIssue[] = [];
  // Compile bot/auto-commit exclude patterns ONCE; a typo'd regex is warned (not fatal — it would
  // otherwise crash every listCommits and degrade the whole briefing to "partial failure") (#4).
  const { regexes: excludeRe, invalid } = compileExcludePatterns(cfg.excludeCommitPatterns ?? DEFAULT_EXCLUDE_COMMIT_PATTERNS);
  for (const p of invalid) warnings.push(`ignored invalid excludeCommitPatterns entry ${JSON.stringify(p)} (not a valid regex)`);
  type Phase1 = { days: number[]; readable: { repo: string; author: { names?: string[]; emails?: string[] } } | null; issues: PathIssue[]; warnings: string[] };
  const phase1 = await mapLimit(repos, REPO_SCAN_CONCURRENCY, async (repo): Promise<Phase1> => {
    // Protected-path guard (§5.11): probe readability BEFORE touching git, so a macOS TCC
    // denial (EPERM under a protected root) is classified distinctly — not mistaken for a
    // broken/empty repo — and the repo is skipped-and-surfaced, never silently dropped.
    const probeErr = await probe(repo);
    if (probeErr) {
      const issue = classify(repo, probeErr, opts);
      return { days: [], readable: null, issues: [issue], warnings: [warnFor(issue)] };
    }
    // An IncompleteReadError anywhere below means git's output could not be read to completion (a
    // held pipe, or a failed read), so NO read from this repo can be trusted. THIS OUTER CATCH is the
    // protection: it keeps the error away from the two swallow paths beneath — resolveAuthor's own
    // fallbacks in git.ts, which return `{}` = NO author filter (every commit matches, crediting
    // coworkers), and the unborn-HEAD branch below, which returns zero days with no issue at all (a
    // fabricated quiet day that then stamps). Surface an unreadable repo instead.
    try {
      // Deliberately no local `.catch` here: every runGit inside resolveAuthor already routes through
      // `orElse`, so an IncompleteReadError is the only thing it can reject with — and that must
      // reach the outer catch. A handler returning `cfg.author ?? {}` would be dead code that reads
      // as though the no-author-filter degradation were still reachable.
      const author = await resolveAuthor(repo, cfg.author);
      try {
        const days = await committerDaysWithCommits(repo, author, cap + 1, excludeRe);
        return { days: [...days], readable: { repo, author }, issues: [], warnings: [] };
      } catch (e) {
        if (e instanceof IncompleteReadError) throw e;   // NOT an unborn HEAD — don't let it look like one
        // A repo with ZERO commits is not the same as "not a git repo", and must still reach phase 2:
        // a brand-new repo with staged work is exactly the "here's where I left off" state
        // resumptionSignals exists for. NOTE this branch is DEFENSIVE, not the common path — measured
        // on git 2.54, `git log --all` exited 0 with empty output on an unborn HEAD, so
        // committerDaysWithCommits did not throw there. Bare `git log` DOES exit 128, so a narrower
        // ref set still lands here (and possibly an older git — unmeasured).
        // ⚠ LOCAL_WORK_REFS STOPPED ENDING IN `--all` on 2026-08-11 (it is now an allowlist — see
        // git.ts), and this warning is exactly why it carries `--ignore-missing`: the allowlist
        // names `HEAD`, which on an unborn HEAD is an unknown revision that exits 128. Re-measured
        // with the new form: exit 0, empty output, so the clean path is preserved and this branch
        // stays defensive. Drop `--ignore-missing` and every brand-new repo routes through here.
        // Only classify-and-warn when
        // the fs probe passed but git itself says this isn't a valid repo.
        if (await gitDirExists(repo)) {
          return { days: [], readable: { repo, author }, issues: [], warnings: [] };
        }
        // The fs probe passed but git can't read it: fall back to classifying git's own
        // (locale-dependent) error as a complement — catches a TCC denial the probe missed.
        const issue = classify(repo, e, opts);
        return { days: [], readable: null, issues: [issue], warnings: [warnFor(issue)] };
      }
    } catch (e) {
      if (!(e instanceof IncompleteReadError)) throw e;   // genuinely unexpected — don't mask it
      // An `unreadable` ISSUE, not just a warning: `blockedDelivery` (core.ts) keys on
      // isInaccessible issues, so warning-only would leave the run to render an empty briefing and
      // STAMP the day — the fabricated quiet day A1 calls worse than the hang. The issue also gives
      // the right asymmetry for free, since blockedDelivery only fires at activityCount === 0: one
      // held repo among healthy ones still delivers a partial briefing plus this warning.
      return {
        days: [], readable: null, issues: [{ path: repo, kind: "unreadable" }],
        warnings: [`skipped ${repo}: git's output could not be read to completion, so its history is not trustworthy — ${e.reason}`],
      };
    }
  });
  // Merge in repo order (deterministic): commitDays is order-independent; readable/issues/warnings
  // keep input order, identical to the previous sequential walk.
  for (const r of phase1) {
    for (const d of r.days) commitDays.add(d);
    if (r.readable) readable.push(r.readable);
    issues.push(...r.issues);
    warnings.push(...r.warnings);
  }
  const start = windowStart(now, (d) => commitDays.has(d.getTime()), cap);

  // 2) per-repo commits + resumption state, in ONE listCommits pass over [start, tomorrow): commits
  // before today-midnight (`end`) are the window recap; commits on/after are "Today so far" (#1) —
  // the window excludes today, so a briefing (re)generated after a morning of work isn't blind to it.
  // Both are author- and bot-filtered. resumptionSignals runs first (a zero-commit repo MAY make
  // listCommits throw — on modern git its `--all` shape exits 0 with empty output instead — but
  // either way its uncommitted/stash signals still matter). One pass avoids a second
  // full-history `git log` per repo and keeps window/today error handling identical.
  const tomorrow = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  const activities: Activity[] = [];
  const today: Activity[] = [];
  // Today's landed PRs — a separate channel from listCommits (merges are dropped there as recap padding),
  // surfaced in the same-day layer so the briefing isn't blind to "PR merged today" (audit 2026-07-16).
  const mergedToday: MergedToday[] = [];
  type Phase2 = { activities: Activity[]; today: Activity[]; mergedToday: MergedToday[]; warnings: string[]; issues: PathIssue[] };
  const phase2 = await mapLimit(readable, REPO_SCAN_CONCURRENCY, async ({ repo, author }): Promise<Phase2> => {
    const acts: Activity[] = [], td: Activity[] = [], merged: MergedToday[] = [];
    try {
      acts.push(...await resumptionSignals(repo));
      for (const c of await listCommits(repo, start, tomorrow, author, excludeRe)) {
        (new Date(c.timestamp ?? "").getTime() < end.getTime() ? acts : td).push(c);
      }
      // Whole window, not just today (defect D — EVAL day 33, user-directed): an in-window PR
      // landing previously had NO channel at all (listCommits drops merges; this scan started at
      // `end`), so six 08-17 landings were invisible on 08-18. One scan covers both halves; the
      // caller splits on `end` — same-day entries keep their existing "Today so far" rendering,
      // in-window entries render as dated lines at the foot of the recap.
      for (const m of await listPrMerges(repo, start, tomorrow, author, excludeRe)) {
        merged.push({ repo: m.repo, prNum: m.prNum, branch: m.branch, sha: m.sha, timestamp: m.timestamp, files: m.files });
      }
    } catch (e) {
      // A held pipe usually manifests HERE first, not in phase 1: an fsmonitor hook is invoked by
      // `git status`, which is resumptionSignals' first call, while phase 1's `git config`/`git log`
      // never touch the index. A bare catch turned that into a vague "partial failure" with no
      // issue — so the run rendered an empty briefing and stamped. Same treatment as phase 1.
      // Whatever is already in `acts`/`td` is trustworthy and kept: runGit now only returns on a
      // COMPLETE read, so anything it handed back is whole by construction. (`merged` is necessarily
      // empty here — listPrMerges is the LAST call and only populates on success — so it is passed
      // for symmetry, not because partial merges can survive. No test can prove otherwise.)
      if (e instanceof IncompleteReadError) {
        return {
          activities: acts, today: td, mergedToday: merged, issues: [{ path: repo, kind: "unreadable" }],
          warnings: [`partial read of ${repo}: git's output could not be read to completion — ${e.reason}`],
        };
      }
      return { activities: acts, today: td, mergedToday: merged, issues: [], warnings: [`partial failure reading repo: ${repo}`] };
    }
    return { activities: acts, today: td, mergedToday: merged, issues: [], warnings: [] };
  });
  // Merge in readable order (deterministic): same intra-repo order (resumption → window commits) and
  // same cross-repo order as the previous sequential walk.
  for (const r of phase2) {
    activities.push(...r.activities);
    today.push(...r.today);
    mergedToday.push(...r.mergedToday);
    warnings.push(...r.warnings);
    issues.push(...r.issues);
  }

  // Linked worktrees share the object store AND the common refs (`git log --all` sees the same
  // commit set; `refs/stash` is likewise a shared ref — a stash made in one checkout shows in
  // `git stash list` from every worktree). So the same commits and stashes appear in each discovered
  // checkout and would otherwise double-recap under two repo labels (a mainstream workflow for this
  // product's audience: AI coding assistants, including this repo, create worktrees). Dedupe commits
  // (by SHA = event_id) and stashes (by their commit SHA) across repos, keeping the first. Genuinely
  // per-worktree signals — uncommitted changes and the current branch/HEAD — pass through untouched.
  // The window day-set is already a Set (no effect).
  // Split the (now window-wide) merge channel on `end`: same-day → mergedToday (existing "Today so
  // far" rendering), earlier → windowMerges (dated recap-foot lines). Same dedupe for both halves.
  const allMerges = dedupeBySha(mergedToday);
  const sameDayMerges = allMerges.filter((m) => new Date(m.timestamp).getTime() >= end.getTime());
  const windowMerges = allMerges.filter((m) => new Date(m.timestamp).getTime() < end.getTime());

  return {
    activities: dedupeSharedRefs(activities), warnings, issues,
    today: await dedupeTwins(dedupeSharedRefs(today)),
    mergedToday: sameDayMerges, windowMerges, windowStartUtc: start.toISOString(),
  };
}

/** Defect E (EVAL day 33, user-directed): a rebase-merge copies branch commits onto main with new
 *  SHAs; with the originals still on a stale local branch, `--all` lists BOTH and "Today so far"
 *  double-counts (measured: five patch-identical pairs, 22 items for ~17 changes). Dedupe same-day
 *  commits by `git patch-id --stable` — the exact content fingerprint, which cannot false-positive —
 *  keeping the NEWEST copy per id (rebase copies get fresh committer dates at merge time, so newest
 *  = the mainline copy). Cost-bounded: patch-ids are computed only for commits whose SUBJECT
 *  collides within their repo (a rebase copy keeps its subject verbatim), which is empty on a
 *  normal morning. Fail open: an unmapped SHA (patchIds error) is never dropped. */
export async function dedupeTwins(items: Activity[], patchIdsFn: typeof patchIds = patchIds): Promise<Activity[]> {
  const bySubject = new Map<string, Activity[]>();
  for (const a of items) {
    if (a.kind !== "commit" || !a.event_id) continue;
    const key = `${a.repo ?? ""}\x1f${(a.text ?? "").trim()}`;
    bySubject.set(key, [...(bySubject.get(key) ?? []), a]);
  }
  const drop = new Set<string>();
  for (const group of bySubject.values()) {
    if (group.length < 2) continue;
    const ids = await patchIdsFn(group[0]!.repo ?? "", group.map((a) => a.event_id!));
    const byId = new Map<string, Activity[]>();
    for (const a of group) {
      const id = ids.get(a.event_id!);
      if (!id) continue; // fail open
      byId.set(id, [...(byId.get(id) ?? []), a]);
    }
    for (const twins of byId.values()) {
      if (twins.length < 2) continue;
      const sorted = [...twins].sort((a, b) => new Date(b.timestamp ?? 0).getTime() - new Date(a.timestamp ?? 0).getTime());
      for (const older of sorted.slice(1)) drop.add(older.event_id!);
    }
  }
  return drop.size === 0 ? items : items.filter((a) => !(a.event_id && drop.has(a.event_id)));
}

// Keep the first commit (by SHA=event_id) and the first stash (by its commit SHA); pass genuinely
// per-worktree activities (uncommitted, branch) through untouched.
function dedupeSharedRefs(items: Activity[]): Activity[] {
  const seenCommit = new Set<string>();
  const seenStash = new Set<string>();
  return items.filter((a) => {
    if (a.kind === "commit") return !seenCommit.has(a.event_id) && (seenCommit.add(a.event_id), true);
    if (a.kind === "stash") {
      const sha = (a.meta as { sha?: string } | undefined)?.sha;
      if (!sha) return true; // no SHA to dedupe by → keep (can't safely collapse)
      return !seenStash.has(sha) && (seenStash.add(sha), true);
    }
    return true;
  });
}

function dedupeBySha(merges: MergedToday[]): MergedToday[] {
  const seen = new Set<string>();
  return merges.filter((m) => !seen.has(m.sha) && (seen.add(m.sha), true));
}
