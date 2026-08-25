// src/main.ts
import { loadConfig, discoverRepos, initConfig, configPath } from "./config";
import { assertInitSafeArgv } from "./harden";
import { probeRepos, type RepoProbe, type ProbeOpts } from "./extractor";
import { renderBriefing, stripControl } from "./render";
import { redactCredentials } from "./transcripts/credentials";
import { checkRanToday, stampToday, stampTick, localDateStr, latestBriefingPath, archivedBriefingPath, markerExists, markerPath, rotateLogIfLarge } from "./marker";
import { warnFor, isInaccessible, type PathIssue, type GuardOpts } from "./protectedPath";
import { ProviderError, type Provider } from "./types";
import { parseFloor, isPastFloor } from "./schedule";
import { clearLastLimit } from "./account";
import { runCore, type CoreResult } from "./core";
import { section } from "./generator";
import pkg from "../package.json"; // single source of truth for --version (bundled by `bun build --compile`)

export type RunDeps = {
  provider?: Provider;   // default: hardenedProvider(cfg.provider, …) — which wraps a BYOCliProvider
  guard?: GuardOpts;     // §5.11 classification injection (tests)
  probe?: RepoProbe;     // repo-readability probe (tests)
  retryDelaysMs?: number[];              // transient-provider retry schedule (tests inject short ones)
  sleep?: (ms: number) => Promise<void>; // injectable for tests
  statusNow?: (repo: string) => Promise<string>; // render-time working-tree re-check (tests inject drift)
  netProbe?: () => Promise<boolean>;     // network-reachability probe (tests)
  powerProbe?: (args: string[]) => Promise<{ code: number; out: string }>; // darkwake probe (tests)
  powerPlatform?: NodeJS.Platform;       // darkwake platform (tests) — see core.ts RunDeps for why this must be injectable
  netGraceMs?: number;                   // network-gate bounds (tests inject short ones)
  netPollMs?: number;
  now?: () => Date;                      // injectable clock for the floor gate (tests pin it; production uses real time)
  interactive?: boolean;                 // TTY at the entry point → floor-exempt (dispatch passes isTTY; tests default false for determinism)
};

// The pipeline (discover → … → generate → drift) and its helpers — blockedDelivery,
// workingTreeDriftWarnings, PROVIDER_RETRY_DELAYS_MS — live in ./core, ONE implementation shared with
// the eval harness. Re-exported so existing importers (tests) keep their `../src/main` path.
export { blockedDelivery, workingTreeDriftWarnings } from "./core";

// init-time preflight (§5.11): probe every repo we'd actually read, AND — when repos are given
// explicitly (so discovery is skipped) — still walk discoverRoots to surface a blocked root the
// user may have meant to include (e.g. a TCC-gated ~/Desktop). Reports access problems while a
// human is present to fix them, rather than silent empty briefings on the first unattended run.
export async function preflightRepos(
  cfg: Parameters<typeof discoverRepos>[0],
  opts?: ProbeOpts,
): Promise<PathIssue[]> {
  const { repos, issues } = await discoverRepos(cfg, opts);
  issues.push(...await probeRepos(repos, opts));
  if (cfg.repos?.length && cfg.discoverRoots?.length) {
    const rootWalk = await discoverRepos({ ...cfg, repos: undefined }, opts);
    issues.push(...rootWalk.issues);
  }
  // Dedup by path: an explicit repo under a discoverRoot (the normal generated config) would
  // otherwise be reported twice — once by the per-repo probe, once by the root walk.
  return [...new Map(issues.map((i) => [i.path, i])).values()];
}

// The net-gate diagnostic line — shell-owned I/O, emitted on the success path AND on a provider
// failure (via the net runCore attaches to the error), so a network-caused failure still shows why.
function emitNetMessage(net: { online: boolean; waitedMs: number } | null | undefined): void {
  if (!net) return;
  const s = Math.round(net.waitedMs / 1000);
  if (!net.online) console.error(`⚠ no network after ~${s}s — calling the provider anyway (forced run)`);
  else if (net.waitedMs > 0) console.error(`waited ~${s}s for the network to come up`);
}

