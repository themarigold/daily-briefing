// test/git.incomplete-read.test.ts
//
// C1/A1 — `runGit` must distinguish "empty because the tree is clean" (success) from "empty
// because a grandchild is holding the pipe and it never EOF'd" (FAIL CLOSED).
//
// The bug: git.ts awaited `Promise.all([stdout.text(), stderr.text()])` BEFORE `p.exited`, with no
// race. A git that exits 0 while a backgrounded grandchild holds the inherited pipe never EOFs, and
// `timeout` cannot fire because the child already exited cleanly — so runGit hung forever.
//
// The trap in the obvious fix: `.text()` is all-or-nothing (it resolves only at EOF), so racing it
// against a flush window yields "" rather than a partial. Since "" is a LEGITIMATE success for
// runGit (`git log` with no in-window commits; `git status --porcelain` on a clean tree), the naive
// port silently returns "" as success — a fabricated quiet day that stamps the day. That is worse
// than the hang, which at least fails visibly.
import { test, expect, spyOn } from "bun:test";
import { runGit, IncompleteReadError } from "../src/git";
import { buildRepo } from "./fixtures/build-repo";

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

/** Fake a `Bun.spawn` result: the child exits cleanly, but the named streams may never EOF. */
function fakeSpawn(opts: { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exitCode?: number }) {
  return {
    stdout: opts.stdout,
    stderr: opts.stderr,
    exited: Promise.resolve(opts.exitCode ?? 0),
    exitCode: opts.exitCode ?? 0,
    signalCode: null,
    kill() {},
  } as unknown as ReturnType<typeof Bun.spawn>;
}

/** Bound every runGit call under test. WITHOUT the fix these hang forever (that is the bug), and a
 *  hanging test wedges CI instead of failing it — so race a guard and surface a clear message. */
const HUNG = Symbol("hung");
async function bounded<T>(p: Promise<T>, ms = 5_000): Promise<T> {
  // Clear the guard in `finally`. Leaving ~14 live 5s timers per run is only hygiene here, but the
  // production code this suite exists to test was fixed for exactly this (runGit clears its losing
  // flush timer) — a helper that leaks the thing it verifies is a bad look and a worse example.
  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const guard = new Promise<typeof HUNG>((r) => { guardTimer = setTimeout(() => r(HUNG), ms); });
    const winner = await Promise.race([p, guard]);
    if (winner === HUNG) throw new Error(`runGit never returned within ${ms}ms — it is hanging on a stream that never EOFs`);
    return winner as T;
  } finally { if (guardTimer) clearTimeout(guardTimer); }
}

test("runGit THROWS IncompleteReadError when the child exits 0 but stdout never EOFs (grandchild holds the pipe)", async () => {
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: neverEofStream(["abc1234 a real commit subject\n"]), stderr: eofStream([]) }));
  try {
    // Must FAIL CLOSED. Returning the partial — or worse, "" — would be a fabricated quiet day.
    await expect(bounded(runGit(["log"], "/tmp"))).rejects.toBeInstanceOf(IncompleteReadError);
  } finally { spy.mockRestore(); }
});

test("runGit returns \"\" as SUCCESS for a genuinely empty result (clean tree) — the discriminator", async () => {
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: eofStream([]), stderr: eofStream([]) }));   // EOF'd, just empty
  try {
    expect(await runGit(["status", "--porcelain"], "/tmp")).toBe("");
  } finally { spy.mockRestore(); }
});

test("runGit succeeds when only STDERR is held and stdout completed (gate on stdout only)", async () => {
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: eofStream(["on branch main\n"]), stderr: neverEofStream(["warning: noise\n"]) }));
  try {
    expect(await bounded(runGit(["status"], "/tmp"))).toBe("on branch main\n");
  } finally { spy.mockRestore(); }
});

test("runGit returns COMPLETE output for a large payload delivered ASYNCHRONOUSLY after exit", async () => {
  // Deliberately NOT a pre-closed stream: enqueuing everything up front means the drain finishes
  // before runGit is even called, so the race can never lose and the test passes even with a 0ms
  // flush window — vacuous w.r.t. its own name. Deliver in chunks that arrive across ticks, with
  // EOF landing after `exited` resolves, so the flush window is genuinely exercised.
  const chunk = "a".repeat(100_000);
  const CHUNKS = 20;
  const slow = new ReadableStream<Uint8Array>({
    async pull(c) {
      const enc = new TextEncoder();
      for (let i = 0; i < CHUNKS; i++) { await Bun.sleep(1); c.enqueue(enc.encode(chunk)); }
      c.close();
    },
  });
  const spy = spyOn(Bun, "spawn").mockImplementation(() => fakeSpawn({ stdout: slow, stderr: eofStream([]) }));
  try {
    expect((await bounded(runGit(["log", "--numstat"], "/tmp"))).length).toBe(chunk.length * CHUNKS);
  } finally { spy.mockRestore(); }
});

