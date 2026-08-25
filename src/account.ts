// src/account.ts — account failover: which login the provider spawns under, and the sticky state that
// decides it. Design notes are maintained privately by the author (see README "Docs").
//
// Two halves, deliberately separated:
//   - `resolveAccount` is PURE — (accounts, state, now) in, a choice out. No I/O, no clock of its own.
//   - every write to the state file lives in this module and nowhere else, so the read-modify-write
//     discipline below has exactly one place it can be broken.
import { join } from "node:path";
import { supportDir } from "./marker";

/** A mark is ALWAYS a real instant — never null. An "unknown expiry" sentinel would have to mean either
 *  "never retry" or "retry immediately", and each reading breaks a requirement: never-retry benches an
 *  account forever, retry-immediately makes the primary permanently selectable so the fallback is never
 *  reached and the whole feature silently does nothing while appearing to work.
 *  `isProbe` distinguishes a PARSED reset from a probe deadline (a parse failure, or a non-limit failure
 *  on a non-first account). The skip message may only claim "resets at…" for a parsed one. */
export type AccountMark = { limitedUntil: string; isProbe: boolean };

/** `lastLimit` is the outage CAUSE, and per the spec the cause is the TRIGGER for reporting: a gap alone
 *  fires on a closed laptop over a weekend. Duration comes from `last-run` (durable, written on a
 *  different schedule); this record is best-effort and its loss means no outage line, not a wrong one. */
export type AccountState = { accounts: Record<string, AccountMark>; lastLimit?: { label: string; at: string } };

export type AccountChoice = { label: string; configDir?: string };
export type AccountSpec = { label: string; configDir?: string };

/** The label a machine with no configured `accounts` marks against. Marks are keyed by label, and the
 *  single-account case still detects limits, suppresses retries and reports outages — so it needs one. */
export const DEFAULT_LABEL = "default";

/** Nothing may be benched for longer than this. One rule closes four hazards at once: clock skew on a
 *  RunAtLoad wake before NTP settles, a bad year-rollover, a hand-edited file, and an older schema
 *  storing a different time unit. Longer than any real weekly wall, so it never truncates a true reset. */
export const MAX_MARK_MS = 8 * 24 * 60 * 60 * 1000;

/** Parse failure ⇒ re-probe in an hour. NOT "already expired": an always-selectable primary means the
 *  fallback is never reached, i.e. an unparseable message would silently disable failover entirely. */
export const PROBE_MS = 60 * 60 * 1000;

export function accountStatePath(stateDir: string = supportDir()): string {
  return join(stateDir, "account-state.json");
}

/** `accounts` absent or empty SYNTHESISES the one-entry list `[{label: "default"}]` — it does not mean
 *  "no usable account". The normal marked/expired rule then applies to that entry, INCLUDING returning
 *  undefined once it is marked, which is what makes the single-account outage path reachable. */
export function effectiveAccounts(accounts: readonly AccountSpec[] | undefined): AccountSpec[] {
  // Defensive on shape, not just on emptiness: `resolveAccounts` is the validating layer, but this
  // function is exported and a caller that skipped it (or a future consumer reading raw config) must not
  // be able to turn a malformed value into a `{label: undefined}` choice. A non-array with a `.length`
  // — a string, say — would otherwise `slice()` into an array of characters.
  if (!Array.isArray(accounts) || accounts.length === 0) return [{ label: DEFAULT_LABEL }];
  const usable = accounts.filter((a): a is AccountSpec => !!a && typeof a === "object" && typeof a.label === "string" && a.label !== "");
  return usable.length ? usable : [{ label: DEFAULT_LABEL }];
}

/** PURE. First account with no mark, or whose mark has expired. `undefined` ⇒ no usable account, which
 *  the caller turns into a quiet skip WITHOUT constructing a provider.
 *  A mark further out than MAX_MARK_MS is treated as absent here (and rewritten by the loader) — the
 *  clamp is applied at WRITE, and an out-of-bounds value already on disk is discarded rather than
 *  re-clamped: re-clamping recomputes a future instant on every read, so the account is never selectable
 *  again — a bounded bench turned permanent. */
