import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepo, branchCommit, mergeBranchWith } from "./fixtures/build-repo";
import { run, blockedDelivery, preflightRepos, limitedSkipMessage } from "../src/main";
import { waitForNetwork } from "../src/net";
import { alreadyRanToday, checkRanToday, latestBriefingPath, archivedBriefingPath, markerPath, localDateStr, readLastRunDate } from "../src/marker";
import { ProviderError, type Provider } from "../src/types";
import { REDACTION } from "../src/transcripts/credentials";

const yesterdayISO = () => new Date(Date.now() - 864e5).toISOString();

// Shared module-scope consts + fixtures — declared ONCE here (I5 Step 1c); I6/I7/I8 REUSE these,
// they must NOT be re-declared (tsc "cannot redeclare").
const RAW = "## RESUME\n- [r] resume x\n## RECAP\n- [r] did y | evidence: abc123\n## SUGGESTIONS\n- z"; // parseable provider output
const BEFORE_FLOOR = () => new Date(2026, 6, 16, 7, 19); // before a 07:20 floor
const AFTER_FLOOR  = () => new Date(2026, 6, 16, 9, 0);  // past a 07:20 floor
const PROV = { cli: "claude", argv: ["-p"], promptVia: "stdin" as const };
// Shared repo fixtures — declared ONCE (top-level await is fine; tsconfig targets esnext). Reused by I6/I7/I8.
const repoWithTodayCommit  = await buildRepo([{ file: "t.txt", content: "t", isoDate: new Date().toISOString() }]); // resumptionSignals makes activities>0 → reaches the provider path
const WINDOW_ACTIVITY_REPO = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);           // a lookback-window commit
const QUIET_DAY_REPO = "/definitely/not/a/repo";  // not-a-repo → no activity, NOT "inaccessible" → the quiet-day path (same pattern as the existing no-activity test)

// Hermetic + deterministic default wrapper around run() (test-hardening, review follow-up): any
// run() that reaches the network gate without an injected netProbe falls through to the real
// defaultNetProbe → live TCP to 1.1.1.1:443/8.8.8.8:443 (hangs offline); any force=false run that
// expects delivery but doesn't pin `now` is wall-clock-dependent on the 07:20 floor. Route every
// run() call through this so both are pinned by default, while any test that needs to exercise the
// floor or network gate itself can still override via `deps` (spread last, so it wins).
function runT(force: boolean, deps: Parameters<typeof run>[1] = {}) {
  return run(force, { now: AFTER_FLOOR, netProbe: async () => true, netGraceMs: 30, netPollMs: 10, ...deps });
}

function fakeProvider() {
  let calls = 0;
  const provider: Provider = {
    async generate() {
      calls++;
      return "## RESUME\n- [r] resume here\n## RECAP\n- [r] did x | evidence: abc123\n## SUGGESTIONS\n- do y";
    },
  };
  return { provider, calls: () => calls };
}

function withEnv(cfgObj?: unknown): () => void {
  const cfgHome = mkdtempSync(join(tmpdir(), "dba-cfg-"));
  const stateDir = mkdtempSync(join(tmpdir(), "dba-state-"));
  mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
  if (cfgObj !== undefined) writeFileSync(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify(cfgObj));
  const prevXdg = process.env.XDG_CONFIG_HOME, prevState = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.XDG_CONFIG_HOME = cfgHome;
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
  return () => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prevState;
  };
}

function captureConsole() {
  const out: string[] = [], err: string[] = [];
  const oLog = console.log, oErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  return { out, err, restore: () => { console.log = oLog; console.error = oErr; } };
}

test("blockedDelivery: zero activity + any inaccessible resolved repo (tcc OR ordinary unreadable) → true; not-a-repo or any activity → false", () => {
  const issue = (kind: "tcc-denied" | "unreadable" | "not-a-repo" | "not-found") => ({ path: "/r", kind });
  expect(blockedDelivery(0, [issue("tcc-denied")])).toBe(true);
  expect(blockedDelivery(0, [issue("unreadable")])).toBe(true);  // non-TCC perms block too (must not stamp)
  expect(blockedDelivery(0, [issue("not-a-repo")])).toBe(false); // a genuinely-absent repo is not a block
  expect(blockedDelivery(0, [issue("not-found")])).toBe(false);  // a typo'd path doesn't block (would loop forever)
  expect(blockedDelivery(1, [issue("tcc-denied")])).toBe(false); // any activity → we deliver + warn
  expect(blockedDelivery(0, [])).toBe(false);                    // genuine quiet day
});

