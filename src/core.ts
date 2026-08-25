// src/core.ts — the pure pipeline core. runCore() computes the whole briefing (discover → extract →
// resolve units → today/mergedToday → reduce → net-gate → generate → working-tree-drift) and RETURNS
// a CoreResult (struct + raw model text + context + net/offlineSkipped flags), doing NO render/write/
// stamp I/O and making NO exit-code decisions. It is the SINGLE pipeline: production main.ts run() is
// a thin shell around it (gates → runCore → render/stamp/exit), and the eval harness scores the very
// same runCore, so there is no second copy to drift.
import { hostname, homedir } from "node:os";
import { discoverRepos, DEFAULT_BUDGET, repoLabel, resolveTranscripts, resolveAccounts } from "./config";
import { gitActivity, type RepoProbe } from "./extractor";
import { reduce } from "./reduce";
import { generateBriefing, norm } from "./generator";
// The output-side DIAGNOSTICS, called near the foot of `runCore`. They live at this layer — not in
// `generateBriefing` — because the struct is not final until this file stops writing to it.
import { checkResumeFreshness, checkSuggestionRestatement } from "./postcheck";
import { parseFloor } from "./schedule";
import { resolveAccount, effectiveAccounts, loadAccountState, recordLimit, recordAuthProbe, clearMark, parseResetInstant, outageReport } from "./account";
import { withRetry, withHardeningLadder } from "./provider";
import { hardenedProvider, type HardenedProvider } from "./harden";

/** Read a provider's accumulated DYNAMIC warnings (C1/B8). Structural rather than an `instanceof` so an
 *  injected test double can carry them and a plain `Provider` is simply a no-op — the wire should work
 *  for any provider that offers them, not only the one this module happens to construct. */
function runtimeWarningsOf(p: Provider): readonly string[] {
  const rw = (p as Partial<HardenedProvider>).runtimeWarnings;
  return Array.isArray(rw) ? rw : [];
}

/** Append `extra` to `base`, skipping values already present. `base` is preserved EXACTLY, duplicates
 *  and order included: de-duplicating what was already there would be a silent behaviour change beyond
 *  this fix's scope. Only the additions are de-duplicated, because withRetry can raise the same probe
 *  anomaly on all three attempts and the operator should read it once. */
function appendUnique(base: readonly string[], extra: readonly string[]): string[] {
  const seen = new Set(base);
  const out = [...base];
  for (const w of extra) if (!seen.has(w)) { seen.add(w); out.push(w); }
  return out;
}
import { localDateStr, supportDir, readLastRunDate } from "./marker";
import { join } from "node:path";
import { claudeShaped } from "./harden";
import { scanTranscripts } from "./transcripts/scan";
import { whySourceFor } from "./transcripts/join";

/** §3.1's read-window margin — the plan chose 24 h: it covers "started last evening, committed this
 *  morning", while a wider window admits stale claimants. */
export const TRANSCRIPT_READ_MARGIN_MS = 24 * 3_600_000;
import { isInaccessible, warnFor, type PathIssue, type GuardOpts } from "./protectedPath";
import { uncommittedFileList, isBranchNotable } from "./git";
import { ProviderError, type DoneItem, type Provider, type BriefingStruct, type Activity, type Config, type ReducedContext } from "./types";
import { resolveUnits, unitForCommit, unitForFiles, repoLabelFor, rootsForRepo, unitKey, INFRA_DENYLIST, type Unit } from "./subprojects";
import { resolveProbeHosts, waitForNetwork, defaultNetProbe, realSleep } from "./net";
import { isFullyAwake } from "./power";

export type RunDeps = {
  provider?: Provider;   // default: hardenedProvider(cfg.provider, …) — which wraps a BYOCliProvider
  guard?: GuardOpts;     // §5.11 classification injection (tests)
  probe?: RepoProbe;     // repo-readability probe (tests)
  retryDelaysMs?: number[];              // transient-provider retry schedule (tests inject short ones)
  sleep?: (ms: number) => Promise<void>; // injectable for tests
  statusNow?: (repo: string) => Promise<string>; // render-time working-tree re-check (tests inject drift)
  netProbe?: () => Promise<boolean>;     // network-reachability probe (tests)
  /** Injected power probe (tests). Production uses `isFullyAwake`'s default `pmset` call. */
  powerProbe?: (args: string[]) => Promise<{ code: number; out: string }>;
  /**
   * Injected platform (tests). Production leaves it undefined so `isFullyAwake` reads
   * `process.platform`.
   *
   * ⚠ WITHOUT THIS THE DARKWAKE TESTS SILENTLY STOP TESTING ANYTHING OFF macOS, which is what
   * happened: `isFullyAwake` returns true immediately on non-darwin (fail-open, deliberate — see
   * power.ts), so on ubuntu CI the injected `powerProbe` was never consulted, the gate never
   * engaged, and `run() SKIPS a scheduled tick in darkwake` failed. CI was red on `main` from
   * `5c1a6fda` (2026-08-09) for 7 consecutive merges before anyone noticed, because the suite is
   * green on the author's macOS.
   */
  powerPlatform?: NodeJS.Platform;
  netGraceMs?: number;                   // network-gate bounds (tests inject short ones)
  netPollMs?: number;
  /** §3.2's ambiguity policy, threaded to the join. Declaring the field without threading it is the
   *  defect T3.3 made it injectable to avoid — MUT2 is the only detector that the drop is live. */
  onAmbiguity?: "drop" | "keep-earliest";
  /** Injected clock. It owns exactly TWO new call sites — the scan's localDay bucketing and the read
   *  window's `now` end. It does NOT replace runDate/stateAsOf/extractor time, which are existing
   *  behaviour with existing tests; replacing those would change behaviour for every current user. */
  now?: () => Date;
  /** Injected transcript reader, so the scan is testable without a real corpus. */
  scan?: typeof import("./transcripts/scan").scanTranscripts;
  /** Injected health writer, so T4.9's ordering is assertable without touching the real state dir. */
  persistHealth?: (date: string, counters: import("./transcripts/scan").TranscriptRunCounters) => Promise<void>;
  /** Prior health history, so §3.8's multi-day triggers (zero-yield) are testable without a state dir. */
  priorHealth?: import("./transcripts/health").TranscriptHealth;
  preWarnings?: string[];                // shell-supplied warnings (e.g. floor.warning) folded in BEFORE the empty/blocked return, so they reach the struct exactly as production run() surfaced them
};

// The launchd 7:20 job coalesces to fire the moment a slept-through-7:20 laptop wakes — often
// seconds BEFORE wifi re-associates — and there is exactly one trigger per day. A transient
// provider failure (network-down nonzero exit, timeout) is therefore retried on a short bounded
// schedule instead of burning the morning. missing-binary is permanent and never retried.
export const PROVIDER_RETRY_DELAYS_MS = [45_000, 90_000];

// Render-time freshness re-check (audit 2026-07-10 #1): the briefing's uncommitted-files claims are
// captured at extraction, but generation takes seconds-to-minutes and repos change underneath (the
// vault auto-commits every ~10 min — this produced a briefing whose top two suggestions rested on
// files that were already committed). Re-read each claimed repo's working tree just before writing
// the briefing; any drift becomes an explicit warning rather than a silently-stale "fact".
/** CODE-RENDERED branch state for "Where you left off" (day-21 audit).
 *
 *  WHY DETERMINISTIC. On 2026-08-06 `personal_code` sat on `chore/sign-live-policy`; the briefing
 *  never said so, and framed the loose `policy.toml` edit as an item23 tail, advising the reader to
 *  commit it "tying it to that work". It was a signing chore. The branch name alone would have
 *  flipped that guidance from wrong to right — and the branch line DID reach the prompt, in the
 *  repo-level catch-all block, while the resume item was written against a sub-project unit. The
 *  model never made the join. A prompt instruction asks it to try again; this cannot be dropped.
 *
 *  SUPPRESSION — the predicate is "is there anything worth saying", NOT "is this the default
 *  branch". Suppressing every default-branch line would also suppress `main (ahead 12, behind 12)`,
 *  which is the exact day-16 B3 case the project ruled must always print its numbers. So:
 *    - detached HEAD              -> always (you are not on a branch; work can be lost)
 *    - a non-default branch       -> always (the day-21 case)
 *    - any divergence, or NO upstream -> always (B3: never a sync claim without the numbers, and
 *                                     "no upstream" is not parity — see git.ts)
 *    - default branch, in sync    -> nothing to say -> silent
 */
