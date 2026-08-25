// Checkpoint 3 — the failover path through the REAL provider stack.
//
// Why this file exists at all: `core.ts` builds `hardenedProvider` only when `deps.provider` is absent,
// so every test that injects a provider double skips the env seam, the ladder, and account selection
// entirely. Written that way, the account tests would assert a simulation and stay green against a build
// where the feature does nothing in production. So these run a real `hardenedProvider` against a fake
// `claude` on disk.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, chmod, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCore } from "../src/core";
import { run } from "../src/main";
import { renderBriefing } from "../src/render";
import { buildRepo } from "./fixtures/build-repo";
import { loadAccountState, accountStatePath } from "../src/account";
import type { Config } from "../src/types";

let stateDir = "";
let repo = "";
let prevStateDir: string | undefined;

/** A fake `claude` that behaves differently per CLAUDE_CONFIG_DIR — the behaviour `pickyClaude` lacks.
 *  Only `okDir` gets a parseable briefing; EVERY other value, empty included, gets the real captured
 *  limit message on stdout and exit 1. It records every invocation's config dir, so spawn COUNTS are
 *  assertable.
 *
 *  ⚠ Keyed on the ONE dir that works, not on the one that fails — deliberately, and it is not a
 *  refactor. Keyed the other way, "both accounts walled" could only be written by pointing both
 *  accounts at the same limited dir, which `resolveAccounts` REJECTS as two labels on one login
 *  (config.ts: "same login directory"). That test therefore ran with failover disabled and silently
 *  re-tested the single-account path — measured by a reviewer, after the assertion added on 2026-08-24
 *  had already been written against it. Two DISTINCT failing dirs are only expressible this way. */
async function fakeClaude(dir: string, okDir: string): Promise<string> {
  const p = join(dir, "claude");
  await writeFile(p, `#!/bin/sh
# hardenedProvider probes \`--help\` for flag support before it ever generates. That spawn is real and
# legitimate, and counting it would make "exactly one spawn per limit" unassertable — so it is answered
# and NOT logged. (It also must not return the limit message, or the probe itself would classify.)
case " $* " in *" --help "*) echo "--tools --setting-sources --strict-mcp-config"; exit 0;; esac
echo "$CLAUDE_CONFIG_DIR" >> "${join(dir, "spawns.log")}"
if [ "$CLAUDE_CONFIG_DIR" != "${okDir}" ]; then
  # A DIFFERENT reset per dir. Identical resets make a mark indistinguishable from any other mark, so
  # an implementation reading label from one account and until from another cannot be caught — measured:
  # that exact mutant survived the suite while every mark shared one timestamp.
  case "$CLAUDE_CONFIG_DIR" in
    *-b) RESET="Aug 25 at 9pm";;
    *)   RESET="Aug 26 at 10pm";;
  esac
  printf "You've hit your weekly limit \\302\\267 resets $RESET (America/Los_Angeles)\\n"
  exit 1
fi
printf "RESUME\\n- resumed\\nRECAP\\n- recapped\\nSUGGESTIONS\\n- suggested\\n"
`);
  await chmod(p, 0o755);
  return p;
}

// Does NOT filter empty lines: an empty CLAUDE_CONFIG_DIR is the single-account case's expected value,
// and dropping it would make "no env var was set" indistinguishable from "no spawn happened".
const spawns = async (dir: string): Promise<string[]> => {
  try {
    const raw = await readFile(join(dir, "spawns.log"), "utf-8");
    return raw.split("\n").slice(0, -1);          // trailing newline only
  } catch { return []; }
};

beforeAll(async () => {
  // Redirect state for the WHOLE file: core.ts's account writes go to supportDir(), which is the user's
  // live directory on a machine that ticks every 600 seconds.
  prevStateDir = process.env.DAILY_BRIEFING_STATE_DIR;
  stateDir = await mkdtemp(join(tmpdir(), "failover-state-"));
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
  repo = await buildRepo([
    { file: "a.ts", content: "one", isoDate: new Date(Date.now() - 2 * 86400e3).toISOString() },
    { file: "b.ts", content: "two", isoDate: new Date(Date.now() - 1 * 86400e3).toISOString() },
  ]);
});