export function resolveAccount(
  accounts: readonly AccountSpec[] | undefined, state: AccountState, now: Date,
): AccountChoice | undefined {
  const t = now.getTime();
  for (const a of effectiveAccounts(accounts)) {
    const mark = state.accounts[a.label];
    if (!mark || !isMarkActive(mark, t)) {
      return a.configDir !== undefined ? { label: a.label, configDir: a.configDir } : { label: a.label };
    }
  }
  return undefined;
}

const emptyState = (): AccountState => ({ accounts: Object.create(null) });

function isMarkActive(mark: AccountMark, nowMs: number): boolean {
  const until = Date.parse(mark.limitedUntil);
  if (!Number.isFinite(until)) return false;            // unparseable ⇒ treat as absent
  if (until - nowMs > MAX_MARK_MS) return false;         // out of bounds ⇒ discarded, not re-clamped
  return until > nowMs;
}


/** Read + self-heal. Anything unreadable, unparseable or out-of-bounds degrades to "no mark", costing at
 *  most one wasted provider call — detection re-records it immediately. The state file is ADVISORY;
 *  detection is authoritative. */
export async function loadAccountState(stateDir?: string): Promise<AccountState> {
  const path = accountStatePath(stateDir);
  let raw: unknown;
  // Null-prototype on EVERY return, not just the populated one: the empty state is what the FIRST write
  // mutates, and `state.accounts["__proto__"] = mark` on a plain object hits the prototype setter and
  // stores nothing. Caught by the __proto__ test after a first fix covered only the read path.
  try { raw = await Bun.file(path).json(); } catch { return emptyState(); }
  if (!raw || typeof raw !== "object") return emptyState();
  const r = raw as Record<string, unknown>;
  const accountsIn = (r.accounts && typeof r.accounts === "object") ? r.accounts as Record<string, unknown> : {};
  // Null-prototype: a label of "__proto__" would otherwise hit the prototype setter, storing no own
  // property — so that account could never be marked and a walled login would be retried every tick.
  const accounts: Record<string, AccountMark> = Object.create(null);
  const nowMs = Date.now();
  for (const [label, v] of Object.entries(accountsIn)) {
    if (!v || typeof v !== "object") continue;
    const m = v as Record<string, unknown>;
    if (typeof m.limitedUntil !== "string") continue;
    const until = Date.parse(m.limitedUntil);
    if (!Number.isFinite(until)) continue;               // nonsense date ⇒ dropped
    if (until - nowMs > MAX_MARK_MS) continue;           // far future ⇒ DISCARDED (see resolveAccount)
    accounts[label] = { limitedUntil: m.limitedUntil, isProbe: m.isProbe === true };
  }
  const ll = r.lastLimit as Record<string, unknown> | undefined;
  const lastLimit = ll && typeof ll.label === "string" && typeof ll.at === "string"
    ? { label: ll.label, at: ll.at } : undefined;
  return lastLimit ? { accounts, lastLimit } : { accounts };
}

/** Atomic: temp file + rename in the same directory, so a concurrent reader sees the old file or the new
 *  one, never a partial one. No lock and no cross-writer merge — two runs racing can lose ONE mark, which
 *  costs one wasted provider call and is re-recorded by the next limit; a torn read would poison every
 *  subsequent run. Bounded and self-correcting beats consistent-but-fragile here. */
async function writeAccountState(state: AccountState, stateDir?: string): Promise<void> {
  const path = accountStatePath(stateDir);
  // Unique PER CALL, not per process: two concurrent writers sharing one temp name meant the first
  // rename moved it away and the second failed ENOENT. Caught by the concurrency test.
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await Bun.write(tmp, JSON.stringify(state, null, 2));
  const { rename } = await import("node:fs/promises");
  await rename(tmp, path);
}

/** Clamp at WRITE (the read path discards instead — see loadAccountState). */
export function clampUntil(until: Date, now: Date): string {
  const max = now.getTime() + MAX_MARK_MS;
  const t = until.getTime();
  // An Invalid Date would make Math.min NaN and toISOString throw a RangeError — which is NOT a
  // ProviderError, so it would escape main.ts's catch and crash the tick instead of skipping it. This is
  // a public function called from an error handler; it must never be the thing that fails.
  if (!Number.isFinite(t)) return new Date(now.getTime() + PROBE_MS).toISOString();
  return new Date(Math.min(t, max)).toISOString();
}