export function branchStateLines(
  activities: Activity[], repoPaths: string[],
): { repo: string; text: string }[] {
  const out: { repo: string; text: string }[] = [];
  for (const a of activities) {
    if (a.kind !== "branch" || !a.repo || !a.text) continue;
    if (!isBranchNotable(a)) continue;   // ONE predicate, shared with the prompt — see git.ts
    out.push({ repo: repoLabel(a.repo, repoPaths), text: a.text });
  }
  return out;
}

/** One repo whose working tree changed between extraction and render. `resolved` is the files that
 *  WERE dirty and no longer are — the only ones that can make a suggestion stale. */
export type WorkingTreeDrift = { label: string; was: string; now: string; resolved: string[] };

// ⚠ EXACT-TOKEN membership against the ", "-joined string, NOT a re-split of it. Splitting is
// unfixable by choice of separator: `,` shattered "has,comma.md", and `", "` still shatters
// "x, y.md" — both desynchronise the two sides of the set-difference once `was` comes from the
// structured `meta.uncommittedFiles`, so a STILL-DIRTY file drops out and is reported resolved,
// marking LIVE work "already committed" (the direction this file's tests call worse than the bug
// being fixed). Anchoring each candidate at a delimiter boundary instead has no such failure mode:
// the separator is only ever consulted around a known filename, never used to guess where one ends.
const joinedListHas = (joined: string, f: string): boolean =>
  joined === f || joined.startsWith(`${f}, `) || joined.endsWith(`, ${f}`) || joined.includes(`, ${f}, `);
const fileList = (s: string) => s.split(", ").map((f) => f.trim()).filter(Boolean);

/** The measurement half of the drift re-check, split out so the warning text and the suggestion
 *  annotation are computed from ONE `statusNow` read per repo rather than two. */
export async function computeWorkingTreeDrift(
  uncommitted: Activity[], repoPaths: string[],
  statusNow: (repo: string) => Promise<string> = uncommittedFileList,
): Promise<WorkingTreeDrift[]> {
  const drifts: WorkingTreeDrift[] = [];
  for (const a of uncommitted) {
    if (a.kind !== "uncommitted" || !a.repo) continue;
    const was = (a.text ?? "").replace(/^Uncommitted changes: /, "");
    const now = await statusNow(a.repo).catch(() => null);
    if (now === null || now === was) continue; // unverifiable → stay silent; unchanged → fine

    // ⚠ Prefer the STRUCTURED list. `was` is recovered by regex-stripping rendered prose and then
    // re-splitting on ","; that was harmless while it only fed display text, but it now feeds a
    // MATCHING decision. A path containing a comma shatters into short tokens ("has,comma.md" →
    // ["has", "comma.md"]) and a 3-char token matches ordinary English prose, producing a false
    // "already committed" on an unrelated suggestion. `meta.uncommittedFiles` is the real array the
    // git layer already carries; the split stays only as a fallback for activities without it.
    const wasFiles = a.meta?.uncommittedFiles ?? fileList(was);
    drifts.push({
      label: repoLabel(a.repo, repoPaths), was, now,
      // ⚠ INFRA paths are dropped here, not by the caller. `subprojects.ts` strips them before the
      // prompt and `generator.ts` strips suggestions containing them, so the model PROVABLY never
      // saw one — any match against a resolved agent-scratch path is coincidental by construction,
      // and annotating on it marks live work done. This restores an invariant the codebase already
      // asserts at two other layers.
      resolved: wasFiles.filter((f) => !joinedListHas(now, f) && !INFRA_DENYLIST.some((d) => f.includes(d))),
    });
  }
  return drifts;
}

export function driftWarnings(drifts: WorkingTreeDrift[]): string[] {
  return drifts.map((d) =>
    `working-tree changed while generating: [${d.label}] was "${d.was}" → ` +
    `${d.now === "" ? "now clean (auto-committed?)" : `now "${d.now}"`} — re-verify "Where you left off" before acting`);
}

/** Propagate drift INTO the items it invalidates (day-20 audit). The footer warning alone left the
 *  briefing recommending work it had already detected was done: on 2026-08-04 the footer said the
 *  vault was "now clean (auto-committed?)" while suggestion #1 still said to commit those exact
 *  files. A reader acting top-down follows the stale instruction and never reaches the correction.
 *
 *  Matching is on the RESOLVED file paths only — files that were dirty and no longer are. A repo
 *  that merely changed (some files committed, others still dirty) annotates only the suggestions
 *  naming the committed ones. Matching is boundary-aware (see `mentionsPath`) — deliberately NOT the
 *  bare `includes` that `generator.ts`'s INFRA_DENYLIST filter uses; an earlier comment claimed the
 *  two mirrored each other, which stopped being true once boundaries landed. The model quotes paths
 *  from the data block, so full-path hits are the common case and a unique basename covers the rest.
 *
 *  ⚠ Deliberately ANNOTATES rather than DROPS. A suggestion can name a resolved file incidentally
 *  while still proposing real work, and this match is a substring test on model prose — not strong
 *  enough evidence to silently delete a recommendation. Being told "verify this first" costs the
 *  reader a moment; losing a genuine next step costs them the point of the briefing. */
// ⚠ "no longer in the working tree", NOT "committed". `resolved` means it left `git status` — which
// is equally true after a stash, a restore, a delete, a rename, or a .gitignore change, where the
// work is GONE rather than DONE. Asserting the cause would be a claim the evidence cannot support.
export const STALE_NOTE = " ⚠ no longer in the working tree (committed, stashed or reverted) — verify before acting";

/** Substring match with PATH BOUNDARIES on both sides. A bare `includes` produced three measured
 *  classes of false "already committed":
 *    - basename containment between DIFFERENT files — `core.ts` is a substring of `score.ts`
 *      (77 such basename pairs measured in this workspace alone);
 *    - cross-project basename collision — a resolved `daily_briefing_application/STATE.md` matching
 *      "update quant_stocks/STATE.md" (7 tracked `STATE.md` paths here);
 *    - untracked DIRECTORIES — git collapses them to `src/`, which then matched any file under it.
 *  Requiring a non-path character (or a string edge) on both sides kills all three while still
 *  matching the normal cases, where the model writes the name in prose, in quotes, or in backticks.
 *  A leading "/" counts as a path char, which is what makes the cross-project collision miss. */
const PATH_CHAR = /[A-Za-z0-9._/-]/;
/** ⚠ A "." only continues a path when a WORD CHARACTER follows it. Treating "." as a path character
 *  unconditionally — the first version of this — made a SENTENCE-FINAL period defeat the match:
 *  "Commit done.md." missed, while every other punctuation shape matched. That is the single most
 *  common way a suggestion ends, so the guard would have silently failed on the majority of real
 *  cases while all four boundary tests stayed green. `done.md.bak` must still miss, which is why the
 *  rule is "dot + word char", not "dot never counts". */
const continuesPath = (text: string, j: number): boolean => {
  const c = text[j];
  if (c === undefined) return false;                       // end of string is always a boundary
  // Lookahead mirrors PATH_CHAR's word members (adds _ and -), so `done.md._old` correctly
  // continues the path rather than matching `done.md`.
  if (c === ".") return /[A-Za-z0-9_-]/.test(text[j + 1] ?? "");
  return PATH_CHAR.test(c);
};
/** Exported for tests only — the empty-name hang guard is unreachable through
 *  `annotateStaleSuggestions` (its caller filters empty names out), so only a direct call can pin it. */
export function mentionsPath(text: string, name: string): boolean {
  // ⚠ NON-TERMINATION GUARD, and it must be LOCAL. `"abc".indexOf("", n)` CLAMPS to `text.length`
  // rather than returning -1, so an empty `name` makes the loop below spin forever — in an
  // unattended 07:20 launchd job that is a HANG, not a failed briefing. An empty name is reachable:
  // git renders an untracked directory as "sub/", whose basename is "". The caller filters those
  // out, but a guard thirteen lines away in another function is not a guard.
  if (!name) return false;
  for (let i = text.indexOf(name); i !== -1; i = text.indexOf(name, i + 1)) {
    const beforeOk = i === 0 || !PATH_CHAR.test(text[i - 1]!);
    if (beforeOk && !continuesPath(text, i + name.length)) return true;
  }
  return false;
}

