// test/provider.incomplete-read.test.ts
//
// C1 read lifecycle. `BYOCliProvider.generate` read its streams with `new Response(s).text()`, which
// resolves ONLY at EOF — so when the post-exit flush race is lost to a grandchild holding the pipe,
// `out` was "" even though every byte had already arrived, and a COMPLETE briefing was discarded as
// `empty-output`. Two faces of one bug: the same held pipe also blanked the nonzero-exit diagnostic
// to "(no output)", which is the exact 2026-07-11 launchd failure the nonzero-exit diagnostic block in provider.ts exists to stop.
//
// Real subprocesses (`sh`) throughout for the pipe behaviour, matching the house style in
// provider.test.ts / provider.opts.test.ts: the properties under test are about what a child actually
// does to our pipes, which a spawn spy cannot model. Injection is used only where no child can
// produce the state (a pipe read that ERRORS, and observing reader cancellation).
//
// STANDING RULE FOR THIS FILE: every test that was GREEN when first written was verified by applying
// its named mutation and observing red, and the observed failure is recorded in its comment. Three
// guards in the three preceding PRs were green-when-written, never mutation-checked, and turned out to
// pin nothing at all.
import { test, expect, spyOn } from "bun:test";
import { BYOCliProvider } from "../src/provider";
import { ProviderError } from "../src/types";

const sh = (script: string, opts = {}) =>
  new BYOCliProvider({ cli: "sh", argv: ["-c", script], promptVia: "stdin" }, opts);

/** Bound every held-pipe call. WITHOUT the fix some of these would hang, and a hanging test wedges CI
 *  instead of failing it. Named for the provider, not runGit — copying git's message verbatim would
 *  print the wrong symbol on every hang. */
const HUNG = Symbol("hung");
async function bounded<T>(p: Promise<T>, ms = 8_000): Promise<T> {
  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const guard = new Promise<typeof HUNG>((r) => { guardTimer = setTimeout(() => r(HUNG), ms); });
    const winner = await Promise.race([p, guard]);
    if (winner === HUNG) throw new Error(`BYOCliProvider.generate never returned within ${ms}ms — it is hanging on a stream that never EOFs`);
    return winner as T;
  } finally { if (guardTimer) clearTimeout(guardTimer); }
}

// ─── Step 1: CHARACTERIZE. Both green on the pre-fix code, written first so the steps that follow
// cannot over-correct into accepting output they must reject. ──────────────────────────────────────

test("T12: a held stdout that produced ZERO bytes is still empty-output", async () => {
  // The anti-over-correction pin. Recovering buffered bytes must not turn "the CLI said nothing" into
  // a success — `""` is never a legitimate provider result (unlike git, where it is).
  // MUTATION (verified red): delete the `!out.trim()` empty-output throw →
  // `Received promise that resolved: Promise { <resolved> }`.
  await expect(bounded(sh("sleep 3 &", { flushMs: 150 }).generate("x")))
    .rejects.toMatchObject({ code: "empty-output" });
});

test("T9: a SIGNAL-killed child with buffered bytes is nonzero-exit, never a truncated success", async () => {
  // the existing signal-kill test in provider.test.ts covers signal death with no output; with bytes in the pipe the sink makes a
  // truncated "success" reachable for the first time, so the guard needs its own pin.
  // MUTATION (verified red): delete the `proc.exitCode === null` throw →
  // `Received message: "sh exited null: (stdout) PARTIAL\n"`. It does NOT resolve — it falls through
  // to the exitCode !== 0 branch — so the `/killed|signal/` assertion is what kills it, not the code
  // check alone. (An earlier record here said `"(no output)"`; that was the PRE-FIX message, captured
  // before the sinks started recovering the bytes. Re-run against shipped code.)
  const p = bounded(sh("echo PARTIAL; sleep 3 & kill -KILL $$", { flushMs: 150 }).generate("x"));
  await expect(p).rejects.toMatchObject({ code: "nonzero-exit" });
  await expect(p).rejects.toThrow(/killed|signal/i);
});

// ─── Step 2: the RED. ───────────────────────────────────────────────────────────────────────────────