test("runGit decodes multi-byte UTF-8 split across a chunk boundary (single decode, not per-chunk)", async () => {
  // "é" is 0xC3 0xA9; splitting it across chunks would yield U+FFFD twice under per-chunk decoding.
  const enc = new TextEncoder().encode("café ☕ 日本語");
  const cut = 4;   // lands mid-sequence
  const split = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.slice(0, cut)); c.enqueue(enc.slice(cut)); c.close(); },
  });
  const spy = spyOn(Bun, "spawn").mockImplementation(() => fakeSpawn({ stdout: split, stderr: eofStream([]) }));
  try {
    expect(await bounded(runGit(["log"], "/tmp"))).toBe("café ☕ 日本語");
  } finally { spy.mockRestore(); }
});

/** A stream that emits `chunks` then ERRORS instead of EOF-ing — models the pipe read itself
 *  failing (an EIO on the fd, a Bun-internal stream failure) rather than being held open. */
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

test("a stream that ERRORS instead of EOF-ing is an IncompleteReadError, not a raw error", async () => {
  // The read is incomplete either way, so it must reach the SAME fail-closed routing. Leaking the
  // raw error instead means every `orElse` site swallows it (gitDirExists → false, resolveAuthor →
  // "" = NO AUTHOR FILTER) and extractor's inner catch routes it down the unborn-HEAD/classify path
  // to a `not-a-repo` issue — which is NOT isInaccessible, so the run stamps a fabricated quiet day.
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: erroringStream(["partial output"], 0), stderr: eofStream([]) }));
  try {
    await expect(bounded(runGit(["log"], "/tmp"))).rejects.toBeInstanceOf(IncompleteReadError);
  } finally { spy.mockRestore(); }
});

test("a read error BEFORE `exited` resolves is caught, not an unhandled rejection", async () => {
  // `drain` starts the reads at once but the first handler is attached only after `await p.exited`.
  // A read that rejects inside that window left `done` rejected with nobody listening — an unhandled
  // rejection that escaped runGit entirely (it never reached any caller's catch) and in production
  // aborts the run. Real git takes macrotask-scale time to exit, so this window is the common case.
  const spy = spyOn(Bun, "spawn").mockImplementation(() => ({
    stdout: erroringStream(["partial"], 10), stderr: eofStream([]),
    exited: Bun.sleep(100).then(() => 0), exitCode: 0, signalCode: null, kill() {},
  }) as unknown as ReturnType<typeof Bun.spawn>);
  try {
    await expect(bounded(runGit(["log"], "/tmp"))).rejects.toBeInstanceOf(IncompleteReadError);
  } finally { spy.mockRestore(); }
});

test("the IncompleteReadError names the underlying cause when the read errored", async () => {
  // Diagnosis honesty, the same standard that gave gitAvailable three outcomes instead of two: the
  // fix for "a hook is holding the pipe" is not the fix for "the pipe broke", so the message must
  // not assert the former when it observed the latter.
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: erroringStream(["partial"], 0), stderr: eofStream([]) }));
  try {
    const e: Error = await bounded(runGit(["log"], "/tmp")).then(
      () => { throw new Error("expected a rejection"); }, (err: Error) => err);
    // The EXACT parenthetical, not a substring: `toContain("EIO: i/o error, read")` alone is also
    // satisfied by the `String(err)` form ("Error: EIO…"), so dropping the `instanceof Error →
    // .message` branch survived it.
    expect(e.message).toContain("(EIO: i/o error, read)");
    expect(e.message).not.toContain("a child process is holding the pipe");
    expect((e as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
  } finally { spy.mockRestore(); }
});

test("a HELD (not errored) stdout keeps its original held-pipe wording and no cause", async () => {
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: neverEofStream(["partial"]), stderr: eofStream([]) }));
  try {
    const e: Error = await bounded(runGit(["log"], "/tmp")).then(
      () => { throw new Error("expected a rejection"); }, (err: Error) => err);
    expect(e.message).toContain("a child process is holding the pipe");
    expect((e as Error & { cause?: unknown }).cause).toBeUndefined();
  } finally { spy.mockRestore(); }
});

