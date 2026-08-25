// src/git.ts
import type { Activity } from "./types";
import { localMidnight } from "./time";
import { eventIdFor } from "./eventId";
import { drain, raceFlush, sinkText } from "./stream";

// A hung network-mount repo (SMB/NFS/VPN, a disconnected share) must not block the unattended 7:20
// run forever — bound every git call. On timeout Bun SIGKILLs git → its pipes EOF → the nonzero-exit
// throw below fires (surfaced upstream as a repo-read issue, not a hang).
/** ⚠ Exported for TESTS ONLY — `runGit`'s `timeoutMs` parameter already defaults to it, and nothing
 *  outside this module should read it. It is exported so `test/ceilings.test.ts` can pin its range:
 *  measured, shrinking it to 300ms left the entire suite green while SIGKILLing every git call on a
 *  slow repo, which reads downstream as "repo unreadable" and yields an EMPTY briefing with no error. */
export const GIT_TIMEOUT_MS = 30_000;

/** A git call exited cleanly but its stdout could not be read to EOF, so the output we have is
 *  INCOMPLETE — and for runGit an empty/partial payload is indistinguishable from a legitimate empty
 *  result (`git log` with no commits, `git status --porcelain` on a clean tree). Its own class so the
 *  swallow sites can let it through instead of degrading it to "" / false.
 *
 *  TWO causes, one class, discriminated by the PRESENCE of `failure` — never by whether `failure.cause`
 *  is defined, since a stream can reject with literally `undefined`. Without `failure`: the stream
 *  never EOF'd — a grandchild (a git hook that backgrounds a child, commonly a custom core.fsmonitor
 *  hook) inherited the pipe and is holding it open; git's own built-in fsmonitor daemon detaches fd
 *  0/1/2 and structurally cannot. With `failure`: the read itself failed, and `e.cause` carries
 *  whatever it rejected with (possibly `undefined`). Both are equally untrustworthy so both must
 *  block, which is why they share a class
 *  — the `instanceof` routing in this file and in extractor.ts stays uniform. But they need
 *  DIFFERENT fixes from the user, so the message must not assert a held pipe when it saw a broken
 *  one (the same diagnosis-honesty standard that gives gitAvailable three outcomes, not two). */
export class IncompleteReadError extends Error {
  // `failure` PRESENT means the read errored — deliberately a wrapper object rather than keying on
  // `cause !== undefined`, because a stream can reject with literally `undefined` and would then be
  // mislabelled as a held pipe. Inferring "did it fail" from "is the payload absent" is the same
  // mistake as the "" ambiguity this whole class exists to resolve.
  /** The cause clause ALONE, for callers that build their own user-facing warning. Without this they
   *  can only append a fixed hint, which asserts a held pipe even when the read simply failed —
   *  blocking correctly but diagnosing wrongly, the gap this class otherwise closes. */
  readonly reason: string;

  constructor(args: string[], cwd: string, failure?: { cause: unknown }) {
    let why = "stdout never reached EOF (a child process is holding the pipe)";
    let reason = "a child process is holding git's output pipe open (usually a git hook that backgrounds a child — a custom core.fsmonitor hook is the common one)";
    if (failure) {
      // Building this string must not THROW. `String(v)` dies on a null-prototype object, and
      // `.message` could be a throwing getter — and if the constructor threw, callers would get a
      // raw TypeError instead of an IncompleteReadError, which every `orElse` site swallows. That
      // would resurrect the silent degradation this class prevents, via its own constructor.
      let detail: string;
      try {
        detail = failure.cause instanceof Error ? failure.cause.message : String(failure.cause);
      } catch { detail = "unprintable error value"; }
      why = `stdout could not be read to EOF (${detail})`;
      reason = `the pipe read itself failed (${detail})`;
    }
    super(`git ${args.join(" ")} in ${cwd}: ${why} — output incomplete`);
    this.name = "IncompleteReadError";
    this.reason = reason;
    if (failure) this.cause = failure.cause;
  }
}

// How long to wait for the pipes to EOF AFTER git has already exited. This bounds EOF, not data:
// the reads run concurrently while git is alive, so a slow-but-finite `git log` is bounded by
// GIT_TIMEOUT_MS, never by this. Deliberately NOT provider.ts's 10s — that is paid once per
// provider attempt, whereas runGit runs 10-12x per repo per tick (~110 calls at 10 repos), and on
// a machine that actually has the pathology every one of them burns the full window.
const GIT_FLUSH_MS = 500;

/** Swallow a git failure to `fallback` — EXCEPT an IncompleteReadError, which must propagate.
 *  These `.catch`es exist because an unborn HEAD / missing git config / detached HEAD are all
 *  normal; an incomplete read is not, and swallowing it silently degrades (at resolveAuthor, to NO
 *  AUTHOR FILTER, crediting coworkers' commits). Uniform within git.ts, no per-site exceptions: on
 *  a machine with a held pipe every subsequent call is untrustworthy too, so failing early beats
 *  guessing. Two sites OUTSIDE this file stay deliberately swallowed (core.ts's render-time drift
 *  re-check and scripts/audit.ts's ground truth) — both advisory, both scoped out by C1 rev 3.4. */