test("T1: a grandchild holding stdout does not discard output that ALREADY arrived", async () => {
  // Named for ACCUMULATION, not for the flush window, and the distinction is not pedantic: measured,
  // this fixture recovers every byte even at `flushMs: 0`, because the bytes reach the sink before
  // `proc.exited` resolves. Calling this a flush-window test would be a lie, and T3 is the one that
  // actually exercises the window. V1: the grandchild must outlive the window by ~20x — `sleep 0.01 &`
  // loses the race 0 times in 25, so the test would pass on the buggy code.
  const t0 = performance.now();
  const out = await bounded(sh("echo BRIEFING; sleep 3 &", { flushMs: 150 }).generate("x"));
  expect(out.trim()).toBe("BRIEFING");
  // V3: prove the race was actually lost rather than silently never happening.
  expect(performance.now() - t0).toBeGreaterThanOrEqual(150);
});

// ─── Step 4: the free SECOND red — the same bug's other face. ───────────────────────────────────────

test("T2: a held pipe no longer blanks the nonzero-exit DIAGNOSTIC to (no output)", async () => {
  // the nonzero-exit diagnostic block in provider.ts exists because the 2026-07-11 launchd failure delivered a blank
  // "claude exited 1:" — and a grandchild holding stdout defeated it completely, which nothing pinned.
  // This flipped red→green with no code beyond T1's, because it is the same defect.
  // MUTATIONS (both verified red): revert the stdout leg to `new Response(...).text()`; OR drop the
  // `out.trim()` push from the nonzero-exit diagnostic. V4 — the negative assertion is what makes this
  // specific; inverting it to /REALCAUSE/ was checked to fail, so `.not.toThrow` is not vacuous here.
  const p = bounded(sh("echo REALCAUSE; sleep 3 & exit 1", { flushMs: 200 }).generate("x"));
  await expect(p).rejects.toThrow(/REALCAUSE/);
  await expect(p).rejects.not.toThrow(/\(no output\)/);
});

// ─── Step 5: stderr onto a sink too. ────────────────────────────────────────────────────────────────

test("T2b: PARTIAL stderr bytes reach the nonzero-exit diagnostic", async () => {
  // §4e's whole security argument is about partial STDERR reaching the ProviderError message, and
  // nothing pinned that direction — T2 covers stdout. Here stdout is closed and only stderr is held.
  // MUTATION (verified red): drop the `err.trim()` push in the nonzero-exit diagnostic →
  // `Received message: "sh exited 3: (no output)"`.
  //
  // THIS RECORD WAS FABRICATED ON ITS FIRST WRITING. I ran the mutation but grepped only for `(fail)`
  // lines, never saw the message, and wrote down what I expected — `"(stdout) "`, which is impossible
  // for this fixture on ANY commit, because stdout is closed here and every byte goes to stderr. A
  // reviewer caught it. The standing rule at the top of this file exists precisely to stop that, and
  // recording a predicted message instead of an observed one defeats it entirely.
  const p = bounded(sh("echo ONSTDERR >&2; sleep 3 & exec 1>&-; exit 3", { flushMs: 200 }).generate("x"));
  await expect(p).rejects.toThrow(/ONSTDERR/);
});

// ─── Step 8: cancel — RED before the abandon() calls exist. ─────────────────────────────────────────

/** A source that records cancellation and counts pulls, so we can prove the reader was RELEASED and
 *  not merely flagged. `neverEofStream` in the git suite has neither hook (V12). */
function instrumented(maxPulls = 60) {
  const st = { canceled: false, pulls: 0 };
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode("BRIEFING\n")); },
    // Paced and CAPPED on purpose. An unbounded tight `pull` models the leak faithfully but wedges the
    // runner: with no cancel (the pre-fix state) the loop spins forever and holds the event loop open,
    // so the suite HANGS instead of failing — measured, 6m40s and counting. The cap lets the pre-fix
    // run terminate and fail honestly; the 5ms pacing leaves a window in which T5 can observe pulls
    // either continuing or frozen.
    async pull(c) {
      if (st.pulls >= maxPulls) { c.close(); return; }
      st.pulls++;
      await Bun.sleep(5);
      c.enqueue(enc.encode("."));
    },
    cancel() { st.canceled = true; },
  });
  return { stream, st };
}

function fakeSpawn(stdout: ReadableStream<Uint8Array>, stderr: ReadableStream<Uint8Array>) {
  return {
    stdout, stderr,
    stdin: { write() {}, end() { return undefined; } },
    exited: Promise.resolve(0), exitCode: 0, signalCode: null,
    kill() {},
  } as unknown as ReturnType<typeof Bun.spawn>;
}

