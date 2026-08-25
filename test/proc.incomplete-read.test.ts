// test/proc.incomplete-read.test.ts
//
// F2 — `run()` (the audit script's spawn helper) must not hang on a held pipe, and must not report
// a partial read as success.
//
// The bug it fixes: scripts/audit.ts awaited `Promise.all([stdout.text(), stderr.text()])` BEFORE
// `p.exited`, with NO flush race at all — strictly worse than the `runGit` bug fixed in #116, which
// at least awaited `exited` first. A child that exits while a backgrounded grandchild holds the
// inherited pipe never EOFs, so `.text()` never resolves and the audit hangs forever. It runs against
// the REAL repos, which is the population where that pathology actually occurs.
//
// The policy, and why it differs per caller (see src/proc.ts's header): `run()` decides NOTHING about
// what a partial read means. It reports `complete`, and additionally forces `code = -1` when stdout
// did not reach EOF — because `code` already means "did this invocation produce trustworthy output"
// (a spawn throw has always mapped to -1), and both existing call sites already gate on it. That
// makes the safe behaviour the one you get without an edit: a caller that never reads `complete`
// still cannot mistake a partial read for success.
import { test, expect, spyOn } from "bun:test";
import { run, DEFAULT_FLUSH_MS, DEFAULT_TIMEOUT_MS } from "../src/proc";

/** A stream that emits `chunks` then NEVER closes — models a grandchild holding the inherited pipe. */
function neverEofStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); /* deliberately no c.close() */ },
  });
}

function eofStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); },
  });
}

/** Emits `chunks`, then ERRORS instead of EOF-ing — the pipe read itself failing (EIO), which is a
 *  different event from a held pipe but must reach the SAME not-trustworthy conclusion. */
function erroringStream(chunks: string[], delayMs: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      if (delayMs) await Bun.sleep(delayMs);
      c.error(new Error("EIO: i/o error, read"));
    },
  });
}

function fakeSpawn(opts: {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  // `number | null`, not `number`: a child killed by a signal reports exitCode NULL, and the previous
  // signature made that state INEXPRESSIBLE — which is why `?? 1` went unpinned while being the only
  // thing standing between a SIGKILL-truncated briefing and the caller's success path.
  exitCode?: number | null;
  signalCode?: string | null;
  exited?: Promise<number>;
}) {
  const exitCode = opts.exitCode === undefined ? 0 : opts.exitCode;
  return {
    stdout: opts.stdout,
    stderr: opts.stderr,
    exited: opts.exited ?? Promise.resolve(exitCode ?? 137),
    exitCode,
    signalCode: opts.signalCode ?? null,
    kill() {},
  } as unknown as ReturnType<typeof Bun.spawn>;
}

/** Bound every call under test: WITHOUT the fix these hang forever (that IS the bug), and a hanging
 *  test wedges CI instead of failing it. Clear the guard timer in `finally` — the production code
 *  this suite exists to test clears its losing flush timer, so the helper must not leak one. */
const HUNG = Symbol("hung");
async function bounded<T>(p: Promise<T>, ms = 5_000): Promise<T> {
  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const guard = new Promise<typeof HUNG>((r) => { guardTimer = setTimeout(() => r(HUNG), ms); });
    const winner = await Promise.race([p, guard]);
    if (winner === HUNG) throw new Error(`run() never returned within ${ms}ms — it is hanging on a stream that never EOFs`);
    return winner as T;
  } finally { if (guardTimer) clearTimeout(guardTimer); }
}

test("run() returns the output and exit code for a normal, fully-EOF'd invocation", async () => {
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: eofStream(["hello\n"]), stderr: eofStream(["warn\n"]) }));
  try {
    const r = await bounded(run(["echo", "hello"]));
    expect(r).toEqual({ out: "hello\n", err: "warn\n", code: 0, complete: true, spawned: true, signal: null, timedOut: false });
  } finally { spy.mockRestore(); }
});

test("run() does NOT HANG when the child exits 0 but stdout never EOFs — the F2 bug", async () => {
  // Before the fix this never returns: `.text()` resolves only at EOF and nothing raced it.
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: neverEofStream(["partial output"]), stderr: eofStream([]) }));
  try {
    const r = await bounded(run(["git", "log"], { flushMs: 50 }));
    expect(r.complete).toBe(false);
  } finally { spy.mockRestore(); }
});

