// test/harden.argv.test.ts
//
// C1/B7 — argv conflict handling. Injected flags are PREPENDED, so anything the user put in
// `provider.argv` lands AFTER ours and wins under both last-wins and accumulating-variadic parsing. That
// means a config can silently defeat hardening while the briefing reports it as applied — the worst
// possible combination, because the user has no signal at all.
//
// Flipping to append does not fix it (an accumulating variadic unions rather than replaces), so the only
// correct answer is DETECTION: skip the injection we cannot win, and say so.
//
// Two classes:
//   OURS — a flag we would inject that the user already passes. Theirs wins, so injecting is pointless
//   AND misleading. Skip it, warn naming it.
//   ADJACENT — flags measured NOT to defeat an injected one (`--settings`, `--mcp-config`,
//   `--allowedTools`, `--permission-mode`, `--dangerously-skip-permissions`, …). Hardening still holds,
//   but they widen the provider's authority and the user should know they are in play. Warn only.
//
// And `--tools`/`--settings` make `init` exit NON-ZERO — never a tick, never `--force`. A `--settings`
// SessionStart hook was measured EXECUTING under full hardening, i.e. arbitrary shell execution, so it is
// worth refusing to proceed while the user is present to fix it. It is never worth killing a morning over.
import { test, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenedProvider, assertInitSafeArgv, argvConflicts } from "../src/harden";

const fast = { probeMs: 3_000, flushMs: 150 };

