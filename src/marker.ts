// src/marker.ts
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";

// Cross-platform state dir (mirrors config.ts's XDG-aware configPath, so state doesn't land in a fake
// ~/Library tree off macOS): macOS → ~/Library/Application Support, Windows → %LOCALAPPDATA%, else the
// XDG state dir (~/.local/state). DAILY_BRIEFING_STATE_DIR overrides everything (tests; power users).
export function stateDirFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (env.DAILY_BRIEFING_STATE_DIR) return env.DAILY_BRIEFING_STATE_DIR;
  if (platform === "darwin") return join(home, "Library", "Application Support", "daily-briefing");
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "daily-briefing");
  return join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "daily-briefing");
}

export function supportDir(): string {
  return stateDirFor(process.platform, process.env, homedir());
}

// The launchd StandardOutPath log (raw stdout) that appends every ~10-min tick.
export function logPath(): string {
  return join(supportDir(), "briefing.log");
}

// That log never rotates, so it grows unbounded (a full briefing echoed every tick). Bound it: once it
// exceeds maxBytes, copy the current content to <log>.1 (one generation kept) and truncate the live
// file in place. Truncation is safe with launchd's O_APPEND stdout fd — its next write resumes at EOF,
// so this run's output still lands. A no-op when the file is absent (non-launchd/interactive runs).
export async function rotateLogIfLarge(path: string = logPath(), maxBytes = 5_000_000): Promise<void> {
  const f = Bun.file(path);
  if (!(await f.exists()) || f.size <= maxBytes) return;
  await Bun.write(`${path}.1`, f); // keep one prior generation
  await Bun.write(path, "");        // truncate in place
}

/** The TICK HEARTBEAT (day-34 finding). Every scheduled invocation stamps this file BEFORE any gate,
 *  so the log records that the tick happened even when it exits at the once-per-day guard, the floor,
 *  or a missing config — all of which return 0 silently and write nothing else.
 *
 *  ⚠ WHY IT EXISTS, and the ambiguity it removes. Day 34 delivered ~110 minutes past the floor on a
 *  machine that never slept, with a healthy agent (`runs = 260`) and no provider failure — and the
 *  cause could NOT be determined, because nothing distinguished "launchd never fired a tick" from
 *  "a tick fired and returned at a gate". Both look identical: an empty `briefing.log` stretch.
 *
 *  ⚠ FORMAT IS `<iso> local=<YYYY-MM-DD> today=<n>`, and the COUNT is the load-bearing half — a bare
 *  timestamp answers "when was the last tick", which is not the question. The question is "did ticks
 *  fire DURING the gap", and `today=` answers it: a briefing landing at 09:10 alongside `today=11`
 *  proves ticks were firing all morning and the GATE is the defect; `today=1` proves launchd was not
 *  firing them.
 *
 *  ⚠ NOT written into `briefing.log`: `lastBriefing` (audit.ts) returns everything from the last
 *  header to EOF, so per-tick lines appended after a briefing would be handed to the judge AS PART OF
 *  the briefing. Checked before choosing this file. Its own file, one line, overwritten.
 *
 *  Diagnostic only — never fatal, never read by the pipeline, and it touches no briefing content and
 *  no counted quantity, so it carries no eval discontinuity. */
export function tickPath(): string {
  return join(supportDir(), "last-tick");
}

/** Read-modify-write of the heartbeat: same local date → increment, new date → reset to 1.
 *  `nowIso`/`todayLocal` injected for tests. Returns the count written (0 if the write failed — the
 *  caller ignores it; a diagnostic must never cost a morning).
 *
 *  ⚠ THE LOCAL DATE IS STORED IN ITS OWN FIELD AND THE COMPARISON READS THAT FIELD — never the
 *  timestamp. Day 35 (2026-08-20) found the original pinned at `today=1` from 17:00 local onward on
 *  this UTC-7 machine: it compared `nowIso.slice(0, 10)` — the **UTC** date — against `todayLocal`,
 *  and those disagree for the last N hours of every local day west of Greenwich. Every evening tick
 *  took the reset branch and rewrote 1, *the exact value STATE.md watch 1 reads as "launchd never
 *  fired"*, and local midnight brought no reset at all — the day boundary had effectively moved to
 *  17:00 local. The unit the counter means is LOCAL ("ticks so far this local day"), matching
 *  `localDateStr`, `alreadyRanToday` and the briefing archive, so local is what keys the file; the
 *  timestamp stays UTC because it answers a different question (which instant), unambiguously.
 *
 *  ⚠ The stored key and the compared key are now THE SAME STRING — that symmetry, not the date
 *  format, is what makes the pin unreachable, so the field is read back as `\S+` rather than
 *  re-validated as a date. Whatever the caller keys the day by round-trips intact.
 *
 *  A line written before that field existed (`<iso> today=<n>`) has no `local=`, so it fails the
 *  match and starts over at 1 — the pre-existing reset-on-unparseable behaviour, kept because it
 *  cannot throw. The whole cost of the format change is one tick of a diagnostic counter. */