export function annotateStaleSuggestions<T extends { text: string }>(
  suggestions: T[], drifts: WorkingTreeDrift[],
): T[] {
  const resolved = drifts.flatMap((d) => d.resolved);
  if (!resolved.length) return suggestions;
  // ⚠ `.filter(Boolean)` IS LOAD-BEARING, not defensive tidiness. `git status --porcelain` renders an
  // untracked DIRECTORY with a trailing slash ("?? sub/"), so its basename is the EMPTY STRING — and
  // `s.text.includes("")` is true for every string, which would annotate EVERY suggestion as already
  // committed. MEASURED: with the guard, an unrelated suggestion is untouched; without it, all of
  // them are marked. (`?? f` was dropped: `split` always returns at least one element, so `pop()`
  // never yields undefined — it was unreachable dead code masquerading as a guard.)
  // ⚠ FULL PATHS ONLY — the bare-basename fallback is GONE. Three independent reviews plus a fuzz
  // pass converged on it as the last false-positive shape: MEASURED 28 false positives across 1836
  // prose cases, every one of them "same leaf, different directory" (`quant_stocks/STATE.md`
  // resolved, "rewrite the STATE.md in daily_briefing_application" annotated). 36 duplicate
  // basenames across 757 tracked files here; `STATE.md` x7, `README.md` x11.
  //
  // Uniqueness-within-`resolved` was tried first and is INSUFFICIENT: with a single resolved
  // `quant_stocks/STATE.md` the leaf is trivially unique, so the bare `STATE.md` still matched — the
  // measured case above. Repo-scoping does not fix it either, because `personal_code` is ONE repo
  // holding every sub-project.
  //
  // The cost is false NEGATIVES when the model writes a bare leaf, and that is the correct trade:
  // this file's own tests call a false "already done" worse than the bug being fixed, because the
  // reader skips real work. The prompt prints repo-relative paths under a `UNIT <label>` banner
  // (`generator.ts`), so the common case is the model quoting the same form `resolved` holds.
  const names = [...new Set(resolved)].filter(Boolean);
  return suggestions.map((s) =>
    s.text.includes(STALE_NOTE) || !names.some((n) => mentionsPath(s.text, n))
      ? s
      : { ...s, text: s.text + STALE_NOTE });
}

export async function workingTreeDriftWarnings(
  uncommitted: Activity[], repoPaths: string[],
  statusNow: (repo: string) => Promise<string> = uncommittedFileList,
): Promise<string[]> {
  return driftWarnings(await computeWorkingTreeDrift(uncommitted, repoPaths, statusNow));
}

// A run must NOT stamp the day (retryable) when it produced nothing AND at least one repo we
// actually tried to read was inaccessible — TCC- OR ordinary-perms-blocked. The emptiness may be
// caused by that block, so consuming the day would silently drop that repo's work. A genuine quiet
// day (all repos readable, just no activity) or a merely-absent (not-a-repo) path still stamps.
// NB: keyed on RESOLVED-repo issues, not discovery-root issues, so an incidental blocked folder
// for a user with genuinely no repos can't create a permanent non-stamping loop.
export function blockedDelivery(activityCount: number, resolvedRepoIssues: PathIssue[]): boolean {
  return activityCount === 0 && resolvedRepoIssues.some(isInaccessible);
}

export type CoreResult = {
  emptyWindow: boolean; blocked: boolean;
  /** Why a scheduled run declined to call the provider. "offline" = the net gate never came up;
   *  "darkwake" = the machine is in a maintenance wake where the provider call cannot complete even
   *  though a TCP probe succeeds. Distinct because the REMEDY differs and, on 2026-08-08, an
   *  undistinguished failure block was misdiagnosed twice. */
  skipReason?: "offline" | "darkwake" | "limited";
  /** Set whenever `skipReason === "limited"`. `until` is what the shell prints; `isProbe` says whether
   *  it is a PARSED reset or merely a probe deadline — the message may only say "resets at…" for the
   *  former, because a probe deadline is a one-hour guess the system explicitly does not trust. */
  /** `exhausted` says whether ANY account remains selectable after this tick's mark — it is the
   *  difference between "the fallback delivers in ten minutes" and "there is nothing left until the
   *  reset", and the shell states one or the other. It is COMPUTED (re-resolved against the state as
   *  written), never assumed: until 2026-08-24 the shell asserted "no other account is available" as a
   *  hardcoded literal, so the live failover test printed it while the fallback sat unmarked and ready. */
  limited?: { label: string; until: string; isProbe: boolean; exhausted: boolean };
  offlineSkipped: boolean;                       // scheduled run, still offline after the grace → provider NOT called; shell returns 0, no stamp
  net: { online: boolean; waitedMs: number } | null; // net-gate outcome; null when the gate wasn't reached (empty/blocked)
  struct: BriefingStruct; rawText: string;      // rawText = "" when emptyWindow (contract: model output only)
  promptText: string;                            // "" when emptyWindow
  ctx: ReducedContext; units: Unit[];
  activities: Activity[]; repos: string[];       // raw — shell needs neither now, but kept for drift/debug
  runDate: string;                               // localDateStr(new Date()) computed ONCE (no re-stamp drift)
  discIssues: PathIssue[]; extrIssues: PathIssue[];
  warnings: string[]; today: { repo: string; text: string }[];
  /** §4. Lives OUTSIDE ReducedContext and never reaches the prompt; carried so the eval harness and
   *  the `whys` projection can read it. Absent when the feature is off or degraded to git-only. */
  transcripts?: import("./transcripts/scan").TranscriptEvidence;
  /** The account label that actually produced this briefing, on the SUCCESS path. Set only when
   *  `provider.accounts` is configured: on a single-account machine there is no choice to record, and
   *  logging the synthesised "default" every morning would add a line to briefing.log for nothing.
   *  Exists because the 2026-08-24 live failover test had no way to prove which account had delivered
   *  except the mtime of a session directory under the fallback's config dir — incidental evidence
   *  that would not survive the next CLI change, for the one fact the whole feature turns on. */
  account?: string;
  /** The git window's start, carried onward for the eval harness (§3.1). */
  windowStartUtc: string;
  /** The SAME-DAY items rendered into the prompt's ALREADY DONE TODAY block, exactly as derived
   *  here — carried (not recomputed) for the eval harness's G7 `recency`. Same rationale as
   *  `transcripts` above: the harness must read what the model was shown, and a second derivation of
   *  the unit LABEL (unitForCommit + repoLabelFor) would be free to drift from this one. `[]` on a
   *  day with no same-day commits, which is what G7's no-op predicate gates on.
   *
   *  ⚠ OPTIONAL, and the reason is semantic rather than convenience: the three early-return paths
   *  (empty window, darkwake, offline) return BEFORE this is derived, and on those paths no prompt
   *  was ever built — so there is no "what the model was shown" to report. `undefined` says that;
   *  `[]` would falsely claim "the model was shown nothing today". G7 treats both as no-op. */
  todaySuppress?: DoneItem[];
};

/** The pure pipeline: cfg + injected deps → the computed briefing struct (+ raw model text/context).
 *  Does NO render/write/stamp I/O and makes NO exit-code decisions — run() (the shell) owns those. */