test("an incomplete stdout forces code = -1 EVEN THOUGH the child exited 0 — the fail-safe mapping", async () => {
  // The contract that makes this fix work without editing every call site. Both existing consumers
  // gate on `code` (`dayShasAndText`'s `code !== 0` skip and `checkShas`'s `code === 0` — by symbol,
  // since the line numbers this comment first cited were stale on arrival), so mapping an incomplete
  // read onto the already-honoured failure sentinel routes it into their failure branch with no edit
  // — and a FUTURE call site that never reads `complete` still cannot mistake partial output
  // for success. Pinned separately from the no-hang test above: returning `complete: false` while
  // leaving `code: 0` would satisfy that test and still fabricate a quiet day at every call site.
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: neverEofStream(["3 commits worth of log output"]), stderr: eofStream([]), exitCode: 0 }));
  try {
    const r = await bounded(run(["git", "log"], { flushMs: 50 }));
    expect(r.code).toBe(-1);
    expect(r.complete).toBe(false);
    // The recovered bytes SURVIVE. This is the single property that distinguishes `drain` from racing
    // `.text()` (which yields "" on a held pipe), and stream.ts argues for its own existence on it.
    expect(r.out).toBe("3 commits worth of log output");
  } finally { spy.mockRestore(); }
});

test("a genuinely empty stdout that EOF'd is COMPLETE and code 0 — the discriminator", async () => {
  // `git status --porcelain` on a clean tree, `git log` with no in-window commits. "" is a legitimate
  // result here, so it must NOT be confused with the held-pipe case above. This is the whole reason
  // `complete` exists rather than inferring failure from an empty payload.
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: eofStream([]), stderr: eofStream([]) }));
  try {
    const r = await bounded(run(["git", "status", "--porcelain"]));
    expect(r).toEqual({ out: "", err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false });
  } finally { spy.mockRestore(); }
});

test("a held STDERR with a complete stdout is still a SUCCESS (gate on stdout only)", async () => {
  // Mirrors runGit's stdout-only gate: the payload is stdout, and stderr is diagnostics. Gating on
  // both would turn a chatty-but-successful command into a failure.
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: eofStream(["real output\n"]), stderr: neverEofStream(["noise\n"]) }));
  try {
    const r = await bounded(run(["git", "status"], { flushMs: 50 }));
    expect(r.out).toBe("real output\n");
    expect(r.code).toBe(0);
    expect(r.complete).toBe(true);
    // The RECOVERED stderr bytes, not just the fact of success: `getBriefing` builds its whole
    // diagnostic from `err`, and dropping partial stderr reproduces the bare-`exit=1` regression the
    // audit script records as having already happened once.
    expect(r.err).toBe("noise\n");
  } finally { spy.mockRestore(); }
});

test("an ERRORED stdout is not-trustworthy too, and does not throw out of run()", async () => {
  // A read error is a different event from a held pipe, but reaches the same conclusion. It must not
  // propagate: `run()`'s contract is to report facts, and the existing catch already flattens a spawn
  // throw into code -1.
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: erroringStream(["partial"], 0), stderr: eofStream([]) }));
  try {
    const r = await bounded(run(["git", "log"], { flushMs: 50 }));
    expect(r.complete).toBe(false);
    expect(r.code).toBe(-1);
  } finally { spy.mockRestore(); }
});

test("a read error BEFORE `exited` resolves is caught, not an unhandled rejection", async () => {
  // The drains start immediately but the first handler is attached only after `await p.exited`. A
  // rejection inside that window had nobody listening in the original git.ts bug — an unhandled
  // rejection that escaped the function entirely. Real children take macrotask-scale time to exit,
  // so this window is the common case, not the exotic one.
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({
      stdout: erroringStream(["partial"], 10), stderr: eofStream([]),
      exited: Bun.sleep(100).then(() => 0),
    }));
  try {
    const r = await bounded(run(["git", "log"], { flushMs: 50 }));
    expect(r.complete).toBe(false);
    expect(r.code).toBe(-1);
  } finally { spy.mockRestore(); }
});

