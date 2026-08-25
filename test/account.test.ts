// Checkpoint 1 — the pure selector, the state module's five writes, and reset parsing.
// Every case here names the defect it pins: these rules were each written in response to a specific
// review finding, and a test that does not fail against the wrong version is not worth its runtime.
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAccount, effectiveAccounts, loadAccountState, recordLimit, clearMark, clearLastLimit,
  parseResetInstant, clampUntil, accountStatePath, DEFAULT_LABEL, MAX_MARK_MS, PROBE_MS, LIMIT_RE,
  type AccountState,
} from "../src/account";

const NOW = new Date("2026-08-23T12:00:00-07:00");
const dir = async () => mkdtemp(join(tmpdir(), "acct-"));
const state = (accounts: AccountState["accounts"] = {}, lastLimit?: AccountState["lastLimit"]): AccountState =>
  lastLimit ? { accounts, lastLimit } : { accounts };
const mark = (until: string, isProbe = false) => ({ limitedUntil: until, isProbe });

describe("resolveAccount — pure selection", () => {
  const two = [{ label: "primary" }, { label: "fallback", configDir: "/tmp/fb" }];

  test("unmarked ⇒ first entry, and it carries no configDir", () => {
    expect(resolveAccount(two, state(), NOW)).toEqual({ label: "primary" });
  });

  test("primary marked in the future ⇒ fallback, with its configDir", () => {
    const s = state({ primary: mark("2026-08-26T22:00:00-07:00") });
    expect(resolveAccount(two, s, NOW)).toEqual({ label: "fallback", configDir: "/tmp/fb" });
  });

  test("expired mark ⇒ primary again (automatic revert, not just the switch)", () => {
    const s = state({ primary: mark("2026-08-23T11:00:00-07:00") });
    expect(resolveAccount(two, s, NOW)).toEqual({ label: "primary" });
  });

  test("all marked ⇒ undefined (no usable account)", () => {
    const s = state({ primary: mark("2026-08-26T22:00:00-07:00"), fallback: mark("2026-08-25T09:00:00-07:00") });
    expect(resolveAccount(two, s, NOW)).toBeUndefined();
  });

  // Empty `accounts` was got wrong in BOTH directions across two review rounds: read as "all marked ⇒
  // none" it stops the briefing entirely on a single-account machine; over-corrected to "never none" it
  // deletes the single-account outage path. Synthesise, then apply the normal rule.
  test("empty/absent accounts ⇒ synthesised default, resolvable", () => {
    expect(effectiveAccounts(undefined)).toEqual([{ label: DEFAULT_LABEL }]);
    expect(resolveAccount(undefined, state(), NOW)).toEqual({ label: DEFAULT_LABEL });
    expect(resolveAccount([], state(), NOW)).toEqual({ label: DEFAULT_LABEL });
  });

  test("…and returns undefined once the synthesised default IS marked", () => {
    const s = state({ [DEFAULT_LABEL]: mark("2026-08-26T22:00:00-07:00") });
    expect(resolveAccount(undefined, s, NOW)).toBeUndefined();
  });

  // A re-clamped far-future mark recomputes as future on every read ⇒ the account is never selectable
  // again. Discarding restores "recover at the cost of one wasted call".
  test("far-future mark is DISCARDED, not re-clamped ⇒ account selectable now", () => {
    const s = state({ primary: mark(new Date(NOW.getTime() + MAX_MARK_MS * 40).toISOString()) });
    expect(resolveAccount(two, s, NOW)).toEqual({ label: "primary" });
  });
});