test("an errored STDERR with a complete stdout is still a SUCCESS (stdout-only gate holds)", async () => {
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: eofStream(["real output\n"]), stderr: erroringStream(["noise"], 0) }));
  try {
    expect(await bounded(runGit(["status"], "/tmp"))).toBe("real output\n");
  } finally { spy.mockRestore(); }
});

test("a stream erroring with literally `undefined` is still labelled a READ ERROR, not a held pipe", async () => {
  // The reason `failure` is a wrapper object rather than a bare `cause`: keying the two messages on
  // `cause !== undefined` mislabels this case as a held pipe. Inferring "did it fail" from "is the
  // payload absent" is the same mistake as the "" ambiguity this error class exists to resolve.
  const undef = new ReadableStream<Uint8Array>({ start(c) { c.error(undefined); } });
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: undef, stderr: eofStream([]) }));
  try {
    const e: Error = await bounded(runGit(["log"], "/tmp")).then(
      () => { throw new Error("expected a rejection"); }, (err: Error) => err);
    expect(e).toBeInstanceOf(IncompleteReadError);
    expect(e.message).not.toContain("a child process is holding the pipe");
    expect(e.message).toContain("could not be read to EOF");
  } finally { spy.mockRestore(); }
});

test("an exotic thrown value cannot make the IncompleteReadError constructor itself throw", async () => {
  // `String(Object.create(null))` throws TypeError: No default value. If that escaped the constructor,
  // callers would get a raw TypeError where they expect an IncompleteReadError — and every `orElse`
  // site swallows a TypeError, resurrecting the silent degradation via the error class itself.
  const hostile = new ReadableStream<Uint8Array>({ start(c) { c.error(Object.create(null)); } });
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: hostile, stderr: eofStream([]) }));
  try {
    const e: Error = await bounded(runGit(["log"], "/tmp")).then(
      () => { throw new Error("expected a rejection"); }, (err: Error) => err);
    expect(e).toBeInstanceOf(IncompleteReadError);
    // Pin the fallback's CONTENT too, not just that it didn't throw — blanking the string survived
    // the instance assertion, leaving the operator an empty parenthetical to diagnose from.
    expect(e.message).toContain("unprintable error value");
  } finally { spy.mockRestore(); }
});

test("IncompleteReadError.reason is the CAUSE CLAUSE ALONE, and differs per cause", async () => {
  // `reason` exists so the extractor's user-facing warnings can name what actually happened instead
  // of always asserting a held pipe. Nothing in the suite read it, so SIX mutations survived all 458
  // tests: blanking either branch, deleting all three interpolations, and `this.reason = why` — which
  // collapses the "clause alone" contract while still reading plausibly. Pin all three properties.
  const held = new IncompleteReadError(["log"], "/tmp");
  expect(held.reason).toContain("holding git's output pipe open");
  expect(held.reason).not.toContain("stdout");        // the CLAUSE, not the whole message
  expect(held.message).toContain("stdout never reached EOF");

  const errored = new IncompleteReadError(["log"], "/tmp", { cause: new Error("EIO: i/o error, read") });
  expect(errored.reason).toContain("the pipe read itself failed (EIO: i/o error, read)");
  expect(errored.reason).not.toContain("holding");     // must not assert the WRONG cause
  expect(errored.reason).not.toContain("stdout");
});

test("runGit still throws the existing nonzero-exit error (unchanged behaviour)", async () => {
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: eofStream([]), stderr: eofStream(["fatal: not a git repository\n"]), exitCode: 128 }));
  try {
    await expect(runGit(["log"], "/tmp")).rejects.toThrow(/not a git repository/);
  } finally { spy.mockRestore(); }
});

test("runGit against a REAL clean repo returns \"\" from status --porcelain (no fake, no regression)", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  expect(await runGit(["status", "--porcelain"], repo)).toBe("");
});

// ── F1 M3 (T3.6): runGit's abandon path ─────────────────────────────────────────────────────────
//
// WHY THESE ARE NEW. Before F1 this file had ZERO cancellation coverage (`grep -c cancel` → 0), and
// git.ts was one of the two sites where weakening the abandon guard's `||` to `&&` passed the ENTIRE
// suite silently — the other being probe.ts. Every test above asserts on runGit's RETURN VALUE, and
// abandonment is structurally invisible there: a held stderr with a complete stdout returns the same
// string either way. Only the stream's own `cancel()` hook can see it.
//
// These are CALL-SITE tests, not duplicates of test/stream.test.ts's shared pin. The shared pin
// proves `raceFlush` releases what it is given; these prove `runGit` gives it both handles.
// `raceFlush(o, o, ms)` is tsc-clean and would pass the shared pin. Do not delete as redundant.