test("output arriving ASYNCHRONOUSLY after exit is kept in full (the flush window is real)", async () => {
  // Deliberately NOT a pre-closed stream: enqueuing everything up front means the drain finishes
  // before run() is called, so the race can never lose and the test would pass with a 0ms window —
  // vacuous w.r.t. its own name. Deliver across ticks with EOF landing after `exited` resolves.
  const chunk = "a".repeat(50_000);
  const CHUNKS = 10;
  const slow = new ReadableStream<Uint8Array>({
    async pull(c) {
      const enc = new TextEncoder();
      for (let i = 0; i < CHUNKS; i++) { await Bun.sleep(1); c.enqueue(enc.encode(chunk)); }
      c.close();
    },
  });
  const spy = spyOn(Bun, "spawn").mockImplementation(() => fakeSpawn({ stdout: slow, stderr: eofStream([]) }));
  try {
    const r = await bounded(run(["git", "log", "--numstat"], { flushMs: 5_000 }));
    expect(r.out.length).toBe(chunk.length * CHUNKS);
    expect(r.complete).toBe(true);
    expect(r.code).toBe(0);
  } finally { spy.mockRestore(); }
});

test("multi-byte UTF-8 split across a chunk boundary decodes once, not per chunk", async () => {
  // "é" is 0xC3 0xA9; per-chunk decoding yields two U+FFFDs. Commit subjects contain non-ASCII, and
  // this text reaches both the SHA matching and the judge prompt.
  const enc = new TextEncoder().encode("café ☕ 日本語");
  const cut = 4; // lands mid-sequence
  const split = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.slice(0, cut)); c.enqueue(enc.slice(cut)); c.close(); },
  });
  const spy = spyOn(Bun, "spawn").mockImplementation(() => fakeSpawn({ stdout: split, stderr: eofStream([]) }));
  try {
    expect((await bounded(run(["git", "log"]))).out).toBe("café ☕ 日本語");
  } finally { spy.mockRestore(); }
});

test("a NONZERO exit with complete reads keeps its real exit code (not flattened to -1)", async () => {
  // -1 must stay meaningful as "output not trustworthy". A command that legitimately failed and told
  // us so through its exit code is a DIFFERENT event, and the regeneration site's error message
  // prints this number.
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: eofStream([]), stderr: eofStream(["fatal: not a git repository\n"]), exitCode: 128 }));
  try {
    const r = await bounded(run(["git", "log"]));
    expect(r.code).toBe(128);
    expect(r.complete).toBe(true);
    expect(r.err).toContain("not a git repository");
  } finally { spy.mockRestore(); }
});

test("a spawn that THROWS is reported, not propagated (existing contract preserved)", async () => {
  const spy = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("ENOENT: no such file"); });
  try {
    const r = await bounded(run(["nope"]));
    expect(r.code).toBe(-1);
    expect(r.complete).toBe(false);
    expect(r.err).toContain("ENOENT");
    expect(r.out).toBe("");
    // `spawned: false` is what lets a consumer tell "no process ever ran" from "a pipe never
    // finished" — both arrive as code -1 / complete false, but only one is worth re-running.
    expect(r.spawned).toBe(false);
  } finally { spy.mockRestore(); }
});

test("flushMs is honoured: the same slow stream is incomplete under a short window, complete under a long one", async () => {
  // Pins the injectable seam itself. Without this, hardcoding the window would survive the suite —
  // and the regeneration call site deliberately passes a much longer window than the git calls.
  const makeSlow = () => new ReadableStream<Uint8Array>({
    async pull(c) { await Bun.sleep(300); c.enqueue(new TextEncoder().encode("late\n")); c.close(); },
  });

  let spy = spyOn(Bun, "spawn").mockImplementation(() => fakeSpawn({ stdout: makeSlow(), stderr: eofStream([]) }));
  try {
    expect((await bounded(run(["slow"], { flushMs: 20 }))).complete).toBe(false);
  } finally { spy.mockRestore(); }

  spy = spyOn(Bun, "spawn").mockImplementation(() => fakeSpawn({ stdout: makeSlow(), stderr: eofStream([]) }));
  try {
    const r = await bounded(run(["slow"], { flushMs: 3_000 }));
    expect(r.complete).toBe(true);
    expect(r.out).toBe("late\n");
  } finally { spy.mockRestore(); }
});

/** A stream that never EOFs and reports whether its reader was cancelled — for pinning abandonment,
 *  which no assertion about the RETURNED VALUE can see. */