describe("state file — five writes, read-modify-write, atomicity", () => {
  test("marking B leaves A's mark intact (a whole-file overwrite passes everything else)", async () => {
    const d = await dir();
    await recordLimit("primary", new Date(NOW.getTime() + 3 * 86400e3), NOW, { stateDir: d });
    await recordLimit("fallback", new Date(NOW.getTime() + 2 * 86400e3), NOW, { stateDir: d, report: false });
    const s = await loadAccountState(d);
    expect(Object.keys(s.accounts).sort()).toEqual(["fallback", "primary"]);
    await rm(d, { recursive: true, force: true });
  });

  test("a success clears ONLY the succeeding account's mark", async () => {
    const d = await dir();
    await recordLimit("primary", new Date(NOW.getTime() + 3 * 86400e3), NOW, { stateDir: d });
    await clearMark("fallback", d);                       // the account that just succeeded
    expect((await loadAccountState(d)).accounts.primary).toBeDefined();
    await rm(d, { recursive: true, force: true });
  });

  test("report:false marks the account but writes NO lastLimit", async () => {
    const d = await dir();
    await recordLimit("fallback", new Date(NOW.getTime() + PROBE_MS), NOW, { stateDir: d, report: false, isProbe: true });
    const s = await loadAccountState(d);
    expect(s.accounts.fallback?.isProbe).toBe(true);
    expect(s.lastLimit).toBeUndefined();
    await rm(d, { recursive: true, force: true });
  });

  test("clearLastLimit removes the cause but keeps the marks", async () => {
    const d = await dir();
    await recordLimit("primary", new Date(NOW.getTime() + 3 * 86400e3), NOW, { stateDir: d });
    await clearLastLimit(d);
    const s = await loadAccountState(d);
    expect(s.lastLimit).toBeUndefined();
    expect(s.accounts.primary).toBeDefined();
    await rm(d, { recursive: true, force: true });
  });

  // clampUntil is called from an ERROR HANDLER. A RangeError here is not a ProviderError, so it would
  // escape main.ts's catch and crash the tick instead of skipping it.
  test("an Invalid Date does not throw — it degrades to a probe window", () => {
    expect(() => clampUntil(new Date("nope"), NOW)).not.toThrow();
    expect(clampUntil(new Date("nope"), NOW)).toBe(new Date(NOW.getTime() + PROBE_MS).toISOString());
  });

  // A "__proto__" label hits the prototype setter on a plain object, storing no own property — so that
  // account could never be marked and a walled login would be retried every 600s forever.
  test("a __proto__ label is stored and honoured like any other", async () => {
    const d = await dir();
    await recordLimit("__proto__", new Date(NOW.getTime() + 3 * 86400e3), NOW, { stateDir: d });
    const s2 = await loadAccountState(d);
    expect(s2.accounts["__proto__"]).toBeDefined();
    expect(resolveAccount([{ label: "__proto__" }], s2, NOW)).toBeUndefined();
    await rm(d, { recursive: true, force: true });
  });

  test("clamped at WRITE to now + 8 days", async () => {
    const d = await dir();
    await recordLimit("primary", new Date(NOW.getTime() + 400 * 86400e3), NOW, { stateDir: d });
    const until = Date.parse((await loadAccountState(d)).accounts.primary!.limitedUntil);
    expect(until).toBe(NOW.getTime() + MAX_MARK_MS);
    expect(clampUntil(new Date(NOW.getTime() + 400 * 86400e3), NOW)).toBe(new Date(NOW.getTime() + MAX_MARK_MS).toISOString());
    await rm(d, { recursive: true, force: true });
  });

  // Resilience: each input degrades to "no mark" at a cost of one wasted call, never to a wedged account.
  for (const [name, body] of [
    ["missing", null],
    ["truncated", '{"accounts":{"primary":{"limitedUn'],
    ["corrupt JSON", "not json at all"],
    ["nonsense date", '{"accounts":{"primary":{"limitedUntil":"never","isProbe":false}}}'],
    ["far future", `{"accounts":{"primary":{"limitedUntil":"${new Date(NOW.getTime() + MAX_MARK_MS * 40).toISOString()}","isProbe":false}}}`],
    ["wrong shape", '{"accounts":"primary"}'],
  ] as [string, string | null][]) {
    test(`resilience: ${name} ⇒ primary selectable, no throw`, async () => {
      const d = await dir();
      if (body !== null) await writeFile(accountStatePath(d), body);
      const s = await loadAccountState(d);
      expect(resolveAccount([{ label: "primary" }, { label: "fallback" }], s, NOW)).toEqual({ label: "primary" });
      await rm(d, { recursive: true, force: true });
    });
  }

  test("atomic write leaves no partial file for a concurrent reader", async () => {
    const d = await dir();
    await Promise.all([
      recordLimit("a", new Date(NOW.getTime() + 86400e3), NOW, { stateDir: d }),
      recordLimit("b", new Date(NOW.getTime() + 86400e3), NOW, { stateDir: d }),
      loadAccountState(d), loadAccountState(d),
    ]);
    const s = await loadAccountState(d);          // never a parse error, whichever writer won
    expect(Object.keys(s.accounts).length).toBeGreaterThanOrEqual(1);
    await rm(d, { recursive: true, force: true });
  });
});