/** Record a limit. `report: false` for a non-limit probe mark (a broken login) — it marks the account but
 *  writes NO `lastLimit`, so a developer- or auth-caused event is never reported to the user as a usage
 *  limit outage. Read-modify-write: marking one account must not erase the other's mark. */
export async function recordLimit(
  label: string, until: Date, now: Date, opts: { isProbe?: boolean; report?: boolean; stateDir?: string } = {},
): Promise<void> {
  const state = await loadAccountState(opts.stateDir);
  state.accounts[label] = { limitedUntil: clampUntil(until, now), isProbe: opts.isProbe === true };
  if (opts.report !== false) state.lastLimit = { label, at: now.toISOString() };
  await writeAccountState(state, opts.stateDir);
}

/** A success clears ONLY the succeeding account's mark. Clearing broadly would erase the primary's mark
 *  the moment the fallback succeeds, so the next tick retries the primary and stickiness is silently
 *  gone. Usually a no-op; it exists for the case where it is not. */
export async function clearMark(label: string, stateDir?: string): Promise<void> {
  const state = await loadAccountState(stateDir);
  if (!(label in state.accounts)) return;
  delete state.accounts[label];
  await writeAccountState(state, stateDir);
}

/** §4a — a NON-limit failure under an account that is not the first entry.
 *
 *  Scoped by POSITION, never by the word "default": on a two-entry config every account is
 *  "non-default", so a label-based rule would mark the PRIMARY on an ordinary wake-before-wifi
 *  `nonzero-exit` — the most common transient failure this codebase has, and the one the whole
 *  `failFastMs` ladder exists for. The first entry is only ever marked by a real limit.
 *
 *  Writes NO `lastLimit`: an auth failure is not a usage wall, and recording it as one would later
 *  report a broken fallback login to the user as a usage-limit outage. */
export async function recordAuthProbe(
  label: string, accounts: readonly AccountSpec[] | undefined, now: Date, stateDir?: string,
): Promise<boolean> {
  if (effectiveAccounts(accounts)[0]?.label === label) return false;   // never bench the primary on a blip
  await recordLimit(label, new Date(now.getTime() + PROBE_MS), now, { isProbe: true, report: false, stateDir });
  return true;
}

/** Cleared after a successful DELIVERY, unconditionally — not only when an outage line was rendered.
 *  Gating it on "a line rendered" leaves the record alive through the normal failover day (where
 *  missed = 0 and no line is due), and an ordinary laptop-closed gap weeks later is then reported as a
 *  usage-limit outage. */
export async function clearLastLimit(stateDir?: string): Promise<void> {
  const state = await loadAccountState(stateDir);
  if (!state.lastLimit) return;
  delete state.lastLimit;
  await writeAccountState(state, stateDir);
}

// ── Reset-time parsing ────────────────────────────────────────────────────────────────────────────
// The message is SERVER-SUPPLIED (`strings` on the CLI binary does not contain it), so everything here
// degrades to a probe rather than guessing. Measured shape, 2026-08-23:
//   "You've hit your weekly limit · resets Aug 26 at 10pm (America/Los_Angeles)"
// The separator is U+00B7 and the apostrophe is plain ASCII — the matcher below crosses neither.
// One definition, imported by provider.ts's classifier — two copies of a classification predicate can
// drift into "provider classifies a limit whose message this file cannot parse".
export const LIMIT_RE = /hit your (weekly|session|usage|daily) limit/i;
// Stops at a NEWLINE, not at end-of-string. The `$`-anchored version required the reset phrase to sit on
// the message's final line, which coupled this parser to a string assembled in another file: it happened
// to work only because that message repeats the limit line inside `diag`, and it silently degraded to an
// hourly probe as soon as stdout exceeded diag's 300-char slice.
const RESET_RE = /resets\s+([^\n]+)/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export type ParsedReset = { until: Date; isProbe: boolean };