export async function stampTick(nowIso: string, todayLocal: string): Promise<number> {
  try {
    const f = Bun.file(tickPath());
    let n = 0;
    if (await f.exists()) {
      const m = (await f.text()).trim().match(/^\S+\s+local=(\S+)\s+today=(\d+)$/);
      // Same local date → continue the count; a different date (or an unparseable/legacy line) starts over.
      if (m && m[1] === todayLocal) n = Number(m[2]) || 0;
    }
    const next = n + 1;
    await Bun.write(tickPath(), `${nowIso} local=${todayLocal} today=${next}\n`);
    return next;
  } catch {
    return 0; // diagnostic only
  }
}

export function markerPath(): string {
  return join(supportDir(), "last-run");
}

/** The marker FILE exists at all (any date) — i.e. a briefing has succeeded at least once.
 *  Distinguishes a fresh install (never delivered) from a config that vanished after working. */
export async function markerExists(): Promise<boolean> {
  return Bun.file(markerPath()).exists();
}

// The clean, OVERWRITTEN copy of the latest briefing — what the user opens and the audit reads.
// (The launchd StandardOutPath log appends every run, so it can't be "just today's".)
export function latestBriefingPath(): string {
  return join(supportDir(), "briefing-latest.md");
}

// A DATED copy — the calibration corpus `postcheck` needs and did not have.
//
// ⚠ "Never-overwritten" is what an earlier version of this comment claimed and it was FALSE, caught in
// review: `Bun.write` truncates, so a same-day `--force` regeneration replaces that day's archive.
// That is the RIGHT behaviour and is left alone — `briefing-latest.md` is replaced by the same run, so
// the two stay in step and the archive keeps matching the briefing the user actually read (days 26 and
// 28 were both graded on a regenerated artifact). One file per DAY, not per RUN. There is also no
// retrospective-run mechanism to speak of: `runDate` is `localDateStr(new Date())` at run start
// (core.ts) and no `--date` flag exists, so keying on it buys midnight-straddle safety, nothing more.
//
// ⚠ Why this exists, recorded so it is not "tidied away" as redundant with briefing-latest.md.
// EVAL.md's days 27–29 window was meant to calibrate `RESTATEMENT_THRESHOLD` over three mornings and
// managed ONE (28 and 29 were blocked by `MIN_SHARED_TOKENS` before reaching the containment gate).
// The obvious fix — re-score the back catalogue — was impossible: `briefing-latest.md` is overwritten
// daily, `briefing.log` was reset by the 2026-08-13 crash, and MEASURED 2026-08-14 it held exactly
// two briefings. So the corpus that would have settled the promotion decision did not exist and could
// not be reconstructed at any price. One file per day, written once, fixes that permanently.
//
// ⚠ RETENTION IS DELIBERATELY UNBOUNDED — do not "fix" this to match the neighbours. `briefing.log`
// rotates (`rotateLogIfLarge`) and `audit-*.md` prunes at `AUDIT_RETENTION` because both are
// disposable; a calibration corpus is the opposite, and pruning it defeats the entire purpose. Cost is
// ~8 KB/day ≈ 3 MB/year. `uninstall.sh` removes the directory, so nothing is leaked.
//
// Deliberately NOT the `.log`: that file appends raw launchd stdout across days and interleaves
// warnings, so it is not machine-parseable back into individual briefings.
export function archivedBriefingPath(dateStr: string): string {
  // Shape-guard the ONE interpolated component. No production caller can reach this with anything else
  // — `runDate` is machine-generated and non-optional — but this is EXPORTED, and the calibration
  // harness it exists to feed will take a date from a CLI arg or a filename. Measured in review:
  // `archivedBriefingPath("../../etc/passwd")` escaped the state dir entirely. Throwing documents the
  // contract and costs one line; the alternative is a path-traversal trap left for the next caller.
  // main.ts's fail-open `.catch` swallows this, so a bad date loses the archive, never the briefing.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`archivedBriefingPath: expected YYYY-MM-DD, got ${JSON.stringify(dateStr)}`);
  }
  return join(supportDir(), "briefings", `${dateStr}.md`);
}

