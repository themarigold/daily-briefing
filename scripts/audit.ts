// scripts/audit.ts — daily adversarial self-audit of the briefing.
//   run: bun run scripts/audit.ts [briefing-file] [--no-judge]
//
// Two layers: (1) DETERMINISTIC code checks — every cited SHA resolves to a real commit; how many of
// the briefing's-own-day (author-filtered) commits it missed; repos with uncommitted state it never
// named — and (2) an adversarial LLM judge (your claude CLI) fed the briefing + the author-filtered
// in-window activity (via the real pipeline), plus — only when `--popup=<dir>` is passed (author-only;
// off by default) — that tool's popup for comparison. Ground truth reuses gitActivity.
import { loadConfig, resolveRepos, compileExcludePatterns, DEFAULT_EXCLUDE_COMMIT_PATTERNS, repoLabel, resolveAccounts } from "../src/config";
import { resolveForScript } from "../src/account";
import { gitActivity } from "../src/extractor";
import { resolveAuthor, authorArgs, LOCAL_WORK_REFS, IncompleteReadError } from "../src/git";
import { withRetry } from "../src/provider";
import { hardenedProvider } from "../src/harden";
import { postureLine, mergeWarnings } from "../src/eval/posture";
import { claudeShaped } from "../src/harden";
import { localDateStr, supportDir, latestBriefingPath, logPath } from "../src/marker";
import { stripControl, stripControlLines } from "../src/render";
import { redactCredentials } from "../src/transcripts/credentials";
import { resolveUnits } from "../src/subprojects";
import type { Config } from "../src/types";
import { featuresLine, extractCitedShas, missingSameDay, coverageGaps, unresolvedFromBatch, unreachableFromRevList, factsFromActivities, lastBriefing, buildAuditPrompt, sameDayCommits, branchLinesFromBriefing, branchAtGeneration, branchAxisLine, generationInstant, regenFailureMessage, groundingVerdict, degradedReadLine, unreadableReposLine, groundTruthUnavailableLine, classifyReadFailure, gitUnavailableLine, bucketPathIssues, accessDeniedLine, bucketFailures, degradationLines, evalRow, collectDegradation, auditFilesToPrune, auditMayCarryRawTurn, HARDENING_OFF_NOTICE, quotationsIn, groundTruthForQuotations, type ReadFailure } from "../src/audit";
import { parseWhy } from "../src/transcripts/frame";
import { discoverDepth1 } from "../src/transcripts/discover";
import { readJsonl, emptyTally } from "../src/transcripts/reader";
import { transformLines } from "../src/transcripts/transform";
import { resolveTranscripts } from "../src/config";
import { homedir } from "node:os";
import { run } from "../src/proc";
import { join, basename } from "node:path";

const ROOT = join(import.meta.dir, "..");

// ⚠ INFORMATIONAL entries are PREFIXED and excluded from `flagCount`. EVAL.md days 18 and 20 both
// record the same instrument nit — `flagCount = deterministic.length`, so a non-defect line makes a
// clean audit read as ">=1 flag(s)". The unreachable/skipped lines below would have made that
// routine rather than occasional: they fire on exactly the day this feature is meant to help.
// The lines still print; they just stop being counted as defects.
const INFO = "(FYI) ";
const defectCount = (lines: string[]) => lines.filter((l) => !l.startsWith(INFO)).length;


// F5 (slice 1.5 T0.3) — everything argv- or env-derived is resolved when `main` RUNS, not when this
// module is imported, and the bare invocation at the bottom is gated on `import.meta.main`. Before
// this, importing the file executed the entire audit against the real repos, so nothing here could be
// tested at all (the deleted comment on `run`, since moved to src/proc.ts, said exactly that). The
// env reads matter as much as argv: `supportDir()`/`latestBriefingPath()`/`logPath()` all consult
// DAILY_BRIEFING_STATE_DIR, so resolving them at import time meant a caller could never point the
// audit at a throwaway state dir. Behaviour is unchanged for the CLI — same argv, same env, same
// values — only the MOMENT of resolution moved.
export type AuditOptions = {
  noJudge: boolean;
  popupDir: string | undefined;
  popupConfigured: boolean;
  briefingArg: string | undefined;
  today: string;
  supportApp: string;
  bin: string;
  latest: string;
  log: string;
};

export function parseAuditOptions(argv: string[]): AuditOptions {
  const supportApp = supportDir();                // honors DAILY_BRIEFING_STATE_DIR + cross-platform (was a hardcoded macOS path)
  // Popup comparison is OPT-IN via `--popup=<dir>`: the daily_briefing popup is the AUTHOR's personal
  // tool, so public users have none. Unset → the VS POPUP section is omitted entirely (no phantom
  // "limitation" noise). (Was a hardcoded personal ~/Library/Application Support/daily_briefing path.)
  const popupDir = argv.find((a) => a.startsWith("--popup="))?.slice("--popup=".length) || undefined;
  return {
    noJudge: argv.includes("--no-judge"),
    popupDir,
    popupConfigured: popupDir !== undefined,
    briefingArg: argv.find((a) => !a.startsWith("--")),
    today: localDateStr(new Date()),
    supportApp,
    bin: join(supportApp, "daily-briefing"),
    latest: latestBriefingPath(),                 // clean overwritten copy (preferred)
    log: logPath(),                               // raw launchd stdout (appends; fallback)
  };
}