async function fakeClaude(dir: string): Promise<string> {
  const p = join(dir, "claude");
  await writeFile(p, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--tools --setting-sources --strict-mcp-config --no-session-persistence'; exit 0; fi
echo "ARGV:[$*]"
`, { mode: 0o755 });
  return p;
}

test("B7: a user's own --tools SKIPS our injection and warns — theirs would win anyway", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dba-b7-"));
  const cli = await fakeClaude(dir);
  const hp = hardenedProvider({ cli, argv: ["--tools", "Bash"], promptVia: "stdin" },
    { ...fast, stateDir: join(dir, "state") });
  const out = await hp.generate("x");
  expect(out).not.toContain("--tools=");                    // we did not pretend to win
  expect(out).toContain("--tools Bash");                    // the user's value is untouched
  expect(out).toContain("--strict-mcp-config");             // the non-conflicting ones still go in
  const w = hp.runtimeWarnings.join(" ");
  expect(w).toContain("--tools");
  expect(w).toMatch(/your own|provider\.argv|config/i);
});

test("B7: a user's own --setting-sources SKIPS ours — and the cwd narrowing follows it", async () => {
  // The gate's reasoning applies transitively: if we could not impose the isolation flag, the narrow cwd
  // is unjustified for exactly the same reason it is unjustified when the probe did not find it.
  const dir = await mkdtemp(join(tmpdir(), "dba-b7b-"));
  const cli = await fakeClaude(dir);
  const hp = hardenedProvider({ cli, argv: ["--setting-sources", "project,user"], promptVia: "stdin" },
    { ...fast, stateDir: join(dir, "state") });
  const out = await hp.generate("x");
  expect(out).not.toContain("--setting-sources user");
  expect(out).toContain("--setting-sources project,user");
  expect(out).not.toContain("provider-cwd");                // the narrowing dropped with the flag
  expect(hp.runtimeWarnings.join(" ")).toContain("--setting-sources");
});

test("B7: an ADJACENT flag warns but does NOT disable anything — hardening still holds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dba-b7c-"));
  const cli = await fakeClaude(dir);
  const hp = hardenedProvider({ cli, argv: ["--dangerously-skip-permissions"], promptVia: "stdin" },
    { ...fast, stateDir: join(dir, "state") });
  const out = await hp.generate("x");
  expect(out).toContain("--tools=");                        // all four still injected
  expect(out).toContain("--setting-sources user");
  expect(hp.runtimeWarnings.join(" ")).toContain("--dangerously-skip-permissions");
});

test("B7: the scan reads the CONFIG argv, never the final argv with the prompt in it", async () => {
  // In arg-mode the prompt is a positional token built from commit subjects — attacker-influenceable
  // text. A prompt that happens to contain "--settings" must never be read as a config conflict, or an
  // attacker could steer a security decision by naming a flag in a branch name.
  const dir = await mkdtemp(join(tmpdir(), "dba-b7d-"));
  const cli = await fakeClaude(dir);
  const hp = hardenedProvider({ cli, argv: [], promptVia: "arg" }, { ...fast, stateDir: join(dir, "state") });
  await hp.generate("fix --settings and --tools handling in the parser");
  expect(hp.runtimeWarnings.join(" ")).not.toMatch(/--settings|your own/i);
});

test("B7: argvConflicts classifies OURS vs ADJACENT, and catches the `=` form", () => {
  const c = argvConflicts(["--tools", "Bash", "--mcp-config", "./x.json"]);
  expect(c.ours).toEqual(["--tools"]);
  expect(c.adjacent).toEqual(["--mcp-config"]);
  expect(argvConflicts(["--tools=Bash"]).ours).toEqual(["--tools"]);   // same flag, `=` form
  expect(argvConflicts([]).adjacent).toEqual([]);
});

test("B7: assertInitSafeArgv throws for --tools and --settings, naming the field", () => {
  expect(() => assertInitSafeArgv(["--settings", "./s.json"])).toThrow(/--settings/);
  expect(() => assertInitSafeArgv(["--tools", "Bash"])).toThrow(/--tools/);
  expect(() => assertInitSafeArgv(["--tools=Bash"])).toThrow(/--tools/);
});

test("B7: assertInitSafeArgv accepts adjacent flags — only those two are refusable", () => {
  expect(() => assertInitSafeArgv(["-p"])).not.toThrow();
  expect(() => assertInitSafeArgv(["--mcp-config", "./x.json"])).not.toThrow();
  expect(() => assertInitSafeArgv(["--dangerously-skip-permissions"])).not.toThrow();
});

test("B7: a tick NEVER hard-errors on a conflicting argv — it warns and delivers", async () => {
  // The asymmetry that matters. Refusing to WRITE a dangerous config is cheap; refusing to RUN one means
  // no briefing tomorrow, and the user cannot act on a briefing they never received.
  const dir = await mkdtemp(join(tmpdir(), "dba-b7e-"));
  const cli = await fakeClaude(dir);
  const hp = hardenedProvider({ cli, argv: ["--settings", "./s.json"], promptVia: "stdin" },
    { ...fast, stateDir: join(dir, "state") });
  const out = await hp.generate("x");
  expect(out).toContain("ARGV:");                           // it ran
  expect(hp.runtimeWarnings.join(" ")).toContain("--settings");
});

// ── the wiring, not just the helper ─────────────────────────────────────────────────────────────────

/** `init()` calls `initConfig()` before the `load` seam, and the real one WRITES
 *  `$XDG_CONFIG_HOME/daily-briefing/config.json`, walks `homedir()` for repos, and spawns `which claude`.
 *  Injecting `write` removes all three: without it the suite wrote into the user's real config dir —
 *  invisible on a machine that already has one, destructive on CI or a fresh checkout — and the $HOME walk
 *  could eat the 5s test timeout. The XDG isolation is kept as a belt in case any other path reaches
 *  configPath(); it is the same save/set/restore used in config.test.ts, main.test.ts, integration.test.ts. */
async function withIsolatedConfigHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "dba-xdg-"));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev; }
}

/** initConfig's shape, with none of its side effects. */
const noWrite = async () => ({ path: "/tmp/dba-test-config.json", wrote: false, cliFound: true });

const cfgWith = (argv: string[]) => ({ repos: [], excludeCommitPatterns: [], lookbackCapDays: 30,
  provider: { cli: "claude", argv, promptVia: "stdin" as const } });

test("B7: init() itself REFUSES a defeating argv with a non-zero code — the wiring, not the helper", async () => {
  // The previous version of this file tested only `assertInitSafeArgv` in isolation, so deleting the call
  // from `init()` survived the whole suite while three separate places — a doc comment, a commit message
  // and a test name — all claimed init hard-errors. It did not: it printed a warning and returned 0.
  const { init } = await import("../src/main");
  expect(await withIsolatedConfigHome(() => init({ load: async () => cfgWith(["--settings", "./s.json"]) as never, write: noWrite }))).toBe(2);
});

test("B7: init() returns 0 for a clean argv", async () => {
  const { init } = await import("../src/main");
  expect(await withIsolatedConfigHome(() => init({ load: async () => cfgWith(["-p"]) as never, write: noWrite }))).toBe(0);
});

test("B7: argvConflicts sees only LONG forms, and this test says so rather than overclaiming", () => {
  // The earlier version of this test was named "...ignores flag-shaped VALUES" and its comment described
  // `--agents` as the value of `--tools`, but its only assertion was on `["-p"]` — which is not a
  // flag-shaped value and pins no such property. The truth is narrower and worth stating: the scan is
  // arity-free, so it cannot distinguish a flag from a value that happens to look like one, in either
  // direction. Acceptable for a hand-written config; building an arity table would be more machinery
  // than the risk warrants. Recorded here so nobody trusts a property that does not exist.
  expect(argvConflicts(["--model", "--add-dir"]).adjacent).toEqual(["--add-dir"]);   // a VALUE, misread
  expect(argvConflicts(["-p", "-c"]).ours).toEqual([]);                             // short forms unseen
});