/** `text` → an absolute instant, or a one-hour probe deadline when the instant cannot be trusted.
 *  A probe is a bounded, self-correcting error; a mis-converted instant is neither. */
export function parseResetInstant(text: string, now: Date): ParsedReset {
  const probe = (): ParsedReset => ({ until: new Date(now.getTime() + PROBE_MS), isProbe: true });
  const m = text.match(RESET_RE);
  if (!m?.[1]) return probe();
  const phrase = m[1];

  // The zone named in the message is honoured by CONVERSION, not by comparison to the machine's zone.
  // An equality check looks simpler and is a trap: `bun test` runs with TZ=UTC while `bun run` uses the
  // machine zone (measured), so the behaviour under test would differ from the behaviour in production —
  // the check would pass a wrong implementation and fail a right one.
  const zone = phrase.match(/\(([A-Za-z]+\/[A-Za-z_]+)\)/)?.[1];

  const time = phrase.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!time) return probe();
  let hour = Number(time[1]) % 12;
  if (/pm/i.test(time[3]!)) hour += 12;
  const minute = time[2] ? Number(time[2]) : 0;

  const date = phrase.match(/\b([A-Za-z]{3,})\s+(\d{1,2})\b/);
  const monthIdx = date ? MONTHS.indexOf(date[1]!.slice(0, 3).toLowerCase()) : -1;

  const wall = (y: number, mo: number, day: number): number | undefined =>
    zone ? zonedWallToInstant(y, mo, day, hour, minute, zone)
         : new Date(y, mo, day, hour, minute, 0, 0).getTime();

  if (monthIdx >= 0 && date) {
    // DATE-BEARING: the message carries no year. Read on 30 Dec, "resets Jan 2" parsed into the current
    // year lands ~11 months in the PAST, which reads as already-expired — so roll forward one year.
    const day = Number(date[2]);
    let t = wall(now.getFullYear(), monthIdx, day);
    if (t === undefined) return probe();
    if (t <= now.getTime()) {
      const t2 = wall(now.getFullYear() + 1, monthIdx, day);
      if (t2 === undefined) return probe();
      t = t2;
    }
    if (t <= now.getTime()) return probe();               // still past ⇒ do not invent a third guess
    return { until: new Date(t), isProbe: false };
  }

  // DATE-LESS (the session-limit shape): roll forward at most ONE DAY. Applying the year rule here would
  // turn a two-hour wall into a twelve-month bench — the mirror of the error the year rule prevents.
  // ⚠ "Today" must be read in the MESSAGE's zone, not the machine's. Taking the local calendar date and
  // then interpreting it as wall time in a different zone turned a 2-hour session wall into a 26-hour
  // bench, recorded as a trusted instant (measured, TZ=UTC + America/Los_Angeles message).
  const today = zone ? civilDateIn(zone, now) : { y: now.getFullYear(), mo: now.getMonth(), d: now.getDate() };
  if (!today) return probe();
  let t = wall(today.y, today.mo, today.d);
  if (t === undefined) return probe();
  if (t <= now.getTime()) t += 24 * 60 * 60 * 1000;
  if (t <= now.getTime()) return probe();
  return { until: new Date(t), isProbe: false };
}

/** Wall-clock time in a named IANA zone → an absolute instant, with no date library (this project has
 *  zero runtime dependencies and Temporal is unavailable). Guess the instant as if the wall time were
 *  UTC, ask Intl what that instant looks like in the zone, and correct by the difference; one extra
 *  iteration settles DST boundaries where the first correction crosses a transition.
 *  Returns undefined for a zone Intl rejects — the caller degrades to a probe rather than a wrong
 *  instant, because a wrong instant can bench an account for days. */
/** The calendar date `now` falls on IN `zone`. Returns undefined for a zone Intl rejects. */
function civilDateIn(zone: string, now: Date): { y: number; mo: number; d: number } | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(now);
    const g = (t: string) => Number(parts.find((x) => x.type === t)?.value);
    const y = g("year"), mo = g("month"), d = g("day");
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return undefined;
    return { y, mo: mo - 1, d };
  } catch { return undefined; }
}