function heldWithCancelFlag(): { stream: ReadableStream<Uint8Array>; wasCancelled: () => boolean } {
  let cancelled = false;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) { await Bun.sleep(5); c.enqueue(enc.encode("noise\n")); },   // keeps producing, never closes
    cancel() { cancelled = true; },
  });
  return { stream, wasCancelled: () => cancelled };
}

test("a ONE-SIDED hold still RELEASES the held reader — stderr held, stdout complete", async () => {
  // Pins the `||` in the abandon guard. Measured: weakening it to `&&` leaves every other test in this file
  // green, because every one of them asserts on the RETURNED VALUE and abandonment is invisible
  // there. Unreleased, a grandchild that keeps writing grows the sink for the life of the process.
  //
  // ⚠ UPDATED BY F1. This used to say the property was "pinned by the provider alone" and that this
  // was "a third copy shipping pinned rather than a fourth unguarded one". Both are now wrong, in
  // opposite directions: the claim was inherited from a stale comment in stream.ts written before
  // proc.ts existed (so proc.ts was ALREADY the second pin, not the third copy), and there is no
  // longer a copy at all — the guard lives once, in stream.ts's `raceFlush`. What this test still
  // uniquely buys is CALL-SITE coverage: a stream-level test cannot see whether `run()` passes both
  // handles, and `raceFlush(o, o, ms)` is tsc-clean. Do not delete it as redundant.
  const held = heldWithCancelFlag();
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: eofStream(["done\n"]), stderr: held.stream }));
  try {
    const r = await bounded(run(["git", "status"], { flushMs: 50 }));
    expect(r.complete).toBe(true);            // stdout-only gate still says success…
    expect(held.wasCancelled()).toBe(true);   // …and the held stderr reader was still released
  } finally { spy.mockRestore(); }
});

test("a ONE-SIDED hold still RELEASES the held reader — stdout held, stderr complete", async () => {
  // The mirror case, and the one that matters most: under `&&` this leaves the HELD side attached
  // precisely when the payload pipe is the one being held.
  const held = heldWithCancelFlag();
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: held.stream, stderr: eofStream([]) }));
  try {
    const r = await bounded(run(["git", "log"], { flushMs: 50 }));
    expect(r.complete).toBe(false);
    expect(held.wasCancelled()).toBe(true);
  } finally { spy.mockRestore(); }
});

test("REAL process: a large stdin payload round-trips intact across many chunks", async () => {
  // No fake: real spawn, real pipes, real EOF, and a payload big enough to arrive as many chunks —
  // so it pins that the sink CONCATENATES rather than keeping one chunk (dropping all but the first
  // fails the length assertion).
  //
  // This test previously claimed to prove the drain-before-stdin ordering prevents a deadlock. It
  // did not, and could not: measured, Bun buffers the entire stdin payload in memory (10 MB into
  // `cat`, `end()` resolved in 4 ms with nothing draining stdout), so the deadlock it named cannot
  // occur through this API — the test was vacuous w.r.t. its own title. Retitled to what it actually
  // verifies. `cat-file --batch-check` is fed every cited SHA, so the multi-chunk path is real.
  const payload = "x".repeat(1_000_000) + "\n";
  const r = await bounded(run(["cat"], { input: payload, flushMs: 2_000 }), 20_000);
  expect(r.code).toBe(0);
  expect(r.complete).toBe(true);
  expect(r.out.length).toBe(payload.length);
});

test("REAL process: a genuinely clean git tree still reads as complete success", async () => {
  // Guards against the whole fix being tuned to fakes: a real spawn, real pipes, real EOF.
  const r = await bounded(run(["git", "--version"]), 20_000);
  expect(r.code).toBe(0);
  expect(r.complete).toBe(true);
  expect(r.out).toContain("git version");
});

test("a SIGNAL-killed child: exitCode is null, pipes EOF, and `code` must NOT become 0", async () => {
  // The second axis, which the suite could not previously express. A killed child CLOSES its fds, so
  // stdout genuinely reaches EOF and `complete` is true — the -1 forcing never fires, leaving `?? 1`
  // as the only guard. Measured on a real `bash -c 'echo …; kill -9 $$'`: exitCode null, signalCode
  // SIGKILL, complete true. Under `?? 0` this returns code 0 and getBriefing accepts a TRUNCATED
  // briefing as today's, which is exactly the wrong-EVAL-row hazard the module exists to prevent.
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: eofStream(["half-a-brief"]), stderr: eofStream([]), exitCode: null, signalCode: "SIGKILL" }));
  try {
    const r = await bounded(run(["bun", "run", "src/main.ts"]));
    expect(r.complete).toBe(true);     // the pipe really did EOF — `complete` cannot save us here
    expect(r.code).toBe(1);            // NOT 0
    expect(r.signal).toBe("SIGKILL");  // preserved, so the operator can tell an OOM kill from a failure
  } finally { spy.mockRestore(); }
});