test("T4: when the flush race is lost, BOTH readers are cancelled", async () => {
  // T4 and T5 overlap more than intended, and the honest version is worth recording: the flag-only
  // mutation (an `abandon` that never calls `reader.cancel()`) turns T4 red too, because
  // `instrumented()`'s `cancel()` hook observes REAL reader cancellation rather than drain's flag. So
  // T5 kills nothing T4 misses. Kept anyway — it asserts a different property (pulls actually stop),
  // which is what a future reader needs to see — but it is redundancy, not extra coverage.
  const a = instrumented(), b = instrumented();
  const spy = spyOn(Bun, "spawn").mockImplementation(() => fakeSpawn(a.stream, b.stream));
  try {
    await bounded(sh("ignored", { flushMs: 100 }).generate("x"));
  } finally { spy.mockRestore(); }
  expect([a.st.canceled, b.st.canceled]).toEqual([true, true]);
});

test("T4b: a ONE-SIDED hold still cancels the held reader", async () => {
  // V11, measured: T4's fixture holds BOTH streams, so `!complete || !complete` and `!complete &&
  // !complete` are both true and weakening `||` to `&&` SURVIVES it. Only a one-sided hold separates
  // them — and under `&&` a held stderr never releases, which is the exact resource-growth hazard
  // this PR was originally filed for.
  const enc = new TextEncoder();
  const closed = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode("BRIEFING\n")); c.close(); } });
  const held = instrumented();
  const spy = spyOn(Bun, "spawn").mockImplementation(() => fakeSpawn(closed, held.stream));
  try {
    await bounded(sh("ignored", { flushMs: 100 }).generate("x"));
  } finally { spy.mockRestore(); }
  expect(held.st.canceled).toBe(true);
});

test("T5: cancelling actually RELEASES the reader — pulls stop", async () => {
  // MUTATION: `abandon = () => { sink.canceled = true; }` (drop `reader.cancel()`) in stream.ts.
  const a = instrumented(), b = instrumented();
  const spy = spyOn(Bun, "spawn").mockImplementation(() => fakeSpawn(a.stream, b.stream));
  try {
    await bounded(sh("ignored", { flushMs: 100 }).generate("x"));
  } finally { spy.mockRestore(); }
  const frozen = [a.st.pulls, b.st.pulls];
  await Bun.sleep(120);
  expect([a.st.pulls, b.st.pulls]).toEqual(frozen);
});

// ─── Step 6: a broken read is not a held pipe. ──────────────────────────────────────────────────────

/** Errors AFTER delivering `chunks`, with a delay so the bytes really land in the sink first.
 *  V8: the zero-delay form errors inside `start()` before the first `read()`, so the sink stays EMPTY
 *  and `if (!out.trim())` alone catches it — the errored guard's mutation SURVIVES that fixture. */
function erroringAfterBytes(chunks: string[], delayMs: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      setTimeout(() => c.error(new Error("EIO")), delayMs);
    },
  });
}

test("T10b: an errored stdout that ALREADY buffered bytes is empty-output, not a truncated success", async () => {
  const enc = new TextEncoder();
  const spy = spyOn(Bun, "spawn").mockImplementation(() => fakeSpawn(
    erroringAfterBytes(["HALF A BRIEFING"], 10),
    new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode("")); c.close(); } }),
  ));
  try {
    await expect(bounded(sh("ignored", { flushMs: 300 }).generate("x")))
      .rejects.toMatchObject({ code: "empty-output" });
  } finally { spy.mockRestore(); }
});

test("T10c: a NONZERO exit with an errored stdout keeps its diagnostic — the guard's position matters", async () => {
  // Hoisting the `o.sink.errored` check above the exitCode checks turns this into `empty-output` and
  // throws away the diagnostic that half of this change exists to rescue.
  const enc = new TextEncoder();
  const spy = spyOn(Bun, "spawn").mockImplementation(() => {
    const p = fakeSpawn(
      erroringAfterBytes(["x"], 10),
      new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode("REALCAUSE")); c.close(); } }),
    ) as any;
    p.exitCode = 4; p.exited = Promise.resolve(4);
    return p;
  });
  try {
    const p = bounded(sh("ignored", { flushMs: 300 }).generate("x"));
    await expect(p).rejects.toMatchObject({ code: "nonzero-exit" });
    await expect(p).rejects.toThrow(/REALCAUSE/);
  } finally { spy.mockRestore(); }
});

// ─── The flush window itself, and the deliberate fail-open. ─────────────────────────────────────────