// The comment that stood here described the old local `run` as handling pipes "in parallel (no pipe
// deadlock)" — which was exactly wrong: it awaited both `.text()`s BEFORE `p.exited` and never raced
// a flush, which is the hang this change fixes. Deleted rather than reworded, so no stale claim
// outlives the code it described.
//
// `run` moved to src/proc.ts (F2) — it awaited `.text()` BEFORE `p.exited` with no flush race, so a
// grandchild holding the inherited pipe hung the audit forever, against the REAL repos. It could not
// be tested here: this file ends in a bare `main().catch(...)`, so importing it runs the whole audit.
//
// The git wrapper inherits proc.ts's DEFAULT_FLUSH_MS and needs no policy of its own: `run` already
// forces `code: -1` on an incomplete stdout, and both git call sites gate on `code` — `dayShasAndText`
// records the repo as degraded and skips it, `checkShas` likewise. Cited by SYMBOL, not line number:
// the first revision of this comment said ":~116" and ":~133", which were already stale by the length
// of the comment blocks inserted above them, and one of them pointed at a function signature.
// Fail-closed is right here because "" is a LEGITIMATE git result (clean tree, no in-window commits),
// so accepting a partial read as success would fabricate a quiet day. But failing closed is only half
// the job — see groundingVerdict/degradedReadLine for why the REPORT must also stop being confident.
const git = (args: string[], opts?: { input?: string }) => run(["git", ...args], opts);

// The generator is spawned ONCE per audit and writes a whole briefing; proc.ts's 500 ms default is
// tuned for the several-per-repo git calls. Here a spurious "incomplete" costs the morning's audit,
// while waiting costs an attended script a few seconds — so the window is deliberately generous.
// It only ever elapses AFTER the child has exited, so this is not added to a healthy run's latency.
const REGEN_FLUSH_MS = 10_000;
// proc.ts's 30s default is tuned for git; regenerating a briefing legitimately takes minutes (the
// notice printed just below says so, and the run retries transient provider failures). This must be
// generous enough never to kill a healthy generation, while still being a CEILING — without one, a
// wedged generator hangs the audit exactly as the original bug did.
const REGEN_TIMEOUT_MS = 20 * 60_000;

// Imported from src/git (authorArgs/LOCAL_WORK_REFS): the audit's ground truth must use
// the SAME author-filter and ref-selection semantics as the app, or it silently stops
// mirroring what the briefing can actually see.
function shiftLocalDate(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return localDateStr(new Date(y!, m! - 1, d! + delta));
}

// Today's briefing: an explicit file arg (reproducible / retrospective), else today's briefing.log,
// else regenerate — checking exit + header so a good log is never clobbered with empty/error output.
const headerDate = (t: string) => t.match(/—\s*(\d{4}-\d{2}-\d{2})/)?.[1];

async function getBriefing(o: AuditOptions): Promise<{ text: string; source: string }> {
  const { briefingArg, today, bin: BIN, latest: LATEST, log: LOG } = o;
  if (briefingArg) {
    const f = Bun.file(briefingArg);
    if (!(await f.exists())) throw new Error(`briefing file not found: ${briefingArg}`);
    return { text: lastBriefing(await f.text()), source: briefingArg };
  }
  // Prefer the clean overwritten briefing-latest.md; fall back to the raw launchd log (which appends,
  // so take its LAST block). Check each candidate's OWN header date == today (not a loose includes).
  for (const [path, label] of [[LATEST, "briefing-latest.md"], [LOG, "briefing.log (latest of the log)"]] as const) {
    const f = Bun.file(path);
    if (!(await f.exists())) continue;
    const last = lastBriefing(await f.text());
    if (headerDate(last) === today) return { text: last, source: `${label} (today's)` };
  }
  console.error(`No current briefing for ${today}; generating with --force… (the run retries transient provider failures — on a flaky network this can take several minutes)`);
  const cmd = (await Bun.file(BIN).exists()) ? [BIN, "run", "--force"] : ["bun", "run", "src/main.ts", "run", "--force"];
  // A much longer flush window than the git calls (F2): this is one attended invocation per audit that
  // spawns a full briefing generation, so waiting is cheap, whereas a spurious "incomplete" costs the
  // morning's audit. The git calls, by contrast, run several times per repo.
  const outcome = await run(cmd, { cwd: ROOT, flushMs: REGEN_FLUSH_MS, timeoutMs: REGEN_TIMEOUT_MS });
  const { out, err, code } = outcome;
  const gen = lastBriefing(out);
  // `complete` is deliberately NOT used to salvage a partial briefing here, which is the opposite of
  // what provider.ts decides for the SAME shape of event. That asymmetry is intentional: provider.ts
  // hands its partial output to a HUMAN, for whom a briefing missing only its EOF beats no briefing.
  // This output is fed to a GRADER, and a truncated briefing scored as whole yields a confidently
  // wrong EVAL.md row — the likely cut point is the tail, which drops SUGGESTIONS and produces a
  // plausible-looking "Actionable: NO". A loud, recoverable failure beats a silent bad measurement in
  // the instrument every other row is judged against. (`code` is already -1 when `!complete`, so this
  // gate fails closed on its own; `complete` only sharpens the diagnosis below.)
  if (code === 0 && headerDate(gen) === today) return { text: gen, source: "regenerated (no current log)" };
  // `err` was previously discarded, so this reported a bare `exit=1` while the actual reason — the
  // provider's diagnostic AND any hardening warnings, both of which main.ts prints to stderr — sat in a
  // dropped variable. Bounded, because a failed run's stderr can be long.
  // stripControl'd here, not only at the report: this text rides a thrown Error to `main().catch`, which
  // console.errors it WITHOUT the report-side sanitization — and it carries provider diagnostics that
  // embed model output, i.e. commit-subject-influenceable text, straight to the operator's terminal.
  const why = err.trim() ? stripControl(err.trim().split("\n").slice(-4).join(" | ").slice(0, 400)) : "";
  throw new Error(regenFailureMessage(outcome, why));
}