afterAll(async () => {
  if (prevStateDir === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR;
  else process.env.DAILY_BRIEFING_STATE_DIR = prevStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

const NOW = new Date("2026-08-24T12:00:00-07:00");

async function cfgFor(cli: string, accounts: Config["provider"]["accounts"]): Promise<Config> {
  return {
    repos: [repo],
    provider: { cli, argv: [], promptVia: "stdin", timeoutMs: 30_000, ...(accounts ? { accounts } : {}) },
  } as Config;
}

// `powerPlatform: "linux"` short-circuits the darkwake gate (only macOS exposes it), which is cleaner
// than faking `pmset` output. `retryDelaysMs: []` keeps a nonzero-exit from sleeping through the suite.
const deps = {
  netProbe: async () => true,
  powerPlatform: "linux" as NodeJS.Platform,
  now: () => NOW,
  sleep: async () => {},
  retryDelaysMs: [] as number[],
};

describe("failover through the real provider stack", () => {
  test("tick A: the limit is classified, the account marked, and the tick exits QUIETLY with no briefing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-cli-"));
    const limitedDir = join(dir, "limited"), okDir = join(dir, "ok");
    const cli = await fakeClaude(dir, okDir);
    const cfg = await cfgFor(cli, [{ label: "primary", configDir: limitedDir }, { label: "fallback", configDir: okDir }]);

    const r = await runCore(cfg, deps);

    expect(r.skipReason).toBe("limited");
    expect(r.offlineSkipped).toBe(true);            // the GATE for the quiet return 0 — not skipReason alone
    expect(r.limited?.label).toBe("primary");
    expect(r.limited?.isProbe).toBe(false);         // a PARSED reset, so the message may state it
    // COMPUTED against the state as written, not assumed. Shipped hardcoded `true`-equivalent, and the
    // 2026-08-24 live test printed "no other account is available" on exactly this tick.
    expect(r.limited?.exhausted).toBe(false);       // the fallback is unmarked and delivers next tick
    expect(r.account).toBeUndefined();              // nothing was produced, so nothing to attribute
    expect(r.rawText).toBe("");                     // no briefing produced
    const st = await loadAccountState(stateDir);
    expect(st.accounts.primary).toBeDefined();
    expect(st.lastLimit?.label).toBe("primary");    // the cause record, which is the outage TRIGGER

    // One spawn, not three: the ladder must not re-run a walled account.
    expect((await spawns(dir)).length).toBe(1);
    await rm(dir, { recursive: true, force: true });
    await rm(accountStatePath(stateDir), { force: true });
  });

  test("tick B: with the primary marked, the fallback is selected, spawned under ITS config dir, and delivers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-cli-"));
    const limitedDir = join(dir, "limited"), okDir = join(dir, "ok");
    const cli = await fakeClaude(dir, okDir);
    const cfg = await cfgFor(cli, [{ label: "primary", configDir: limitedDir }, { label: "fallback", configDir: okDir }]);

    await runCore(cfg, deps);                        // tick A marks the primary
    const before = process.env.CLAUDE_CONFIG_DIR;
    const r = await runCore(cfg, deps);              // tick B

    expect(r.skipReason).toBeUndefined();
    expect(r.rawText).toContain("RESUME");           // a real briefing came back
    expect((await spawns(dir)).at(-1)).toBe(okDir);  // spawned under the FALLBACK's dir
    // Provenance the SHELL can log. Until 2026-08-24 the only proof of which account delivered was the
    // mtime of a session dir under the fallback's config dir — incidental, and not evidence that would
    // survive a CLI change, for the one fact the whole feature turns on.
    expect(r.account).toBe("fallback");
    // §4's worst silent hazard: CLAUDE_CONFIG_DIR also resolves the transcript scan root, so exporting
    // it would blank transcript evidence on exactly the days failover engages, with nothing warning.
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(before as string | undefined as never);
    await rm(dir, { recursive: true, force: true });
    await rm(accountStatePath(stateDir), { force: true });
  });

  // ⚠ TWO DISTINCT failing dirs. Written with one shared dir until 2026-08-24, which `resolveAccounts`
  // rejects as two labels on one login — so the test ran with failover DISABLED and merely re-tested the
  // single-account path below it. That hole is what let a mutant computing `exhausted` from
  // `accounts.length > 1` (rather than from the state) survive the whole suite.
  test("both walled ⇒ exhausted becomes true, then a quiet skip with NO spawn at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-cli-"));
    const limitedA = join(dir, "limited-a"), limitedB = join(dir, "limited-b");
    const cli = await fakeClaude(dir, join(dir, "ok"));       // neither account's dir is the working one
    const cfg = await cfgFor(cli, [{ label: "primary", configDir: limitedA }, { label: "fallback", configDir: limitedB }]);

    const first = await runCore(cfg, deps);          // marks primary — the fallback is still selectable
    expect(first.limited?.exhausted).toBe(false);

    // THE case the old shared-dir test could not reach: the CATCH branch, with two accounts configured,
    // where the account being marked is the last one standing. A `accounts.length > 1` implementation
    // answers false here and the shell then promises a retry that can never happen.
    const second = await runCore(cfg, deps);         // marks fallback — now nothing is left
    expect(second.limited?.label).toBe("fallback");
    expect(second.limited?.exhausted).toBe(true);

    const spawnsBefore = (await spawns(dir)).length;
    expect(spawnsBefore).toBe(2);                    // exactly one spawn per tick, no ladder re-runs
    const r = await runCore(cfg, deps);              // nothing usable left — the early-return branch

    expect(r.skipReason).toBe("limited");
    expect(r.offlineSkipped).toBe(true);
    expect(r.limited?.exhausted).toBe(true);
    // label and until must describe the SAME account: they were read from different ones until
    // 2026-08-24 (label from lastLimit, until from the FIRST account's mark unconditionally).
    expect(r.limited?.label).toBe("fallback");
    const st = await loadAccountState(stateDir);
    expect(r.limited?.until).toBe(st.accounts.fallback!.limitedUntil);
    expect((await spawns(dir)).length).toBe(spawnsBefore);   // no provider constructed, nothing spawned
    await rm(dir, { recursive: true, force: true });
    await rm(accountStatePath(stateDir), { force: true });
  });

  // Provenance is gated on `hardened` for the same reason recordLimit/clearMark/recordAuthProbe are:
  // an injected provider means the resolved label never reached a spawn, so attributing output to it
  // would describe a process that never ran. The eval harness calls runCore exactly this way.
  test("an INJECTED provider produces no account attribution, even with accounts configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-cli-"));
    const okDir = join(dir, "ok");
    const cfg = await cfgFor(await fakeClaude(dir, okDir), [{ label: "primary", configDir: okDir }]);
    const r = await runCore(cfg, {
      ...deps,
      provider: { generate: async () => "RESUME\n- resumed\nRECAP\n- recapped\nSUGGESTIONS\n- suggested\n" },
    });
    expect(r.rawText).toContain("RESUME");        // it really did deliver, via the injected transport
    expect(r.account).toBeUndefined();            // …and claims nothing about which account did it
    await rm(dir, { recursive: true, force: true });
    await rm(accountStatePath(stateDir), { force: true });
  });

  // The whole loop: a limit is recorded, days pass with no delivery, then a run succeeds and the
  // recovery briefing OPENS with the outage line. Unit tests cover the formula and the render slot
  // separately; this is the only test that proves they meet on a real runCore result.
  test("a recovery run carries the outage line on its struct", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-cli-"));
    const okDir = join(dir, "ok");
    const cli = await fakeClaude(dir, okDir);
    const cfg = await cfgFor(cli, [{ label: "primary", configDir: okDir }]);

    // Three days ago someone got a briefing; two days ago the primary walled.
    await writeFile(join(stateDir, "last-run"), "2026-08-21");
    await writeFile(accountStatePath(stateDir), JSON.stringify({
      accounts: {}, lastLimit: { label: "primary", at: "2026-08-22T07:20:00-07:00" },
    }));

    const r = await runCore(cfg, deps);           // NOW = 2026-08-24, and the account is usable again

    expect(r.struct.outage).toEqual({ missedDays: 2, label: "primary" });
    expect(renderBriefing(r.struct).split("\n").slice(0, 4).join("\n")).toContain("No briefing for 2 days");
    await rm(dir, { recursive: true, force: true });
    await rm(accountStatePath(stateDir), { force: true });
    await rm(join(stateDir, "last-run"), { force: true });
  });

  test("a single-account machine (no `accounts` configured) still detects, marks and skips quietly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-cli-"));
    const cli = await fakeClaude(dir, join(dir, "ok"));        // empty CLAUDE_CONFIG_DIR is not okDir ⇒ limits
    const cfg = await cfgFor(cli, undefined);

    const r = await runCore(cfg, deps);

    expect(r.skipReason).toBe("limited");
    const st = await loadAccountState(stateDir);
    expect(st.accounts.default).toBeDefined();       // the synthesised implicit account
    expect((await spawns(dir))[0]).toBe("");         // no CLAUDE_CONFIG_DIR was set — byte-identical spawn
    // One implicit account and it is walled, so "no other account is available" is the true sentence.
    expect(r.limited?.exhausted).toBe(true);
    await rm(dir, { recursive: true, force: true });
    await rm(accountStatePath(stateDir), { force: true });
  });
});