test("preflightRepos flags a TCC-blocked configured repo (init would report it up front)", async () => {
  const blocked = "/Users/me/Desktop/repo";
  const cfg = { repos: [blocked], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  const issues = await preflightRepos(cfg, {
    platform: "darwin", protectedRoots: ["/Users/me/Desktop"],
    probe: async () => ({ code: "EPERM" } as NodeJS.ErrnoException),
  });
  expect(issues.some((i) => i.kind === "tcc-denied" && i.path === blocked)).toBe(true);
});

test("preflightRepos reports nothing when the configured repos are readable", async () => {
  const good = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cfg = { repos: [good], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  const issues = await preflightRepos(cfg);
  expect(issues.length).toBe(0);
});

test("preflightRepos surfaces a blocked discoverRoot even when explicit repos are configured (mixed case)", async () => {
  const good = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const blockedRoot = mkdtempSync(join(tmpdir(), "dba-blkroot-"));
  chmodSync(blockedRoot, 0o000);
  const cfg = { repos: [good], discoverRoots: [blockedRoot], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  try {
    const issues = await preflightRepos(cfg);
    expect(issues.some((i) => i.path === blockedRoot)).toBe(true); // blocked root surfaced despite explicit repos
  } finally {
    chmodSync(blockedRoot, 0o755);
  }
});

test("run() prints repo warnings to stderr and still succeeds on a good repo", async () => {
  const good = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cleanup = withEnv({ repos: [good, "/definitely/not/a/repo"], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  try {
    const code = await runT(true, { provider: fakeProvider().provider });
    expect(code).toBe(0);
    expect(cap.err.some((l) => l.includes("/definitely/not/a/repo"))).toBe(true);
    // the clean overwritten copy is written on success (the file the user/audit read)
    expect(await Bun.file(latestBriefingPath()).text()).toContain("briefing —");
  } finally { cap.restore(); cleanup(); }
});

test("run() strips control bytes from a git-derived warning before printing to stderr [Tier-5]", async () => {
  // A repo PATH can legally contain ANSI/control bytes; its warning reaches the terminal via the
  // non-render console.error path (main.ts), which must sanitize like the render boundary does.
  const good = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const evil = "/definitely/not/a/repo-\x1b]0;pwned\x07-x";
  const cleanup = withEnv({ repos: [good, evil], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  try {
    await runT(true, { provider: fakeProvider().provider });
    const allErr = cap.err.join("\n");
    expect(allErr.includes("\x1b")).toBe(false); // escape neutralized
    expect(allErr.includes("\x07")).toBe(false);
    expect(allErr).toContain("]0;pwned");        // inert remainder still surfaced (the path is shown)
  } finally { cap.restore(); cleanup(); }
});

test("run() rotates an oversized launchd log at startup (wiring for rotateLogIfLarge) [Tier-5]", async () => {
  const good = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cleanup = withEnv({ repos: [good], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const stateDir = process.env.DAILY_BRIEFING_STATE_DIR!;
  const log = join(stateDir, "briefing.log");
  writeFileSync(log, Buffer.alloc(5_000_001, 0x78)); // just over the 5 MB default cap
  const cap = captureConsole();
  try {
    await runT(true, { provider: fakeProvider().provider });
    expect(Bun.file(log).size).toBe(0);                     // truncated in place at run() start
    expect(await Bun.file(log + ".1").exists()).toBe(true); // prior content preserved in one generation
  } finally { cap.restore(); cleanup(); }
});

test("run() with ALL repos TCC-blocked does not stamp, returns non-zero, never calls the provider", async () => {
  const blocked = "/Users/me/Desktop/only-repo";
  const cleanup = withEnv({ repos: [blocked], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  const fp = fakeProvider();
  try {
    const code = await runT(true, {
      provider: fp.provider,
      guard: { platform: "darwin", protectedRoots: ["/Users/me/Desktop"] },
      probe: async () => ({ code: "EPERM" } as NodeJS.ErrnoException),
    });
    expect(code).not.toBe(0);
    expect(fp.calls()).toBe(0);
    expect(await alreadyRanToday()).toBe(false); // NOT stamped → retryable
    expect(await Bun.file(latestBriefingPath()).exists()).toBe(false); // failure path must NOT overwrite the last good briefing-latest.md
  } finally { cap.restore(); cleanup(); }
});

test("run() delivers AND stamps when one repo is blocked but another has activity (partial block is not a delivery failure)", async () => {
  const good = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const blocked = "/Users/me/Desktop/blocked";
  const cleanup = withEnv({ repos: [blocked, good], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  const fp = fakeProvider();
  try {
    const code = await runT(true, {
      provider: fp.provider,
      guard: { platform: "darwin", protectedRoots: ["/Users/me/Desktop"] },
      probe: async (repo) => (repo === blocked ? ({ code: "EPERM" } as NodeJS.ErrnoException) : null),
    });
    expect(code).toBe(0);                      // delivered
    expect(fp.calls()).toBe(1);                // provider ran
    expect(await alreadyRanToday()).toBe(true); // stamped — a partial block with real activity is a success
    expect(cap.err.some((l) => l.includes(blocked) && /Full Disk Access|Files & Folders/.test(l))).toBe(true); // but warned
  } finally { cap.restore(); cleanup(); }
});

test("run() renders + stamps + writes a Today-so-far section from a readable repo's today commits even when another repo is blocked (review #4 today-flow)", async () => {
  // Sole readable repo's commit is dated NOW → it lands in `today` (excluded from the yesterday window).
  // NB: that repo also contributes an `On branch …` resumption signal to `activities`, so the window is
  // NOT empty and the provider runs — the `blockedDelivery && today.length===0` guard is defensive only
  // (a readable repo with today's commits can't leave activities empty). This pins the reachable path:
  // the deterministic today section survives a partial block and reaches the rendered/written briefing.
  const todayRepo = await buildRepo([{ file: "t.txt", content: "t", isoDate: new Date().toISOString() }]);
  const blocked = "/Users/me/Desktop/blocked";
  const cleanup = withEnv({ repos: [blocked, todayRepo], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  const fp = fakeProvider();
  try {
    const code = await runT(true, {
      provider: fp.provider,
      guard: { platform: "darwin", protectedRoots: ["/Users/me/Desktop"] },
      probe: async (repo) => (repo === blocked ? ({ code: "EPERM" } as NodeJS.ErrnoException) : null),
    });
    expect(code).toBe(0);                          // partial block is not a delivery failure
    expect(await alreadyRanToday()).toBe(true);    // stamped: real content was delivered
    const latest = await Bun.file(latestBriefingPath()).text();
    expect(latest).toContain("Today so far");      // deterministic today section rendered + written
  } finally { cap.restore(); cleanup(); }
});

test("run() on a soft-parse failure (real window activity, unparseable provider output) returns non-zero, does NOT stamp, and does NOT overwrite briefing-latest.md (review #4)", async () => {
  const good = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cleanup = withEnv({ repos: [good], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  let calls = 0;
  const junkProvider: Provider = { async generate() { calls++; return "totally unparseable output — no sections here"; } };
  try {
    const code = await runT(true, { provider: junkProvider });
    expect(code).not.toBe(0);
    expect(calls).toBe(1);                                          // provider WAS called (real activity)
    expect(await alreadyRanToday()).toBe(false);                   // soft-parse failure is retryable, not stamped
    expect(await Bun.file(latestBriefingPath()).exists()).toBe(false); // and the last good latest is left untouched
  } finally { cap.restore(); cleanup(); }
});

test("run() with the sole repo blocked by ordinary EACCES (non-TCC) also does not stamp — retryable, provider not called", async () => {
  const blocked = "/some/eacces/repo";
  const cleanup = withEnv({ repos: [blocked], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  const fp = fakeProvider();
  try {
    const code = await runT(true, { provider: fp.provider, probe: async () => ({ code: "EACCES" } as NodeJS.ErrnoException) });
    expect(code).not.toBe(0);
    expect(fp.calls()).toBe(0);
    expect(await alreadyRanToday()).toBe(false);
  } finally { cap.restore(); cleanup(); }
});

test("run() on a no-activity day prints an honest briefing, skips the provider, and stamps (quiet day is not a failure)", async () => {
  const cleanup = withEnv({ repos: ["/definitely/not/a/repo"], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  const fp = fakeProvider();
  try {
    const code = await runT(true, { provider: fp.provider });
    expect(code).toBe(0);
    expect(fp.calls()).toBe(0);                                              // provider skipped
    expect(cap.out.join("\n").toLowerCase()).toContain("no commits in the window"); // honest empty render
    expect(await alreadyRanToday()).toBe(true);
  } finally { cap.restore(); cleanup(); }
});

test("run() twice the same day produces exactly one briefing (second guarded by the marker)", async () => {
  const good = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cleanup = withEnv({ repos: [good], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  const fp = fakeProvider();
  try {
    const c1 = await runT(false, { provider: fp.provider });
    const c2 = await runT(false, { provider: fp.provider });
    expect(c1).toBe(0);
    expect(c2).toBe(0);
    expect(fp.calls()).toBe(1);
  } finally { cap.restore(); cleanup(); }
});

test("run() retries a transiently-failing provider and succeeds (wake-before-wifi morning)", async () => {
  const { ProviderError } = await import("../src/types");
  const repo = await buildRepo([{ file: "w.txt", content: "w", isoDate: yesterdayISO() }]);
  const cleanup = withEnv({ repos: [repo], provider: { cli: "true", argv: [], promptVia: "stdin" } });
  const cap = captureConsole();
  const slept: number[] = [];
  let calls = 0;
  const flaky: Provider = {
    async generate() {
      calls++;
      if (calls < 3) throw new ProviderError("nonzero-exit", "claude exited 1: network is down");
      return "## RESUME\n- [r] resume\n## RECAP\n- [r] did x | evidence: abc123\n## SUGGESTIONS\n- y";
    },
  };
  try {
    const code = await runT(true, { provider: flaky, retryDelaysMs: [5, 5], sleep: async (ms) => { slept.push(ms); } });
    expect(code).toBe(0);
    expect(calls).toBe(3);
    expect(slept).toEqual([5, 5]);
  } finally { cap.restore(); cleanup(); }
});

test("run() does NOT retry a missing-binary provider failure (permanent, not transient)", async () => {
  const { ProviderError } = await import("../src/types");
  const repo = await buildRepo([{ file: "w.txt", content: "w", isoDate: yesterdayISO() }]);
  const cleanup = withEnv({ repos: [repo], provider: { cli: "true", argv: [], promptVia: "stdin" } });
  const cap = captureConsole();
  let calls = 0;
  const missing: Provider = {
    async generate() { calls++; throw new ProviderError("missing-binary", "CLI not found"); },
  };
  try {
    const code = await runT(true, { provider: missing, retryDelaysMs: [5, 5], sleep: async () => {} });
    expect(code).toBe(1);
    expect(calls).toBe(1);
    expect(await alreadyRanToday()).toBe(false); // still retryable tomorrow / by hand
  } finally { cap.restore(); cleanup(); }
});

test("run() still prints pipeline warnings on a ProviderError (T1: warnings must not be dropped on provider failure)", async () => {
  const { ProviderError } = await import("../src/types");
  const good = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const blocked = "/Users/me/Desktop/blocked"; // produces a non-empty discIssues warning
  const cleanup = withEnv({ repos: [blocked, good], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  const failing: Provider = { async generate() { throw new ProviderError("nonzero-exit", "boom"); } };
  try {
    const code = await run(true, {
      provider: failing,
      guard: { platform: "darwin", protectedRoots: ["/Users/me/Desktop"] },
      probe: async (repo) => (repo === blocked ? ({ code: "EPERM" } as NodeJS.ErrnoException) : null),
      retryDelaysMs: [], // fail immediately, no retry wait
    });
    expect(code).toBe(1);
    // the pipeline warning for the blocked repo must still surface, not just the provider-failed line
    expect(cap.err.some((l) => l.includes(blocked) && /Full Disk Access|Files & Folders/.test(l))).toBe(true);
    expect(cap.err.some((l) => l.includes("Briefing provider failed"))).toBe(true);
  } finally { cap.restore(); cleanup(); }
});

// ---- render-time freshness re-check (audit 2026-07-10 #1: volatile working-tree claims) ----

test("run() appends a drift warning when a repo's uncommitted state changes during generation (vault auto-commit race)", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  writeFileSync(join(repo, "dirty.txt"), "wip"); // uncommitted at extraction time
  const cleanup = withEnv({ repos: [repo], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  try {
    const code = await runT(true, {
      provider: fakeProvider().provider,
      statusNow: async () => "",              // by render time the repo is clean (auto-committed)
    });
    expect(code).toBe(0);
    const latest = await Bun.file(latestBriefingPath()).text();
    expect(latest).toContain("working-tree changed while generating");
    expect(latest).toContain("dirty.txt");    // names what the briefing believed
  } finally { cap.restore(); cleanup(); }
});

test("run() adds NO drift warning when the working tree is unchanged at render time", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  writeFileSync(join(repo, "dirty.txt"), "wip");
  const cleanup = withEnv({ repos: [repo], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  try {
    const code = await runT(true, { provider: fakeProvider().provider }); // default statusNow re-reads git: same state
    expect(code).toBe(0);
    const latest = await Bun.file(latestBriefingPath()).text();
    expect(latest).not.toContain("working-tree changed while generating");
    expect(latest).toContain("state as of");  // resume header carries the as-of stamp
  } finally { cap.restore(); cleanup(); }
});

test("run() propagates drift INTO the suggestion it invalidates — not just the footer (day-20)", async () => {
  // ⚠ THE WIRING PIN. `test/core.drift-propagation.test.ts` covers `annotateStaleSuggestions` as a
  // unit, and every one of its 11 tests stays GREEN if the call site in `core.ts` is deleted — the
  // "exists but nothing drives it" shape that has been this codebase's single most common defect.
  // Only an end-to-end run through `runCore` can catch that, so this is the test that makes the fix
  // real rather than merely present.
  //
  // Reproduces the delivered 2026-08-04 briefing exactly: the footer said the tree was now clean
  // while SUGGESTIONS still told the reader to commit those same files.
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  writeFileSync(join(repo, "dirty.txt"), "wip");
  const cleanup = withEnv({ repos: [repo], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  try {
    const code = await runT(true, {
      provider: { async generate() {
        return "## RESUME\n- [r] resume here\n## RECAP\n- [r] did x | evidence: abc123\n" +
               "## SUGGESTIONS\n- Commit the pending work in dirty.txt\n- Ship the release";
      } } as Provider,
      statusNow: async () => "",             // clean by render time — dirty.txt was auto-committed
    });
    expect(code).toBe(0);
    const latest = await Bun.file(latestBriefingPath()).text();
    expect(latest).toContain("working-tree changed while generating");   // footer still there…
    expect(latest).toMatch(/Commit the pending work in dirty\.txt.*no longer in the working tree/);
    // …and the UNRELATED suggestion is untouched, so this cannot pass by blanket-annotating.
    expect(latest).toMatch(/Ship the release(?!.*no longer in the working tree)/);
  } finally { cap.restore(); cleanup(); }
});

// ---- network gate (audit 2026-07-10 #2: dark-wake timeout — retries burned before wifi was up) ----

test("run() waits for the network before calling the provider (probe: down, down, up)", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cleanup = withEnv({ repos: [repo], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  const fp = fakeProvider();
  const slept: number[] = [];
  let probes = 0;
  try {
    const code = await runT(true, {
      provider: fp.provider,
      netProbe: async () => ++probes >= 3,
      netGraceMs: 1000, netPollMs: 10,
      sleep: async (ms) => { slept.push(ms); },
    });
    expect(code).toBe(0);
    expect(probes).toBe(3);          // polled until the network came up
    expect(fp.calls()).toBe(1);      // then the provider ran
    expect(slept.length).toBe(2);    // one sleep per down-probe
  } finally { cap.restore(); cleanup(); }
});

test("run() proceeds to the provider (which still retries) when the network never comes up within the grace", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cleanup = withEnv({ repos: [repo], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  const fp = fakeProvider();
  try {
    const code = await runT(true, {
      provider: fp.provider,
      netProbe: async () => false,
      netGraceMs: 30, netPollMs: 10,
      sleep: async () => {},
    });
    expect(code).toBe(0);            // provider succeeded anyway (gate must not fail the run)
    expect(fp.calls()).toBe(1);
    expect(cap.err.some((l) => l.includes("no network"))).toBe(true); // but it said so
  } finally { cap.restore(); cleanup(); }
});

test("waitForNetwork bounds TOTAL elapsed time (probe latency counts toward the grace budget)", async () => {
  let probes = 0;
  const slowProbe = async () => { await new Promise((r) => setTimeout(r, 40)); probes++; return false; }; // 40ms/probe
  const start = Date.now();
  const res = await waitForNetwork(slowProbe, (ms) => new Promise((r) => setTimeout(r, ms)), 100, 20); // grace 100ms, poll 20ms
  expect(res.online).toBe(false);
  // Old code counted only sleeps → ~5 rounds × (40 probe + 20 sleep) ≈ 300ms. Elapsed-aware → ≲ ~160ms.
  expect(Date.now() - start).toBeLessThan(220);
});

// ---- Task 15: resolveUnits wired into run() — warnings merged, "Today so far" labeled by Unit.label ----

test("run(): a subprojects entry naming an unknown repo surfaces a warning", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cfg = { repos: [repo], subprojects: [{ repo: "/does/not/exist", roots: ["*"] }],
    provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  const restore = withEnv(cfg); const cap = captureConsole(); const { provider } = fakeProvider();
  try {
    await runT(true, { provider }); // add netProbe/guard deps as the existing full-run tests do, if the gate needs them
    expect(cap.err.join("\n")).toMatch(/not in the resolved repo set/i);
  } finally { cap.restore(); restore(); }
});

test("run(): a same-day-only sub-project commit renders in 'Today so far' with its sub-project label", async () => {
  const repo = await buildRepo([{ file: "packages/api/x.ts", content: "y", isoDate: new Date().toISOString() }]); // committed TODAY
  const cfg = { repos: [repo], subprojects: [{ repo, roots: ["packages/*"] }],
    provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  const restore = withEnv(cfg); const cap = captureConsole(); const { provider } = fakeProvider();
  try {
    await runT(true, { provider });
    expect(cap.out.join("\n")).toMatch(/\[api\]/); // Today-so-far label is the sub-project, not the repo basename
  } finally { cap.restore(); restore(); }
});

test("run(): the zero-activity early-return still surfaces a resolveUnits warning", async () => {
  // No repos → activities is empty → main.ts's `activities.length === 0` early-return fires. Its
  // BriefingStruct must still carry the merged warnings (render.ts renders b.warnings as "⚠ …").
  const cfg = { repos: [], subprojects: [{ repo: "/does/not/exist", roots: ["*"] }],
    provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  const restore = withEnv(cfg); const cap = captureConsole(); const { provider } = fakeProvider();
  try {
    await runT(true, { provider });
    expect([...cap.out, ...cap.err].join("\n")).toMatch(/not in the resolved repo set/i);
  } finally { cap.restore(); restore(); }
});

// ---- Task I5: morning-floor gate + !force-gated missing-config no-op ----

// (a) before the floor, a scheduled run no-ops — no provider, no stamp.
test("run() no-ops before the morning floor", async () => {
  const cleanup = withEnv({ morningTime: "07:20", repos: [repoWithTodayCommit], provider: PROV });
  let called = false;
  try {
    const code = await runT(false, { now: BEFORE_FLOOR, provider: { generate: async () => { called = true; return RAW; } } });
    expect(code).toBe(0);
    expect(called).toBe(false);
    expect(await alreadyRanToday()).toBe(false);
  } finally { cleanup(); }
});

// (b) --force bypasses the floor.
test("run(force=true) bypasses the floor", async () => {
  const cleanup = withEnv({ morningTime: "07:20", repos: [repoWithTodayCommit], provider: PROV });
  let called = false;
  try {
    await runT(true, { now: BEFORE_FLOOR, provider: { generate: async () => { called = true; return RAW; } } });
    expect(called).toBe(true);
  } finally { cleanup(); }
});

// (b2) an interactive run (a human at a TTY) is floor-exempt — it delivers before the floor, whereas
// the scheduled (non-interactive) agent no-ops (test (a)). The floor only paces the scheduled agent.
test("run() interactive is floor-exempt: delivers + stamps before the morning floor", async () => {
  const cleanup = withEnv({ morningTime: "07:20", repos: [repoWithTodayCommit], provider: PROV });
  let called = false;
  try {
    const code = await runT(false, { now: BEFORE_FLOOR, interactive: true, provider: { generate: async () => { called = true; return RAW; } } });
    expect(code).toBe(0);
    expect(called).toBe(true);                  // reached the provider (floor bypassed for the human)
    expect(await alreadyRanToday()).toBe(true); // delivered → day stamped
  } finally { cleanup(); }
});

// (b3) interactive + already-ran-today → a human gets a one-liner, not the scheduled agent's silent exit.
test("run() interactive + already ran today: prints a one-liner and does not regenerate", async () => {
  const cleanup = withEnv({ morningTime: "07:20", repos: [repoWithTodayCommit], provider: PROV });
  const cap = captureConsole();
  let called = false;
  try {
    await Bun.write(markerPath(), localDateStr(new Date())); // today's marker → alreadyRanToday() true
    const code = await runT(false, { interactive: true, provider: { generate: async () => { called = true; return RAW; } } });
    expect(code).toBe(0);
    expect(called).toBe(false);                              // did not regenerate
    expect(cap.err.join("\n")).toMatch(/already ran today/i);
  } finally { cap.restore(); cleanup(); }
});

// (c) missing config, scheduled + FRESH (no marker) → silent exit 0.
test("run() missing config, fresh install: silent no-op exit 0", async () => {
  const cleanup = withEnv();           // no cfgObj → no config.json → loadConfig throws no-config
  const cap = captureConsole();
  try {
    const code = await runT(false, { now: AFTER_FLOOR });
    expect(code).toBe(0);
    expect(cap.err.join("\n")).not.toMatch(/config/i);
  } finally { cap.restore(); cleanup(); }
});

// (d) missing config, scheduled + a marker EXISTS from a PAST day (config vanished after working)
//     → regression logged, exit 0. (Past date so alreadyRanToday() doesn't short-circuit.)
test("run() missing config, config vanished after working: logs regression, exit 0", async () => {
  const cleanup = withEnv();
  await Bun.write(markerPath(), "2020-01-01"); // markerExists() true, alreadyRanToday() false
  const cap = captureConsole();
  try {
    const code = await runT(false, { now: AFTER_FLOOR });
    expect(code).toBe(0);
    expect(cap.err.join("\n")).toMatch(/config move|ran before/i);
  } finally { cap.restore(); cleanup(); }
});

// (e) missing config, FORCED → message + exit 2.
test("run(force=true) missing config: message + exit 2", async () => {
  const cleanup = withEnv();
  const cap = captureConsole();
  try {
    const code = await runT(true, { now: AFTER_FLOOR });
    expect(code).toBe(2);
    expect(cap.err.join("\n")).toMatch(/init/i);
  } finally { cap.restore(); cleanup(); }
});

// ---- Task I6: network step — scheduled-skip-with-log / forced-proceed; empty-hosts skip ----
// RAW / AFTER_FLOOR / PROV / repoWithTodayCommit are declared once in I5 Step 1c — reuse, do NOT re-declare.

// scheduled + offline → skip: exit 0, no stamp, logs the distinguishing skip line.
test("run(force=false) with no network → skip: exit 0, no stamp, logs skip", async () => {
  const cleanup = withEnv({ morningTime: "07:20", repos: [repoWithTodayCommit], provider: PROV });
  const cap = captureConsole();
  try {
    const code = await runT(false, { now: AFTER_FLOOR, provider: { generate: async () => RAW }, netProbe: async () => false, netGraceMs: 30, netPollMs: 10 });
    expect(code).toBe(0);
    expect(await alreadyRanToday()).toBe(false);       // no stamp → retry next tick
    expect(cap.err.join("\n")).toMatch(/no network/i); // observable (not silent)
  } finally { cap.restore(); cleanup(); }
});

// forced + offline → proceeds to the provider (preserves the existing test 308 "proceed anyway").
test("run(force=true) with no network still calls the provider", async () => {
  const cleanup = withEnv({ repos: [repoWithTodayCommit], provider: PROV });
  let called = false;
  try {
    await runT(true, { now: AFTER_FLOOR, provider: { generate: async () => { called = true; return RAW; } }, netProbe: async () => false, netGraceMs: 30, netPollMs: 10 });
    expect(called).toBe(true);
  } finally { cleanup(); }
});

// networkProbeHosts: [] → the DEFAULT probe skips the gate. NO netProbe injected → exercises the REAL
// cfg→defaultNetProbe→tcpProbe([]) wiring (the §5 skip switch, otherwise untested).
test("run(force=false) with networkProbeHosts: [] skips the gate and delivers", async () => {
  const cleanup = withEnv({ morningTime: "07:20", networkProbeHosts: [], repos: [repoWithTodayCommit], provider: PROV });
  let called = false;
  try {
    // netProbe deliberately NOT injected (exercises the real defaultNetProbe→tcpProbe([]) path) — so this
    // call goes through `run` directly, NOT `runT` (whose default netProbe would mask this path). The short
    // netGraceMs/netPollMs only bound the PRE-I6 transitional run (old httpProbe would live-fetch for ~25s);
    // post-I6, tcpProbe([]) returns true on the first probe regardless, so the assertion is unaffected.
    const code = await run(false, { now: AFTER_FLOOR, netGraceMs: 30, netPollMs: 10, provider: { generate: async () => { called = true; return RAW; } } });
    expect(called).toBe(true);   // empty hosts → tcpProbe returns true → provider attempted immediately
    expect(code).toBe(0);
  } finally { cleanup(); }
});

// ---- Task I7: guard both stampToday sites (crash → fail-closed exit 1) ----
// force=true → floor bypassed, no clock needed. Make the state dir unwritable so stampToday() throws
// (chmodSync 0o000 — the file's existing blocked-root idiom); chmod back in finally.
// QUIET_DAY_REPO / WINDOW_ACTIVITY_REPO / RAW are all declared once in I5 Step 1c — reuse them here.
test("run() returns 1 (no crash) when the marker write fails — quiet day", async () => {
  const cleanup = withEnv({ repos: [QUIET_DAY_REPO], provider: PROV });
  const stateDir = process.env.DAILY_BRIEFING_STATE_DIR!;
  chmodSync(stateDir, 0o000);
  try {
    expect(await runT(true, { provider: { generate: async () => RAW } })).toBe(1); // fail-closed, NOT a crash
  } finally { chmodSync(stateDir, 0o755); cleanup(); }
});
test("run() returns 1 (no crash) when the marker write fails — generated briefing", async () => {
  const cleanup = withEnv({ repos: [WINDOW_ACTIVITY_REPO], provider: PROV });
  const stateDir = process.env.DAILY_BRIEFING_STATE_DIR!;
  chmodSync(stateDir, 0o000);
  try {
    expect(await runT(true, { provider: { generate: async () => RAW }, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 })).toBe(1);
  } finally { chmodSync(stateDir, 0o755); cleanup(); }
});

// ---- Task I8: thread the morningTime warning into BriefingStruct.warnings ----
// RAW / WINDOW_ACTIVITY_REPO / PROV reused from I5/I7 — do NOT re-declare.
test("an invalid morningTime surfaces a warning in the generated briefing", async () => {
  const cleanup = withEnv({ morningTime: "7am", repos: [WINDOW_ACTIVITY_REPO], provider: PROV }); // "7am" invalid
  const cap = captureConsole();
  try {
    await runT(true, { provider: { generate: async () => RAW }, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 });  // force=true → past floor
    expect(cap.out.join("\n")).toMatch(/invalid morningTime/i);    // via render.ts's "⚠ " + warnings (stdout)
  } finally { cap.restore(); cleanup(); }
});

// ---- Fix 4: resolveProbeHosts wired into run() — malformed networkProbeHosts degrades gracefully ----

// A non-array networkProbeHosts (forgot the array brackets) must NOT crash run() — it must fall back
// to the defaults and thread a warning into the briefing, mirroring I8's morningTime pattern above.
test("a non-array networkProbeHosts does not crash run() and surfaces a warning in the briefing", async () => {
  const cleanup = withEnv({
    morningTime: "07:20", networkProbeHosts: { host: "1.1.1.1", port: 443 }, // forgot the array brackets
    repos: [WINDOW_ACTIVITY_REPO], provider: PROV,
  });
  const cap = captureConsole();
  try {
    const code = await runT(true, { provider: { generate: async () => RAW }, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 });
    expect(code).toBe(0); // delivered, not crashed
    expect(cap.out.join("\n")).toMatch(/networkProbeHosts must be an array/i);
  } finally { cap.restore(); cleanup(); }
});

// An all-invalid networkProbeHosts array (e.g. plain strings instead of {host,port}) must not silently
// burn the grace forever — resolveProbeHosts degrades it to the defaults and still delivers + warns.
// netProbe IS injected here (unlike the networkProbeHosts:[] test above) so this stays hermetic — the
// point under test is the resolveProbeHosts→warnings wiring, not the real TCP gate (already covered by
// net.test.ts + the existing empty-hosts integration test).
test("an all-invalid networkProbeHosts array does not silently stall delivery — degrades to defaults + warns", async () => {
  const cleanup = withEnv({
    morningTime: "07:20", networkProbeHosts: ["1.1.1.1:443"], // string, not {host,port} — all entries invalid
    repos: [WINDOW_ACTIVITY_REPO], provider: PROV,
  });
  const cap = captureConsole();
  try {
    const code = await runT(true, { provider: { generate: async () => RAW }, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 });
    expect(code).toBe(0);
    expect(cap.out.join("\n")).toMatch(/all networkProbeHosts entries invalid/i);
  } finally { cap.restore(); cleanup(); }
});

// ---- Tier-2 unification coverage: the "🔀 Merged #N" today-render through run()→runCore ----
// The review flagged that the merge-resumption render (mergedToday → today.push) had NO test through
// either pipeline. Now that run() delegates to runCore, this pins the render end-to-end.
test("run() renders a today PR-merge as a 🔀 Merged line in 'today so far'", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]); // a window commit → full render path
  await branchCommit(repo, "feat-x", "b.txt", new Date().toISOString());
  await mergeBranchWith(repo, "feat-x", "Merge pull request #7 from acme/feat-x", new Date().toISOString());
  const cleanup = withEnv({ morningTime: "07:20", repos: [repo], provider: PROV });
  const cap = captureConsole();
  try {
    const code = await runT(true, { provider: { generate: async () => RAW } }); // force → past floor
    expect(code).toBe(0);
    expect(cap.out.join("\n")).toContain("🔀 Merged #7 (feat-x)");
  } finally { cap.restore(); cleanup(); }
});

// Regression (PR #86 review): the net-gate diagnostic must SURVIVE a provider failure. Old inline
// run() printed it before the provider, so a network-caused failure still showed the reason; the
// runCore refactor initially dropped it (net returned only on success). Now attached to the error.
test("run() forced-offline then provider fails: still prints the 'calling anyway' net line, not just 'provider failed'", async () => {
  const cleanup = withEnv({ morningTime: "07:20", repos: [WINDOW_ACTIVITY_REPO], provider: PROV });
  const cap = captureConsole();
  try {
    const code = await run(true, { // force → past floor + proceeds through forced-offline to the provider
      now: AFTER_FLOOR,
      netProbe: async () => false, netGraceMs: 5, netPollMs: 5, // offline after a tiny grace
      provider: { generate: async () => { throw new ProviderError("nonzero-exit", "boom"); } },
      retryDelaysMs: [], sleep: async () => {},
    });
    expect(code).toBe(1);
    const err = cap.err.join("\n");
    expect(err).toContain("calling the provider anyway (forced run)"); // net diagnostic survived the failure
    expect(err).toContain("Briefing provider failed");
  } finally { cap.restore(); cleanup(); }
});

test("run() with a malformed config on disk → 'Config error' + exit 2 (distinct from the no-config path) [Tier-3 #13]", async () => {
  const cleanup = withEnv({ provider: { cli: "claude", argv: [], promptVia: "stdin" }, lookbackCapDays: "4" }); // invalid: string, not number
  const cap = captureConsole();
  try {
    const code = await runT(true, {});
    expect(code).toBe(2);
    expect(cap.err.join("\n")).toMatch(/config error/i);
  } finally { cap.restore(); cleanup(); }
});

test("run() RENDERS branch state into 'Where you left off' when off the default branch (day-21)", async () => {
  // ⚠ THE WIRING PIN. `test/core.branch-state.test.ts` covers `branchStateLines` as a unit and every
  // one of its 8 tests stays GREEN if the call site in `core.ts` or the render line is deleted — the
  // "exists but nothing drives it" shape that is this codebase's most common defect. Only an
  // end-to-end run catches that.
  //
  // Reproduces the day-21 failure: a repo on a non-default branch whose name the briefing never said.
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  await Bun.$`git -C ${repo} checkout -q -b chore/sign-live-policy`.quiet();
  const cleanup = withEnv({ repos: [repo], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  try {
    const code = await runT(true, { provider: fakeProvider().provider });
    expect(code).toBe(0);
    const latest = await Bun.file(latestBriefingPath()).text();
    // The branch is NAMED, and it sits inside "Where you left off" — above the resume bullets it
    // frames, not in a footer after them.
    expect(latest).toContain("chore/sign-live-policy");
    const section = latest.slice(latest.indexOf("▶ Where you left off"), latest.indexOf("▶ What you did"));
    expect(section).toContain("chore/sign-live-policy");
    // ⚠ POSITION, not just membership. `render.ts` declares the ordering load-bearing — branch state
    // is the frame the resume bullets are read in, and a correction placed after the thing it
    // corrects is read too late. A membership-only assertion is equally true with the line BELOW the
    // bullets: MEASURED, moving the push down left all 1020 tests green.
    const resumeBullet = section.indexOf("[", section.indexOf("chore/sign-live-policy") + 1);
    expect(section.indexOf("chore/sign-live-policy")).toBeLessThan(resumeBullet);
  } finally { cap.restore(); cleanup(); }
});

test("run() emits the morning floor beside the state stamp (day-23 wiring pin)", async () => {
  // ⚠ THE WIRING PIN. Every test in test/render.morning-floor.test.ts stays GREEN if core.ts never
  // sets `morningFloor` or parseBriefing never threads it — the render function would simply receive
  // undefined and fall back to the old shape. That is the "exists but nothing drives it" class this
  // codebase hits most, and it has three separate legs here: core computes it, parseBriefing carries
  // it through the model round-trip, render prints it.
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cleanup = withEnv({ repos: [repo], morningTime: "06:45",
    provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  try {
    expect(await runT(true, { provider: fakeProvider().provider })).toBe(0);
    const latest = await Bun.file(latestBriefingPath()).text();
    expect(latest).toContain("first wake past 06:45");   // the CONFIGURED floor, not the default
    expect(latest).toMatch(/first wake past 06:45 · state as of \d\d:\d\d/);
  } finally { cap.restore(); cleanup(); }
});

test("run() SKIPS a scheduled tick in darkwake — provider never called, day not stamped", async () => {
  // ⚠ THE WIRING PIN. Every test in test/power.test.ts stays GREEN if the gate in core.ts is deleted —
  // `isFullyAwake` would simply never be called. That is the "exists but nothing drives it" class this
  // codebase hits most. Only an end-to-end run catches it.
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cleanup = withEnv({ repos: [repo], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  try {
    const fp = fakeProvider();
    const code = await runT(false, {                       // scheduled, NOT forced
      provider: fp.provider,
      powerPlatform: "darwin",                              // see below — without this the probe is never consulted off macOS
      powerProbe: async () => ({ code: 0, out: "Current System Capabilities are: CPU Network " }),
    });
    expect(code).toBe(0);                                   // a skip is success, not failure
    expect(fp.calls()).toBe(0);                             // ⚠ the provider was never called
    expect(await alreadyRanToday()).toBe(false);            // ⚠ and the day is NOT stamped, so it retries
    expect(cap.err.some((l) => /darkwake/i.test(l))).toBe(true);
  } finally { cap.restore(); cleanup(); }
});

test("run() does NOT gate a FORCED run on darkwake — the user is present and asking", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cleanup = withEnv({ repos: [repo], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  try {
    const fp = fakeProvider();
    expect(await runT(true, {                               // forced
      provider: fp.provider,
      powerPlatform: "darwin",
      powerProbe: async () => ({ code: 0, out: "Current System Capabilities are: CPU Network " }),
    })).toBe(0);
    expect(fp.calls()).toBe(1);                             // proceeded anyway
  } finally { cap.restore(); cleanup(); }
});

test("run() proceeds normally when awake — the gate is not over-broad", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cleanup = withEnv({ repos: [repo], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  try {
    const fp = fakeProvider();
    expect(await runT(false, {
      provider: fp.provider,
      powerPlatform: "darwin",
      powerProbe: async () => ({ code: 0, out: "Current System Capabilities are: CPU Graphics Audio Network " }),
    })).toBe(0);
    expect(fp.calls()).toBe(1);
  } finally { cap.restore(); cleanup(); }
});

test("run() FAIL-OPENS off macOS — and this is what pins the platform WIRING on every platform", async () => {
  // ⚠ THE PLATFORM-INDEPENDENT WIRING PIN. The three tests above all force "darwin", so on a macOS
  // dev machine they pass whether or not `powerPlatform` is actually threaded through to
  // `isFullyAwake` — reverting core.ts to `isFullyAwake(undefined, …)` would still read
  // process.platform === "darwin" and they would stay green. Only a Linux runner caught that, which
  // is exactly how CI sat red for 7 merges (2026-08-09 → 2026-08-10) while the suite was green here.
  //
  // This one inverts the injection: a DARKWAKE probe plus platform "linux" must PROCEED, because
  // `isFullyAwake` fail-opens off macOS (power.ts:36). If the platform stops being threaded, the
  // default resolves to the host — darwin on this machine — the gate fires on the darkwake probe,
  // the run skips, and this fails HERE rather than only in CI.
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cleanup = withEnv({ repos: [repo], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  try {
    const fp = fakeProvider();
    expect(await runT(false, {
      provider: fp.provider,
      powerPlatform: "linux",
      powerProbe: async () => ({ code: 0, out: "Current System Capabilities are: CPU Network " }), // darkwake shape
    })).toBe(0);
    expect(fp.calls()).toBe(1);                             // proceeded: fail-open, gate never engaged
  } finally { cap.restore(); cleanup(); }
});

// ── Dated briefing archive (added 2026-08-14) ────────────────────────────────────────────────────
// The corpus `postcheck` calibration needed and did not have: `briefing-latest.md` is overwritten
// daily and `briefing.log` was reset by the 2026-08-13 crash, so on 2026-08-14 exactly TWO briefings
// existed anywhere on disk. The days 27-29 window was meant to yield three calibration points and
// yielded one, and no back catalogue could be re-scored at any price.
test("run() writes a DATED archive alongside briefing-latest.md, keyed on the run date", async () => {
  const good = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cleanup = withEnv({ repos: [good], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  try {
    expect(await runT(true, { provider: fakeProvider().provider })).toBe(0);
    const archived = archivedBriefingPath(localDateStr(new Date()));
    expect(await Bun.file(archived).text()).toContain("briefing —");
    // ⚠ Assert the LITERAL shape, not just "wherever the function points". Measured in review: with
    // the path computed only by calling the implementation, mutating the filename to a constant —
    // i.e. one file overwritten every day, the exact briefing-latest.md failure this feature exists
    // to fix — left the whole suite green, as did renaming the directory (which would also silently
    // decouple it from uninstall.sh's cleanup).
    expect(archived).toMatch(/[/\\]briefings[/\\]\d{4}-\d{2}-\d{2}\.md$/);
    // It must be a SEPARATE artifact, not a rename — the overwritten copy is what the user/audit read.
    expect(await Bun.file(latestBriefingPath()).exists()).toBe(true);
    expect(archived).not.toBe(latestBriefingPath());
  } finally { cap.restore(); cleanup(); }
});

// ⚠ Named for what it actually proves, after review caught the first name overclaiming. This run
// fails at the TCC guard, BEFORE the provider is called, so no briefing is ever rendered — it shows
// the archive is not written when there is nothing to archive, which is weaker than "an archive never
// outlives its briefing". The stronger invariant is genuinely violable and deliberately not claimed:
// the archive write sits above `stampToday`, so a marker failure leaves an archive for a day the tool
// treats as undelivered. That is accepted — the retry regenerates and overwrites it, and the archive
// is meant to record what was RENDERED.
test("run() writes no archive when the run fails before a briefing is ever generated", async () => {
  const cleanup = withEnv({ repos: ["/definitely/not/a/repo"], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  try {
    const fp = fakeProvider();
    const code = await runT(true, {
      provider: fp.provider,
      guard: { platform: "darwin", protectedRoots: ["/definitely"] },
      probe: async () => ({ code: "EPERM" } as NodeJS.ErrnoException),
    });
    expect(code).not.toBe(0);        // the delivery genuinely failed
    expect(fp.calls()).toBe(0);      // …before the provider ran, so there is no briefing to archive
    expect(await Bun.file(archivedBriefingPath(localDateStr(new Date()))).exists()).toBe(false);
  } finally { cap.restore(); cleanup(); }
});

// The line a usage-limited tick leaves in briefing.log — the ONLY one it leaves, so a false clause
// here misleads exactly when someone is reading the log to diagnose an outage. It shipped asserting
// "no other account is available" unconditionally, and the 2026-08-24 live failover test printed it
// on the tick that marked the primary while the fallback delivered two minutes later.
describe("limitedSkipMessage", () => {
  const base = { label: "primary", until: "2026-08-27T05:00:00.000Z", isProbe: false };

  test("a fallback remains ⇒ says the next tick will use it, and does NOT claim exhaustion", () => {
    const m = limitedSkipMessage({ ...base, exhausted: false });
    expect(m).toContain('account "primary" is at its usage limit until 2026-08-27T05:00:00.000Z');
    expect(m).toContain("the next tick will use another account");
    expect(m).not.toContain("no other account is available");
  });

  test("nothing left ⇒ says so", () => {
    expect(limitedSkipMessage({ ...base, exhausted: true })).toContain("no other account is available");
  });

  // A probe deadline is a one-hour guess; printing it as a reset claims knowledge the system lacks.
  // It also does not prove a usage LIMIT — recordAuthProbe writes a probe mark for a fallback whose
  // config dir was never logged into — so the cause must not be named either.
  test("a PROBE mark states neither a reset time nor a cause", () => {
    const m = limitedSkipMessage({ label: "fallback", until: "2026-08-24T18:00:00.000Z", isProbe: true, exhausted: true });
    expect(m).not.toContain("until");
    expect(m).not.toContain("usage limit");
    expect(m).toContain('account "fallback" is unavailable —');
  });

  // A parsed reset is the ONLY case that may name the cause, and it must carry the time with it.
  test("a PARSED reset names the cause and states the time", () => {
    const m = limitedSkipMessage({ ...base, exhausted: true });
    expect(m).toContain('account "primary" is at its usage limit until 2026-08-27T05:00:00.000Z');
  });

  // Corrupt state: isProbe false but no time. Must degrade to the weaker wording, never "until ".
  test("a parsed mark with an empty time degrades instead of printing a dangling \"until\"", () => {
    const m = limitedSkipMessage({ label: "primary", until: "", isProbe: false, exhausted: true });
    expect(m).not.toContain("until");
    expect(m).toContain("is unavailable");
  });

  // The label is arbitrary config text and reaches a terminal and briefing.log.
  test("control bytes in a label are stripped", () => {
    const m = limitedSkipMessage({ label: "pri\u001b[31mmary", until: "", isProbe: true, exhausted: true });
    expect(m).not.toContain("\u001b");
  });

  // Conservative default: never promise a retry on a payload that does not say one is coming.
  test("an absent payload keeps the conservative wording, not the promise", () => {
    const m = limitedSkipMessage(undefined);
    expect(m).toContain("no other account is available");
    expect(m).toContain('account "?"');
  });
});

// `readLastRunDate` feeds the outage line — decoration on a briefing — and is the FIRST marker read a
// `--force` run performs (that path skips `alreadyRanToday`). An existing-but-unreadable marker must
// therefore degrade, never throw. Untested until the verification round measured it as unpinned.
describe("readLastRunDate", () => {
  test("an unreadable marker degrades to undefined instead of crashing the tick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marker-eacces-"));
    const prev = process.env.DAILY_BRIEFING_STATE_DIR;
    process.env.DAILY_BRIEFING_STATE_DIR = dir;
    try {
      writeFileSync(join(dir, "last-run"), "2026-08-22");
      chmodSync(join(dir, "last-run"), 0o000);
      // A root-owned CI runner ignores mode bits; skip rather than assert a tautology there.
      let readable = true;
      try { await Bun.file(join(dir, "last-run")).text(); } catch { readable = false; }
      if (readable) return;
      expect(await readLastRunDate()).toBeUndefined();
    } finally {
      chmodSync(join(dir, "last-run"), 0o600);
      if (prev === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR;
      else process.env.DAILY_BRIEFING_STATE_DIR = prev;
    }
  });

  test("a well-formed marker still reads back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marker-ok-"));
    const prev = process.env.DAILY_BRIEFING_STATE_DIR;
    process.env.DAILY_BRIEFING_STATE_DIR = dir;
    try {
      writeFileSync(join(dir, "last-run"), "2026-08-22\n");
      expect(await readLastRunDate()).toBe("2026-08-22");
      writeFileSync(join(dir, "last-run"), "garbage");
      expect(await readLastRunDate()).toBeUndefined();     // shape-checked, not merely non-empty
    } finally {
      if (prev === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR;
      else process.env.DAILY_BRIEFING_STATE_DIR = prev;
    }
  });
});

// ── The unreadable day marker.
//
// Reading it is the FIRST thing every tick does, and it used to throw uncaught — killing the tick every
// 600s forever, with no briefing and no self-recovery. Answering `false` instead would be worse: a full
// briefing per tick, ~100 provider calls a day, never terminating because the stamp fails for the same
// reason the read did. So the marker is REPAIRED (unlink needs permission on the directory, not the
// file) and "did we run?" is answered from the dated archive, an independent witness every delivering
// run already writes.
describe("checkRanToday — repair, not merely survive", () => {
  const brk = (dir: string, date = "2026-08-22") => {
    writeFileSync(join(dir, "last-run"), date);
    chmodSync(join(dir, "last-run"), 0o000);
    // A root runner ignores mode bits; every test below no-ops rather than asserting a tautology there.
    try { readFileSync(join(dir, "last-run")); return false; } catch { return true; }
  };

  test("a healthy marker is untouched — no repair on the path that runs every day", async () => {
    const cleanup = withEnv();
    try {
      const dir = process.env.DAILY_BRIEFING_STATE_DIR!;
      writeFileSync(join(dir, "last-run"), localDateStr(new Date()));
      expect(await checkRanToday()).toEqual({ ranToday: true });     // no `repair` key at all
      writeFileSync(join(dir, "last-run"), "2020-01-01");
      expect(await checkRanToday()).toEqual({ ranToday: false });
    } finally { cleanup(); }
  });

  test("no marker at all is not a repair, it is a fresh day", async () => {
    const cleanup = withEnv();
    try { expect(await checkRanToday()).toEqual({ ranToday: false }); } finally { cleanup(); }
  });

  test("unreadable + today IS archived ⇒ the day is claimed and the marker rebuilt", async () => {
    const cleanup = withEnv();
    try {
      const dir = process.env.DAILY_BRIEFING_STATE_DIR!;
      const today = localDateStr(new Date());
      mkdirSync(join(dir, "briefings"), { recursive: true });
      writeFileSync(archivedBriefingPath(today), "yesterday's delivered briefing");
      if (!brk(dir)) return;

      expect(await checkRanToday()).toEqual({ ranToday: true, repair: "rewritten" });
      expect(readFileSync(join(dir, "last-run"), "utf-8")).toBe(today);   // readable again
      expect(await checkRanToday()).toEqual({ ranToday: true });          // and healed for good
    } finally { cleanup(); }
  });

  test("unreadable + NOTHING archived today ⇒ the marker is cleared so this tick can generate", async () => {
    const cleanup = withEnv();
    try {
      const dir = process.env.DAILY_BRIEFING_STATE_DIR!;
      if (!brk(dir)) return;
      expect(await checkRanToday()).toEqual({ ranToday: false, repair: "cleared" });
      expect(existsSync(join(dir, "last-run"))).toBe(false);             // gone, so stampToday can create
      expect(await checkRanToday()).toEqual({ ranToday: false });
    } finally { cleanup(); }
  });

  // The one case that trades briefings for quota, and the reason it is reported rather than silent.
  test("unreadable AND undeletable ⇒ claims the day rather than regenerating every tick", async () => {
    const cleanup = withEnv();
    const dir = process.env.DAILY_BRIEFING_STATE_DIR!;
    try {
      if (!brk(dir)) return;
      chmodSync(dir, 0o500);                                            // r-x: readable, not writable
      try { unlinkSync(join(dir, "last-run")); return; } catch { /* undeletable, as intended */ }
      expect(await checkRanToday()).toEqual({ ranToday: true, repair: "failed" });
    } finally { chmodSync(dir, 0o700); cleanup(); }
  });
});

test("run() survives an unreadable day marker instead of crashing the tick", async () => {
  const good = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cleanup = withEnv({ repos: [good], provider: PROV });
  const cap = captureConsole();
  const fp = fakeProvider();
  try {
    const dir = process.env.DAILY_BRIEFING_STATE_DIR!;
    writeFileSync(join(dir, "last-run"), "2026-08-22");
    chmodSync(join(dir, "last-run"), 0o000);
    try { readFileSync(join(dir, "last-run")); return; } catch { /* genuinely unreadable */ }

    const code = await runT(false, { provider: fp.provider });           // scheduled, NOT forced
    expect(code).toBe(0);                                                // it used to throw here
    expect(cap.err.some((l) => l.includes("the marker was cleared"))).toBe(true);
    expect(await alreadyRanToday()).toBe(true);                          // and the stamp now succeeds…
    expect(fp.calls()).toBe(1);                                          // …so the next tick will NOT regenerate
  } finally { cap.restore(); cleanup(); }
});

// ── The output-side credential scan must NOT ride on an unrelated feature flag.
//
// It was gated on `transcripts.enabled` until 2026-08-25. Turning transcripts off — for reasons with
// nothing to do with security; their attribution rules cannot resolve a multi-session workflow —
// silently disabled credential redaction on the briefing and the audit report. The gate's own comment
// said the scan fires on "a branch name, a commit subject, a provider diagnostic", every one of which
// is git-derived and unaffected by the flag, so the gate removed the scan from precisely the text it
// was described as protecting. These tests exist so re-gating it fails loudly.
describe("output credential scan is unconditional", () => {
  const KEY = "ghp_AbCdEfGhIjKlMnOpQrStUv123456";
  const withKey = `## RESUME\n- [r] rotate ${KEY} out of CI\n## RECAP\n- [r] did x | evidence: abc123\n## SUGGESTIONS\n- z`;

  for (const enabled of [false, true]) {
    test(`redacts with transcripts.enabled=${enabled}`, async () => {
      const cleanup = withEnv({
        repos: [WINDOW_ACTIVITY_REPO], provider: PROV, transcripts: { enabled },
      });
      const cap = captureConsole();
      try {
        await runT(true, { provider: { generate: async () => withKey } });
        const out = cap.out.join("\n");
        expect(out).not.toContain(KEY);        // the whole point
        expect(out).toContain(REDACTION);
      } finally { cap.restore(); cleanup(); }
    });
  }

  // What lands on DISK, not merely what was printed — briefing-latest.md is the file the user opens
  // and the audit reads, and it is written from the same `rendered` string.
  test("the redaction reaches briefing-latest.md, not just stdout", async () => {
    const cleanup = withEnv({
      repos: [WINDOW_ACTIVITY_REPO], provider: PROV, transcripts: { enabled: false },
    });
    const cap = captureConsole();
    try {
      await runT(true, { provider: { generate: async () => withKey } });
      const latest = await Bun.file(latestBriefingPath()).text();
      expect(latest).not.toContain(KEY);
      expect(latest).toContain(REDACTION);
    } finally { cap.restore(); cleanup(); }
  });
});
