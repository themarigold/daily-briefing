// test/provider.opts.test.ts
//
// C1/B10 — the seam. `ProviderTimeouts` widens to `ProviderOpts { timeoutMs, killGraceMs, flushMs,
// cwd, env }` and both new fields must reach `Bun.spawn`. This is a prerequisite, not a nicety: as it
// stands `Bun.spawn` is called with neither, so B1's narrow cwd and B4's env var would BOTH silently
// no-op — the hardening would look implemented and do nothing.
//
// The env merge is the load-bearing half. `Bun.spawn`'s `env` REPLACES the environment wholesale, so
// passing `{CLAUDE_CODE_SKIP_PROMPT_HISTORY:"1"}` alone was measured leaving `HOME=UNSET`, which kills
// the provider's auth and violates the invariant's own preserved-user-config clause. Real subprocesses
// here rather than a spawn spy, matching the house style in test/provider.test.ts — a spy would assert
// what we passed, not what the child actually received, and it is the child's view that matters.
import { test, expect } from "bun:test";
import { Glob } from "bun";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, sep } from "node:path";
import { BYOCliProvider } from "../src/provider";
import { hardenedProvider } from "../src/harden";
import { ProviderError, type Provider } from "../src/types";

const sh = (script: string, opts = {}) =>
  new BYOCliProvider({ cli: "sh", argv: ["-c", script], promptVia: "stdin" }, opts);

test("B10: `cwd` reaches the child process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dba-cwd-"));
  const out = await sh("pwd", { cwd: dir }).generate("");
  expect(out).toContain(basename(dir));
});

test("B10: omitting `cwd` leaves the child in the parent's cwd (no behaviour change)", async () => {
  const out = await sh("pwd").generate("");
  expect(out.trim()).toBe(process.cwd());
});

test("B10: `env` MERGES with process.env — PATH and HOME survive", async () => {
  // The whole point. A replacing env yields empty HOME/PATH here, which is the measured auth-killer.
  const out = await sh('echo "HOME=[$HOME] PATH_EMPTY=[${PATH:+no}] EXTRA=[$DBA_TEST_VAR]"', {
    env: { DBA_TEST_VAR: "injected" },
  }).generate("");
  expect(out).toContain("EXTRA=[injected]");        // our var arrived
  expect(out).not.toContain("HOME=[]");             // ...and did not evict the environment
  expect(out).toContain("PATH_EMPTY=[no]");
});

test("B10: omitting `env` still gives the child the full environment", async () => {
  const out = await sh('echo "HOME=[$HOME]"').generate("");
  expect(out).not.toContain("HOME=[]");
});

test("B10: an explicit `env` key OVERRIDES the inherited value of the same name", async () => {
  // Merge order matters: {...process.env, ...opts.env}, not the reverse — otherwise an inherited
  // CLAUDE_CODE_SKIP_PROMPT_HISTORY=0 would win over the hardening we are trying to apply.
  const out = await sh('echo "H=[$HOME]"', { env: { HOME: "/dba/override" } }).generate("");
  expect(out).toContain("H=[/dba/override]");
});

test("B10: hardenedProvider returns a Provider that also exposes runtimeWarnings", async () => {
  // The return type must be `Provider & { runtimeWarnings: string[] }`, not a bare `Provider`. B8's
  // dynamic warnings (probe anomalies, ladder outcome) need core.ts to READ the wrapper's accumulated
  // warnings; a bare Provider gives it no accessor and the wire silently would not exist.
  const hp = hardenedProvider({ cli: "sh", argv: ["-c", "echo hi"], promptVia: "stdin" });
  const asProvider: Provider = hp;                  // must structurally satisfy Provider
  expect(typeof asProvider.generate).toBe("function");
  expect(Array.isArray(hp.runtimeWarnings)).toBe(true);
});

test("B10: hardenedProvider injects nothing into a non-claude cli, and SAYS so", async () => {
  // Originally this asserted zero warnings, because the seam was a pure no-op. The activation commit
  // changed that deliberately: staying silent meant nothing in the briefing told the user whether
  // hardening was in effect, which the security review called worse than either outcome. The
  // behavioural half of the original assertion — output passes through untouched — still holds.
  const hp = hardenedProvider({ cli: "sh", argv: ["-c", "echo seam-ok"], promptVia: "stdin" });
  expect((await hp.generate("")).trim()).toBe("seam-ok");
  expect(hp.runtimeWarnings.join(" ")).toMatch(/not recognised as the claude CLI/);
});

test("B10: hardenedProvider propagates the ProviderError ITSELF — prototype intact, not a re-wrap", async () => {
  // `toMatchObject({ code })` was not enough, and the gap was demonstrated: a seam that re-threw
  // `{ code, message }` as a plain object passed all 470 tests AND `tsc` (throwing a non-Error is legal
  // TS). The consequence is severe and completely silent — `withRetry` gates on
  // `e instanceof ProviderError`, so a re-wrap makes every transient failure PERMANENT (zero retries
  // on the wake-before-wifi morning the retry schedule exists for), and `core.ts`'s `e instanceof
  // Error` gate then stops attaching `warnings`/`net`, so the shell's diagnostics vanish too.
  // Wrapper fidelity is the one property this whole commit exists to guarantee, so assert the
  // prototype, not a shape.
  const hp = hardenedProvider({ cli: "sh", argv: ["-c", "echo boom >&2; exit 3"], promptVia: "stdin" });
  const e: unknown = await hp.generate("").then(
    () => { throw new Error("expected the provider call to reject"); }, (err: unknown) => err);
  expect(e).toBeInstanceOf(ProviderError);
  expect(e).toBeInstanceOf(Error);
  expect((e as ProviderError).code).toBe("nonzero-exit");
});

test("B10: every production provider construction routes through the seam (static guard)", async () => {
  // The four-site routing is invisible to a runtime suite: while the wrapper injects nothing, reverting
  // any site is behaviour-equivalent, and `scripts/` is never executed by `bun test` at all. Once
  // hardening activates, a reverted eval or audit site IS the "the eval stops measuring production"
  // failure — a green gate over a product nobody tested. Nothing dynamic can catch that, so guard it
  // statically. `harden.ts` is the single legitimate construction site.
  const offenders: string[] = [];
  for (const dir of ["src", "scripts"]) {
    for await (const f of new Glob("**/*.ts").scan({ cwd: dir, absolute: true })) {
      if (f.endsWith(`${sep}harden.ts`)) continue;
      if ((await Bun.file(f).text()).includes("new BYOCliProvider")) offenders.push(f);
    }
  }
  expect(offenders).toEqual([]);
});

test("B10: hardenedProvider threads opts through to the child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dba-hp-cwd-"));
  const hp = hardenedProvider({ cli: "sh", argv: ["-c", "pwd"], promptVia: "stdin" }, { cwd: dir });
  expect(await hp.generate("")).toContain(basename(dir));
});