// ── THE CALL SITE, not the helper.
//
// Extracting `limitedSkipMessage` made the WORDING testable and left the WIRING untested: a reviewer
// restored the original hardcoded "no other account is available" literal at the call site and the whole
// suite stayed green, as did deleting the provenance line outright. Both defects live in `run()`, so
// both have to be observed through `run()`. These drive the real shell — real config load, real
// hardenedProvider, real fake-CLI spawn — and read the stderr it actually emits.
describe("run() — the shell's own output on the failover path", () => {
  let cfgHome = "", prevCfgHome: string | undefined;

  /** Point loadConfig() at a temp tree (configPath() reads XDG_CONFIG_HOME) and capture stderr. */
  async function withShell(accounts: unknown, cli: string, fn: (err: string[]) => Promise<void>) {
    prevCfgHome = process.env.XDG_CONFIG_HOME;
    cfgHome = await mkdtemp(join(tmpdir(), "fake-cfg-"));
    await mkdir(join(cfgHome, "daily-briefing"), { recursive: true });
    await writeFile(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify({
      repos: [repo],
      provider: { cli, argv: [], promptVia: "stdin", timeoutMs: 30_000, accounts },
    }));
    process.env.XDG_CONFIG_HOME = cfgHome;
    // ONE array for BOTH streams, in call order — not two. The launchd plist points StandardOutPath and
    // StandardErrorPath at the same briefing.log, so their relative ORDER is a real, assertable property
    // of the log the audit judge later reads; captured separately it is not expressible at all.
    const err: string[] = [];
    const realErr = console.error, realLog = console.log;
    console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
    console.log = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
    try { await fn(err); } finally {
      console.error = realErr; console.log = realLog;
      if (prevCfgHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevCfgHome;
      await rm(cfgHome, { recursive: true, force: true });
      await rm(accountStatePath(stateDir), { force: true });
      await rm(join(stateDir, "last-run"), { force: true });
    }
  }

  test("a limited tick with a fallback left does NOT claim there is no other account", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-cli-"));
    const limitedDir = join(dir, "limited"), okDir = join(dir, "ok");
    const cli = await fakeClaude(dir, okDir);

    await withShell([{ label: "primary", configDir: limitedDir }, { label: "fallback", configDir: okDir }], cli, async (err) => {
      const code = await run(true, deps);
      expect(code).toBe(0);                                   // a wall is a known outage, not an error
      const line = err.find((l) => l.includes("is at its usage limit"));
      expect(line).toBeDefined();
      expect(line).toContain('account "primary"');
      expect(line).toContain("the next tick will use another account");
      expect(line).not.toContain("no other account is available");   // the defect, at its call site
    });
    await rm(dir, { recursive: true, force: true });
  });

  test("…and once nothing is left, it says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-cli-"));
    const cli = await fakeClaude(dir, join(dir, "ok"));
    await withShell([{ label: "primary", configDir: join(dir, "a") }, { label: "fallback", configDir: join(dir, "b") }], cli, async (err) => {
      await run(true, deps);
      await run(true, deps);
      expect(err.some((l) => l.includes("no other account is available"))).toBe(true);
    });
    await rm(dir, { recursive: true, force: true });
  });

  test("a delivering tick names the account that produced the briefing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-cli-"));
    const limitedDir = join(dir, "limited"), okDir = join(dir, "ok");
    const cli = await fakeClaude(dir, okDir);

    await withShell([{ label: "primary", configDir: limitedDir }, { label: "fallback", configDir: okDir }], cli, async (err) => {
      await run(true, deps);                                  // walls the primary
      err.length = 0;
      await run(true, deps);                                  // delivers via the fallback
      expect(err.some((l) => l === 'briefing generated by account "fallback"')).toBe(true);
    });
    await rm(dir, { recursive: true, force: true });
  });

  // The common machine. A new log line every morning for a user who configured nothing would be a
  // regression in its own right, so absence is asserted, not assumed.
  test("a machine with no accounts configured gains NO provenance line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-cli-"));
    const cli = await fakeClaude(dir, "");                    // empty CLAUDE_CONFIG_DIR ⇒ this one delivers
    await withShell(undefined, cli, async (err) => {
      await run(true, deps);
      expect(err.some((l) => l.includes("briefing generated by account"))).toBe(false);
    });
    await rm(dir, { recursive: true, force: true });
  });

  // `resolveAccounts([])` ACCEPTS an empty array with no warning, and effectiveAccounts synthesises
  // "default" from it — so a truthy `acc.accounts` test logs `account "default"` every morning to
  // someone who emptied the list precisely to turn the feature off. Same class as the line above, but
  // reachable only through a config shape no other test writes.
  test("an EMPTY accounts list is still no-provenance, not a synthesised \"default\"", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-cli-"));
    const cli = await fakeClaude(dir, "");
    await withShell([], cli, async (err) => {
      await run(true, deps);
      expect(err.some((l) => l.includes("briefing generated by account"))).toBe(false);
    });
    await rm(dir, { recursive: true, force: true });
  });

  // The ORDER is the whole point of where the line sits: stdout and stderr land in one briefing.log,
  // and audit's lastBriefing() slices from the last "☀️ … briefing —" header to EOF. A provenance line
  // after the header is fed to the judge as part of the briefing it grades.
  test("provenance is emitted BEFORE the briefing header, so audit never grades it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-cli-"));
    const limitedDir = join(dir, "limited"), okDir = join(dir, "ok");
    const cli = await fakeClaude(dir, okDir);
    await withShell([{ label: "primary", configDir: limitedDir }, { label: "fallback", configDir: okDir }], cli, async (err) => {
      await run(true, deps);                                  // walls the primary
      err.length = 0;
      await run(true, deps);                                  // delivers
      const prov = err.findIndex((l) => l.includes("briefing generated by account"));
      const header = err.findIndex((l) => l.includes("Daily briefing"));
      expect(prov).toBeGreaterThanOrEqual(0);
      expect(header).toBeGreaterThanOrEqual(0);
      expect(prov).toBeLessThan(header);
    });
    await rm(dir, { recursive: true, force: true });
  });

  // An account LABEL is arbitrary hand-edited config text that reaches a terminal and briefing.log.
  test("control bytes in an account label are stripped from the provenance line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-cli-"));
    const okDir = join(dir, "ok");
    const cli = await fakeClaude(dir, okDir);
    await withShell([{ label: "fall\u001b[31mback", configDir: okDir }], cli, async (err) => {
      await run(true, deps);
      const line = err.find((l) => l.includes("briefing generated by account"));
      expect(line).toBeDefined();
      expect(line).not.toContain("\u001b");
    });
    await rm(dir, { recursive: true, force: true });
  });
});