export async function runCore(cfg: Config, deps: RunDeps, force = false): Promise<CoreResult> {
  const { repos, issues: discIssues } = await discoverRepos(cfg, deps.guard);
  const { activities, warnings, issues: extrIssues, today: todayActs, mergedToday, windowMerges, windowStartUtc } =
    await gitActivity(cfg, repos, { ...deps.guard, probe: deps.probe });

  // Resolve sub-project units ONCE (Task 15): the window activity + today's commits are both
  // attributed against the same unit set, and any resolution warnings (unknown subprojects repo,
  // zero-glob roots, workspace-detection failure, ...) are merged into the run's warnings so they
  // surface on BOTH the normal briefing and the zero-activity early-return below.
  const { units, warnings: unitWarnings, rootsByRepo } = await resolveUnits(activities, todayActs, repos, cfg);

  // Merge attribution (T1.3): label a PR merge by the UNIQUE plurality unit of its first-parent
  // numstat files — the SAME rule commits use (unitForFiles is unitForCommit's extracted core), so
  // one PR's commits and its merge line finally carry one label instead of splitting the story
  // across `[unit]` and `[bare-repo]` tags (day-34: `#257 feat/tick-kill-switch` — pure
  // accountant_ai work filed under `[personal_code]`). Fallbacks preserve today's exact behaviour:
  // tie or no files (old git, degraded parse) → bare repo label; a unit resolveUnits never created
  // (merge-only activity under a root) → bare repo label rather than a label coverageGaps and the
  // whys projection have never seen.
  const mergeLabel = (m: { repo: string; files: string[] }): string => {
    const root = unitForFiles(m.files, rootsByRepo.get(m.repo) ?? rootsForRepo(units, m.repo));
    return units.find((u) => u.repo === m.repo && u.root === root)?.label ?? repoLabelFor(m.repo, repos);
  };
  warnings.push(...unitWarnings);
  warnings.push(...(deps.preWarnings ?? [])); // shell-supplied (e.g. floor.warning), BEFORE the empty return so it reaches the struct
  // Resolve the probe hosts ONCE, up front — so a malformed-networkProbeHosts warning lands in the
  // (possibly empty) struct exactly as production run() surfaced it, before the empty/blocked return.
  const { hosts: probeHosts, warning: probeWarning } = resolveProbeHosts(cfg.networkProbeHosts);
  if (probeWarning) warnings.push(probeWarning);
  // §3.6 requires a malformed `transcripts` block to degrade "with a config-blaming warning" at the
  // consumer boundary. Found at C1 with no reader at all: config.ts produced this warning and nothing
  // consumed it, which is the same defect class as a DropReason with no writer.
  const tx = resolveTranscripts(cfg.transcripts, homedir());
  if (tx.warning) warnings.push(tx.warning);
  // A4 — transcripts require a claude-shaped CLI, as PRODUCT SCOPE (transcript support is for Claude
  // Code users). The predicate is a filename check and cannot see a proxy; that residual is stated in
  // §3.4, not solved here. A silent no-op would be the worse failure: the user enabled a feature and
  // would never learn why nothing appeared.
  if (tx.enabled && !claudeShaped(cfg.provider.cli)) {
    warnings.push(`transcripts.enabled is set, but "${cfg.provider.cli}" is not a Claude Code CLI — transcript evidence is off for this run.`);
  }

  // (Wake-schedule drift removed with the pmset-wake mechanism — PR #81 replaced RTC-wake scheduling
  // with a StartInterval self-gating launchd agent, so there is no external repeat schedule to drift.)

  // Deterministic "today so far" (#1): commits made today (excluded from the window). Formatted here,
  // never sent to the LLM, so it can't be hallucinated — this rendered `today` list is the ONLY thing
  // shown to a human. Today's raw subjects are ALSO handed to the model as SHA-free suppress-only
  // context (todaySuppress, below) so it doesn't re-suggest work already done today, but only when the
  // window has real activity (buildDoneBlock no-ops on an empty body). Labeled by the RESOLVED unit's
  // label (not the bare repo label) so a same-day-only sub-project commit shows its sub-project, not
  // just its repo. Buckets against resolveUnits' REAL roots (rootsByRepo), not the survivor subset
  // (rootsForRepo), which can mis-attribute a commit for nested project roots (see subprojects.ts's
  // resolveUnits).
  const realTodayActs = todayActs.filter((a) => !a.meta?.excluded);
  const today = realTodayActs.map((a) => {
    const root = unitForCommit(a, rootsByRepo.get(a.repo ?? "") ?? rootsForRepo(units, a.repo ?? ""));
    const label = units.find((u) => u.repo === a.repo && u.root === root)?.label ?? repoLabelFor(a.repo ?? "", repos);
    return { repo: label, text: `${a.text ?? ""} (${(a.event_id ?? "").slice(0, 7)})`.trim() };
  });
  // Landed-PR events for today (audit 2026-07-16): merges are dropped from the recap as padding, but a
  // PR merging today is a real same-day event — without it the briefing mis-frames merged work as
  // "resume the review". Labeled by the merge's first-parent file plurality (mergeLabel above; bare
  // repo on tie/no-files) and, like the rest of "today so far", rendered deterministically and never
  // sent to the LLM.
  for (const m of mergedToday) {
    today.push({ repo: mergeLabel(m), text: `🔀 Merged #${m.prNum} (${m.branch}) (${(m.sha ?? "").slice(0, 7)})` });
  }
  // In-window PR landings (defect D — EVAL day 33, user-directed): same deterministic treatment,
  // rendered as dated lines at the foot of "What you did" (render.ts). Dated like recap bullets —
  // "(Aug 17)" — because "which morning did this land" is exactly the question the line answers.
  // Render-only: NOT added to todaySuppress (that list is same-day context by contract, and the
  // freshness postcheck keys on it — types.ts:149); the model stays blind to landings, which is the
  // stated residual of this fix, and the READER no longer is.
  const windowMergeLines = windowMerges.map((m) => {
    const d = new Date(m.timestamp ?? 0);
    const dateTag = isNaN(d.getTime()) ? "" : ` (${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })})`;
    return { repo: mergeLabel(m), text: `🔀 Merged #${m.prNum} (${m.branch})${dateTag}  (${(m.sha ?? "").slice(0, 7)})` };
  });

  // SHA-free suppress-context for the prompt (design 2026-07-19): raw subjects + a whenMs sort key so
  // buildPrompt can keep the newest 30. Never rendered, never in the struct. Commit dates from
  // Activity.timestamp; merge dates from MergedToday.timestamp. Empty subjects dropped.
  const todaySuppress: DoneItem[] = [];
  for (const a of realTodayActs) {
    const subject = (a.text ?? "").trim();
    if (!subject) continue;
    const root = unitForCommit(a, rootsByRepo.get(a.repo ?? "") ?? rootsForRepo(units, a.repo ?? ""));
    const label = units.find((u) => u.repo === a.repo && u.root === root)?.label ?? repoLabelFor(a.repo ?? "", repos);
    todaySuppress.push({ label, subject, whenMs: new Date(a.timestamp ?? 0).getTime() });
  }
  for (const m of mergedToday) {
    todaySuppress.push({ label: mergeLabel(m), subject: `Merged #${m.prNum} (${m.branch})`, whenMs: new Date(m.timestamp ?? 0).getTime() });
  }

  // Capture the run's date ONCE: the retry schedule can carry a run across midnight, and recomputing
  // at render/stamp time would date the briefing — and, worse, the day marker — as TOMORROW, silently
  // skipping the next scheduled run (final-review finding).
  const runDate = localDateStr(new Date());
  // When the working-tree ("resume") facts were captured — rendered on the resume header so a reader
  // hours later knows the claims' vintage (they're volatile; see workingTreeDriftWarnings).
  const stateAsOf = new Date().toTimeString().slice(0, 5);
  // Day-23: printed beside stateAsOf so on-time vs late is legible without inferring a cause.
  const fm = parseFloor(cfg.morningTime).minutes;
  const morningFloor = `${String(Math.floor(fm / 60)).padStart(2, "0")}:${String(fm % 60).padStart(2, "0")}`;
  // A provider-less BriefingStruct (empty-window / offline-skip): identical but for the provider label.
  // Hoisted here because both the outage computation below and account selection need it. `deps.now`'s
  // own docstring said it owned exactly two call sites; this is the third and fourth.
  const clockNow = deps.now ?? (() => new Date());

  // Computed BEFORE the provider call and applied to every struct this function can return: the
  // empty-window and blocked paths build their own structs and still get rendered and written, so a
  // recovery day that happens to be an empty-window day must still carry the line.
  const outage = outageReport(await readLastRunDate(), (await loadAccountState()).lastLimit, clockNow());
  const mkStruct = (provider: string): BriefingStruct => ({
    date: runDate, machineScope: hostname(), provider, resume: [], recap: [], suggestions: [], today, windowMerges: windowMergeLines, stateAsOf, morningFloor, warnings,
    ...(outage ? { outage } : {}),
  });

  // ctx is a pure, provider-independent transform of the activities; computed here so the CoreResult
  // always carries it (harmlessly {repos:[]} when there's no window activity).
  // `meta.excluded` commits (bot/auto-commit noise) are retained through `resolveUnits` so they can vote
  // for a root and mark window content — but they are invisible to EVERY other consumer. Filtering once,
  // here, covers `reduce` and therefore `knownShas`, `bucketActivities` and `buildPrompt` downstream.
  const realActivities = activities.filter((a) => !a.meta?.excluded);
  const ctx = reduce(realActivities, cfg.tokenBudget ?? DEFAULT_BUDGET);

  // A bot-commit-only day is an HONEST empty window: it must skip the provider, exactly as a silent day
  // does. Counting excluded commits here would call the provider with nothing real to say.
  const emptyWindow = realActivities.length === 0;
  // Empty run + an inaccessible repo we tried to read = delivery FAILURE, not a quiet day (§5.11):
  // the shell must NOT stamp and must exit non-zero so the next run retries once access is fixed.
  // BUT if there IS today's work (from readable repos), don't discard it — not blocked; the shell
  // renders it via the emptyWindow path (the block still shows as a warning).
  const blocked = blockedDelivery(realActivities.length, extrIssues) && today.length === 0;

  if (blocked || emptyWindow) {
    // Zero activity is an HONEST empty briefing enforced in code (§7): skip the provider entirely so a
    // quiet day can never be hallucinated. A day with only resumption signals (a half-done branch) is
    // NOT empty and still briefs.
    const empty = mkStruct("(no window activity)");
    return {
      emptyWindow, blocked, offlineSkipped: false, net: null, struct: empty, rawText: "", promptText: "",
      ctx, units, activities, repos, runDate, discIssues, extrIssues, warnings, today, windowStartUtc,
    };
  }

  // Hoisted above account selection, which needs it: `deps.now`'s own docstring says it owns exactly two
  // call sites, and account selection is the third — the sticky/revert behaviour is untestable without
  // an injectable clock.
  // ── Account selection ───────────────────────────────────────────────────────────────────────────
  // Resolved UNCONDITIONALLY, before the `deps.provider` ternary: the catch below records a limit
  // against "the label this run resolved", and an injected-provider path would otherwise have none.
  // (Recording itself is still gated on having built the provider — see the catch.)
  // Validated HERE, not in validateConfig: a malformed list disables failover with a warning the user
  // can see, rather than throwing (which would cost the briefing every tick) or silently stripping
  // (which would destroy the diagnostic). Same shape as resolveTranscripts above.
  const acc = resolveAccounts(cfg.provider.accounts, homedir());
  for (const w of acc.warnings) warnings.push(w);
  const accountState = await loadAccountState();
  const account = resolveAccount(acc.accounts, accountState, clockNow());

  // No usable account: every configured login is walled off (or the single implicit one is). Skip
  // WITHOUT constructing a provider or spawning anything — this is a known wall, not an error, so it
  // takes the same quiet `return 0` path the offline/darkwake skips take rather than the error path,
  // which would print a failure line every 600s for the length of the outage.
  if (!account) {
    // ⚠ label, until and isProbe must come from the SAME account. They did not until 2026-08-24:
    // `label` was read from `lastLimit` (whichever account most recently walled) while `until`/`isProbe`
    // were read from the FIRST account's mark unconditionally — so with a walled primary (resets in 3
    // days) and a later-walled fallback (resets in 9 hours) the shell printed the fallback's NAME beside
    // the primary's RESET, and in the mirror case printed an untrusted probe deadline as a parsed reset.
    // Same falsehood class as the hardcoded clause above, in the same sentence.
    const reportLabel = accountState.lastLimit?.label ?? effectiveAccounts(acc.accounts)[0]!.label;
    const walled = accountState.accounts[reportLabel];
    const skip = mkStruct("(skipped: limited)");
    return {
      emptyWindow: false, blocked: false, offlineSkipped: true, skipReason: "limited",
      limited: {
        label: reportLabel,
        until: walled?.limitedUntil ?? "",
        isProbe: walled?.isProbe ?? true,
        exhausted: true,        // this branch IS "resolveAccount found nothing selectable"
      },
      net: null, struct: skip, rawText: "", promptText: "",
      ctx, units, activities, repos, runDate, discIssues, extrIssues, warnings, today, windowStartUtc,
    };
  }

  // Kept as a typed local so the B6 ladder and B8's warning merge can reach the wrapper's own members.
  // An injected `deps.provider` (tests, the eval) is a plain Provider and simply gets neither.
  // `CLAUDE_CONFIG_DIR` is passed as a PER-SPAWN env option and must never be written to process.env:
  // that variable also resolves the transcript scan root (config.ts resolveTranscripts), so exporting
  // it would silently point transcript discovery at the fallback's directory on exactly the days
  // failover engages, with claudeShaped still passing and nothing warning.
  const hardened = deps.provider ? undefined : hardenedProvider(cfg.provider, {
    timeoutMs: cfg.provider.timeoutMs,
    ...(account.configDir !== undefined ? { env: { CLAUDE_CONFIG_DIR: account.configDir } } : {}),
  }); // #8: honor the config timeout knob
  const provider: Provider = deps.provider ?? hardened!;
  const delays = deps.retryDelaysMs ?? PROVIDER_RETRY_DELAYS_MS;

  // Gate the provider call on real connectivity (bounded). A scheduled (non-forced) run still offline
  // after the grace SKIPS without calling the provider — the shell returns 0, does NOT stamp, and the
  // ~10-min interval loop retries; a forced run proceeds (its own retry schedule is the fallback). The
  // net OUTCOME is RETURNED (not printed here) so the shell (run()) owns all I/O. probeHosts was
  // resolved up front (above), so its malformed-config warning is already in `warnings`.
  // ⚠ DARKWAKE GATE, BEFORE the network gate — deliberately, because the network gate PASSES here.
  // `pmset` keeps TCPKeepAlive active through clamshell sleep, so the anycast TCP probe answers in
  // ~0s while the provider call cannot complete; on 2026-08-08 that cost three timeouts and a failure
  // block that was misdiagnosed twice. A scheduled run in a darkwake declines exactly as an offline
  // one does: no provider call, no stamp, retry next tick.
  //
  // A FORCED run is never gated — the user is present and asking, which is the same carve-out the
  // network gate makes.
  if (!force && !(await isFullyAwake(deps.powerPlatform, deps.powerProbe))) {
    const skip = mkStruct("(skipped: darkwake)");
    return {
      emptyWindow: false, blocked: false, offlineSkipped: true, skipReason: "darkwake",
      net: null, struct: skip, rawText: "", promptText: "",
      ctx, units, activities, repos, runDate, discIssues, extrIssues, warnings, today, windowStartUtc,
    };
  }

  const net = await waitForNetwork(deps.netProbe ?? defaultNetProbe(probeHosts), deps.sleep ?? realSleep, deps.netGraceMs, deps.netPollMs);
  if (!net.online && !force) {
    // scheduled + offline: don't call the provider. struct is unused by the shell (it returns 0 on offlineSkipped).
    const skip = mkStruct("(skipped: offline)");
    return {
      emptyWindow: false, blocked: false, offlineSkipped: true, skipReason: "offline", net, struct: skip, rawText: "", promptText: "",
      ctx, units, activities, repos, runDate, discIssues, extrIssues, warnings, today, windowStartUtc,
    };
  }

  // Capturing wrapper: record the EXACT prompt built by buildPrompt and the raw model output, so the
  // eval harness can score both without re-running the pipeline. On a retry the last attempt wins —
  // matching the struct withRetry returns. (deps.provider is the injected/BYO provider.)
  // ── T4.3: the transcript scan runs CONCURRENTLY with generation.
  //
  // Started here (after the net gate and after the emptyWindow/blocked returns), awaited after the
  // provider call. Overlapping it is the whole reason the reader yields: a synchronous multi-megabyte
  // parse would stall the very call it overlaps with.
  //
  // ⚠ The rejection is neutralised AT CREATION with `.catch`, not at the await. If the provider
  // throws — which it does, and runCore rethrows — the await is never reached, and an unhandled
  // rejection from an in-flight scan would crash the process on a path that is otherwise a clean
  // exit-1. Invariant 8: the transcript feature must never take the briefing down.
  const scanFn = deps.scan ?? scanTranscripts;
  const scanPromise: Promise<import("./transcripts/scan").ScanOutcome | null> =
    tx.enabled && claudeShaped(cfg.provider.cli)
      ? scanFn({
          root: tx.root,
          // §3.1: [gitWindowStart - margin, now]. The margin covers "started last evening, committed
          // this morning"; the plan chose 24 h.
          window: {
            startUtc: new Date(Date.parse(windowStartUtc) - TRANSCRIPT_READ_MARGIN_MS).toISOString(),
            endUtc: clockNow().toISOString(),
          },
          repos, cfg, activities, units, rootsByRepo,
          onAmbiguity: deps.onAmbiguity,
        }).catch(() => null)
      : Promise.resolve(null);

  let promptText = "", rawText = "";
  const capturing: Provider = {
    generate: async (prompt) => { promptText = prompt; const t = await provider.generate(prompt); rawText = t; return t; },
  };

  // withRetry / generateBriefing may throw ProviderError; it propagates out of runCore so the shell
  // (run()) can log it and return 1. reduce() ran OUTSIDE this so a reduce bug isn't masked as one.
  // Carry the pre-provider diagnostics OUT on the error so the shell's catch can still surface them —
  // pre-refactor run() printed the pipeline warnings AND the net-gate line BEFORE the provider call,
  // so a failure (especially a network-caused one) must not silently drop them. Attached to any Error
  // (a generic generate/parse crash gets them too); printing stays the shell's job.
  let struct: BriefingStruct;
  // ONE attempt, shared by withRetry and the C1/B6 ladder. The ladder's rungs must be single attempts:
  // re-running the whole retry schedule per rung would cost 9 provider calls and ~10 minutes rather than
  // the intended worst case of 5 calls.
  const attempt = () => generateBriefing(ctx, capturing, {
    date: runDate, machineScope: hostname(), provider: cfg.provider.cli, warnings, today, windowMerges: windowMergeLines, stateAsOf, morningFloor, todaySuppress,
  }, units, rootsByRepo);
  try {
    // The ladder wraps the withRetry CALL (C1/B6): it only acts once the schedule is exhausted, which is
    // what moves the "a network failure looks like a usage error" window from t~0.09s — peak
    // wake-before-wifi hazard — out to t~135s. A plain `Provider` (an injected test double) has no
    // ladder members, so it runs unwrapped.
    struct = hardened
      ? await withHardeningLadder(hardened, () => withRetry(attempt, delays, deps.sleep), attempt, cfg.provider.timeoutMs)
      : await withRetry(attempt, delays, deps.sleep);
  } catch (e) {
    if (e instanceof Error) {
      // Fold in the provider's DYNAMIC warnings (C1/B8). This is the most valuable case for them:
      // "hardening was disabled, and then the call failed anyway" — without this the shell logs a bare
      // ProviderError and the operator never learns hardening was off.
      (e as ProviderError).warnings = appendUnique([...discIssues.map(warnFor), ...warnings], runtimeWarningsOf(provider));
      (e as ProviderError).net = net;
    }
    // A usage wall is a KNOWN, timed outage, not a failure: mark the account that hit it and exit by the
    // same quiet path as the offline/darkwake skips. This tick produces no briefing — the cost of
    // resolving the account before the call — and the next provider-calling tick selects the fallback.
    //
    // ⚠ Recording is gated on `hardened` being defined, i.e. on THIS run having built the provider and
    // resolved the account. An injected `deps.provider` means the caller supplied the transport: the
    // eval harness runs the real pipeline through runCore that way (src/eval/run-case.ts), so recording
    // here would let a developer's eval write a mark — and a reportable outage — into the user's live
    // state. Tests inject the same way.
    if (e instanceof ProviderError && e.code === "usage-limit" && hardened) {
      const now = clockNow();
      const reset = parseResetInstant(e.message, now);
      await recordLimit(account.label, reset.until, now, { isProbe: reset.isProbe });
      // Re-resolve against the state AS WRITTEN rather than reasoning about what the mark implies:
      // this is the only honest answer to "is anything left?", and the shell prints one of two
      // opposite sentences from it. Costs one extra state read, on the limited path only.
      const remaining = resolveAccount(acc.accounts, await loadAccountState(), now);
      const skip = mkStruct("(skipped: limited)");
      return {
        emptyWindow: false, blocked: false, offlineSkipped: true, skipReason: "limited",
        limited: { label: account.label, until: reset.until.toISOString(), isProbe: reset.isProbe, exhausted: !remaining },
        net, struct: skip, rawText: "", promptText: "",
        ctx, units, activities, repos, runDate, discIssues, extrIssues, warnings, today, windowStartUtc,
      };
    }
    // §4a — a NON-limit failure on a FALLBACK account. The likeliest cause is a config dir that was
    // never logged into, and without this the ladder re-runs against that broken login every 600s for
    // the whole outage: ~135s of backoff plus a failure line per tick, strictly worse than the defect
    // this feature exists to fix. A one-hour probe mark backs off without benching it for the week.
    // Never applies to the first entry — see recordAuthProbe.
    if (e instanceof ProviderError && hardened) await recordAuthProbe(account.label, acc.accounts, clockNow());
    throw e;
  }
  // The SUCCESS struct comes from generateBriefing, not from mkStruct — so it needs the outage attached
  // here or the line renders on every path EXCEPT the one that actually delivers a briefing. Caught by
  // the end-to-end recovery test; the unit tests for the formula and the render slot both passed while
  // the two never met.
  if (outage) struct.outage = outage;

  // Success clears ONLY this account's mark — clearing broadly would erase a walled account's mark the
  // moment the fallback succeeds, so the next tick would retry the wall and stickiness would be gone.
  if (hardened) await clearMark(account.label);

  // Volatile-state re-check just before returning (see workingTreeDriftWarnings) — merged into the
  // struct's own warnings (surfaced in the rendered briefing), not the pipeline `warnings` the shell prints.
  const drifts = await computeWorkingTreeDrift(
    activities.filter((a) => a.kind === "uncommitted"), repos, deps.statusNow);
  const drift = driftWarnings(drifts);
  // C1/B8: merge the provider's dynamic warnings here, EXPLICITLY. They are only known during
  // generate(), i.e. after the pipeline `warnings` list above was assembled — and pushing onto that
  // shared array would not work, because `generator.ts` passes it by reference but then REASSIGNS
  // `struct.warnings` whenever a cited SHA fails verification, detaching the alias. That reassignment
  // is conditional, so aliasing survives on some mornings and not others; relying on it would make a
  // warning appear or vanish depending on whether a SHA happened to fail that day.
  const late = [...drift, ...runtimeWarningsOf(provider)];
  if (late.length) struct.warnings = appendUnique(struct.warnings ?? [], late);

  // ── T4.3: await the scan started before generation. ── T4.4: route EVERY degradation.
  const scanned = await scanPromise;
  let transcripts = scanned?.evidence;
  if (scanned) {
    // ⚠ Each trigger's SINK is non-negotiable (§3.8). Routing a degradation to telemetry alone is
    // precisely the silent decay this tier forbids — so every code below emits a `struct.warnings`
    // line as well as being counted. Rev 2 wrote only the parse-failure warning.
    const LOUD: Record<string, string> = {
      "cap-tripped": "transcript scan exceeded its time budget — all transcript evidence was discarded for this run (the briefing is git-only).",
      "self-test-mismatch": "transcript pipeline self-test FAILED — transcript evidence is off for this run (the briefing is git-only). This is a systematic failure, not a quiet day.",
      "parse-failure-rate": "transcript scan could not parse enough of the corpus to be trusted — all transcript evidence was discarded for this run (the briefing is git-only).",
      "subsystem-throw": "transcript scan failed — the briefing is git-only for this run.",
    };
    for (const code of scanned.degraded) if (LOUD[code]) struct.warnings = appendUnique(struct.warnings ?? [], [LOUD[code]!]);
    if (scanned.degraded.length) transcripts = undefined;   // git-only: never a partial evidence set
  }

  // ── T7.3: the `whys` PROJECTION. Runs here, in runCore, after generateBriefing and BEFORE
  // CoreResult is assembled — NOT in main.ts beside renderBriefing. The eval harness calls runCore
  // directly and builds CheckInput from the returned result, so a main.ts projection would leave
  // every G5 check running against a struct with no `whys`.
  //
  // `sources` is keyed by `unitKey` (injective); struct bullets carry a LABEL. The projection maps
  // one to the other through `units`, keyed by `norm(label)` because struct bullets hold RAW MODEL
  // TEXT — an exact lookup would silently miss `[**app**]`, `[App]`, `[app.]`.
  if (transcripts) {
    // ⚠ THE COLLISION TEST RANGES OVER ALL UNITS, not only those that produced a why.
    //
    // Scoping it to why-producing units is the obvious implementation and it leaves the defect wide
    // open: if unit A has a why and unit B shares `norm(label)` but has none, there is no collision
    // to detect — and the render join walks EVERY bullet's label, so A's quotation lands above B's
    // bullets. That is cross-repo mis-attribution, the class Q2 exists to forbid, and nothing
    // downstream catches it. `repoLabel` is NOT injective and the codebase has already been burned
    // by assuming otherwise (config.ts: "a collision deleted one repo's diagnosis entirely").
    const byNorm = new Map<string, number>();
    for (const u of units) byNorm.set(norm(u.label), (byNorm.get(norm(u.label)) ?? 0) + 1);
    // ⚠ Pre-mortem risk 5's writer. Counts the COLLIDING UNITS themselves, which is deliberately
    // wider than `drops["label-collision"]` (only collisions that cost a why). Without it, how often
    // the norm(label) keying decision bites at all stays unknown until 1.5b — i.e. until after the
    // gate that depends on knowing.
    transcripts.counters.labelCollisions += units.filter((u) => (byNorm.get(norm(u.label)) ?? 0) > 1).length;

    const whys: Record<string, string> = {};
    for (const u of units) {
      const key = norm(u.label);
      if ((byNorm.get(key) ?? 0) > 1) {
        // Fail-closed, identical in posture to §3.2's drop-on-ambiguity. Counted so 1.5b can measure
        // what the norm(label) keying decision costs — the dark launch's whole deliverable.
        // ⚠ Counts against the ADOPTED curve, not against conservative alone — otherwise a why that
        // only strict-majority resolved would be dropped by the collision guard and never counted,
        // under-reporting exactly what the norm(label) keying costs.
        if (whySourceFor(transcripts, unitKey(u.repo, u.root))) {
          transcripts.counters.drops["label-collision"]++;
        }
        continue;
      }
      const src = whySourceFor(transcripts, unitKey(u.repo, u.root));
      if (src) whys[key] = src.text;          // the BARE turn; the frame is render's job
    }
    if (Object.keys(whys).length) struct.whys = whys;
  }

  // ── T8.4a: G5 WIRING into the delivery path.
  //
  // ⚠ A `fail` becomes a DropReason plus a `struct.warnings` line and NEVER throws. G5 is a
  // correctness check on the why, not a release gate on the briefing — an exception here would let
  // the eval layer take down the morning briefing, which invariant 8 forbids outright.
  //
  // ⚠ Only G5 runs here, deliberately. Running the existing `CHECKS` array would put G1–G4 — which
  // are EVAL gates for gold cases — on every production run.
  if (transcripts && struct.whys && Object.keys(struct.whys).length > 0) {
    try {
      const { g5Whys } = await import("./eval/checks");
      const findings = g5Whys({
        caseName: "live", struct, rawText, promptText, ctx, units,
        emptyWindow: false, gitShaSet: new Set(), fileInventory: new Set(),
        shaToUnit: new Map(), commitMessages: new Map(), denylist: [],
        transcripts,
        // Only G5 runs here, so this is unread — but it is the REAL list rather than `[]`, because a
        // stub would become a lie the moment another check is added to this call.
        doneToday: todaySuppress,
      });
      const failed = findings.filter((f) => f.severity === "fail");
      if (failed.length) {
        // Drop every why rather than ship one G5 says is wrong. Fail-closed, matching the posture of
        // §3.2's ambiguity drop and §3.3's credential rule.
        // ⚠ COUNT THE WHYS WITHHELD, NOT THE FINDINGS. `failed.length` is the number of fail
        // FINDINGS, which is neither the number of whys deleted nor one-per-unit: `g5Whys` can fire
        // several rules for ONE label (verbatim + scope + why-attribution), and `surface` findings
        // are per-BULLET, not per-why. So one bad why among three recorded 3 drops, while one
        // finding that deleted three whys recorded 1. One drop per why withheld is the only reading
        // under which `drops` still answers its own question — "why did this unit not yield?" — once
        // for each unit that did not.
        // ⚠ It does NOT restore the join identity `unitsEligible == adopted + Σdrops` in telemetry,
        // and an earlier draft of this comment claimed it did. That identity is asserted against
        // `joinEvidence`'s OWN return value (transcripts-join.test.ts); `counters.drops` is a
        // separate accumulated record (scan.ts) that also carries per-line and per-path codes, and
        // `whysConservative`/`whysStrictMajority` are written from the join's map sizes and are
        // never decremented when this deletes the whys. No value here could hold that identity —
        // this is the honest per-unit count, not an invariant repair.
        // Captured BEFORE the delete, because after it there is nothing left to count.
        const whysWithheld = Object.keys(struct.whys ?? {}).length;
        delete struct.whys;
        // ⚠ The BUCKET is reused rather than invented: `DropReason` is a closed enumerated set
        // (scan.ts), and adding a member is an eval-integrity decision for the operator, not a
        // detail of this fix. `no-qualifying-turn` is the nearest honest existing code — the why was
        // produced but did not survive validation. Flagged in the review rather than changed here.
        transcripts.counters.drops["no-qualifying-turn"] += whysWithheld;
        struct.warnings = appendUnique(struct.warnings ?? [], [
          `transcript quotations failed a correctness check (${[...new Set(failed.map((f) => f.rule))].join(", ")}) and were withheld from this briefing. The briefing itself is unaffected.`,
        ]);
      }
    } catch { /* the eval layer must never break the briefing */ }
  }

  // Day-20 audit: the drift FOOTER is not enough on its own — propagate the drift into the
  // SUGGESTIONS it invalidates, or the briefing keeps recommending work it has already detected as
  // done.
  //
  // ⚠ POSITION IS LOAD-BEARING: AFTER the G5 block above, BEFORE render. Placed before G5 (where it
  // first landed) it SILENTLY DEFEATS the `surface` check: that check's first clause is
  // `whyValues.has(s.text)` — byte equality against the BARE anchored turn (`eval/checks.ts`) — so
  // appending STALE_NOTE makes a why that leaked into SUGGESTIONS stop matching. MEASURED: the same
  // struct yields 1 `surface` finding unannotated and 0 annotated. Clause 2 (`parseWhy`) does not
  // backstop it — a bare why carries no frame, so `parseWhy` returns null. Net effect was that a
  // leaked quotation naming a drift-resolved file shipped unchecked. T7.6-style ordering assertion
  // below pins this.
  struct.suggestions = annotateStaleSuggestions(struct.suggestions, drifts);

  // Day-21: branch state, CODE-RENDERED into "Where you left off". Computed from the raw activities
  // (not the reduced copies) so a budget trim can never drop it. Left ABSENT rather than set to an
  // empty array when no repo has anything worth saying — render treats both identically, and the
  // struct stays free of empty keys.
  const bs = branchStateLines(activities, repos);
  if (bs.length) struct.branchState = bs;

  // ── OUTPUT-SIDE CHECKS (postcheck). MOVED HERE from `generateBriefing` on 2026-08-11 — see the
  // tombstone there for the defect. This is the first point at which `struct` is genuinely final:
  // `annotateStaleSuggestions` (just above) and `struct.branchState` (immediately above) are both
  // writers that ran AFTER the generator returned, and both feed these checks.
  //
  // ⚠ PLACE ANY NEW `struct` WRITER ABOVE THIS BLOCK. Below it, the writer is ungraded and nothing
  // fails — which is exactly how the branch-state gap survived undetected until a live morning.
  //
  // ⚠ RESTATEMENT IS SCORED AGAINST THE RESUME SECTION AS DELIVERED — `branchState` FIRST, then the
  // model's bullets, which is render.ts's own order. Render puts branch-state lines inside
  // "Where you left off", so a reader cannot tell them from model prose, and a suggestion that
  // restates one is the same defect whichever half it echoes. Scoring only `struct.resume` is what
  // returned 0 findings on 2026-08-11 against a 1.000-containment restatement of the
  // `[personal_code]` branch line.
  //
  // ⚠ FRESHNESS IS DELIBERATELY *NOT* WIDENED THE SAME WAY, and the asymmetry is the point rather
  // than an oversight. `checkResumeFreshness` asks whether a bullet ANCHORED on a stale commit, and
  // it detects that by matching backtick-quoted commit subjects. Branch-state lines are
  // CODE-rendered (`On branch X (ahead N, behind M)`, git.ts) — they quote no subject, cannot
  // anchor, and can therefore only add pairs that are structurally incapable of firing. Passing
  // them would look symmetrical and buy nothing.
  //
  // DIAGNOSTIC ONLY (unchanged by the move): writes to stderr → briefing.log, never to
  // `struct.warnings`, so the DELIVERED briefing is byte-identical either way. Promoting either rule
  // to a counted defect remains an eval-integrity decision for the operator.
  //
  // ⚠ ONE SIDE EFFECT OF THE MOVE, and it is an improvement worth naming: `generateBriefing` is the
  // retried unit (`withRetry`), so the old site re-ran these checks on every provider attempt and a
  // retried morning logged each finding twice. Here they run exactly once, on the struct that ships.
  //
  // ⚠ WRAPPED, and not as defensive boilerplate — it is this file's own rule for anything
  // observational on the delivery path (the eval layer above is guarded the same way). A DIAGNOSTIC
  // that can abort the 07:20 briefing is strictly worse than one that misses a finding.
  try {
    const post = [
      ...checkResumeFreshness(struct.resume, todaySuppress),
      ...checkSuggestionRestatement(struct.suggestions, [...(struct.branchState ?? []), ...struct.resume]),
    ];
    // `postcheck-info` for telemetry rows: the EVAL convention counts `grep -c "postcheck \["`, and
    // "postcheck-info [" does not match it — near-misses must never move a flag count (thresholds.ts).
    for (const p of post) console.error(`${p.info ? "postcheck-info" : "postcheck"} [${p.rule}]: ${p.detail}`);
  } catch (e) {
    console.error(`postcheck skipped (non-fatal): ${e}`); // never let a diagnostic cost a morning
  }

  // ── T4.9: the health-JSON WRITE call site.
  //
  // ⚠ IT MUST RUN AFTER THE `whys` PROJECTION, because §4 makes that projection a SECOND writer to
  // `counters.drops` (`label-collision`). A write placed naturally where the scan completes would
  // silently lose every collision count — the one counter the dark launch exists to produce. The
  // projection is T7.3 (M7); this call site is deliberately positioned after where it will land, and
  // T7.6 is the paired assertion that the ordering holds.
  //
  // ⚠ RULE 1: only a run that ACTUALLY EXECUTED THE SCAN writes a day record. Most runs return before
  // the insertion point (empty window, blocked, offline); a non-scanning run stamping a record whose
  // derived sets are all zero would zero the day under last-run-wins and fire the zero-yield trigger
  // every single day.
  // ⚠ RULE 1 keys on "did the scan actually RUN", NOT on "is there usable evidence". A cap-tripped or
  // throwing run DID scan, and its counters — `capTripped`, `filesScanned`, the parse-failure rate —
  // are precisely what diagnose the degradation. Keying on `transcripts` instead made every
  // degradation invisible in telemetry (found at C4). Runs that returned before the scan (empty
  // window, blocked, offline, feature off) still write nothing, which is what RULE 1 protects.
  if (scanned) {
    // ⚠ §3.8's TRIGGERS are evaluated HERE, against the MERGED history — not against this run alone.
    // The zero-yield trigger fires after N=3 consecutive QUALIFYING days (days where sessions were
    // found) that produced no why, which is the signal that the allowlist or the discriminator has
    // silently decayed. It cannot be evaluated from one run's counters, which is why it lives at the
    // persist step where the history is in hand.
    //
    // ⚠ Each trigger's SINK is non-negotiable: routing these to telemetry alone is precisely the
    // silent degradation §3.8 forbids, so every fired code also emits a struct.warnings line.
    const { fired, health } = await evaluateHealthTriggers(runDate, scanned.evidence.counters, deps);
    // ⚠ The zero-yield notice is BUILT FROM THE HEALTH RECORD, not a fixed string. The fixed string
    // asserted "allowlist or discriminator decay" and both hypotheses were refuted by the very
    // telemetry the trigger reads (day 21). See `zeroYieldNotice`.
    const { zeroYieldEvidence, zeroYieldNotice } = await import("./transcripts/health");
    const TRIGGER_NOTICE: Record<string, string> = {
      "zero-yield": zeroYieldNotice(zeroYieldEvidence(health)),
      "parse-failure-rate": "transcript parse-failure rate is above threshold — treat this run's transcript telemetry as unreliable.",
      "cap-tripped": "transcript scan hit its time cap — evidence was discarded for this run.",
    };
    for (const code of fired) {
      if (TRIGGER_NOTICE[code]) struct.warnings = appendUnique(struct.warnings ?? [], [TRIGGER_NOTICE[code]!]);
    }
  }

  return {
    emptyWindow: false, blocked: false, offlineSkipped: false, net, struct, rawText, promptText,
    ctx, units, activities, repos, runDate, discIssues, extrIssues, warnings, today, windowStartUtc,
    transcripts,
    // Provenance, only when there was a real choice to make — see CoreResult.account.
    // `?.length` not a truthy test: `resolveAccounts([])` returns an ACCEPTED empty array (no warning),
    // and `effectiveAccounts([])` synthesises "default" — so a truthy test logs `account "default"`
    // every morning for a user who emptied the list to turn the feature off.
    // Gated on `hardened` for the same reason recordLimit/clearMark/recordAuthProbe are: an injected
    // `deps.provider` means the resolved label never reached a spawn, so attributing the output to it
    // would be a claim about a process that never ran. The eval harness calls runCore exactly that way.
    ...(hardened && acc.accounts?.length ? { account: account.label } : {}),
    // Purely ADDITIVE, for the eval harness's G7 (`recency`). Exposing the list rather than letting
    // the harness rebuild it from `today` is deliberate: `todaySuppress` carries the resolved unit
    // LABEL (unitForCommit + repoLabelFor) and the merge-derived entries, and a second derivation of
    // that would be free to drift from this one — the defect fixed in #177. Existing destructurers
    // are unaffected.
    todaySuppress,
  };
}