test("T3: the flush window is what captures bytes written AFTER the child exits", async () => {
  // The test T1's comment defers to. T1 proves ACCUMULATION and passes even at flushMs: 0, because its
  // bytes arrive before `proc.exited`. Only a LATE writer exercises the window: measured, this fixture
  // yields "EARLY" at flushMs 0 and "EARLY\nLATE" at 600.
  const out = await bounded(sh("(sleep 0.2; echo LATE; sleep 3) & echo EARLY", { flushMs: 700 }).generate("x"));
  expect(out).toContain("EARLY");
  expect(out).toContain("LATE");
});

test("a TRUNCATED stdout is returned rather than discarded — the fail-open, on purpose", async () => {
  // The counterpart to T12. Zero bytes must reject; SOME bytes with no EOF must resolve. git.ts fails
  // closed on the same condition because "" is a legitimate git result; for the provider it never is.
  // Without this pin the fail-open is indistinguishable from an oversight, and a future "make it match
  // runGit" change would look like a consistency fix.
  const out = await bounded(sh("printf 'HALF A BRIEF'; sleep 3 &", { flushMs: 150 }).generate("x"));
  expect(out).toBe("HALF A BRIEF");
});

test("the readers are abandoned on the TIMEOUT path too, not only after a clean exit", async () => {
  // T4/T4b/T5 all reach the `finally` via exit 0. Guarding the abandon with `if (!timedOut)` would
  // survive every one of them, and the timeout path is where a held pipe is most likely.
  const held = instrumented();
  const enc = new TextEncoder();
  const spy = spyOn(Bun, "spawn").mockImplementation(() => {
    const p = fakeSpawn(held.stream, new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode("")); c.close(); } })) as any;
    p.exitCode = null;
    p.exited = Bun.sleep(120).then(() => { p.exitCode = 0; return 0; });
    return p;
  });
  try {
    await expect(bounded(sh("ignored", { timeoutMs: 40, killGraceMs: 20, flushMs: 60 }).generate("x")))
      .rejects.toMatchObject({ code: "timeout" });
  } finally { spy.mockRestore(); }
  expect(held.st.canceled).toBe(true);
});

// ─── Step 7: the hazard THIS change creates. ────────────────────────────────────────────────────────

test("T8: a TIMED-OUT child with buffered bytes never returns a truncated success", async () => {
  // Unkillable before this branch — `out` was always "" on that path, so there was nothing to leak.
  // Recovering bytes creates the hazard, so the guard ships with it.
  //
  // The `wait` is load-bearing and not obvious (V9). A POSIX shell defers a trap until the foreground
  // command returns, so `sleep 30` WITHOUT `wait` never runs the trap, the child dies on SIGKILL, and
  // `exitCode` is null — at which point the mutation is killed by the `exitCode === null` guard
  // instead, and T8 stops testing its own line. With `wait`, the trap runs and exitCode is 0.
  // MUTATION (verified red): delete the `timedOut` throw →
  // `Received promise that resolved: Promise { <resolved> }`.
  const p = bounded(sh(
    'trap "exit 0" TERM; printf "PARTIAL-HALF-A-BRIEFING"; sleep 5 1>&- & sleep 30 & wait',
    { timeoutMs: 300, killGraceMs: 2_000, flushMs: 200 },
  ).generate("x"));
  await expect(p).rejects.toMatchObject({ code: "timeout" });
  await expect(p).rejects.not.toThrow(/PARTIAL-HALF/);
});

// ─── Step 10: the truncation warning. ───────────────────────────────────────────────────────────────

const TRUNC = "its output stream never closed";

test("T13: a held pipe warns; a clean EOF does NOT", async () => {
  // The negative half is the point. An UNCONDITIONAL `this.warn(...)` is not killed by the positive
  // case alone, and it would put a false "may be cut off" line into every briefing, every morning.
  const held: string[] = [];
  await bounded(sh("echo BRIEFING; sleep 3 &", { flushMs: 150, onWarning: (w: string) => held.push(w) }).generate("x"));
  expect(held.some((w) => w.includes(TRUNC))).toBe(true);

  const clean: string[] = [];
  await bounded(sh("echo BRIEFING", { flushMs: 150, onWarning: (w: string) => clean.push(w) }).generate("x"));
  expect(clean).toEqual([]);
});