// The briefing's OWN-day commits (author-filtered), committer-date verified in JS (mirrors the app's
// filter; avoids raw --since approxidate driving the count). Anchored to the briefing's date, so a
// retrospective audit of an older briefing measures the right day.
async function dayShasAndText(
  cfg: Config, repos: string[], bDate: string, generatedBeforeMs?: number,
): Promise<{ shas: string[]; text: string; postGen: string[]; transient: string[]; repo: string[]; toolchain: string[]; toolchainDetail: string[] }> {
  // Wide `--since` (2 days before the day) purely to bound output — the exact day is decided by the JS
  // committer-date match, mirroring the app's listCommits. The margin keeps bDate's commits far
  // from the traversal cutoff, so `--since` early-stop can't drop one (the risk documented on
  // committerDaysWithCommits in git.ts — cited by symbol, since line numbers there have moved).
  const since = `${shiftLocalDate(bDate, -2)}T00:00:00`;
  // Mirror the app's bot-commit filter, else `vault backup:` SHAs get flagged as "same-day blindness"
  // false positives every run (review #2).
  const { regexes: excludeRe } = compileExcludePatterns(cfg.excludeCommitPatterns ?? DEFAULT_EXCLUDE_COMMIT_PATTERNS);
  const shas: string[] = [];
  const blocks: string[] = [];
  const postGen: string[] = [];
  // Returned rather than only pushed into `blocks`, because `blocks` feeds ONLY the judge prompt — so
  // under --no-judge a silently truncated ground truth produced a report that looked cleaner than a
  // healthy one. Classification is `classifyReadFailure`'s job, from the WHOLE outcome: an earlier
  // version keyed on `code === -1` alone and mis-sorted both a timeout (which exits 1 after SIGKILL)
  // and a missing git binary.
  // Only RECORD {repo, kind} here; `bucketFailures` does the routing. Inlining the ternary put an
  // untested branch on the path that decides operator advice — a measured mutation swapping two arms
  // left the whole suite green, silently restoring "delete your healthy repo" advice for a timeout.
  const failures: { repo: string; kind: ReadFailure }[] = [];
  const toolchainDetail: string[] = [];
  for (const r of repos) {
    // Catch ONLY the non-trustworthy-read case, and fail closed on it. The blanket
    // `.catch(() => cfg.author ?? {})` here swallowed an IncompleteReadError, and with `cfg.author`
    // unset — the common case, identity resolved from the repo — `authorArgs({})` yields NO --author
    // filter at all. Coworkers' commits then entered `dayShas`, producing false SAME-DAY BLINDNESS and
    // a wrong "missed N same-day" in the EVAL row, with nothing marked degraded. The extractor's own
    // phase-1 catch names this exact hazard; the audit's git path had never replicated it.
    let author: { names?: string[]; emails?: string[] };
    try {
      author = await resolveAuthor(r, cfg.author);
    } catch (e) {
      if (!(e instanceof IncompleteReadError)) { author = cfg.author ?? {}; }
      else {
        blocks.push(`### ${r} — (couldn't resolve the author filter for ${bDate})`);
        failures.push({ repo: r, kind: "transient" });
        continue;
      }
    }
    // %P adds parent hashes → sameDayCommits drops merges (the app does too) and, given the generation
    // instant, splits out commits that landed AFTER the briefing ran.
    const res = await git(["-C", r, "log", ...LOCAL_WORK_REFS, `--since=${since}`, "--pretty=%h%x1f%cI%x1f%P%x1f%s", ...authorArgs(author)]);
    const { out, code } = res;
    if (code !== 0) {
      blocks.push(`### ${r} — (couldn't read commits for ${bDate})`);
      const kind = classifyReadFailure(res);
      failures.push({ repo: r, kind });
      if (kind === "toolchain") toolchainDetail.push(res.err);
      continue;
    }
    const { shas: rShas, lines, postGeneration, prMerges, otherMerges } = sameDayCommits(out, bDate, excludeRe, generatedBeforeMs);
    shas.push(...rShas);
    postGen.push(...postGeneration.map((l) => `${repoLabel(r, repos)}: ${l}`));
    const shown = lines.slice(0, 12);
    blocks.push(`### ${r} — ${lines.length} of YOUR commit(s) on ${bDate} (the briefing's own day, EXCLUDED from its window):\n${shown.join("\n") || "(none)"}${lines.length > 12 ? `\n…+${lines.length - 12} more` : ""}`);
    // Defect A (EVAL.md freeze block, fixed 2026-08-14): the app renders same-day PR landings from its
    // own `mergedToday` channel as `🔀 Merged #N (branch) (sha)`. They are NOT recap commits and are
    // deliberately absent from the list above — but until now they were absent from the ENTIRE ground
    // truth, so the judge read a real merge as fabricated on three consecutive days. Printed even when
    // empty: "(none)" tells the judge the channel was checked, whereas a missing heading is the exact
    // silence that produced the false HIGHs.
    //
    // The two lists are SEPARATE because the app treats them differently, and collapsing them would
    // trade one false finding for its mirror image — see PR_MERGE_SUBJECT in src/audit.ts.
    blocks.push(`### ${r} — ${prMerges.length} PR merge(s) on ${bDate}, surfaced by the app's SEPARATE "🔀 Merged #N" channel (NOT recap commits — their absence from the commit list above is BY DESIGN, and a briefing citing one of these is GROUNDED, not fabricating):\n${prMerges.slice(0, 12).join("\n") || "(none)"}${prMerges.length > 12 ? `\n…+${prMerges.length - 12} more` : ""}`);
    blocks.push(`### ${r} — ${otherMerges.length} other merge commit(s) on ${bDate} (plain branch/pull merges). The app surfaces these NOWHERE — neither as recap commits nor via the "🔀 Merged #N" channel — so the briefing is CORRECT to omit them, and a briefing citing one is NOT grounded:\n${otherMerges.slice(0, 12).join("\n") || "(none)"}${otherMerges.length > 12 ? `\n…+${otherMerges.length - 12} more` : ""}`);
  }
  return { shas, text: blocks.join("\n"), postGen, ...bucketFailures(failures), toolchainDetail };
}

