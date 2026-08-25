// test/harden.ladder.test.ts
//
// C1/B6 — the flag-rejection ladder. The probe proves a flag's NAME exists in `--help`; it cannot prove
// the VALUE FORM is accepted, and it false-positives on help text that mentions a flag in deprecation
// prose. So injection can still be rejected, and an unknown/invalid flag is FATAL: the CLI exits nonzero
// on its own usage error, which is indistinguishable from a wake-before-wifi failure. Without a rung
// that says "the last failure had our flags in it — try again without them", withRetry burns all three
// attempts and the user gets NO BRIEFING, every morning, until somebody reads the log.
//
// Two rungs, because the evidence differs:
//   FAST PATH — stderr matches a known rejection phrase. Rejection is PROVEN, so act immediately:
//   disable, warn, retry bare. Measured recovery 3.09s / 2 calls versus 138.4s / 5 without it.
//   AMBIGUOUS — nonzero exit with nothing conclusive on stderr. Cannot distinguish "rejected our flag"
//   from "network hiccup", so only probe it on the LAST withRetry attempt, and only if the attempt
//   failed FAST (a usage error returns in ~90ms; a real provider call does not).
import { test, expect } from "bun:test";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenedProvider } from "../src/harden";
import { withRetry, withHardeningLadder } from "../src/provider";
import { ProviderError } from "../src/types";

const fast = { probeMs: 3_000, flushMs: 150 };

/** A fake claude that lists every flag in --help but REJECTS one of them when actually used. */
async function pickyClaude(dir: string, opts: { reject?: string; bareOk?: boolean } = {}): Promise<string> {
  const msg = opts.reject ?? "error: unknown option '--strict-mcp-config'";
  const p = join(dir, "claude");
  await writeFile(p, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--tools --setting-sources --strict-mcp-config --no-session-persistence'; exit 0; fi
case "$*" in
  *--strict-mcp-config*) echo "${msg}" >&2; exit 2 ;;
esac
echo "BARE-OK"
`, { mode: 0o755 });
  return p;
}

test("B6 fast path: a PROVEN flag rejection disables hardening and retries bare, in one call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dba-lad-"));
  const cli = await pickyClaude(dir);
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "state") });
  const out = await hp.generate("x");
  expect(out).toContain("BARE-OK");                              // the briefing still happened
  const w = hp.runtimeWarnings.join(" ");
  expect(w).toMatch(/rejected/i);
  expect(w).toContain("--strict-mcp-config");                    // names the flag the CLI refused
});

test("B6 fast path: the latch HOLDS — a second call does not re-inject the rejected flag", async () => {
  // Without a latch every attempt pays the rejection again: 3 attempts x 2 calls, and 135s of withRetry
  // sleeps between them. The latch is what turns that into one wasted call for the process lifetime.
  const dir = await mkdtemp(join(tmpdir(), "dba-lad2-"));
  const cli = await pickyClaude(dir);
  const log = join(dir, "calls.log");
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--tools --setting-sources --strict-mcp-config'; exit 0; fi
echo "CALL:$*" >> ${log}
case "$*" in *--strict-mcp-config*) echo "error: unknown option '--strict-mcp-config'" >&2; exit 2 ;; esac
echo "BARE-OK"
`, { mode: 0o755 });
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "state") });
  await hp.generate("a");
  await hp.generate("b");
  const calls = (await Bun.file(log).text()).trim().split("\n").filter(Boolean);
  // First generate: one rejected + one bare. Second: bare only. Three total, not four.
  expect(calls).toHaveLength(3);
  expect(calls.filter((c) => c.includes("--strict-mcp-config"))).toHaveLength(1);
});

test("B6 fast path: a rejection phrase does NOT disable hardening when nothing was injected", async () => {
  // A non-claude CLI that happens to print "unknown option" about the USER's own argv must not be read
  // as our flag being rejected — we injected nothing, so there is nothing to back off from.
  const dir = await mkdtemp(join(tmpdir(), "dba-lad3-"));
  const cli = join(dir, "codex");
  await writeFile(cli, "#!/bin/sh\necho \"error: unknown option '--their-flag'\" >&2\nexit 2\n", { mode: 0o755 });
  const hp = hardenedProvider({ cli, argv: ["--their-flag"], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "state") });
  await expect(hp.generate("x")).rejects.toMatchObject({ code: "nonzero-exit" });
  expect(hp.runtimeWarnings.join(" ")).not.toMatch(/rejected an injected/i);
});