/** The one line a usage-limited tick leaves in briefing.log. Exported and pure so the WORDING is
 *  testable: it was a template literal ending in a hardcoded "no other account is available" until
 *  2026-08-24, when the live failover test printed exactly that on the tick that marked the primary
 *  while the fallback sat unmarked and delivered two minutes later. Nothing could assert a string
 *  built inline at its only call site, so the falsehood shipped through ten review rounds.
 *
 *  The reset is stated ONLY for a parsed one — a probe deadline is a one-hour guess, and calling it a
 *  reset would claim knowledge the system does not have. `exhausted === false` rather than a truthy
 *  test: an absent payload keeps the conservative wording instead of promising a retry that may not come. */
export function limitedSkipMessage(limited: CoreResult["limited"]): string {
  // A PROBE mark does not prove a usage limit. `recordAuthProbe` writes one for a non-limit failure on
  // a fallback (the likeliest cause being a config dir that was never logged into), and a limit whose
  // reset would not parse writes one too — this branch cannot tell them apart. Saying "at its usage
  // limit" for a broken login would be the same false-cause defect one clause to the left, so a probe
  // gets the weaker, always-true wording instead. A parsed reset is the only case that names the cause.
  // `until` is guarded as well as `isProbe`: the exhausted branch reads it from state and falls back to
  // "", so a corrupt account-state.json could otherwise render "at its usage limit until " with nothing.
  const state = limited?.isProbe === false && limited.until
    ? `is at its usage limit until ${limited.until}`
    : "is unavailable";
  const tail = limited?.exhausted === false
    ? "the next tick will use another account"
    : "no other account is available; will retry next interval";
  // The label is arbitrary config text; every other config-derived line in run() is stripped.
  return `skipped: account "${stripControl(limited?.label ?? "?")}" ${state} — ${tail}`;
}