// Defect B (EVAL.md freeze block, fixed 2026-08-14): the branch/working-tree facts are read NOW, hours
// after the briefing ran, and nothing told the judge that. This recovers the GENERATION-TIME fact from
// the delivered briefing itself — see the long note on `branchAtGeneration` in src/audit.ts for why the
// obvious `git reflog` approach was built, reviewed, and thrown away.
//
// Synchronous and git-free by design. The reflog version shelled out per repo and mapped a read failure
// to `""`, which fell through to `unguarded` with no `failures.push` and no degradation line — a broken
// toolchain could still report "deterministic layer clean". There is now nothing to fail.
function branchAxisText(briefing: string, repos: string[]): string {
  if (!repos.length) return "";
  // A blank briefing means absence proves nothing; a real one that simply has no branch lines means the
  // predicate was false for every repo, which is a genuine finding rather than a gap.
  const parsed = briefing.trim() ? branchLinesFromBriefing(briefing) : null;
  const lines = repos.map((r) => {
    const label = repoLabel(r, repos);
    return branchAxisLine(label, r, branchAtGeneration(parsed, label));
  });
  return `GENERATION-TIME state on the branch axis, recovered from the briefing itself (the commit axis is
already guarded — see the same-day blocks). ⚠ This says what the app BELIEVED about each branch when it
ran; it is NOT independent confirmation that the belief was right, because it is derived from the
artifact under review. ⚠ The WORKING-TREE axis has no equivalent record at all: uncommitted files leave
no trace of their state at generation, so treat any working-tree difference as unverifiable rather than
as an omission.\n${lines.join("\n")}`;
}

// Which cited SHAs resolve in NO repo. cat-file --batch-check (one spawn/repo; ambiguous≠fabricated).
// `verified` is false when no repo could be read. That guard was necessary but NOT sufficient: with
// one readable repo it proceeded on partial `outputs`, and every SHA living only in the skipped repo
// came back "unresolved" and was printed as FABRICATED with a ❌ EVAL row. Reproduced against real
// repos — nine genuine commits accused of being hallucinated. `degraded` is what lets the caller
// refuse to reach a verdict; see groundingVerdict.
async function checkShas(cited: string[], repos: string[]): Promise<{ unresolved: string[]; unreachable: string[]; revListBlind: string[]; verified: boolean; transient: string[]; repo: string[]; toolchain: string[]; toolchainDetail: string[] }> {
  if (!cited.length) return { unresolved: [], unreachable: [], revListBlind: [], verified: true, transient: [], repo: [], toolchain: [], toolchainDetail: [] };
  const outputs: string[][] = [];
  // Reachability, gathered alongside existence — one extra spawn per repo, mirroring cat-file's
  // "one spawn/repo" design.
  //
  // ⚠ A PARTIAL rev-list failure suppresses the whole check, and that is not caution — it is the
  // difference between a warning and a FALSE ACCUSATION. Repos have disjoint histories, so if repo
  // A's rev-list fails while repo B's succeeds, `reachable` is non-empty and every SHA cited from A
  // fails the prefix test: the audit then reports real, on-a-branch commits as "reachable from NO
  // branch or tag". MEASURED: unreachableFromRevList(["aaaaaaa"], [], [[<repo-B hash>]]) returns
  // ["aaaaaaa"]. An earlier comment here claimed the failure path was non-fatal because a failed
  // repo "contributes no refs" — true only when EVERY repo fails, which is the one case the
  // all-or-nothing guard inside the function already covered. `rev-list` runs on proc.ts's 30s
  // default, so a slow repo or a transient index.lock is enough to trigger this.
  const reachable: string[][] = [];
  const revListBlind: string[] = [];   // repo paths whose rev-list failed — REPORTED, not just obeyed
  const failures: { repo: string; kind: ReadFailure }[] = [];
  const toolchainDetail: string[] = [];
  for (const r of repos) {
    const res = await git(["-C", r, "cat-file", "--batch-check"], { input: cited.join("\n") + "\n" });
    if (res.code === 0) {
      outputs.push(res.out.split("\n"));
      const rl = await git(["-C", r, "rev-list", "--all"]);
      if (rl.code === 0) reachable.push(rl.out.split("\n"));
      else revListBlind.push(r);  // see the note above: a PARTIAL failure must suppress, not accuse
      continue;
    }
    const kind = classifyReadFailure(res);
    // Repo NAMES in every bucket — the error TEXT rides `toolchainDetail`. Pushing `res.err` into a
    // bucket made groundingVerdict render "could not read Error: ENOENT…" where repo names belong.
    failures.push({ repo: r, kind });
    if (kind === "toolchain") toolchainDetail.push(res.err);
  }
  const b = bucketFailures(failures);
  if (!outputs.length) return { unresolved: [], unreachable: [], revListBlind, verified: false, ...b, toolchainDetail };
  const unresolved = unresolvedFromBatch(cited, outputs);
  return {
    unresolved,
    // Blind ⇒ report NOTHING. Silence is the honest answer: we cannot distinguish "orphaned" from
    // "living on a branch in the repo we could not read".
    unreachable: revListBlind.length ? [] : unreachableFromRevList(cited, unresolved, reachable),
    revListBlind,
    verified: true, ...b, toolchainDetail,
  };
}