test("B6: ProviderError carries durationMs, so the ladder can tell a usage error from a slow failure", async () => {
  // withRetry sleeps 135s internally and passes nothing out, so an outer wrapper cannot time the final
  // attempt itself. Without this field the failed-fast trigger has no way to fire at all.
  const p = hardenedProvider({ cli: "sh", argv: ["-c", "exit 3"], promptVia: "stdin" }, fast);
  const e: unknown = await p.generate("x").then(() => { throw new Error("expected a rejection"); }, (err: unknown) => err);
  expect(e).toBeInstanceOf(ProviderError);
  expect(typeof (e as ProviderError).durationMs).toBe("number");
  expect((e as ProviderError).durationMs!).toBeLessThan(5_000);   // a usage error is fast
});

test("B6 ambiguous rung: only fires on the LAST attempt, and only when the failure was FAST", async () => {
  // Placing it on the last attempt moves the ~90ms misattribution window from t=0.09s — peak
  // wake-before-wifi hazard, where a network failure looks exactly like a usage error — out to
  // t=135.3s, where it is near zero. It does not eliminate it; it relocates it to where it is harmless.
  const dir = await mkdtemp(join(tmpdir(), "dba-lad4-"));
  const cli = join(dir, "claude");
  const log = join(dir, "calls.log");
  // Fails with NOTHING conclusive on stderr, so the fast path cannot fire; bare succeeds.
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--tools --setting-sources'; exit 0; fi
echo "CALL:$*" >> ${log}
case "$*" in *--tools=*) exit 4 ;; esac
echo "BARE-OK"
`, { mode: 0o755 });
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "state") });
  const out = await withHardeningLadder(hp, () => withRetry(() => hp.generate("x"), [], async () => {}), () => hp.generate("x"));
  expect(out).toContain("BARE-OK");
  expect(hp.runtimeWarnings.join(" ")).toMatch(/hardening/i);
});

test("B6 ambiguous rung: a SLOW failure never triggers it, even if bare would have worked", async () => {
  // THE gate. A failure that took real time reached the provider and did real work, so our flags are not
  // the story — most likely it is the wake-before-wifi network failure the retry schedule exists for.
  // Acting on it would disable hardening permanently on the strength of a coincidence. Here bare WOULD
  // succeed, so without the gate the ladder "proves" the flags were at fault and downgrades the posture.
  const dir = await mkdtemp(join(tmpdir(), "dba-lad-slow-"));
  const cli = join(dir, "claude");
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--tools --setting-sources'; exit 0; fi
case "$*" in *--tools=*) sleep 0.3; exit 4 ;; esac
echo "BARE-OK"
`, { mode: 0o755 });
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" },
    { ...fast, stateDir: join(dir, "state"), timeoutMs: 1_000 });   // failFast = 100ms; the failure takes ~300ms
  await expect(
    withHardeningLadder(hp, () => withRetry(() => hp.generate("x"), [], async () => {}), () => hp.generate("x"), 1_000),
  ).rejects.toMatchObject({ code: "nonzero-exit" });
  expect(hp.hardeningActive()).toBe(true);                          // no conclusion drawn
});