export async function run(force: boolean, deps: RunDeps = {}): Promise<number> {
  // Bound the launchd stdout log before anything writes to it this tick (it appends every ~10-min
  // run and never rotates). No-op when absent (interactive/non-launchd) or small; never fatal.
  await rotateLogIfLarge().catch(() => {});
  const now = deps.now?.() ?? new Date();  // injectable clock; only the floor gate needs determinism
  // TICK HEARTBEAT — BEFORE every gate below, deliberately. The three gates that follow (once-per-day,
  // no-config, morning floor) all `return 0` SILENTLY and write nothing, so without this a tick that
  // fired is indistinguishable from a tick that never happened — the exact ambiguity that left day
  // 34's 110-minute first-wake gap undiagnosable. Diagnostic only; never fatal (stampTick swallows).
  // ⚠ The two arguments are DIFFERENT UNITS on purpose — a UTC instant and the LOCAL day it belongs
  // to — and the day-35 defect was born here by keying the count off the first. stampTick keys off
  // the second and stores it explicitly; do not "tidy" these into one value. See its docstring.
  await stampTick(now.toISOString(), localDateStr(now));
  const interactive = deps.interactive ?? false; // set by dispatch from isTTY; tests default false
  // CHECKED unconditionally, OBEYED only when not forced. The check repairs an unreadable marker, and
  // a forced run needs that repair too: it skips the guard but still stamps at the end, so it would
  // otherwise hit the same EACCES one line from the finish and report "not marking today done".
  const marker = await checkRanToday();
  // Reported here, never inside marker.ts — run() owns all I/O. Not gated on `interactive`, unlike the
  // line below: a repaired marker is exactly the kind of event that must survive in briefing.log for
  // the launchd runs nobody watches.
  if (marker.repair === "rewritten") {
    console.error("day marker was unreadable; today's briefing is already archived, so the marker was rebuilt — skipping this tick");
  } else if (marker.repair === "cleared") {
    console.error("day marker was unreadable and today has no archived briefing; the marker was cleared and this tick will generate one");
  } else if (marker.repair === "failed") {
    console.error(stripControl(`day marker at ${markerPath()} is unreadable AND could not be replaced — the state directory itself may be broken. Claiming the day rather than regenerating every ~10 minutes; fix its permissions to resume briefings.`));
  }
  if (!force && marker.ranToday) {
    if (interactive) console.error("Already ran today. Use --force to regenerate."); // not silent for a human
    return 0; // once-per-morning guard
  }
  let cfg;
  try { cfg = await loadConfig(); }
  catch (e) {
    const noConfig = e instanceof Error && e.message === "no-config";
    if (noConfig && !force) {
      // Scheduled tick on a config-less machine: a FRESH install (no marker EVER) stays silent — no
      // per-tick spam before `init`. A config that VANISHED after working (a marker exists) is a
      // regression → surface it (repeats every ~10 min until fixed; accepted: visibility > silence).
      if (await markerExists()) console.error(`No config, but a briefing ran before — did the config move/get deleted? Re-create it: \`daily-briefing init\` (${configPath()}).`);
      return 0;
    }
    // A forced run, OR any non-"no-config" load error (malformed JSON, perms) is a real error →
    // surface it and exit 2 (today's behavior), regardless of force. NOT silenced.
    if (noConfig) console.error(`No config. Run \`daily-briefing init\` (writes ${configPath()}).`);
    else console.error(`Config error: ${e}`);
    return 2;
  }

  // Morning floor: gates only the SCHEDULED (non-interactive) agent — below it a scheduled tick no-ops
  // silently (no per-tick log spam; git state is identical whenever we generate). An interactive run (a
  // human at the terminal) or --force is floor-exempt: they explicitly asked for the briefing now.
  const floor = parseFloor(cfg.morningTime);
  if (!force && !interactive && !isPastFloor(now, floor.minutes)) return 0;

  // The whole pipeline (discover → extract → resolve → today/mergedToday → reduce → net-gate →
  // generate → drift) lives in runCore() — ONE implementation, shared with the eval harness. run() is
  // the thin shell: it owns the gates above and the render/stamp/exit + all stderr I/O below. The
  // floor warning is shell-owned config, so it's threaded in via preWarnings.
  let r;
  try {
    r = await runCore(cfg, { ...deps, preWarnings: floor.warning ? [floor.warning] : [] }, force);
  } catch (e) {
    // Surface the pre-provider diagnostics runCore attached (pipeline warnings + net-gate outcome)
    // even though the pipeline failed — old inline run() printed them BEFORE the provider, so a
    // network-caused failure still shows the reason. Order matches old: warnings → net → the error.
    const err = e as ProviderError; // .warnings/.net attached by runCore for any Error
    // stripControl on every terminal line that can carry git/fs-derived text (repo paths, a provider
    // CLI's stderr): the same terminal-escape-injection class the render boundary closes (a repo path
    // or filename can legally contain ANSI/control bytes) reaches the terminal here too.
    for (const w of err.warnings ?? []) console.error(stripControl(`⚠ ${w}`));
    emitNetMessage(err.net);
    if (e instanceof ProviderError) {
      console.error(stripControl(`Briefing provider failed (${e.code}): ${e.message}`));
      return 1;
    }
    throw e; // non-ProviderError: diagnostics surfaced; rethrow to preserve the crash exit
  }

  // Surface every protected-path/read + pipeline issue (§5.11): discovery-side issues have no warning
  // string of their own, so format them here; the rest are already strings in r.warnings.
  for (const w of [...r.discIssues.map(warnFor), ...r.warnings]) console.error(stripControl(`⚠ ${w}`));

  // Empty run + an inaccessible repo we tried to read = delivery FAILURE, not a quiet day (§5.11):
  // don't stamp, exit non-zero so the next run retries once access is fixed.
  if (r.blocked) {
    console.error("Some configured repo(s) could not be read and no other activity was found — today NOT marked done. Fix access (see warnings above) and re-run.");
    return 1;
  }
  // Scheduled tick still offline after the grace: the provider was NOT called — skip without stamping;
  // the ~10-min interval loop retries. (A forced offline run proceeds; see the net message just below.)
  if (r.offlineSkipped) {
    // Distinct line per reason: the remedy differs, and an undistinguished failure block was
    // misdiagnosed twice on 2026-08-08 before `pmset` settled it.
    // THREE ways, not two. A limited tick reusing the offline branch would print "skipped: no network
    // after ~0s" every 600s for the length of the outage — a false diagnosis, which is precisely the
    // class of failure this feature exists to end.
    // The reset time is printed ONLY when it was parsed from the message: a probe deadline is a
    // one-hour guess, and stating it as a reset would claim knowledge the system does not have.
    // ⚠ The second half is `exhausted`, COMPUTED in runCore — not a fixed phrase. It was a hardcoded
    // "no other account is available" until 2026-08-24, when the live failover test printed it on the
    // tick that marked the primary while the fallback sat unmarked and delivered two minutes later.
    // This is the ONLY line a limited tick leaves in briefing.log, so a false one misleads precisely
    // when someone is reading the log to diagnose an outage. `=== false` rather than a truthy test:
    // an absent `limited` keeps the conservative wording instead of promising a retry that may not come.
    console.error(r.skipReason === "darkwake"
      ? "skipped: machine is in a maintenance darkwake (no display power) — the provider cannot complete here; will retry next interval"
      : r.skipReason === "limited"
      ? limitedSkipMessage(r.limited)
      : `skipped: no network after ~${Math.round((r.net?.waitedMs ?? 0) / 1000)}s — will retry next interval`);
    return 0;
  }
  // Net-gate message (null net = empty/blocked, no gate). !online here implies a forced run proceeded.
  emitNetMessage(r.net);

  // Provenance BEFORE the rendered briefing, deliberately. The launchd plist points StandardOutPath and
  // StandardErrorPath at the SAME briefing.log, and audit's lastBriefing() slices from the last "☀️ …
  // briefing —" header to EOF — so a line emitted after the render would be fed to the audit judge as
  // part of the briefing text it grades. Anything before the header is outside that slice.
  // Absent on a single-account machine (see CoreResult.account), so existing logs are unchanged.
  if (r.account) console.error(`briefing generated by account "${stripControl(r.account)}"`);

  // ── T8.1: OUTPUT-SIDE credential scan, sinks 1-3 (stdout, briefing-latest.md, briefing.log).
  //
  // REDACT IN PLACE, never abort: aborting would break the git briefing, which invariant 8 forbids.
  //
  // ⚠ UNCONDITIONAL since 2026-08-25. It was gated on `transcripts.enabled`, on the reasoning that
  // with the feature off "nothing new reaches this string". True of TRANSCRIPT text and irrelevant to
  // the risk: the very next line of that comment said this fires on "a branch name, a commit subject,
  // a provider diagnostic" — all of which are git-derived and all of which survive the feature being
  // off. So the gate removed the scan from exactly the text it was described as protecting, and it did
  // so invisibly: turning transcripts off for unrelated reasons (their attribution rules cannot resolve
  // a multi-session workflow) silently disabled credential redaction. Nothing in the config hinted at
  // the coupling. A security control must not ride on an unrelated feature flag.
  //
  // The false-positive worry the gate existed for is already handled INSIDE the matcher, not here:
  // `provider-key` requires a >=20-char UNHYPHENATED run precisely because branch names like
  // `pk-refactor-the-whole-thing` were measured matching a looser tail at C2.
  //
  // ⚠ It can never fire INSIDE a why, and that is the shared-matcher guarantee, not luck: a turn that
  // passed the ingest scan cannot match output-side because both scans use the SAME pattern module.
  const rendered = redactCredentials(renderBriefing(r.struct));
  console.log(rendered);

  // Soft-parse failure (only when the window had activity): the model output didn't parse into any
  // section — a broken run, not a quiet day. Don't stamp; the next scheduled run retries.
  if (!r.emptyWindow) {
    // Derived from `rawText`, NOT from `r.struct`, and that distinction is the whole gate.
    // `generateBriefing` backfills a resume bullet for every Tier-1 unit the model omitted
    // (`orderResumeByRank`), and it does so BEFORE this check ever runs — so a briefing truncated to
    // nothing still arrives here with a non-empty `resume` and gets stamped, behind bullets we wrote
    // ourselves. On this machine `hasResumptionState` is true most mornings, so the gate was very
    // nearly decorative. Since C1 the provider may deliberately return a truncated result, which makes
    // "parsed into nothing" reachable rather than theoretical.
    // Reuses the exported `section` rather than re-parsing: no new field, no signature change, and
    // `rawText` is "" on three paths and none of them reach this line: `blocked` and `offlineSkipped`
    // return earlier, and `emptyWindow` — which does NOT return early, it renders and stamps a genuine
    // quiet day — is excluded by the enclosing `if (!r.emptyWindow)`.
    //
    // THE COST, stated because it is a real regression in one scenario. A model that PERSISTENTLY
    // ignores the output format used to yield one stamped, backfill-only briefing per day; it now
    // yields none, and a provider call every ~10-minute tick until midnight. That is the intended
    // trade: a backfill-only briefing carries no recap, no suggestions and nothing the model
    // contributed, so delivering it silently and marking the day done teaches the user nothing while
    // hiding a broken integration indefinitely. Note the asymmetry with the provider's own fail-open —
    // a briefing known to be CUT OFF still stamps, because it carries real model content plus a
    // warning saying so.
    const parsedEmpty = ["RESUME", "RECAP", "SUGGESTIONS"].every((h) => section(r.rawText, h).length === 0);
    if (parsedEmpty) {
      console.error("Briefing did not parse into any section; not marking today done.");
      return 1;
    }
  }
  // The outage record is cleared once a briefing has actually been WRITTEN — not merely rendered.
  // `parsedEmpty` returns 1 between renderBriefing and here, and clearing there would destroy the cause
  // record without delivering anything: the cause IS the trigger, so the outage could then never be
  // reported. Unconditional on delivery, NOT gated on "a line was rendered" — on the ordinary failover
  // day missedDays is 0 and no line is due, and gating would leave the record alive to blame a later
  // laptop-closed weekend on the usage limit.
  await clearLastLimit().catch(() => {});
  await Bun.write(latestBriefingPath(), rendered).catch(() => {}); // clean overwritten copy the user/audit read
  // Dated archive alongside it — see archivedBriefingPath for why. Same fail-open `.catch` as the line
  // above (which now also swallows the date-shape throw): an archive that could not be written must
  // never cost the user their briefing, and the marker below is what decides delivery. One file per
  // DAY — a same-day regeneration replaces it, exactly as it replaces briefing-latest.md above.
  await Bun.write(archivedBriefingPath(r.runDate), rendered).catch(() => {});
  try { await stampToday(r.runDate); } // fail-closed: only on a successful delivery (incl. a genuine quiet day)
  catch (e) { console.error(stripControl(`could not write the day marker: ${e} — not marking today done`)); return 1; }
  return 0;
}