test("T7b: a ONE-SIDED hold (complete stdout, held stderr) does not warn about truncation", async () => {
  // Widening the warn gate to `!o.sink.complete || !e.sink.complete` survives T7 (which asserts only
  // the returned text) and T13 (whose fixtures are held-stdout and clean-EOF). stdout was complete
  // here, so the result is whole and claiming otherwise would be a lie told every morning.
  const ws: string[] = [];
  const out = await bounded(sh("echo BRIEFING; sleep 3 1>/dev/null &", { flushMs: 150, onWarning: (w: string) => ws.push(w) }).generate("x"));
  expect(out.trim()).toBe("BRIEFING");
  expect(ws.some((w) => w.includes(TRUNC))).toBe(false);
});

test("T13c: a THROWING onWarning cannot fail a call that already succeeded", async () => {
  // MUTATION: delete the try/catch in `warn` → the throw escapes as a non-ProviderError, which
  // withRetry rethrows with zero retries.
  const out = await bounded(sh("echo BRIEFING; sleep 3 &", {
    flushMs: 150, onWarning: () => { throw new Error("hook exploded"); },
  }).generate("x"));
  expect(out.trim()).toBe("BRIEFING");
});

test("T13d: the wrapper's own onWarning wins over one passed by a caller", async () => {
  // `HardenOpts` extends `ProviderOpts`, so `onWarning` is structurally caller-settable and only
  // argument ORDER stops a caller's handler from swallowing every provider warning. Moving the
  // wrapper's `onWarning` before the `...opts` spread in `build()` is the mutation.
  const { hardenedProvider } = await import("../src/harden");
  const callers: string[] = [];
  const hp = hardenedProvider(
    { cli: "sh", argv: ["-c", "echo BRIEFING; sleep 3 &"], promptVia: "stdin" } as any,
    { flushMs: 150, onWarning: (w: string) => callers.push(w) } as any,
  );
  await bounded(hp.generate("x"));
  expect(hp.runtimeWarnings.some((w) => w.includes(TRUNC))).toBe(true);
});

test("T13b: the truncation warning carries no POSTURE_MARKERS substring", async () => {
  // If it did, `postureLine` would classify a truncated run as `degraded` and EVAL.md rows would blame
  // hardening for a stream problem. The text is deliberately outside that vocabulary — which is also
  // why test/posture.test.ts has to allow it explicitly rather than match it.
  const { isPostureWarning } = await import("../src/eval/posture");
  const ws: string[] = [];
  await bounded(sh("echo BRIEFING; sleep 3 &", { flushMs: 150, onWarning: (w: string) => ws.push(w) }).generate("x"));
  const t = ws.find((w) => w.includes(TRUNC))!;
  expect(t).toBeDefined();
  expect(isPostureWarning(t)).toBe(false);
});

// ─── Step 12: the two security gates. ───────────────────────────────────────────────────────────────

test("T14: the normal flush window stays above the fail-fast cap (a security invariant now)", async () => {
  const { flushWindowMs, failFastMs, TIMEOUT_MS } = await import("../src/provider");
  expect(flushWindowMs(false, {})).toBeGreaterThan(failFastMs(TIMEOUT_MS));
});

test("T14b: the flush TIERS are not swapped", async () => {
  // T14 alone does not catch a branch swap in either direction once it is phrased against the
  // function, but this states the wiring outright: the killed tier is the SHORT one. Measured, a swap
  // drops a race-lost attempt's durationMs from ~10007ms to ~1007ms — under the 5000ms cap — while
  // leaving both constants, and every other test, untouched.
  const { flushWindowMs } = await import("../src/provider");
  expect(flushWindowMs(true, {})).toBeLessThan(flushWindowMs(false, {}));
  expect(flushWindowMs(false, { flushMs: 42 })).toBe(42);   // an injected value still wins
});

test("T16: an error carrying possibly-partial bytes is stamped partialRead", async () => {
  const p = bounded(sh("echo REALCAUSE; sleep 3 & exit 1", { flushMs: 150 }).generate("x"));
  await expect(p).rejects.toMatchObject({ partialRead: true });
});

test("T17: a CLEAN failure is not stamped — partialRead is not unconditional", async () => {
  // The anti-over-correction mirror of T16. Stamping unconditionally would kill the B6 fast path
  // everywhere and revert its measured 3.09s / 2 calls to 138.4s / 5.
  const p = bounded(sh("echo nope >&2; exit 2", { flushMs: 150 }).generate("x"));
  await expect(p).rejects.toMatchObject({ partialRead: false });
});