test("B6 ambiguous rung: a TIMEOUT is rethrown and draws NO conclusion", async () => {
  // Renamed and strengthened. "never triggers it" was unobservable from the old assertion — a timeout is
  // rethrown whether or not the rung ran, so `rejects.toMatchObject({code:"timeout"})` was equally true
  // either way, and deleting `e.code === "timeout"` survived the suite. What is actually observable is
  // that no conclusion was drawn. (The clause is redundant given core's shared-timeout wiring, which the
  // source says explicitly; this pins the OUTCOME rather than the clause.)
  const hp = hardenedProvider({ cli: "sh", argv: ["-c", "sleep 5"], promptVia: "stdin" }, { ...fast, timeoutMs: 150 });
  await expect(
    withHardeningLadder(hp, () => withRetry(() => hp.generate("x"), [], async () => {}), () => hp.generate("x")),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(hp.hardeningActive()).toBe(true);
  expect(hp.runtimeWarnings.join(" ")).not.toMatch(/disabled|rejected/i);
});

test("B6 ambiguous rung: when BARE also fails, conclude nothing and keep hardening", async () => {
  // The honest outcome for an inconclusive experiment. Disabling hardening on a failure that had nothing
  // to do with our flags would be a silent, permanent posture downgrade bought with no evidence.
  const dir = await mkdtemp(join(tmpdir(), "dba-lad5-"));
  const cli = join(dir, "claude");
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--tools --setting-sources'; exit 0; fi
exit 7
`, { mode: 0o755 });
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "state") });
  await expect(
    withHardeningLadder(hp, () => withRetry(() => hp.generate("x"), [], async () => {}), () => hp.generate("x")),
  ).rejects.toMatchObject({ code: "nonzero-exit" });
  // Assert the STATE, not the wording: matching on /disabled/i let a mutant that latched with a
  // different message pass. `hardeningActive()` is the property that actually matters.
  expect(hp.hardeningActive()).toBe(true);
});

// ── the fast path's evidence gates (final-review findings) ──────────────────────────────────────────

test("B6 fast path: a SLOW failure never latches, even with a perfect rejection phrase", async () => {
  // The fast path fired on ANY nonzero exit whose message matched, with no duration gate — measured
  // latching on a 6.24s failure, 70x the ~90ms a real usage error takes. The ambiguous rung enforces this
  // discipline; the rung that fires FIRST and on EVERY attempt did not.
  const dir = await mkdtemp(join(tmpdir(), "dba-slow-rej-"));
  const cli = join(dir, "claude");
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--tools --setting-sources'; exit 0; fi
sleep 0.4; echo "error: unknown option '--tools'" >&2; exit 2
`, { mode: 0o755 });
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" },
    { ...fast, stateDir: join(dir, "state"), timeoutMs: 1_000 });   // failFast = 100ms; failure takes ~400ms
  await expect(hp.generate("x")).rejects.toMatchObject({ code: "nonzero-exit" });
  expect(hp.hardeningActive()).toBe(true);
});

test("B6 fast path: the message must NAME a flag we actually sent — not just any English phrase", async () => {
  // FLAG_REJECTION_RE's phrases are ordinary English, and the message it scans embeds `(stdout)`, which on
  // a hardened run is MODEL OUTPUT quoting commit subjects. So a commit subject like
  // `fix: handle unknown option in the parser` was otherwise sufficient evidence to disable hardening and
  // immediately re-run the same hostile prompt bare. Same rule B7 applies to argv: attacker text must
  // never steer a security decision.
  const dir = await mkdtemp(join(tmpdir(), "dba-name-rej-"));
  const cli = join(dir, "claude");
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--tools --setting-sources'; exit 0; fi
echo "recap: fix: handle unknown option in the parser"; exit 2
`, { mode: 0o755 });
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "state") });
  await expect(hp.generate("x")).rejects.toMatchObject({ code: "nonzero-exit" });
  expect(hp.hardeningActive()).toBe(true);          // no flag of ours was named
});

test("B5: PARTIAL probe support is announced — a silently missing --tools is the worst case", async () => {
  // The activation review fixed this class for --setting-sources and left it unfixed for --tools, the
  // primary injection-to-execution barrier. A future CLI that renames or hides it would silently remove
  // the main protection forever while the README still promised it.
  const dir = await mkdtemp(join(tmpdir(), "dba-partial-"));
  const cli = join(dir, "claude");
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--setting-sources --strict-mcp-config --no-session-persistence'; exit 0; fi
echo "ARGV:[$*]"
`, { mode: 0o755 });
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "state") });
  const out = await hp.generate("x");
  expect(out).not.toContain("--tools=");
  const w = hp.runtimeWarnings.join(" ");
  expect(w).toMatch(/PARTIAL/);
  expect(w).toContain("--tools");
  expect(w).toMatch(/built-in tools/);              // says WHY that particular gap matters
});