/** Extracted from the old inline init block, WITHOUT its process.exit(0) — dispatch owns the only
 *  process.exit. Returns an exit code: 2 when it REFUSES the config (C1/B7), 0 otherwise. */
export async function init(deps: { load?: typeof loadConfig; write?: typeof initConfig } = {}): Promise<number> {
  const loadFn = deps.load ?? loadConfig;
  // `write` is injectable so a test can exercise init's LOGIC without initConfig's side effects — it
  // walks `homedir()` for repos and spawns `which claude`, which is read-only but can eat a 5s test
  // timeout on slow CI, and is nothing the argv-refusal path is about.
  const writeFn = deps.write ?? initConfig;
  const { path: p, wrote, cliFound } = await writeFn();
  console.log(wrote
    ? `Wrote config template to ${p}. Edit it, then run \`daily-briefing\`.`
    : `Config already exists at ${p}; leaving it alone.`);
  // #13: don't let a missing AI CLI be a silent surprise at the first run — the config defaults to
  // `claude`, so a user with neither claude nor codex on PATH needs to install one (or edit provider.cli).
  if (!cliFound) console.error(stripControl(`\n⚠ No AI CLI found on PATH (looked for claude, codex) — the config uses \`claude\` by default. Install it, or set \`provider.cli\` in ${p}, before running \`daily-briefing\`.`));
  const loaded = await loadFn();
  // C1/B7: REFUSE a provider.argv that defeats hardening outright — but only here, while the user is
  // present to fix it. This genuinely exits non-zero rather than warning: an earlier version printed a
  // warning and still returned 0, which made the "hard-error at init" claim in the comment, the commit
  // message and a test name all false at once. A tick must still never fail on this — the user cannot act
  // on a briefing they never received — so the daily run warns and delivers.
  try {
    assertInitSafeArgv(loaded.provider.argv);
  } catch (e) {
    console.error(stripControl(`\n✖ ${e instanceof Error ? e.message : String(e)}`));
    return 2;
  }
  const issues = await preflightRepos(loaded);
  const blocked = issues.filter(isInaccessible);
  if (blocked.length) {
    console.error(`\n⚠ ${blocked.length} repo(s)/dir(s) could not be read:`);
    for (const i of blocked) console.error(stripControl(`  ${warnFor(i)}`));
    console.error(`\nGrant access (or move the repos out of protected folders) and re-run \`daily-briefing init\` to re-scan.`);
  }
  // Surface typo'd/nonexistent configured paths HERE (while the user is present to fix them) instead of
  // only in the next daily run's warnings — init's whole job is catching config problems up front.
  const notFound = issues.filter((i) => i.kind === "not-found");
  if (notFound.length) {
    console.error(`\n⚠ ${notFound.length} configured path(s) not found (typo, or a relative path?):`);
    for (const i of notFound) console.error(stripControl(`  ${warnFor(i)}`));
  }
  return 0;
}