test("REAL process: `cwd` is honoured", async () => {
  // Untested until now, while the regeneration call passes `cwd: ROOT` — silently dropping it would
  // run the generator against the wrong tree. Mutating `cwd: opts?.cwd` to `undefined` survived
  // everything else in this file.
  const r = await bounded(run(["pwd"], { cwd: "/tmp" }), 20_000);
  expect(r.code).toBe(0);
  expect(r.out.trim()).toMatch(/(^|\/)tmp$/);
});

test("the DEFAULT flush window is used when none is given, and is neither 0 nor enormous", async () => {
  // Pins the DEFAULT itself, not just the seam. Both `DEFAULT_FLUSH_MS = 0` and `= 600_000` shipped
  // green before this: every other test passes `flushMs` explicitly, and the default-path tests used
  // streams that had already finished. 600_000 would stall every git call in the audit for ten
  // minutes; 0 would call every in-flight read incomplete.
  expect(DEFAULT_FLUSH_MS).toBeGreaterThan(50);
  expect(DEFAULT_FLUSH_MS).toBeLessThan(5_000);

  // …and behaviourally: a stream still arriving must be waited for on the DEFAULT path.
  const slow = new ReadableStream<Uint8Array>({
    async pull(c) { await Bun.sleep(120); c.enqueue(new TextEncoder().encode("late\n")); c.close(); },
  });
  const spy = spyOn(Bun, "spawn").mockImplementation(() => fakeSpawn({ stdout: slow, stderr: eofStream([]) }));
  try {
    const r = await bounded(run(["git", "log"]), 3_000);   // no flushMs
    expect(r.complete).toBe(true);
    expect(r.out).toBe("late\n");
  } finally { spy.mockRestore(); }
});

test("REAL process: a child that never exits is bounded by the timeout, not hung forever", async () => {
  // The other route to the SAME user-visible symptom F2 fixes: the flush race is only entered AFTER
  // `p.exited`, so without a spawn timeout a wedged child (an unresponsive network mount, a blocking
  // git hook) hangs the audit exactly as the held pipe did. `runGit` bounds the same binary over the
  // same repos at 30s; this had neither `timeout` nor `killSignal`.
  const t0 = Date.now();
  const r = await bounded(run(["sleep", "30"], { timeoutMs: 400 }), 10_000);
  expect(Date.now() - t0).toBeLessThan(5_000);
  expect(r.code).not.toBe(0);
});

test("the DEFAULT timeout exists and is sane — the hang guard must not be removable", async () => {
  // Measured: deleting `timeout: … ?? DEFAULT_TIMEOUT_MS` left the whole suite green, because the only
  // timeout test passed `timeoutMs` explicitly and nothing imported the constant. That mutation
  // reinstates the unbounded hang on the DEFAULT path — which is every git call the audit makes.
  expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(5_000);
  expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
});

test("REAL process: a TERM-IGNORING child is still killed — killSignal must be SIGKILL", async () => {
  // Measured: removing `killSignal: "SIGKILL"` also left the suite green, because the existing timeout
  // test uses `sleep`, which dies to Bun's default SIGTERM. A child that traps TERM — a wedged git
  // hook is the scenario proc.ts's own comment names — would then never die, `await p.exited` would
  // never resolve, and the F2 symptom returns by yet another route.
  const t0 = Date.now();
  const r = await bounded(run(["bash", "-c", "trap '' TERM; sleep 30"], { timeoutMs: 500 }), 12_000);
  expect(Date.now() - t0).toBeLessThan(8_000);
  expect(r.code).not.toBe(0);
  expect(r.timedOut).toBe(true);
});

test("REAL process: OUR timeout kill is reported as timedOut, not as an anonymous signal", async () => {
  // Without this fact the ceiling we impose is indistinguishable from an external/OOM kill, so the
  // audit's own 20-minute limit wore an OOM costume — and the message advised re-running a job
  // guaranteed to be killed again at the same limit.
  const r = await bounded(run(["sleep", "20"], { timeoutMs: 400 }), 10_000);
  expect(r.timedOut).toBe(true);
  expect(r.signal).toBe("SIGKILL");
});