async function readPopup(o: AuditOptions): Promise<string | null> {
  const { popupDir, today } = o;
  if (!popupDir) return null; // not configured → no popup comparison
  for (const name of ["briefing-full.md", "briefing-cache.md"]) {
    const f = Bun.file(join(popupDir, name));
    if (!(await f.exists())) continue;
    const text = await f.text();
    const m = text.match(/briefing_date:\s*(\d{4}-\d{2}-\d{2})/);
    if (m && m[1] !== today) return `[NOTE: this popup is dated ${m[1]}, NOT today (${today}) — treat as STALE]\n${text}`;
    return text;
  }
  return null;
}

// ---- run ----
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const o = parseAuditOptions(argv);
  const { noJudge, popupConfigured, briefingArg, today, supportApp: SUPPORT_APP } = o;
  const cfg = await loadConfig().catch((e) => { throw new Error(`config error: ${e}. Run \`daily-briefing init\`.`); });
  const repos = await resolveRepos(cfg);
  const { text: briefing, source } = await getBriefing(o);
  const bDate = briefing.match(/—\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? today;
  const retro = bDate !== today;

  // Ground truth (guarded so a git failure still yields a partial deterministic report).
  let gitFactsText = "(git ground truth unavailable — a git call failed)";
  let reposWithState: { repo: string; labels: string[] }[] = [];
  let dayShas: string[] = [];
  let dayText = "";
  let postGen: string[] = [];
  // Truncated (transient) vs definitively-unreadable (config) reads, from every consumer — including
  // the EXTRACTOR, whose own `issues` were previously discarded. That mattered: the extractor is the
  // one consumer feeding `reposWithState`, so a repo it failed to read silently dropped out of the
  // UNCOMMITTED-NOT-SURFACED check while `degradedReadLine` promised exactly that coverage.
  // Raw sources only; `collectDegradation` does every merge, dedupe and classification. Assembling
  // them inline here is what left the report's INPUTS unpinned while its output was well covered.
  let extractorIssues: { path: string; kind: string }[] = [];
  let extractorWarnings: string[] = [];
  let dayBuckets = { transient: [] as string[], repo: [] as string[], toolchainDetail: [] as string[] };
  let groundTruthErr: unknown = null;
  // Exclude commits made AFTER the briefing was generated from the same-day-miss count: parse the
  // briefing's own "state as of HH:MM" stamp → generation instant. Null (no stamp) → count all (old behavior).
  const generatedBeforeMs = generationInstant(briefing, bDate) ?? undefined;
  try {
    const { activities, today: todayActs, issues, warnings } = await gitActivity(cfg, repos);
    extractorIssues = issues; extractorWarnings = warnings;
    const { units } = await resolveUnits(activities, todayActs, repos, cfg);
    const f = factsFromActivities(activities, units, repos, 15);
    // `reposWithState` is assigned BEFORE the branch-axis append: a throw between the two would leave it
    // `[]` and silently empty the UNCOMMITTED-NOT-SURFACED check that `degradedReadLine` promises.
    reposWithState = f.reposWithState;
    gitFactsText = [f.text, branchAxisText(briefing, repos)].filter(Boolean).join("\n");
    const d = await dayShasAndText(cfg, repos, bDate, generatedBeforeMs);
    dayShas = d.shas; dayText = d.text; postGen = d.postGen;
    dayBuckets = { transient: d.transient, repo: d.repo, toolchainDetail: d.toolchainDetail };
  } catch (e) {
    // Recorded, not just logged. `console.error` does not reach the saved audit-<date>.md, so a
    // scheduled run showed a confident "clean" report with no hint that every derived check below is
    // vacuously empty rather than genuinely clean.
    groundTruthErr = e;
    console.error(`ground-truth gathering degraded: ${e}`);
  }

  // ── T8.1a's CALL SITE. The module existed with nothing calling it — the "module built, call site
  // untasked" pattern the plan flagged three times. Ground truth for any QUOTATION the delivered
  // briefing carries is recovered by CONTENT SEARCH: parse the quotation with the frame's own parser,
  // then find the corpus turn whose bytes equal it. Sound because invariant 5 guarantees that
  // equality; unmatched quotations are OMITTED, never substituted.
  let whyGroundTruth: { quotation: string; sessionId: string; tsUtc: string }[] = [];
  const quotations = quotationsIn(briefing, parseWhy);
  if (quotations.length > 0) {
    const tx = resolveTranscripts(cfg.transcripts, homedir());
    if (tx.enabled) {
      whyGroundTruth = await groundTruthForQuotations(quotations, async (needle) => {
        const tally = emptyTally();
        const start = Date.parse(bDate + "T00:00:00Z") - 7 * 864e5;   // a week of slack around the briefing's day
        for (const f of await discoverDepth1(tx.root, start)) {
          const lines: Record<string, unknown>[] = [];
          for await (const o of readJsonl(f, tally)) lines.push(o);
          for (const t of transformLines(lines, f, "depth1").turns) {
            if (t.text === needle) return { found: true, sessionId: t.sessionId, tsUtc: t.tsUtc };
          }
        }
        return { found: false };
      }).catch(() => []);
    }
  }

  const cited = extractCitedShas(briefing);
  const sha = await checkShas(cited, repos).catch(() => ({ unresolved: [] as string[], unreachable: [] as string[], revListBlind: [] as string[], verified: false, transient: [] as string[], repo: [] as string[], toolchain: [] as string[], toolchainDetail: [] as string[] }));
  const { unresolved, verified } = sha;
  const deg = collectDegradation({ extractorIssues, extractorWarnings, day: dayBuckets, sha });
  // Labels are for DISPLAY only, applied inside the renderers. Filtering happens on full paths, because
  // `repoLabel` is not injective (one parent segment), and filtering on a non-injective key is what
  // deleted a repo's diagnosis twice.
  const label = (p: string) => repoLabel(p, repos);
  // ONLY the SHA-resolution reads gate the grounding verdict — a `git log` timeout on some large repo
  // must not downgrade a PROVABLE fabrication to UNKNOWN while asserting the SHAs "may live in the
  // unread repo", which would be false when `cat-file` read every repo.
  // But BOTH KINDS of cat-file failure gate it. Fault injection caught the tempting error here: a repo
  // git definitively cannot read still cannot clear a citation, because the briefing was generated
  // EARLIER, when that repo was readable. Truncated vs unreadable changes the remedy, never whether a
  // fabrication verdict is sound.
  // ONLY the cat-file reads — `checkShas` runs its own per-repo invocation, so its OWN failures are
  // exactly the set that could hide a citation. Including extractor-derived blindness (as an earlier
  // revision did with `accessRepos`) re-creates the union bug in a new costume: a phase-1 truncation
  // that never touched cat-file would downgrade a PROVABLE fabrication to UNKNOWN while asserting the
  // SHAs "may live in the unread repo", which cat-file had in fact read.
  const shaBlind = deg.shaBlind;
  const ground = groundingVerdict({ citedCount: cited.length, unresolved, verified, degradedRepos: shaBlind.map(label) });
  const missedDay = missingSameDay(dayShas, briefing);
  const uncovered = coverageGaps(reposWithState, briefing);
  const popup = await readPopup(o).catch(() => null); // guarded: never abort the deterministic report

  const deterministic: string[] = [];
  // Report what the search found — and, just as importantly, what it could NOT find. A quotation
  // whose source turn is gone (pruned, rotated) is stated as unverifiable rather than passed off as
  // grounded.
  if (quotations.length > 0) {
    const missing = quotations.length - whyGroundTruth.length;
    deterministic.push(`${INFO}transcript quotations in this briefing: ${quotations.length}; source turn located for ${whyGroundTruth.length}${missing > 0 ? `, NOT located for ${missing} (transcript pruned or rotated — treat those as unverifiable, not as fabricated)` : ""}.`);
  }
  // ⚠ SILENCE IS NOT A RESULT. Every other read failure in this file routes to a sink
  // (degradationLines / shaBlind / groundTruthUnavailableLine), because "we did not check" must
  // never render identically to "we checked and found nothing". Suppressing the accusation was
  // right; suppressing it INVISIBLY was the remaining half of the defect.
  if (sha.revListBlind.length) {
    deterministic.push(
      `${INFO}reachability check SKIPPED: \`git rev-list\` failed in ${sha.revListBlind.map((r) => repoLabel(r, repos)).join(", ")} — ` +
      `cited SHAs were NOT checked for orphaning this run (a partial check would accuse commits living in the unread repo).`);
  }
  // "Resolvable but unreachable" — its own state, never folded into fabrication (day-16 finding,
  // closed 2026-08-04). These SHAs exist as objects but sit on no ref, so `cat-file` certifies a
  // citation the reader cannot find. Reported as a DURABILITY warning, and deliberately NOT gating
  // `shaGround`: the commits are real, the briefing did not hallucinate them, and failing grounding
  // on them would be the false-fabrication verdict PR #140 removed.
  if (sha.unreachable.length) {
    deterministic.push(
      `${INFO}${sha.unreachable.length} cited SHA(s) resolve but are reachable from NO branch or tag — ` +
      `real commits on a deleted/abandoned branch, so a reader following them finds nothing: ` +
      `${sha.unreachable.join(", ")}. NOT fabrication; the briefing's evidence has become undurable.`);
  }
  // Mirror the app's warning: a bad excludeCommitPatterns regex is silently dropped from the filter,
  // so bot commits could leak into "same-day blindness". Surface it here too (the app warns to stderr).
  const { invalid: invalidExcludes } = compileExcludePatterns(cfg.excludeCommitPatterns ?? DEFAULT_EXCLUDE_COMMIT_PATTERNS);
  if (invalidExcludes.length) deterministic.push(`INVALID excludeCommitPatterns ignored (not valid regex): ${invalidExcludes.join(", ")} — bot-commit filtering may be incomplete, so same-day checks can over-report.`);
  // Early in the list (the invalid-regex line above can precede it — an earlier version of this
  // comment said "FIRST", which was conditionally false), and always PRESENT, which is what actually
  // matters: any entry here suppresses the "clean:" fallback that otherwise called a degraded run clean.
  // ONE producer, pure and behaviourally tested — see degradationLines. Cross-bucket filtering and
  // ordering live there, because three rounds of defects in this assembly were invisible to the suite
  // while it was inline in this unimportable file.
  deterministic.push(...degradationLines({ groundTruthErr, groundingLine: ground.line, label, ...deg }));
  if (missedDay.length) deterministic.push(`SAME-DAY BLINDNESS: ${missedDay.length}/${dayShas.length} of your ${bDate} commits are absent from the briefing: ${missedDay.slice(0, 15).join(", ")}${missedDay.length > 15 ? " …" : ""}`);
  if (postGen.length) deterministic.push(`${INFO}not a miss — ${postGen.length} commit(s) landed AFTER the briefing was generated — excluded from the same-day count: ${postGen.slice(0, 10).join(", ")}${postGen.length > 10 ? " …" : ""}`);
  if (uncovered.length) deterministic.push(`UNCOMMITTED NOT SURFACED: repos with working state the briefing never names: ${uncovered.map((u) => u.repo).join(", ")}`);

  const shaGround = ground.ground;
  const evalGround = ground.emoji;

  let judged = noJudge ? "(skipped: --no-judge)" : "(judge unavailable)";
  // T8.2: the `hardening-off` DropReason. ⚠ It is INCREMENTED here and MERGED into the health record
  // below — the audit runs in its own process with no TranscriptEvidence, so without that merge this
  // would be a local that nothing ever reads. Found by checking, having just written it: exactly the
  // "counter with no reader" class the DropReason coverage table exists to prevent.
  let hardeningOffDrops = 0;
  // C2: the judge runs on its OWN hardenedProvider, which never passes through runCore — so unlike the
  // briefing's own provider, nothing else would ever surface a probe anomaly or a mid-run hardening latch
  // from it. Collected here so the report can state the posture it judged under.
  const judgeProviders: unknown[] = [];
  // Which account judged. The instrument may change between audits (the judge inherits failover); it
  // may not change INVISIBLY, so this rides into the report alongside the posture line.
  let judgeAccountLabel: string | undefined;
  if (!noJudge) {
    console.error("Running adversarial judge via claude (one LLM call)…");
    const retroNote = retro
      ? `NOTE: this briefing is dated ${bDate}, NOT today. The in-window ground truth below is the CURRENT window (the pipeline can't reproduce ${bDate}'s), so do NOT fault the briefing for mismatching current uncommitted/branch state; judge same-day (${bDate}) commits normally.\n\n`
      : "";
    try {
      // Judge gets timeout headroom (high-commit days produced real 120s timeouts) + a short
      // retry — this call bypasses main.ts's run() loop, so it needs its own coverage.
      // ⚠ T8.2 — evaluated BEFORE the prompt is built. `buildAuditPrompt` sits inside the withRetry
      // closure and is rebuilt identically per attempt, so there is no later hook that could remove
      // the raw turn once it is in the string.
      const mayCarryRaw = auditMayCarryRawTurn(cfg.provider, claudeShaped);
      if (!mayCarryRaw) {
        // BOTH sinks: the warning AND the counter. Telemetry alone is the silent degradation §3.8
        // forbids, and the counter alone left `hardening-off` with no writer.
        deterministic.push(HARDENING_OFF_NOTICE);
        hardeningOffDrops++;
      }
      // ⚠ The judge gets its OWN argv when configured — the instrument is not the thing measured.
      // Appended after `provider.argv` so a repeated flag (e.g. --model) resolves to the judge's.
      const judgeCfg = cfg.auditJudgeArgv?.length
        ? { ...cfg.provider, argv: [...cfg.provider.argv, ...cfg.auditJudgeArgv] }
        : cfg.provider;
      // The judge inherits failover. Exempting it would be worse than the alternative: the audit
      // becomes unrunnable during exactly the outages most worth auditing. The trade-off that buys is
      // that the INSTRUMENT can change between audits — so the account is recorded in the report below.
      const judgeAcct = await resolveForScript(resolveAccounts(cfg.provider.accounts, homedir()).accounts, new Date());
      judgeAccountLabel = judgeAcct.account?.label;
      const judgeProvider = hardenedProvider(judgeCfg, { timeoutMs: 240_000, ...(judgeAcct.env ? { env: judgeAcct.env } : {}) });
      judgeProviders.push(judgeProvider);
      judged = await withRetry(() => judgeProvider.generate(
        buildAuditPrompt({ whyGroundTruth, briefing, gitFacts: `${retroNote}${gitFactsText}\n\nCOMMITS ON ${bDate} (same-day, excluded from the briefing window):\n${dayText}`, popup, popupConfigured, deterministic }),
      ), [5_000, 15_000]);
    } catch (e) {
      // Merge `e` as well as the provider, matching eval.ts. Harmless today — the judge bypasses core, so
      // nothing attaches `.warnings` to its errors — but the two scripts should not disagree about where
      // a warning can hide, and this is the cheaper side of that argument.
      judgeProviders.push(e);
      judged = `(judge failed: ${e})`;
    }
  }

  // Folded into the report AND the EVAL.md Notes column: a row recorded under unknown hardening cannot
  // honestly be compared with a later one.
  // `n/a` when no judge ran: with --no-judge the collector is empty, and reporting `posture: full` for a
  // call that never happened is the exact provenance failure this feature exists to remove — it would
  // put an unearned "full" into the EVAL.md row.
  // Scoped as `judge posture:` deliberately. In an EVAL.md row written by `scripts/eval.ts` the bare
  // `posture:` token describes the CASE RUNS; here it would describe only the judge call, and the audited
  // briefing's own generation posture is not captured on this path at all. One key with two meanings in a
  // hand-maintained table is worse than a longer key — a reader a month from now cannot tell them apart.
  const auditPosture = noJudge
    ? "judge posture: n/a (--no-judge)"
    // ACCOUNT PROVENANCE, for the same reason the model-provenance note below exists: the judge now
    // inherits account failover, so which account judged can differ between audits. Recorded here so a
    // changed instrument is visible in the artifact rather than only in a log nobody re-reads.
    : `${postureLine(mergeWarnings(...judgeProviders)).replace(/^posture: /, "judge posture: ")}${judgeAccountLabel ? ` · account: ${judgeAccountLabel}` : ""}`;
  // ⚠ MODEL PROVENANCE. 23 EVAL rows exist and NONE records which model produced them — the CLI's
  // default was whatever it happened to be that day and could have moved silently. That makes the
  // B4 before/after comparison (day 18 ⚠️ → day 19 ✅) unsound in principle: if the model changed in
  // the same window, the prompt cannot be credited. An eval whose independent variable is unrecorded
  // is not measuring what it claims, so both models now ride in the row.
  // ⚠ lastIndexOf, NOT indexOf. `auditJudgeArgv` is APPENDED to `provider.argv`, so the judge's
  // combined argv can hold two `--model` flags and the CLI takes the LAST (VERIFIED empirically:
  // `claude -p --model sonnet --model opus` answers "opus"). Reading the first one reported
  // `judge=sonnet` on 2026-08-09 while the judge was demonstrably running Opus — i.e. the field added
  // to fix unrecorded provenance reported the WRONG provenance on its first live run.
  const modelOf = (argv: string[]): string => {
    const i = argv.lastIndexOf("--model");
    return i !== -1 && argv[i + 1] ? argv[i + 1]! : "cli-default";
  };
  const modelNote = `models: brief=${modelOf(cfg.provider.argv)}, judge=${modelOf([...cfg.provider.argv, ...(cfg.auditJudgeArgv ?? [])])}`;

  const raw = [
    `# Briefing self-audit — ${bDate}${retro ? ` (audited ${today})` : ""}`,
    `source: ${source}`,
    ...(retro
      ? ["", `> ⚠ Retrospective audit: this briefing is dated ${bDate}, not today (${today}). Same-day commit checks are anchored to ${bDate} (correct); but working-tree/branch facts and the in-window recap ground truth reflect NOW — treat resumption/recap-grounding mismatches with that caveat.`]
      : briefingArg
        ? ["", `> ⚠ Auditing a saved briefing file — working-tree/branch facts reflect now, not generation time.`]
        : []),
    "",
    "## Deterministic checks (code — reliable)",
    // The features echo (day-33 decision, user-directed): the watch-opener's page states what the
    // deployed config actually enables, so a watch can no longer be opened on a dark feature silently.
    `- ${featuresLine(cfg, resolveTranscripts(cfg.transcripts, homedir()))}`,
    `- provider hardening during this audit's judge call: ${auditPosture.replace(/^judge posture: /, "")}`,
    // The "clean:" line is suppressed by DEFECTS, not by informational notes — otherwise a day whose
    // only entry is an FYI loses its clean verdict while flagCount correctly reads 0, and the report
    // contradicts its own EVAL row.
    ...deterministic.map((d) => `- ${d}`),
    ...(defectCount(deterministic) === 0 ? ["- clean: all cited SHAs resolve, no same-day miss, all working-state repos named"] : []),
    `- SHA-grounding (deterministic — cited SHAs only; the judge additionally weighs cited FILES): ${shaGround}`,
    `- popup available for comparison: ${!popupConfigured ? "not configured (--popup=<dir> to enable)" : popup ? (popup.startsWith("[NOTE") ? "STALE (see note)" : "yes") : "NO"}`,
    "",
    "## Adversarial judge (claude — holistic; its Ground verdict also considers files)",
    judged,
    "",
    "## Suggested EVAL.md row (fill Act + (a)/(b) yourself; Ground here is SHA-only — reconcile with the judge if it flags a file)",
    evalRow({
      bDate, emoji: evalGround, flagCount: defectCount(deterministic), groundTruthFailed: groundTruthErr !== null,
      ...deg, label, fabricated: unresolved, shaBlind: shaBlind.length > 0,
      missedDay: missedDay.length, posture: `${modelNote}; ${auditPosture}`,
      // `judged` is set to a "(judge failed: …)" string when the call threw; absent judging entirely
      // (--no-judge) is a deliberate choice and keeps the posture line, which already says "n/a".
      judgeRan: o.noJudge ? undefined : !judged.startsWith("(judge failed:"),
    }),
  ].join("\n");
  // Sanitize the report (git-derived text) before print + file-write — per REAL line, so the multi-line
  // LLM-judge verdict keeps its structure (a per-array-element strip would flatten it). Render parity.
  // ⚠ T8.1 SINK 5, and it needs its own call site: a fix that scans `rendered` in main.ts and forgets
  // this one passes a sink-agnostic check while the audit report — which carries the RAW anchored turn
  // as ground truth (§3.4 sink 1) plus provider diagnostics — reaches disk unscanned.
  // Unconditional since 2026-08-25 — see the T8.1 note in src/main.ts. The audit report quotes the
  // briefing and the provider's diagnostics, both git-derived, so the transcript flag never governed
  // whether a credential could reach this page.
  const report = redactCredentials(stripControlLines(raw));

  console.log(report);
  const outFile = join(SUPPORT_APP, `audit-${bDate}.md`);
  try { await Bun.write(outFile, report); console.error(`\nSaved: ${outFile}`); } catch (e) { console.error(`could not save report: ${e}`); }
  // Retention (T4.7): without it the support dir accretes one report per day forever. Failures are
  // swallowed — housekeeping must never fail the audit that just succeeded.
  try {
    const { readdir, unlink } = await import("node:fs/promises");
    for (const name of auditFilesToPrune(await readdir(SUPPORT_APP))) {
      await unlink(join(SUPPORT_APP, name)).catch(() => {});
    }
  } catch { /* housekeeping only */ }

  // ⚠ T8.2's telemetry half. §3.8 governs EVERY self-disable: routing this to the report alone is
  // the silent degradation that tier forbids, so the code is merged into the day record too.
  // Failures are swallowed — telemetry must never fail the audit that just succeeded.
  if (hardeningOffDrops > 0) {
    try {
      const { mergeRun, emptyHealth, emptyCounters, serialiseHealth } = await import("../src/transcripts/health");
      const path = join(SUPPORT_APP, "transcript-health.json");
      let prior = emptyHealth();
      const f = Bun.file(path);
      if (await f.exists()) prior = { ...emptyHealth(), ...(await f.json()) };
      const run = emptyCounters();
      run.drops["hardening-off"] = hardeningOffDrops;
      await Bun.write(path, serialiseHealth(mergeRun(prior, bDate, run)));
    } catch { /* telemetry must never fail the audit */ }
  }
}

// Gated (F5): importing this module must not run the audit — that is the whole point of the
// extraction. `bun run scripts/audit.ts` still takes this path unchanged.
if (import.meta.main) main().catch((e) => { console.error(`audit failed: ${e}`); process.exit(1); });