// ⚠ A module-level `persistHealth` USED TO SIT HERE and was deleted on 2026-08-11. It had NO
// caller — `evaluateHealthTriggers` below inlines the same read-merge-write — so it was a second
// copy of the telemetry write path that nothing exercised, and the two had already drifted (only
// the live one guards its `Bun.write` with `.catch`). Kept as a tombstone rather than silently
// removed because "persist" and "evaluate" read like separate steps a caller might want: they are
// deliberately ONE, since the triggers are defined over the merged history, not over a single run.
// Do not reintroduce a standalone writer; extend `evaluateHealthTriggers` instead.

/** Merge this run into the day record, then evaluate §3.8's triggers over the RESULT. Returns the
 *  fired codes so the caller can emit each one's warning. Persisting and evaluating are one step
 *  because the triggers are defined over the merged history, not over a single run. */
async function evaluateHealthTriggers(
  date: string, counters: import("./transcripts/scan").TranscriptRunCounters, deps: RunDeps,
): Promise<{ fired: string[]; health: import("./transcripts/health").TranscriptHealth }> {
  const { mergeRun, emptyHealth, serialiseHealth, evaluateTriggers } = await import("./transcripts/health");
  if (deps.persistHealth) {
    // Injected writer (tests): still evaluate, against this run merged onto `deps.priorHealth` when
    // one is supplied and an empty history otherwise — `priorHealth` exists precisely so a test can
    // seed history (see RunDeps). Said "an empty history" unconditionally until 2026-08-11.
    await deps.persistHealth(date, counters).catch(() => {});
    const merged = mergeRun(deps.priorHealth ?? emptyHealth(), date, counters);
    return { fired: evaluateTriggers(merged, merged.days.find((d) => d.date === date)), health: merged };
  }
  const path = join(supportDir(), "transcript-health.json");
  let prior = emptyHealth();
  try {
    const f = Bun.file(path);
    if (await f.exists()) prior = { ...emptyHealth(), ...(await f.json()) };
  } catch { /* a corrupt record is replaced, not fatal */ }
  const merged = mergeRun(prior, date, counters);
  await Bun.write(path, serialiseHealth(merged)).catch(() => {});
  return { fired: evaluateTriggers(merged, merged.days.find((d) => d.date === date)), health: merged };
}