const VERSION = pkg.version; // from package.json — no hardcoded duplicate to drift

function printUsage(): void {
  console.log(
`daily-briefing — a resumption-focused daily briefing from your local git activity, ready at your first
wake of the day (see morningTime: the floor it will not fire BEFORE, not a delivery time).

Usage:
  daily-briefing [run] [--force]   Generate today's briefing (the default command)
  daily-briefing init              Create/refresh the config (${configPath()})

Flags:
  --force, -f      Ignore the morning-time floor and the once-per-day guard
  --help,  -h      Show this help
  --version, -v    Show the version`);
}

export async function dispatch(
  argv: string[],
  deps: { run?: typeof run; init?: typeof init } = {},
): Promise<number> {
  const runFn = deps.run ?? run;
  const initFn = deps.init ?? init;
  const first = argv[2];
  // Help/version are informational — they must NEVER trigger a stateful briefing run (the old
  // catch-all routed any leading flag, incl. --help, straight into a full generate + day-stamp).
  if (first === "--help" || first === "-h" || first === "help") { printUsage(); return 0; }
  if (first === "--version" || first === "-v") { console.log(VERSION); return 0; }
  // A leading run-flag (bare `daily-briefing --force`) still means the default `run`, but reject an
  // UNKNOWN leading flag instead of silently running — a typo'd `--frce` must not generate a briefing.
  if (first && first.startsWith("-") && first !== "--force" && first !== "-f") {
    console.error(`unknown flag: ${first}`); printUsage(); return 2;
  }
  const cmd = first && !first.startsWith("-") ? first : "run";
  switch (cmd) {
    // interactive = a human at a TTY (launchd redirects stdout to the log → not a TTY) → floor-exempt.
    // interactive = a human at a TTY (stdin OR stdout — so `daily-briefing > out.md` still counts);
    // launchd redirects both to files/devnull → not a TTY → floor enforced for the scheduled agent.
    case "run": return runFn(argv.includes("--force") || argv.includes("-f"), { interactive: Boolean(process.stdin.isTTY || process.stdout.isTTY) });
    // init now signals failure (C1/B7 refuses a provider.argv that defeats hardening), so propagate it.
    case "init": return initFn();
    default: console.error(`unknown command: ${cmd}`); printUsage(); return 2;
  }
}

if (import.meta.main) process.exit(await dispatch(process.argv));