function orElse<T>(fallback: T) {
  return (e: unknown): T => { if (e instanceof IncompleteReadError) throw e; return fallback; };
}

export async function runGit(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL" });
  // Ordering is load-bearing (mirrors provider.ts):
  //  - the reads START first (concurrent drain — git writing enough to fill the OS pipe buffer
  //    while we wait on `exited` would otherwise deadlock it),
  //  - we AWAIT `p.exited` (bounded by timeout + SIGKILL),
  //  - then we RACE the reads against a short flush window instead of awaiting them outright. A
  //    grandchild that inherited the pipes (an fsmonitor hook, a backgrounding hook) keeps them
  //    open after git itself exits, and an un-raced read would then never see EOF — the 2026-07-26
  //    hang. Side-assignment via sinks, not `const [out, err] = await Promise.all(...)`: under a
  //    race that destructures undefined.
  const o = drain(p.stdout), e = drain(p.stderr);
  await p.exited;
  // The race, the clearable timer and the `||` abandon guard now live in stream.ts (F1). This site
  // used to hand-roll all three, as did `probe.ts` and `proc.ts` near-verbatim; `provider.ts`'s copy
  // differed structurally (it hoisted the `Promise.all` above `await exited` and nested two
  // try/finallys). Policy stays HERE — see the fail-closed gate below, which is what makes this
  // caller different from the provider's.
  await raceFlush(o, e, GIT_FLUSH_MS);
  const out = sinkText(o.sink), err = sinkText(e.sink);
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${err}`);
  // FAIL CLOSED on an incomplete stdout. "" is a legitimate success here (`git log` with no
  // in-window commits; `git status --porcelain` on a clean tree), so returning a partial/empty
  // payload would fabricate a quiet day and stamp it — worse than the hang this replaces. Gate on
  // STDOUT only: a held OR ERRORED stderr with a complete stdout is a success — stderr feeds only
  // the nonzero-exit message above, so losing it cannot corrupt a result.
  if (!o.sink.complete) throw new IncompleteReadError(args, cwd, o.sink.errored ? { cause: o.sink.error } : undefined);
  return out;
}

/** True if `repo` is inside a git working tree/dir at all (even with zero commits — unborn
 *  HEAD). Lets callers distinguish "valid repo, just no history yet" from "not a git repo". */
export async function gitDirExists(repo: string): Promise<boolean> {
  return runGit(["rev-parse", "--git-dir"], repo).then(() => true).catch(orElse(false));
}

/** SHA + committer-date ISO of a ref, in ONE `git show` (both come from the same commit object).
 *  Best-effort: returns empty strings if the ref can't be resolved (e.g. unborn HEAD). */
async function shaAndDate(repo: string, ref: string): Promise<{ sha: string; date: string }> {
  const out = (await runGit(["show", "-s", "--format=%H%n%cI", ref], repo).catch(orElse(""))).trim();
  const [sha, date] = out.split("\n");
  return { sha: (sha ?? "").trim(), date: (date ?? "").trim() };
}

// Ref selection for every "what commits exist" query — shared with the audit tool so its ground
// truth can't drift from the app's view.
//
// ⚠ THIS IS AN ALLOWLIST, and it was an `--all`-minus-exclusions list until 2026-08-11. The three
// exclusions were right about WHAT to drop and wrong about HOW, because `--all` means every ref
// under `refs/`, and third-party tools write there. MEASURED on this repo: Cline (an editor
// extension) parks checkpoints under `refs/cline/checkpoints/<session>/<n>`, and they are
// STASH-SHAPED — `git for-each-ref --contains 1623e2cb` resolves to exactly that ref, and the pair
// it adds beyond any branch is `On <branch>: cline checkpoint session=…` plus
// `index on <branch>: 8cefd594 …`. So `--exclude=refs/stash` was defeated by a stash living
// somewhere other than `refs/stash`, and the day-26 briefing shipped that index commit as a
// "Today so far" item BESIDE the real commit it wraps.
//
// ⚠ AND THE SECOND SYMPTOM WAS THE SAME CAUSE, not an independent bug. A stash index commit whose
// tree matches its parent has an EMPTY diffstat, so `unitForCommit`'s majority-root vote has no
// files to count and falls back to the repo label: the wrapper rendered as `[personal_code]` while
// the real commit rendered `[accountant_ai]`. One line, two labels, one underlying fix. Filtering
// by SUBJECT (`^(index|WIP) on `) would have hidden both symptoms and left the actual hole open —
// the next tool to write a differently-shaped ref walks straight back in.
//
// What the allowlist keeps, and why each is needed rather than merely harmless:
//  - --branches: the user's work. This is the whole point.
//  - --tags: a commit reachable only from a tag (released, branch since deleted) is still work.
//  - --ignore-missing HEAD: a DETACHED HEAD has no branch, and `--all` DID include HEAD (git's
//    docs: "all the refs in refs/, along with HEAD"), so plain `--branches --tags` would silently
//    lose the current checkout's history — the one thing a resumption briefing must never miss.
//    MEASURED: on a detached HEAD, `--branches --tags` reports only the branch commit while
//    `--branches --tags --ignore-missing HEAD` reports both.
//    ⚠ `--ignore-missing` IS LOAD-BEARING, NOT DEFENSIVE DRESSING. On an UNBORN HEAD (`git init`,
//    no commit yet) bare `HEAD` is an unknown revision: git exits 128 with
//    `fatal: ambiguous argument 'HEAD'`, where the old `--all` form exited 0 with empty output.
//    That is the brand-new-repo-with-staged-work case `extractor.ts` exists to reach, and although
//    its defensive branch would catch the throw, converting a clean path into an error path on the
//    FIRST run in a new repo is not a trade worth making. With the flag: exit 0, empty. Measured
//    2026-08-11 on the git in this environment; the `extractor.ts` note about older gits stands.
// What it now drops BY CONSTRUCTION rather than by enumeration — the three former exclusions, plus
// every future namespace nobody has thought of:
//  - refs/remotes/*: work you did on ANOTHER machine, or a GitHub squash-merge preserving you as
//    author — the briefing claims "LOCAL GIT ACTIVITY on THIS machine only", and these also shift
//    the shared window.
//  - refs/notes/*: metadata, not work commits.
//  - refs/stash: "WIP on …"/"index on …" would surface as phantom commits and skew the
//    last-working-day window. A stash is resumption state and has its OWN signal — `git stash list`
//    in `resumptionSignals` below — which is why dropping it here loses nothing.
export const LOCAL_WORK_REFS = ["--branches", "--tags", "--ignore-missing", "HEAD"] as const;

// Author-filter args, shared with the audit's ground-truth query (same drift rationale).
export function authorArgs(author?: { names?: string[]; emails?: string[] }): string[] {
  // Filter empty/whitespace-only entries: a config with `"emails": [""]` would otherwise build
  // `--author=` which git treats as "matches EVERY commit" — silently including other people's work.
  const pats = [...(author?.emails ?? []), ...(author?.names ?? [])].filter((p) => p.trim().length > 0);
  if (pats.length === 0) return [];
  // git treats --author=<pattern> as a REGEX (basic regex by default, not extended); emails
  // commonly contain `+`/`.` (e.g. Gmail aliases) which would silently mis-match as regex
  // metacharacters — and naively backslash-escaping `+`/`?`/`|`/`(`/`)` is actually WRONG here,
  // since in git's default *basic* regex those escaped forms are GNU extensions for
  // one-or-more/optional/alternation/grouping, not literal-char escapes (unlike extended regex).
  // --fixed-strings forces literal matching for --author regardless of grep.patternType config,
  // sidestepping the BRE/ERE ambiguity entirely.
  return ["--fixed-strings", ...pats.map((p) => `--author=${p}`)]; // git ORs multiple --author
}

/** Numstat rename rows can read "old => new" (no common prefix/suffix), or a brace-collapsed
 *  form around just the differing path segment: "dir/{old => new}" (trailing brace) or
 *  "src/{old => new}/f.ts" (an intermediate-directory brace, with a suffix AFTER the closing
 *  brace). Normalize to a NEW-path-ish string — good enough for display, not meant to be an
 *  authoritative path. */
export function displayFile(raw: string): string {
  // prefix + "{" + (old segment, discarded) + " => " + new segment + "}" + suffix.
  const brace = raw.match(/^(.*)\{.*? => (.*?)\}(.*)$/);
  if (brace) {
    const [, prefix, newSeg, suffix] = brace;
    return `${prefix}${newSeg}${suffix}`;
  }
  const idx = raw.lastIndexOf(" => ");
  return idx === -1 ? raw : raw.slice(idx + 4);
}

/** The OLD-path side of a numstat rename row, or undefined for a non-rename. Defect C (EVAL day 32):
 *  displayFile deliberately keeps only the new path, so downstream of git.ts a rename was
 *  indistinguishable from an add — the day-32 judge read `{verify-b2a.sh => verify-safe-subset.sh}`
 *  as "adds and deletes nothing" and built a wrong orphan claim on it. This recovers the delete half
 *  for EVIDENCE rendering only; attribution (subprojects/reduce) keeps keying on `file` — the
 *  new-path side — unchanged. */
export function renamedFromOf(raw: string): string | undefined {
  const brace = raw.match(/^(.*)\{(.*?) => .*?\}(.*)$/);
  if (brace) {
    const [, prefix, oldSeg, suffix] = brace;
    return `${prefix}${oldSeg}${suffix}`;
  }
  const idx = raw.lastIndexOf(" => ");
  return idx === -1 ? undefined : raw.slice(0, idx);
}

/** `git status --porcelain` always double-quotes (C-string style) a path containing a space,
 *  tab, double-quote, or backslash — REGARDLESS of `core.quotePath` (that setting only controls
 *  octal-escaping of non-ASCII bytes, not this). e.g. "weird, name.txt" (has a space) round-trips
 *  as the literal 8 characters `"weird, name.txt"` including the wrapping quotes. Strip the
 *  quoting and undo the backslash escapes so callers get the real filename back.
 *  NB: numeric `\NNN` octal escapes are intentionally NOT decoded — every caller sets
 *  `core.quotePath=false`, so git prints non-ASCII bytes raw and never emits octal here. */
export function unquotePath(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const inner = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "\\" && i + 1 < inner.length) {
      const next = inner[++i];
      switch (next) {
        case "\\": out += "\\"; break;
        case '"': out += '"'; break;
        case "t": out += "\t"; break;
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        default: out += next; // unrecognized escape: pass the char through literally
      }
    } else {
      out += c;
    }
  }
  return out;
}

/** Index of the closing (unescaped) double-quote of a C-quoted field that starts at index 0, or -1. */
function closingQuoteIndex(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; } // skip the escaped char
    if (s[i] === '"') return i;
  }
  return -1;
}

/** `git status --porcelain` rename entries read "R  old -> new"; after slice(3) that's
 *  "old -> new" (each side independently quoted per unquotePath's rule above). Display the
 *  new name. The " -> " separator is found QUOTE-AWARE: a path containing " -> " has spaces, so
 *  git C-quotes it, meaning a raw " -> " can sit INSIDE the quoted old path — splitting on the
 *  first (or last) " -> " would then garble the new name. */
export function displayStatusEntry(entry: string): string {
  let sep: number;
  if (entry[0] === '"') {
    // old is quoted: the real separator is the first " -> " AFTER its closing quote.
    const close = closingQuoteIndex(entry);
    sep = close === -1 ? entry.indexOf(" -> ") : entry.indexOf(" -> ", close + 1);
  } else {
    // old is unquoted → it has no space, hence no " -> " → the first " -> " is the separator.
    sep = entry.indexOf(" -> ");
  }
  const path = sep === -1 ? entry : entry.slice(sep + 4);
  return unquotePath(path);
}

/** Effective author filter (spec §5.2): explicit config wins; else fall back to the
 *  repo's own `git config user.email`, then `user.name`, so coworker commits are never
 *  credited. Only returns {} (no filter) if the repo has neither identity configured. */
export async function resolveAuthor(
  repo: string, author: { names?: string[]; emails?: string[] } | undefined,
): Promise<{ names?: string[]; emails?: string[] }> {
  // Count NON-EMPTY identities: an all-empty config (`emails:[""]`) must NOT count as "an explicit
  // author is set" — that would skip the git-config fallback and (with authorArgs filtering the empty)
  // leave NO filter = every commit, crediting coworkers. Fall back to the repo identity instead.
  if (author && [...(author.emails ?? []), ...(author.names ?? [])].some((p) => p.trim().length > 0)) return author;
  const email = (await runGit(["config", "user.email"], repo).catch(orElse(""))).trim();
  if (email) return { emails: [email] };
  const name = (await runGit(["config", "user.name"], repo).catch(orElse(""))).trim();
  return name ? { names: [name] } : {};
}

// --- High ③: bound the full-history `git log --all` walks -----------------------------------------
// committerDaysWithCommits / listCommits / listPrMerges each scanned the ENTIRE history of every repo
// (listCommits even ran full-history --numstat) and filtered to a ~window in JS — O(total history) per
// repo per run, unusable on a large repo a public user points us at. Plain `--since` is unsafe here (its
// approxidate + graph-traversal early-stop can drop a commit-day sitting behind an older merge — the
// exact concern documented on committerDaysWithCommits). git >= 2.37's `--since-as-filter` applies the
// date test to EACH commit WITHOUT that early-stop, so it bounds the walk while the downstream JS date
// filter stays authoritative. On older git we fall back to the (correct, slower) unbounded scan.
const SINCE_MARGIN_MS = 2 * 864e5; // 2-day slack (tz/DST/clock skew); the JS window filter is authoritative

/** True iff `git --version` output reports >= 2.37 (when `--since-as-filter` landed). Pure/testable. */
export function gitSupportsSinceAsFilter(versionOutput: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(versionOutput);
  if (!m) return false;
  const major = Number(m[1]), minor = Number(m[2]);
  return major > 2 || (major === 2 && minor >= 37);
}

/** The `--since-as-filter` arg (margined before `cutoffMs`) for a bounded scan, or [] when unsupported. Pure. */
export function sinceAsFilterArgs(cutoffMs: number, supported: boolean): string[] {
  return supported ? [`--since-as-filter=${new Date(cutoffMs - SINCE_MARGIN_MS).toISOString()}`] : [];
}

let _supportsSinceAsFilter: boolean | undefined; // detected once per process (git version is per-install)
// extractor.gitActivity now scans repos CONCURRENTLY (bounded mapLimit), so several windowArgs calls
// can hit this check-then-set before the cache fills and fire a few redundant `git --version` probes
// on the first tick. Harmless: every probe computes the same per-install result, so the cache
// converges to one value and the outcome is never incorrect.
async function windowArgs(cutoffMs: number): Promise<string[]> {
  if (_supportsSinceAsFilter === undefined) {
    const v = await runGit(["--version"], process.cwd()).catch(orElse(""));
    _supportsSinceAsFilter = gitSupportsSinceAsFilter(v);
  }
  return sinceAsFilterArgs(cutoffMs, _supportsSinceAsFilter);
}

/** Local-midnight epoch-ms for every day (within lookback) that had an authored commit.
 *  Filters in JS by absolute instant (authoritative) — NOT `git log --since` (per Global Constraints:
 *  --since approxidate + graph-traversal early-stop could drop a commit-day sitting behind an older
 *  merge, and this day-set drives the window directly). On git >= 2.37 the walk itself is bounded by
 *  `--since-as-filter` (see windowArgs — no early-stop), so it is windowed there and full-history only
 *  on older git.
 *  `--all` makes this branch-independent: work on a branch you've since switched away from
 *  still counts toward the shared window — and it also means a zero-commit repo does NOT
 *  necessarily throw: measured on git 2.54, `git log --all` on an unborn HEAD exits 0 with empty
 *  output (bare `git log` exits 128). So this returns an empty set there on modern git, and throws
 *  only on a narrower ref set (and possibly an older git — unmeasured, no pre-2.37 build to hand).
 *  Callers must handle BOTH, and distinguish either
 *  from "not a git repo" via `gitDirExists` — see the phase-1 note in extractor.ts. */
export async function committerDaysWithCommits(
  repo: string, author: { names?: string[]; emails?: string[] } | undefined, sinceDaysAgo: number, exclude?: RegExp[],
): Promise<Set<number>> {
  const cutoff = Date.now() - sinceDaysAgo * 864e5;
  // Include the subject so bot/auto commits can be excluded HERE too — otherwise a repo that
  // auto-commits every day (the vault) marks every day active and collapses the shared window to
  // just yesterday, hiding real older work that listCommits would then filter out anyway (#3/#1).
  const out = await runGit(["log", ...LOCAL_WORK_REFS, ...(await windowArgs(cutoff)), "--pretty=%cI%x1f%s", ...authorArgs(author)], repo);
  const days = new Set<number>();
  for (const line of out.split("\n").filter(Boolean)) {
    const [cISO, subject] = line.split("\x1f");
    if (!cISO) continue;
    if (exclude?.some((re) => re.test(subject ?? ""))) continue;
    const t = new Date(cISO.trim()).getTime();
    if (t >= cutoff) days.add(localMidnight(new Date(t)).getTime());
  }
  return days;
}

/** Commits by committer date within [start,end), filtered to author; with diffstat.
 *  `--all` makes this branch-independent (same rationale as committerDaysWithCommits).
 *  Diffstat comes from a SINGLE `git log --numstat` (not one `git show --numstat` per commit)
 *  — one process instead of N. */
export async function listCommits(
  repo: string, start: Date, end: Date, author?: { names?: string[]; emails?: string[] }, exclude?: RegExp[],
): Promise<Activity[]> {
  // %x1e record sep (leads each record), %x1f field sep; committer ISO + SHA + parents + subject.
  // %P (parent hashes) drives merge detection: a merge has 2+ parents.
  const fmt = "%x1e%cI%x1f%H%x1f%P%x1f%s";
  const out = await runGit(
    ["-c", "core.quotePath=false", "log", ...LOCAL_WORK_REFS, ...(await windowArgs(start.getTime())), "--date-order", "--numstat", `--pretty=format:${fmt}`, ...authorArgs(author)],
    repo,
  );
  const acts: Activity[] = [];
  for (const chunk of out.split("\x1e")) {
    if (!chunk.trim()) continue;
    const lines = chunk.split("\n");
    const [cISO, sha, parents, subject] = (lines[0] ?? "").split("\x1f");
    if (!cISO || !sha) continue;
    const t = new Date(cISO).getTime();
    if (t < start.getTime() || t >= end.getTime()) continue;
    // Drop merge commits (2+ parents): a "Merge pull request #N" bullet carries no file changes
    // (git shows no --numstat for merges) and just restates the feature commit already listed —
    // pure padding in the recap (audit 2026-07-11). The PR's real commits are recapped on their
    // own; a rare conflict-resolving "evil merge" is an accepted omission (its numstat is hidden
    // by default anyway). committerDaysWithCommits still counts merges, so a merge-only day is not
    // silently dropped from the window.
    if ((parents ?? "").trim().split(/\s+/).filter(Boolean).length > 1) continue;
    // Bot/auto-commit noise (#3). RETAINED, not dropped (slice 1.5 T0.2): the commit must still vote in
    // `unitForCommit` and set per-unit `sawWindowContent`, or an excluded-only day looks like a unit
    // that never existed. Every OTHER consumer skips it — see `meta.excluded`'s consumer list in
    // core.ts. It must never enter `u.commits`: that feeds `latestCommitTime`, the sole recency key in
    // `rankUnits`, and the newest commit of the day in an auto-committing repo is a bot commit on
    // 54/54 measured days — so admitting it would re-rank RESUME every morning.
    const excluded = exclude?.some((re) => re.test(subject ?? "")) ?? false;
    const diffstat = lines.slice(1).filter((l) => l.length > 0).map(parseNumstatRow);
    acts.push({
      source: "git", kind: "commit", event_id: sha, repo,
      timestamp: cISO, text: subject ?? "", meta: { diffstat, ...(excluded ? { excluded: true } : {}) },
    });
  }
  return acts;
}

/** ONE numstat-row parser for every attribution consumer (extract-at-2: listCommits and
 *  listPrMerges both feed unit attribution, and a silent divergence here mis-buckets work).
 *  A numstat path with a space/quote/tab/backslash stays C-quoted even under core.quotePath=false
 *  (that only governs non-ASCII octal), so the briefing would otherwise show a literal
 *  `"has\"quote.txt"` and summarize() would count the quoted form as a distinct file. Normalize a
 *  rename FIRST (displayFile picks the new-path side), THEN unquote — a quoted rename row is
 *  `"old" => "new"` with EACH side independently quoted, so unquoting the whole field first would
 *  treat the outer quotes as one token and mangle it. */
function parseNumstatRow(l: string): { file: string; added: number; removed: number; renamedFrom?: string } {
  const [added, removed, file] = l.split("\t");
  const renamedFrom = renamedFromOf(file ?? "");
  return {
    file: unquotePath(displayFile(file ?? "")), added: Number(added) || 0, removed: Number(removed) || 0,
    ...(renamedFrom !== undefined ? { renamedFrom: unquotePath(renamedFrom) } : {}),
  };
}

/** GitHub PR-merge commits ("Merge pull request #N from owner/branch") in [start,end), author-filtered.
 *  listCommits DROPS all merges (padding in the recap — audit 2026-07-11), but a PR *landing* is a real
 *  same-day event the briefing was otherwise blind to (audit 2026-07-16 day-9: it framed already-merged
 *  work as "resume the review", missing the PR-78 merge that happened that morning). Fetched on a
 *  SEPARATE channel from listCommits so a merge never enters resolveUnits' commit attribution (its
 *  first-parent numstat, added for T1.3's mergeLabel, restates the PR's own commits — counting it
 *  would double-vote every landed PR's files). Only GitHub's default "Merge pull request #N"
 *  subject matches, so `git pull` "Merge remote-tracking branch …" noise (exactly what PR #66 removed)
 *  stays out; users can still suppress a match via excludeCommitPatterns. `--merges` keeps the scan tiny. */
export async function listPrMerges(
  repo: string, start: Date, end: Date, author?: { names?: string[]; emails?: string[] }, exclude?: RegExp[],
): Promise<{ repo: string; sha: string; timestamp: string; prNum: string; branch: string; files: string[] }[]> {
  // `--diff-merges=first-parent --numstat` (T1.3 attribution unification): the old comment here said
  // "no --numstat: merges have none" — true only for the DEFAULT diff mode. First-parent numstat is
  // exactly the PR's net file change, which is what lets a merge be labeled by the same unit
  // plurality rule commits use (core.ts mergeLabel) instead of the bare repo. Requires git >= 2.31;
  // on ANY failure of the flagged invocation we retry once without it and return file-less merges —
  // fail open to today's exact labels, never cost the briefing.
  const fmt = "%x1e%cI%x1f%H%x1f%s"; // committer ISO + SHA + subject; first-parent numstat rows follow
  // -c core.quotePath=false, same as listCommits (review MED-1, measured): without it non-ASCII
  // paths come octal-escaped, unquotePath passes the escapes through, rootOf then matches no root —
  // dropping exactly the votes mergeLabel exists to count.
  const baseArgs = ["-c", "core.quotePath=false", "log", ...LOCAL_WORK_REFS, ...(await windowArgs(start.getTime())), "--merges", "--date-order", `--pretty=format:${fmt}`, ...authorArgs(author)];
  let out: string;
  let hasFiles = true;
  try {
    out = await runGit([...baseArgs, "--diff-merges=first-parent", "--numstat"], repo);
  } catch {
    hasFiles = false;
    out = await runGit(baseArgs, repo); // a real git failure here propagates, as before
  }
  const merges: { repo: string; sha: string; timestamp: string; prNum: string; branch: string; files: string[] }[] = [];
  for (const chunk of out.split("\x1e")) {
    if (!chunk.trim()) continue;
    const lines = chunk.split("\n");
    const [cISO, sha, subject] = (lines[0] ?? "").split("\x1f");
    if (!cISO || !sha) continue;
    const t = new Date(cISO).getTime();
    if (t < start.getTime() || t >= end.getTime()) continue;
    const m = /^Merge pull request #(\d+) from (\S+)/.exec(subject ?? "");
    if (!m) continue; // not a GitHub PR merge (pull-noise / plain branch merge) — skip
    if (exclude?.some((re) => re.test(subject ?? ""))) continue;
    const remote = m[2]!; // "owner/branch" (branch may itself contain slashes, e.g. feat/x)
    const slash = remote.indexOf("/");
    const branch = slash >= 0 ? remote.slice(slash + 1) : remote; // strip only the leading owner segment
    const files = hasFiles ? lines.slice(1).filter((l) => l.length > 0).map((l) => parseNumstatRow(l).file) : [];
    merges.push({ repo, sha, timestamp: cISO, prNum: m[1]!, branch, files });
  }
  return merges;
}

/** `git patch-id --stable` for each SHA — the content fingerprint git itself uses for cherry
 *  detection: two commits with equal stable patch-ids carry the identical change (rebase copies
 *  match even when hunk offsets shifted). Defect E (EVAL day 33): a rebase-merge plus a stale local
 *  branch put the SAME five changes into "Today so far" twice under different SHAs.
 *
 *  BEST-EFFORT by design: any failure (git missing patch-id, timeout, nonzero exit, merge commit
 *  with no patch) simply omits that SHA from the map, and the caller keeps both copies — fail open,
 *  never fail the briefing. Bounded: callers pre-filter to same-day commits with colliding subjects,
 *  so N is ~0 on a normal morning. Uses Bun.spawn directly (a two-process pipe) rather than runGit,
 *  which is single-command by contract. */
export async function patchIds(repo: string, shas: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const sha of shas) {
    try {
      const show = Bun.spawn(["git", "-C", repo, "show", "--format=", "--no-color", "--unified=3", sha],
        { stdout: "pipe", stderr: "ignore" });
      const patch = await new Response(show.stdout).arrayBuffer();
      if ((await show.exited) !== 0 || patch.byteLength === 0) continue;
      const pid = Bun.spawn(["git", "patch-id", "--stable"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
      pid.stdin.write(patch);
      await pid.stdin.end();
      const line = await new Response(pid.stdout).text();
      if ((await pid.exited) !== 0) continue;
      const id = line.trim().split(/\s+/)[0];
      if (id) out.set(sha, id);
    } catch {
      // fail open: an unmapped SHA is simply never deduped
    }
  }
  return out;
}

/** Window-independent "what was I in the middle of" signals: uncommitted changes,
 *  current branch (with ahead/behind vs. upstream), and any stashes. Always reflects
 *  the repo's CURRENT state, not the commit-history window. Resilient to a repo with
 *  no commits yet (unborn HEAD): branch-tip/ahead-behind is best-effort there, but
 *  uncommitted changes and stashes still surface. */
/** Sorted display list of the repo's current working-tree changes ("" = clean). Shared by
 *  resumptionSignals and the render-time freshness re-check (main.ts): working-tree state is
 *  volatile (the vault auto-commits every ~10 min), so a claim captured at extraction must be
 *  re-computable just before the briefing is written out.
 *  NB: don't `.trim()` the whole multi-line porcelain output before splitting — porcelain's
 *  first status column is a leading space for "unstaged" (e.g. " M a.txt"), and a blanket
 *  trim() eats exactly that leading space off the FIRST line only, shifting slice(3) and
 *  truncating that entry's filename. Split raw, then drop only genuinely empty lines.
 *  core.quotePath=false so unicode filenames print raw instead of octal-escaped. */
export async function uncommittedFiles(repo: string): Promise<string[]> {
  // core.optionalLocks=false: don't take index.lock to refresh the index — this is a read-only status
  // and the 7:20 run must not race a concurrent IDE/rebase/commit in the user's repo (GIT_OPTIONAL_LOCKS=0 equivalent).
  const statusLines = (await runGit(["-c", "core.quotePath=false", "-c", "core.optionalLocks=false", "status", "--porcelain"], repo))
    .split("\n").filter((l) => l.length > 0);
  return statusLines.map((l) => displayStatusEntry(l.slice(3))).sort();
}

export async function uncommittedFileList(repo: string): Promise<string> {
  return (await uncommittedFiles(repo)).join(", ");
}

/** Is this branch activity worth telling anyone about? ONE definition, shared by the prompt
 *  (`generator.ts`, which repeats it into each unit block) and the render (`core.ts`'s
 *  `branchStateLines`). Two copies of this predicate would drift, and the two sides disagreeing is
 *  exactly the "detected but not propagated" shape that produced the day-20 and day-21 findings.
 *
 *  The test is "is there anything worth saying", NOT "is this the default branch": suppressing every
 *  default-branch line would also suppress `main (ahead 12, behind 12)`, the day-16 B3 case that the
 *  project ruled must always print its numbers.
 *    - detached HEAD              -> yes (you are not on a branch; work can be lost)
 *    - a non-default branch       -> yes (the day-21 case)
 *    - divergence, or NO upstream -> yes (B3; and "no upstream" is not parity — see hasUpstream)
 *    - default branch, in sync    -> nothing to say
 *
 *  ⚠ Absent metadata REPORTS. A hand-built or older Activity carries no isDefaultBranch/hasUpstream,
 *  and defaulting those to the suppressing values would silently hide every branch line — the exact
 *  failure being fixed. `isDefaultBranch === true` is therefore required explicitly. */
export function isBranchNotable(a: Activity): boolean {
  if (a.kind !== "branch") return false;
  const m = a.meta ?? {};
  if (a.target === "HEAD") return true;                       // detached
  if (m.isDefaultBranch !== true) return true;                // non-default (or unknown)
  if (m.hasUpstream === false) return true;                   // never pushed — not parity
  return (m.aheadBehind?.ahead ?? 0) !== 0 || (m.aheadBehind?.behind ?? 0) !== 0;
}

export async function resumptionSignals(repo: string): Promise<Activity[]> {
  const out: Activity[] = [];
  const now = new Date().toISOString();

  const files = await uncommittedFiles(repo);
  const dirty = files.length > 0;
  if (dirty) {
    const base = { source: "git" as const, kind: "uncommitted" as const, repo, timestamp: now,
      text: `Uncommitted changes: ${files.join(", ")}`,
      meta: { uncommittedFiles: files } };
    out.push({ ...base, event_id: eventIdFor(base) });
  }

  // Branch tip / ahead-behind require a born HEAD; a brand-new repo with zero commits has
  // neither, so `rev-parse HEAD` throws there. Fall back to a best-effort branch name via
  // symbolic-ref (works even with no commits); omit the branch signal entirely if nothing
  // resolves rather than throw and lose the uncommitted/stash signals above.
  // Tip SHA + committer date in ONE `git show`; empty sha ⇒ unborn HEAD (no commits yet).
  const head = await shaAndDate(repo, "HEAD");
  const tip = head.sha || undefined;
  let branch: string | undefined;
  let ahead = 0, behind = 0;
  // ⚠ `hasUpstream` is NOT cosmetic. `git rev-list ...@{u}` exits 128 when a branch has no upstream
  // (MEASURED), the catch below swallows it, and ahead/behind stay 0 — byte-identical to genuine
  // parity. So a purely local branch rendered as "(ahead 0, behind 0)", which reads as "in sync with
  // origin": a false sync claim, the day-16 B3 family. The two states are now distinguishable.
  let hasUpstream = false;
  if (tip) {
    branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repo).catch(orElse(""))).trim() || undefined;
    if (branch) {
      try {
        const ab = (await runGit(["rev-list", "--left-right", "--count", `${branch}...@{u}`], repo)).trim().split("\t");
        ahead = Number(ab[0]) || 0; behind = Number(ab[1]) || 0;
        hasUpstream = true;
      } catch (e) { if (e instanceof IncompleteReadError) throw e; /* else: no upstream */ }
    }
  } else {
    // unborn HEAD (zero commits): best-effort branch name via symbolic-ref, which works with no commits.
    branch = (await runGit(["symbolic-ref", "--short", "HEAD"], repo).catch(orElse(""))).trim() || undefined;
  }
  if (branch) {
    // Branch signal's timestamp is the tip's committer date (spec §5.2), not run-time — it dates
    // "where the branch is", the same recency signal commits carry; run-time only when unborn.
    // Detached HEAD: `--abbrev-ref HEAD` literally returns "HEAD", which would otherwise render
    // the confusing "On branch HEAD (ahead 0, behind 0)". Use the already-resolved tip SHA instead.
    // The repo's DEFAULT branch: `origin/HEAD` UNION the main/master heuristic.
    //
    // ⚠ A UNION, not a precedence. The first version let `origin/HEAD` win outright and claimed "the
    // worst case is exactly what a hardcoded list gives" — FALSE, and measurably so. `origin/HEAD` is
    // written once at clone time and is NOT refreshed by `git fetch` (only `git remote set-head -a`
    // does that), so after the ubiquitous master→main rename a repo cloned pre-rename still reports
    // `origin/master`. MEASURED: clone before rename, rename upstream, `fetch --prune` → `origin/HEAD`
    // still `origin/master`, so a user sitting on `main` was marked non-default and got a permanent,
    // unactionable daily bullet — strictly WORSE than the hardcoded list this was meant to improve on.
    //
    // ⚠ And "verify the ref still exists" does NOT fix it: in that same measurement `origin/master`
    // remained a live tracking ref. The staleness is in the SYMBOL, not the target.
    //
    // The union makes the original claim true. `origin/HEAD` only ever ADDS coverage (a `trunk` or
    // `develop` repo is recognised), never removes the heuristic's. Residual, accepted: a repo whose
    // default is `trunk` where the user checks out a branch literally named `main` is treated as
    // default and stays silent. That suppresses one line in a case that barely occurs, against a
    // daily false line in a rename case that is everywhere.
    const originHead = branch === "HEAD" ? "" :
      (await runGit(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], repo).catch(orElse(""))).trim();
    const defaultBranch = originHead.replace(/^origin\//, "");
    const isDefaultBranch = branch !== "HEAD" &&
      (branch === defaultBranch || branch === "main" || branch === "master");
    const text = branch === "HEAD" && tip
      ? `Detached HEAD at ${tip.slice(0, 7)}`
      // "no upstream" is stated, never rendered as parity — see the hasUpstream note above.
      : `On branch ${branch} (${hasUpstream ? `ahead ${ahead}, behind ${behind}` : "no upstream"})`;
    const bBase = { source: "git" as const, kind: "branch" as const, repo, timestamp: head.date || now,
      target: branch, text,
      meta: { aheadBehind: { ahead, behind }, hasUpstream, isDefaultBranch, dirty, ...(tip ? { tip } : {}) } };
    out.push({ ...bBase, event_id: eventIdFor(bBase) });
  }

  // ONE `git stash list --format` yields sha + date + ref + subject per stash — no N+1 `git show`
  // per stash. `%gd: %gs` reconstructs the default `git stash list` line exactly (verified), and %H/%cI
  // are the same commit fields shaAndDate returned, so event_id (ref + sha) is unchanged.
  const stashes = (await runGit(["stash", "list", "--format=%H%x1f%cI%x1f%gd%x1f%gs"], repo)).trim();
  if (stashes) {
    for (const line of stashes.split("\n").filter(Boolean)) {
      const [sha, date, ref, subject] = line.split("\x1f");
      // spec §5.3: event_id carries the ref AND its SHA (a stash's ref, e.g. stash@{0}, is reused
      // across pushes/pops — the SHA identifies content). spec §5.2: timestamp is the stash's own date.
      const gd = ref || "stash";
      const sBase = { source: "git" as const, kind: "stash" as const, repo, timestamp: date || now,
        target: gd, text: `${gd}: ${subject ?? ""}`, meta: { sha: sha ?? "" } };
      out.push({ ...sBase, event_id: eventIdFor(sBase) });
    }
  }
  return out;
}