test("B6 fast path: the VALUE token `user` is not evidence — only a FLAG counts", async () => {
  // Measured hole in the first version of this gate: it iterated all of `extra`, which contains the value
  // token `user` from `--setting-sources user`. The bare word "user" appears in a large fraction of English
  // error text, so a message naming NO flag at all satisfied it and latched hardening off. This is the
  // reviewer's exact reproduction: a rejection phrase plus "user", no flag anywhere.
  const dir = await mkdtemp(join(tmpdir(), "dba-uservalue-"));
  const cli = join(dir, "claude");
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--tools --setting-sources --strict-mcp-config'; exit 0; fi
echo "recap: fix: handle unknown option in user parser"; exit 2
`, { mode: 0o755 });
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "state") });
  await expect(hp.generate("x")).rejects.toMatchObject({ code: "nonzero-exit" });
  expect(hp.hardeningActive()).toBe(true);
});

test("B6 fast path: a flag mentioned FAR from the rejection phrase is coincidence, not evidence", async () => {
  // A real CLI prints them adjacent: `error: unknown option '--strict-mcp-config'`. A commit subject that
  // merely mentions `--tools` somewhere in a paragraph that also contains "invalid option" is not a
  // rejection — and model output quoting commit subjects is exactly where both could co-occur by chance.
  const dir = await mkdtemp(join(tmpdir(), "dba-farflag-"));
  const cli = join(dir, "claude");
  const pad = "x".repeat(160);
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--tools --setting-sources --strict-mcp-config'; exit 0; fi
echo "invalid option ${pad} and separately we renamed --tools in the parser"; exit 2
`, { mode: 0o755 });
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "state") });
  await expect(hp.generate("x")).rejects.toMatchObject({ code: "nonzero-exit" });
  expect(hp.hardeningActive()).toBe(true);
});

test("B6 ambiguous rung: rung 1 retries WITH flags — a transient failure keeps hardening", async () => {
  // Rung 1 existed only in the code: deleting it entirely survived the whole suite, because nothing
  // distinguished "succeeded on a retry that still had the flags" from "succeeded bare". That is the most
  // likely explanation for an ambiguous failure and the cheapest to keep, so it is tried FIRST — and if it
  // works, hardening must survive untouched. Also the only ladder test with a multi-attempt schedule:
  // every other one passes `[]`, so "last attempt only" was never actually exercised.
  const dir = await mkdtemp(join(tmpdir(), "dba-rung1-"));
  const cli = join(dir, "claude");
  const counter = join(dir, "n");
  await writeFile(counter, "0");
  // Fails the first THREE calls — withRetry with `[0, 0]` is three ATTEMPTS, not two, so a CLI that failed
  // only twice succeeded inside withRetry and the ladder never ran at all (my first version of this test
  // made exactly that off-by-one and therefore proved nothing). The fourth call is rung 1, still
  // carrying the flags. If rung 1 were absent, the ladder would go straight to a bare probe and conclude
  // the flags were at fault.
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--tools --setting-sources'; exit 0; fi
n=$(cat ${counter}); n=$((n+1)); echo $n > ${counter}
if [ "$n" -le 3 ]; then exit 4; fi
echo "STILL-HARDENED:[$*]"
`, { mode: 0o755 });
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "state") });
  const out = await withHardeningLadder(hp, () => withRetry(() => hp.generate("x"), [0, 0], async () => {}), () => hp.generate("x"));
  expect(out).toContain("STILL-HARDENED");
  expect(out).toContain("--tools=");                 // succeeded WITH the flags, not without them
  expect(hp.hardeningActive()).toBe(true);           // ...so no conclusion was drawn
  expect(hp.runtimeWarnings.join(" ")).not.toMatch(/disabled|rejected/i);
});

test("B6 fast path: the disable warning is raised ONCE, not once per attempt", async () => {
  // Pins the USER-VISIBLE invariant — the disable reason appears once, not once per attempt — and NOT the
  // `if (flagsOff) return` guard itself, which is unpinnable: measured, deleting that guard still passes
  // this test and the whole suite, because latching also empties `extra` so the fast path cannot re-fire.
  // An earlier version of this comment claimed the guard was pinned, contradicting the source comment
  // added in the very same commit. What survives a mutation and what a test asserts are different things.
  const dir = await mkdtemp(join(tmpdir(), "dba-once-"));
  const cli = await pickyClaude(dir);
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "state") });
  await hp.generate("a");
  await hp.generate("b");
  expect(hp.runtimeWarnings.filter((w) => /rejected an injected/.test(w))).toHaveLength(1);
});

test("B6 ambiguous rung: the bare probe's own warnings do not leak into the run's outcome", async () => {
  // While suppressed, `generate()` sees no isolation flag and would otherwise push "kept this process's
  // working directory…" — a capability-gap diagnosis for a deliberate experiment, landing in the briefing
  // next to the ladder's own correct explanation. Dropping the `suppressed === 0` guard survived.
  const dir = await mkdtemp(join(tmpdir(), "dba-noleak-"));
  const cli = join(dir, "claude");
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--tools --setting-sources'; exit 0; fi
case "$*" in *--tools=*) exit 4 ;; esac
echo "BARE-OK"
`, { mode: 0o755 });
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "state") });
  await withHardeningLadder(hp, () => withRetry(() => hp.generate("x"), [], async () => {}), () => hp.generate("x"));
  expect(hp.runtimeWarnings.join(" ")).not.toMatch(/kept this process's working directory/);
});