function zonedWallToInstant(y: number, mo: number, day: number, h: number, mi: number, zone: string): number | undefined {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch { return undefined; }
  const target = Date.UTC(y, mo, day, h, mi, 0, 0);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p: Record<string, number> = {};
    for (const part of fmt.formatToParts(new Date(guess))) {
      if (part.type !== "literal") p[part.type] = Number(part.value);
    }
    if (p.year === undefined || p.hour === undefined) return undefined;
    const asUtc = Date.UTC(p.year, (p.month ?? 1) - 1, p.day ?? 1, p.hour % 24, p.minute ?? 0, p.second ?? 0);
    const drift = asUtc - target;
    if (drift === 0) return guess;
    guess -= drift;
  }
  return guess;
}

// ── Outage reporting ──────────────────────────────────────────────────────────────────────────────

/** Local calendar days between two `YYYY-MM-DD` strings. Calendar days, not elapsed/86400e3: the rest
 *  of this codebase keys on local dates (`localDateStr`, `alreadyRanToday`), and the two disagree
 *  across a DST boundary. */
export function calendarDaysBetween(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = toYmd.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400e3);
}

const ymdOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** How many briefings a limit outage actually cost, and which account caused it.
 *
 *  Two sources, deliberately: the DURATION comes from `last-run` (durable — a different file on a
 *  different schedule, so state corruption cannot destroy it), and the CAUSE comes from `lastLimit`.
 *  **The cause is the trigger.** Reporting on the gap alone would announce a usage-limit outage after
 *  any ordinary gap — a closed laptop over a weekend, a week of travel.
 *
 *  `missedDays` counts BRIEFINGS THAT DID NOT HAPPEN, not elapsed days. `last-run` is always yesterday
 *  in normal operation, so a gap of 1 is the healthy case: the ordinary failover day, delivered ten
 *  minutes late, must render nothing.
 *
 *  `outageStart` also floors at the limit itself, so a non-limit gap immediately PRECEDING a limit is
 *  not billed to it: laptop closed Fri-Sun, Monday's tick hits the wall, the fallback delivers minutes
 *  later — that cost zero briefings and must say nothing. */
export function outageReport(
  lastRunYmd: string | undefined, lastLimit: { label: string; at: string } | undefined, now: Date,
): { missedDays: number; label: string } | undefined {
  if (!lastLimit || !lastRunYmd) return undefined;          // no cause ⇒ no line, whatever the gap
  const limitAt = new Date(lastLimit.at);
  if (!Number.isFinite(limitAt.getTime())) return undefined;
  // The day before the limit was recorded is the last day a briefing could have been expected.
  const limitStart = ymdOf(new Date(limitAt.getTime() - 86400e3));
  const start = calendarDaysBetween(lastRunYmd, limitStart) > 0 ? limitStart : lastRunYmd;
  const missedDays = calendarDaysBetween(start, ymdOf(now)) - 1;
  return missedDays >= 1 ? { missedDays, label: lastLimit.label } : undefined;
}

/** Resolve the account a SCRIPT path (audit / eval) should spawn under, and the env option to pass.
 *
 *  The scripts build their own `hardenedProvider`s, so they do not inherit core.ts's selection. Two
 *  properties this exists to keep:
 *   - the judges honour the same limit marks, so an audit during an outage is runnable at all — which
 *     is exactly when it is most worth running;
 *   - and they cannot write a REPORTABLE outage: the eval generator runs through `runCore` with an
 *     INJECTED provider, and runCore only records when it built the provider itself — so a developer
 *     running `bun scripts/eval.ts` can never put a usage-limit outage on the user's next briefing.
 *
 *  Returns `undefined` for the account when nothing is usable — the caller decides whether to proceed
 *  (a script may legitimately want to try anyway and report the failure). */
export async function resolveForScript(
  accounts: readonly AccountSpec[] | undefined, now: Date, stateDir?: string,
): Promise<{ account?: AccountChoice; env?: Record<string, string> }> {
  const account = resolveAccount(accounts, await loadAccountState(stateDir), now);
  if (!account) return {};
  return account.configDir !== undefined
    ? { account, env: { CLAUDE_CONFIG_DIR: account.configDir } }
    : { account };
}