/** Never EOFs, and reports whether its reader was really cancelled. Copied (not imported) from
 *  proc.incomplete-read.test.ts:268 — module-local there, and importing one test file into another
 *  re-registers its tests. Observing the SOURCE's cancel() hook rather than `sink.canceled` also
 *  kills the drop-`reader.cancel()` mutation, which a flag assertion passes. */
function heldWithCancelFlag(): { stream: ReadableStream<Uint8Array>; wasCancelled: () => boolean } {
  let cancelled = false;
  const enc = new TextEncoder();
  return {
    stream: new ReadableStream<Uint8Array>({
      async pull(c) { await Bun.sleep(5); c.enqueue(enc.encode("noise\n")); },
      cancel() { cancelled = true; },
    }),
    wasCancelled: () => cancelled,
  };
}

test("T3.6a — runGit RELEASES a held STDERR reader when stdout completed (one-sided `||`)", async () => {
  // One-sided is required: with both streams held, `||` and `&&` are indistinguishable.
  // stdout completes, so runGit SUCCEEDS and returns — the release is the only observable.
  const held = heldWithCancelFlag();
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: eofStream(["deadbeef\n"]), stderr: held.stream }));
  try {
    const out = await bounded(runGit(["log"], "/repo"));
    expect(out).toBe("deadbeef\n");          // stdout-only gate still reports success…
    expect(held.wasCancelled()).toBe(true);  // …and the held stderr reader was still released
  } finally { spy.mockRestore(); }
});

test("T3.6b — runGit RELEASES a held STDOUT reader (the mirror, and the one that matters most)", async () => {
  // Under `&&` this leaves the HELD side attached precisely when the payload pipe is the one being
  // held — and that is also the fail-closed path, so both properties are exercised at once.
  const held = heldWithCancelFlag();
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: held.stream, stderr: eofStream([]) }));
  try {
    await bounded(runGit(["log"], "/repo")).then(
      () => { throw new Error("expected IncompleteReadError"); },
      (e) => { expect(e).toBeInstanceOf(IncompleteReadError); },
    );
    expect(held.wasCancelled()).toBe(true);
  } finally { spy.mockRestore(); }
});

test("T3.6c — a SLOW but healthy git returns its payload; the flush race must not start before exit", async () => {
  // ⚠ THE ORDERING PIN. Pre-F1, `await p.exited` and the flush race were separated by a 15-line
  // inline try/finally, so "start reads -> await exit -> THEN race" was structurally obvious. F1
  // collapsed the race to one line, leaving two adjacent awaits separated only by a comment — and
  // nothing pinned their order.
  //
  // Measured on the merged code: moving `raceFlush` ABOVE `await p.exited` leaves the whole suite at
  // 930 pass / 0 fail and tsc clean, while every healthy git call slower than GIT_FLUSH_MS (500ms)
  // has both readers abandoned mid-flight and throws IncompleteReadError. `orElse` deliberately
  // RETHROWS that class, so it propagates and kills extraction: no briefing, with a false
  // "a child process is holding the pipe" diagnosis on a perfectly healthy repo.
  //
  // Probe is immune to the same mutation only because its tests drive real `sh -c` children; this
  // file's fakes resolve `exited` immediately, so the window was never contended. Hence a fake whose
  // exit AND EOF both land well past the flush window.
  const enc = new TextEncoder();
  const slow = new ReadableStream<Uint8Array>({
    async start(c) { await Bun.sleep(900); c.enqueue(enc.encode("deadbeef commit subject\n")); c.close(); },
  });
  const spy = spyOn(Bun, "spawn").mockImplementation(() => ({
    stdout: slow,
    stderr: eofStream([]),
    exited: Bun.sleep(900).then(() => 0),   // git itself is just slow, not held
    exitCode: 0,
    signalCode: null,
    kill() {},
  } as unknown as ReturnType<typeof Bun.spawn>));
  try {
    // 5s bound: if this ever hangs it is a real regression, not a slow machine.
    const out = await bounded(runGit(["log"], "/repo"), 5_000);
    expect(out).toBe("deadbeef commit subject\n");
  } finally { spy.mockRestore(); }
});