test("a child that exits normally is NOT reported as timed out", async () => {
  // The other direction: `timedOut` must not become a synonym for "failed".
  const r = await bounded(run(["bash", "-c", "exit 3"], { timeoutMs: 10_000 }), 10_000);
  expect(r.timedOut).toBe(false);
  expect(r.code).toBe(3);
});

test("the default timeout and SIGKILL are WIRED INTO the spawn, not merely exported", async () => {
  // Measured: dropping the `?? DEFAULT_TIMEOUT_MS` fallback left the whole suite green, because the
  // only behavioural timeout tests pass `timeoutMs` explicitly and the constant was checked only for
  // its VALUE. A behavioural pin on the default path would have to wait the full 30s, so assert the
  // wiring instead — the spawn options are the contract, and both fields are hang guards.
  let seen: { timeout?: number; killSignal?: string } | undefined;
  const spy = spyOn(Bun, "spawn").mockImplementation(((_cmd: unknown, o: unknown) => {
    seen = o as { timeout?: number; killSignal?: string };
    return fakeSpawn({ stdout: eofStream(["x"]), stderr: eofStream([]) });
  }) as unknown as typeof Bun.spawn);
  try {
    await bounded(run(["git", "log"]));            // deliberately NO timeoutMs
    expect(seen?.timeout).toBe(DEFAULT_TIMEOUT_MS);
    expect(seen?.killSignal).toBe("SIGKILL");
  } finally { spy.mockRestore(); }
});

test("run() waits for EXIT before racing the flush — a slow but healthy child keeps its payload", async () => {
  // Mirror of git.ts's T3.6c. F1 collapsed the flush race to a single `await raceFlush(...)` line
  // adjacent to `await p.exited`, and nothing pinned their order. Measured on the merged code:
  // hoisting raceFlush above the exit await left the whole suite at 930 pass / 0 fail while every
  // child slower than the flush window has both readers abandoned mid-read and returns code -1.
  // Lower blast radius than git.ts (proc is eval/audit only, not on the main.ts path) but the same
  // one-line slip, so it gets the same pin.
  const enc = new TextEncoder();
  const slow = new ReadableStream<Uint8Array>({
    async start(c) { await Bun.sleep(400); c.enqueue(enc.encode("payload\n")); c.close(); },
  });
  const spy = spyOn(Bun, "spawn").mockImplementation(() => ({
    stdout: slow, stderr: eofStream([]),
    exited: Bun.sleep(400).then(() => 0), exitCode: 0, signalCode: null, stdin: null, kill() {},
  } as unknown as ReturnType<typeof Bun.spawn>));
  try {
    const r = await bounded(run(["git", "log"], { flushMs: 100 }));   // flush window << the child's runtime
    expect(r.complete).toBe(true);
    expect(r.code).toBe(0);
    expect(r.out).toBe("payload\n");
  } finally { spy.mockRestore(); }
});

test("a large stdin payload against a child that exits immediately still returns cleanly", async () => {
  // ⚠ THIS TEST DOES NOT PIN THE stdin.write() FIX, and says so rather than implying it does.
  // What it pins: `run()` returns a well-formed RunResult when the write promise rejects underneath
  // it. What it CANNOT pin: that the rejection is handled. Measured — removing
  // `if (wrote instanceof Promise) wrote.catch(...)` from src/proc.ts leaves the whole suite green.
  //
  // The mechanism IS real: a standalone script measured `unhandled rejections: 1 :: EPIPE: broken
  // pipe, send` for both a child that exits immediately and one we SIGKILL, on a 5 MB write. But an
  // `unhandledRejection` listener that fires standalone does NOT fire under `bun test` — the same
  // harness shape used at test/transcripts-wiring.test.ts:346 works there and not here. So the fix
  // is knowingly UNPINNED, which is the honest state to leave it in: it is out of F1/F3 scope,
  // unreachable under the default prompt budget, and defended by argument rather than by a test.
  const r = await bounded(run(["sh", "-c", "exit 0"], { input: "x".repeat(2_000_000), flushMs: 50 }), 10_000);
  expect(r.spawned).toBe(true);
  expect(r.code).toBe(0);
  expect(r.complete).toBe(true);
});