test("T2c: exit 127 with a HELD pipe stays retryable, never permanent missing-binary", async () => {
  // `missing-binary` means zero retries and "install a CLI" advice. A genuinely absent binary throws
  // ENOENT at spawn, long before any stream exists, so gating this on a complete read cannot mask it —
  // it can only stop a held pipe from turning a retryable failure into an unrecoverable one.
  const p = bounded(sh("echo 'sh: nosuchcmd: not found' >&2; sleep 3 & exit 127", { flushMs: 150 }).generate("x"));
  await expect(p).rejects.toMatchObject({ code: "nonzero-exit" });
});

test("T14c: attempt() actually CALLS flushWindowMs — the call site is pinned statically", async () => {
  // T14/T14b test the exported function in isolation. Nothing stopped the call site from being
  // re-inlined as a ternary — including a SWAPPED one — because every timing-sensitive test injects
  // `flushMs` and so cannot observe the default tiers at all. A static scan is the only thing that can
  // see it, the same reasoning as the source guards in test/posture.test.ts.
  const raw = await Bun.file(new URL("../src/provider.ts", import.meta.url)).text();
  // Strip comments first. Without this the pin is satisfiable by PROSE: re-inlining the call site with
  // numeric literals and leaving a comment that mentions `flushWindowMs(timedOut` passes both
  // assertions (measured). A source-scanning guard that a comment can satisfy is the same class of
  // fake guard this file exists to avoid.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const body = src.slice(src.indexOf("private async attempt("));
  expect(`call site: ${/flushWindowMs\(\s*timedOut/.test(body)}`).toBe("call site: true");
  // ...and the tier constants must not reappear inline anywhere below the helper that owns them.
  expect(`inline tiers: ${/timedOut \? FLUSH_/.test(body)}`).toBe("inline tiers: false");
  // F1: the computed value must also be THREADED INTO the shared raceFlush. Calling flushWindowMs and
  // then passing something else is a dead local — and `tsconfig.json` sets no `noUnusedLocals`, so
  // `tsc` will not catch it, T14/T14b test the function in isolation, and every timing-sensitive test
  // here injects `flushMs`. The whole suite stays green while the post-exit window silently collapses
  // from FLUSH_EXITED_MS (10s) to 500ms — on the post-wake 7:20 run, which is the case that tier
  // exists for, and which provider.ts calls a SECURITY invariant that must fail loudly.
  //
  // ANCHORED on the bare local, not a substring. `/raceFlush\([^)]*flushMs/` looks equivalent and is
  // NOT: it matches `raceFlush(o, e, this.t.flushMs ?? 500)` — the exact severed form — because
  // `this.t.flushMs` CONTAINS "flushMs". Measured: substring form → correct=true / severed=true;
  // anchored form → correct=true / severed=false.
  expect(`threaded: ${/raceFlush\(\s*\w+\s*,\s*\w+\s*,\s*flushMs\s*\)/.test(body)}`).toBe("threaded: true");
  // ...and the call must sit AFTER `await proc.exited`. Position is the only thing that makes
  // `timedOut` meaningful: it is set solely by the timer callback, so hoisting this above the exit
  // await makes it always false, silently selecting FLUSH_EXITED_MS (10s) on the killed path where
  // FLUSH_KILLED_MS (1s) is intended. Measured: the hoist leaves the suite at 930 pass / 0 fail,
  // because the two scans above pin the CALL and the THREADING but not where it happens.
  expect(`after exit: ${/await proc\.exited;[\s\S]*?flushWindowMs\(\s*timedOut/.test(body)}`).toBe("after exit: true");
});

test("T13e: the harden:false path also lets the wrapper's onWarning win", async () => {
  // T13d pins the ordering at `build()`. The disabled path constructs a provider separately and has
  // the same requirement; reordering it survived the whole suite.
  // `HardenOpts` now Omits `onWarning`, so this collision is a TYPE error for honest callers — which
  // is the real fix. It stays pinned at runtime because `as any` still reaches it, and because the
  // ordering is what makes the Omit safe rather than merely tidy. Passing a caller handler is the
  // whole point: without one the spread has nothing to override and the mutation is invisible
  // (measured — my first version of this test missed it).
  const { hardenedProvider } = await import("../src/harden");
  const swallowed: string[] = [];
  const hp = hardenedProvider(
    { cli: "sh", argv: ["-c", "echo BRIEFING; sleep 3 &"], promptVia: "stdin", harden: false } as any,
    { flushMs: 150, onWarning: (w: string) => swallowed.push(w) } as any,
  );
  await bounded(hp.generate("x"));
  expect(hp.runtimeWarnings.some((w) => w.includes(TRUNC))).toBe(true);
});