export function localDateStr(d: Date): string {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The DATE of the last successful delivery, or undefined if none is recorded.
 *
 *  `alreadyRanToday` reads the same file but only compares it, discarding the value — and the outage
 *  report needs the value: `last-run` is the durable half of "no briefing for N days" (it is written on
 *  a different schedule from the account state, so corruption there cannot destroy the duration). */
export async function readLastRunDate(): Promise<string | undefined> {
  // Total, never throwing: this feeds the outage line, which is decoration on a briefing — an
  // existing-but-unreadable marker must never cost the delivery. It matters more since `--force`
  // skips `alreadyRanToday` (whose own unguarded read would otherwise throw first on the scheduled
  // path), making this the FIRST marker read a forced run performs.
  try {
    const f = Bun.file(markerPath());
    if (!(await f.exists())) return undefined;
    const t = (await f.text()).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : undefined;
  } catch { return undefined; }
}

/** What the day-marker check did, so the SHELL can report it — marker.ts writes no output itself
 *  (run() owns all I/O). `repair` is absent on every healthy path, which is all but one in a hundred
 *  thousand ticks. */
export type RanTodayCheck = { ranToday: boolean; repair?: "rewritten" | "cleared" | "failed" };

/** Answers "did today's briefing already happen?", and REPAIRS the marker if it cannot be read.
 *
 *  The marker is one date string, and reading it is the first thing every tick does. An
 *  existing-but-unreadable marker used to throw here, uncaught, killing the tick — every 600s,
 *  indefinitely, with no briefing and no self-recovery (`Verified: chmod 000 → EACCES`).
 *
 *  ⚠ The obvious guard is WORSE than the bug. Answering `false` on a read failure regenerates a full
 *  briefing every tick — ~100 provider calls a day — and never terminates, because the stamp that
 *  would stop it fails for the same reason the read did. That is precisely the usage wall the account
 *  failover feature exists to survive, self-inflicted.
 *
 *  So it repairs instead of coping. Deleting a file needs write permission on the DIRECTORY, not on
 *  the file, so an unreadable marker is replaceable even though it is not writable in place
 *  (`Verified: plain write → EACCES; unlink then write → OK`). The "did we run?" answer meanwhile
 *  comes from the dated archive, a second signal every delivering run already writes.
 *
 *  If even the unlink fails, the state DIRECTORY is broken rather than the file, and this claims the
 *  day rather than regenerate every tick — the one case that trades briefings for quota. It is
 *  reported, never silent. */
export async function checkRanToday(): Promise<RanTodayCheck> {
  const f = Bun.file(markerPath());
  if (!(await f.exists())) return { ranToday: false };
  const today = localDateStr(new Date());
  try {
    return { ranToday: (await f.text()).trim() === today };
  } catch { /* unreadable — repair below */ }

  // Independent of the marker, and written BEFORE the stamp on every delivering run, so it is the
  // better witness here rather than merely the available one.
  let ranToday = false;
  try { ranToday = await Bun.file(archivedBriefingPath(today)).exists(); } catch { ranToday = false; }
  try {
    await unlink(markerPath());
    if (ranToday) await Bun.write(markerPath(), today);
    return { ranToday, repair: ranToday ? "rewritten" : "cleared" };
  } catch {
    return { ranToday: true, repair: "failed" };
  }
}

export async function alreadyRanToday(): Promise<boolean> {
  return (await checkRanToday()).ranToday;
}

// Accepts the date captured at RUN START: with retry delays a run can straddle midnight, and
// stamping now-at-finish would mark TOMORROW done — silently skipping the next 7:20 run.
export async function stampToday(dateStr?: string): Promise<void> {
  await Bun.write(markerPath(), dateStr ?? localDateStr(new Date()));
}