describe("parseResetInstant", () => {
  const real = "You've hit your weekly limit · resets Aug 26 at 10pm (America/Los_Angeles)";

  test("the matcher accepts the REAL captured message", () => {
    expect(LIMIT_RE.test(real)).toBe(true);
  });

  // Assert the ABSOLUTE instant, never local calendar fields: `bun test` runs with TZ=UTC while
  // `bun run` uses the machine zone (measured), so getDate()/getHours() assertions disagree between the
  // harness and production for the same correct value.
  test("weekly, date-bearing ⇒ the right instant, not a probe", () => {
    const r = parseResetInstant(real, NOW);
    expect(r.isProbe).toBe(false);
    expect(r.until.toISOString()).toBe("2026-08-27T05:00:00.000Z");   // 22:00 PDT = UTC-7
  });

  // Read on 30 Dec, "resets Jan 2" parsed into the current year lands ~11 months in the PAST.
  test("year rollover: 30 Dec + 'resets Jan 2' ⇒ the FOLLOWING January", () => {
    const dec = new Date("2026-12-30T12:00:00-08:00");
    const r = parseResetInstant("hit your weekly limit · resets Jan 2 at 10pm", dec);
    expect(r.isProbe).toBe(false);
    expect(r.until.getFullYear()).toBe(2027);
    expect(r.until.getMonth()).toBe(0);
  });

  // The mirror error: applying the YEAR rule to a date-less message turns a 2-hour wall into 12 months.
  test("date-less ⇒ within a day, never a year", () => {
    const r = parseResetInstant("hit your session limit · resets at 3pm", new Date("2026-08-23T17:00:00-07:00"));
    expect(r.until.getTime() - Date.parse("2026-08-23T17:00:00-07:00")).toBeLessThanOrEqual(24 * 3600e3);
  });

  test("a DIFFERENT named zone is CONVERTED, not probed", () => {
    const r = parseResetInstant("hit your weekly limit · resets Aug 26 at 10pm (Europe/Berlin)", NOW);
    expect(r.isProbe).toBe(false);
    expect(r.until.toISOString()).toBe("2026-08-26T20:00:00.000Z");   // 22:00 CEST = UTC+2
  });

  // The DST fixture the spec asks for: Nov 1 2026 is AFTER PDT→PST, so the same wall time is UTC-8, not
  // UTC-7. An implementation using a fixed offset passes every other case here and fails this one.
  test("DST boundary: a reset after the transition uses the post-transition offset", () => {
    const r = parseResetInstant("hit your weekly limit · resets Nov 1 at 10pm (America/Los_Angeles)", NOW);
    expect(r.isProbe).toBe(false);
    expect(r.until.toISOString()).toBe("2026-11-02T06:00:00.000Z");   // 22:00 PST = UTC-8
  });

  test("an unknown zone ⇒ probe rather than a wrong instant", () => {
    const r = parseResetInstant("hit your weekly limit · resets Aug 26 at 10pm (Not/AZone)", NOW);
    expect(r.isProbe).toBe(true);
  });

  // Checkpoint-1 finding: the reset phrase does not sit on the message's final line. provider.ts builds
  // `<matched line> — <cli> exited 1: <diag>`, and a $-anchored parser only worked by accident, because
  // diag repeats the line — an accident that breaks the moment stdout exceeds diag's 300-char slice.
  test("the reset parses when it is NOT on the final line", () => {
    const r = parseResetInstant(`${real}\nRun /login to switch accounts`, NOW);
    expect(r.isProbe).toBe(false);
    expect(r.until.toISOString()).toBe("2026-08-27T05:00:00.000Z");
  });

  // Checkpoint-1 finding: taking "today" from the MACHINE's calendar and interpreting it as wall time in
  // the MESSAGE's zone turned a 2-hour session wall into a 26-hour bench, recorded as trusted.
  test("date-less: 'today' is read in the MESSAGE's zone, not the machine's", () => {
    const now = new Date("2026-08-24T02:00:00Z");        // = Aug 23 19:00 in America/Los_Angeles
    const r = parseResetInstant("hit your session limit · resets at 9pm (America/Los_Angeles)", now);
    expect(r.isProbe).toBe(false);
    expect((r.until.getTime() - now.getTime()) / 3600e3).toBeCloseTo(2, 5);
  });

  test("unparseable ⇒ one-hour PROBE (not already-expired, which disables failover silently)", () => {
    const r = parseResetInstant("hit your weekly limit, try later", NOW);
    expect(r.isProbe).toBe(true);
    expect(r.until.getTime()).toBe(NOW.getTime() + PROBE_MS);
    expect(r.until.getTime()).toBeGreaterThan(NOW.getTime());
  });
});