test("B3: a cwd that becomes unusable MID-RUN is recovered from, not blamed on the CLI", async () => {
  // The last unpinned recovery rung (pre-existing, surfaced by a mutation probe): forcing `cwdUsable()` to
  // always return true survived the full suite. A directory can pass every check at first-use and be
  // un-`chdir`-able minutes later — removed, remounted, chmod'd — and Bun reports that as ENOENT/EACCES
  // naming the BINARY, so without this rung the morning blames the user's CLI for a directory problem.
  // Provoked by breaking the memoised directory AFTER the first successful call.
  const dir = await mkdtemp(join(tmpdir(), "dba-vanish-"));
  const cli = join(dir, "claude");
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--tools --setting-sources'; exit 0; fi
echo "RAN"
`, { mode: 0o755 });
  const state = join(dir, "state");
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: state });
  expect((await hp.generate("a")).trim()).toBe("RAN");        // first call memoises the narrow cwd
  await chmod(join(state, "provider-cwd"), 0o000);            // now make it un-enterable
  expect((await hp.generate("b")).trim()).toBe("RAN");        // ...and it still delivers
  expect(hp.runtimeWarnings.join(" ")).toMatch(/became unusable/);
});

test("B6 fast path: a rejection of the USER's `--toolset` is not a rejection of our `--tools`", async () => {
  // Measured hole in the first proximity gate: it used a plain `indexOf`, so `--tools` matched INSIDE the
  // user's own `--toolset`, and the run latched hardening off with the false diagnosis "rejected an
  // injected hardening flag" plus a wasted bare attempt. No unhardened model call was reachable — the bare
  // retry still carries the user's bad flag and dies at parse — but a confidently wrong diagnosis is
  // exactly what this gate exists to prevent. Same word-boundary rule the probe's matcher already used.
  const dir = await mkdtemp(join(tmpdir(), "dba-toolset-"));
  const cli = join(dir, "claude");
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--tools --setting-sources --strict-mcp-config'; exit 0; fi
echo "error: unknown option '--toolset'" >&2; exit 2
`, { mode: 0o755 });
  const hp = hardenedProvider({ cli, argv: ["--toolset", "x"], promptVia: "stdin" },
    { ...fast, stateDir: join(dir, "state") });
  await expect(hp.generate("x")).rejects.toMatchObject({ code: "nonzero-exit" });
  expect(hp.hardeningActive()).toBe(true);
  expect(hp.runtimeWarnings.join(" ")).not.toMatch(/rejected an injected/);
});

test("T15: the fast path REFUSES to latch when the evidence came from a partial read", async () => {
  // The security property `partialRead` exists for, and the half that T16 (which only checks the flag
  // is stamped) does not reach: removing `!partialRead` from the fast-path condition must fail HERE.
  //
  // Why it matters, concretely. The fast path's other protection is a timing argument — a real usage
  // error returns in ~90ms, a mid-generation failure is slow — and that argument is FALSE for an
  // errored or held stream: `drain` resolves instead of rejecting, so the attempt is fast while the
  // message still carries partial, prompt-derived bytes. This CLI models exactly that: it emits the
  // rejection phrase, then leaves a grandchild holding the pipe, and exits fast.
  const dir = await mkdtemp(join(tmpdir(), "dba-lad-partial-"));
  const cli = join(dir, "claude");
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--tools --setting-sources --strict-mcp-config'; exit 0; fi
case "$*" in
  *--strict-mcp-config*) echo "error: unknown option '--strict-mcp-config'" >&2; sleep 3 & exit 2 ;;
esac
echo "BARE-OK"
`, { mode: 0o755 });
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "state") });
  await expect(hp.generate("x")).rejects.toBeInstanceOf(ProviderError);
  // Hardening must still be ON: the ladder saw a rejection phrase in bytes it cannot trust, so it
  // declines to act and lets the normal retry schedule handle the failure.
  expect(hp.runtimeWarnings.join(" ")).not.toMatch(/rejected an injected/i);
  expect(hp.hardeningActive()).toBe(true);
});
