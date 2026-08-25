// test/eval/run-case.gitlines.test.ts — F3: `gitLines` fails CLOSED on a degraded read.
//
// WHY THIS FILE EXISTS. F3 converged `gitLines` onto `proc.ts`'s `run()`, which trades an unbounded
// hang for a bounded read — and in doing so makes a partial read POSSIBLE where `.text()` (awaiting
// EOF) made it impossible. `gitLines` feeds `gitShaSet` and `fileInventory`, the ground truth the G2
// fabrication check grades gold cases against, so a silently short `rev-list --all` would mark
// correctly-cited SHAs as FABRICATED and produce a false `fail` row. The `r.code !== 0` gate is what
// makes that unreachable, and this file is what stops the gate being quietly relaxed.
//
// Real subprocesses cannot model a held pipe on demand, so these use a spawn fake — the same shape as
// test/git.incomplete-read.test.ts:34-43. The rest of test/eval/ builds real fixture repos; this is a
// deliberate, narrow departure for the one property that needs it.
import { test, expect, spyOn } from "bun:test";
import { gitLines, gitFailureReason } from "../../src/eval/run-case";
import type { RunResult } from "../../src/proc";

function eofStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); } });
}

/** Emits some output then NEVER closes — a grandchild holding the inherited pipe. */
function heldStream(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); /* no close() */ } });
}

function fakeSpawn(o: {
  stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>;
  exitCode?: number | null; signalCode?: string | null;
}) {
  return {
    stdout: o.stdout, stderr: o.stderr,
    exited: Promise.resolve(o.exitCode ?? 0),
    exitCode: o.exitCode === undefined ? 0 : o.exitCode,
    signalCode: o.signalCode ?? null,
    stdin: null,
    kill() {},
  } as unknown as ReturnType<typeof Bun.spawn>;
}

test("T4.3 — a TRUNCATED read THROWS rather than returning a short list", async () => {
  // THE test this file exists for. Without the `r.code !== 0` gate, `run()` returns the bytes it got
  // after the flush window and gitLines hands back a SHORT gitShaSet — a silent false-fabrication
  // verdict on the eval verdict path. MUTATION (verified red): delete the gate.
  // Two SHAs arrive, the pipe is then held open, so the read never reaches EOF.
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: heldStream("aaaaaaa\nbbbbbbb\n"), stderr: eofStream([]) }));
  try {
    await expect(gitLines(["rev-list", "--all"], "/repo")).rejects.toThrow(/incomplete read/);
  } finally { spy.mockRestore(); }
});

test("T4.3b — a MISSING git binary is reported as a spawn failure, not as an incomplete read", async () => {
  // `code === -1` is NOT iff-incomplete: proc.ts's outer catch returns it for a spawn throw too.
  // Reporting "incomplete read (Executable not found)" would be the same diagnosis conflation that
  // git.ts's IncompleteReadError and proc.ts's `spawned` flag exist to prevent — it tells the
  // operator to re-run a job whose binary is missing. MUTATION (verified red): drop the `!r.spawned`
  // arm, and this message becomes "incomplete read (...)".
  const spy = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("Executable not found in $PATH"); });
  try {
    const e = await gitLines(["ls-files"], "/repo").catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toContain("could not run git");
    expect((e as Error).message).not.toContain("incomplete read");
  } finally { spy.mockRestore(); }
});

test("T4.3c — a healthy read still returns trimmed, non-empty lines", async () => {
  // The guard is not over-broad: the ordinary path must be untouched. Also pins the trim/filter
  // behaviour the two production call sites depend on (blank trailing line from git's output).
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: eofStream(["  aaaaaaa  \nbbbbbbb\n\n"]), stderr: eofStream([]) }));
  try {
    expect(await gitLines(["rev-list", "--all"], "/repo")).toEqual(["aaaaaaa", "bbbbbbb"]);
  } finally { spy.mockRestore(); }
});

test("T4.3d — a nonzero exit surfaces git's stderr, unchanged from the pre-F3 behaviour", async () => {
  // The one message shape that existed before F3 must still read the same way, or a mis-authored
  // gold case starts reporting something the operator has never seen.
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: eofStream([]), stderr: eofStream(["fatal: not a git repository\n"]), exitCode: 128 }));
  try {
    const e = await gitLines(["ls-files"], "/repo").catch((x: Error) => x);
    expect((e as Error).message).toContain("fatal: not a git repository");
    // ⚠ And it must be the FALLBACK arm, not the incomplete-read one. `r.err` is interpolated into
    // BOTH, so a substring match on stderr alone never says which arm ran — measured: relaxing
    // `r.code === -1` to `r.code !== 0` misreports EVERY nonzero git exit as "incomplete read", the
    // exact conflation this commit claims to prevent, and left the suite at 928 pass / 0 fail.
    expect((e as Error).message).not.toContain("incomplete read");
  } finally { spy.mockRestore(); }
});

// ── T4.3e: every arm of the failure classifier, and their ORDER ─────────────────────────────────
//
// Driven through `gitFailureReason` directly rather than through a spawn fake. That is not a
// shortcut — it is the only way: `gitLines` hardcodes `run()`'s defaults, and no spawn-level fake
// can reach Bun's `timeout`, so `timedOut` is structurally unreachable from the tests above. Three
// arms shipped unpinned because of that. Each shape below was MEASURED against the real src/proc.ts.
const shape = (o: Partial<RunResult>): RunResult => ({
  out: "", err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false, ...o,
});

test("T4.3e — each failure arm is reachable and reports its own cause", () => {
  // missing binary / unreadable cwd — proc.ts's OUTER CATCH also yields code -1
  expect(gitFailureReason(shape({ code: -1, spawned: false, complete: false, err: "Error: Executable not found in $PATH" })))
    .toBe("could not run git (Error: Executable not found in $PATH)");
  // our own 30s ceiling, single process: the `?? 1` fabrication
  expect(gitFailureReason(shape({ code: 1, signal: "SIGKILL", timedOut: true })))
    .toBe("timed out (SIGKILL)");
  // grandchild holds the pipe, child exited cleanly
  expect(gitFailureReason(shape({ code: -1, complete: false, err: "" })))
    .toBe("incomplete read (no stderr)");
  // killed by an EXTERNAL signal (OOM), not our timeout — must not read as an ordinary failure exit
  expect(gitFailureReason(shape({ code: 1, signal: "SIGKILL", timedOut: false })))
    .toBe("killed (signal SIGKILL)");
  // ordinary nonzero exit: git's own stderr, unchanged from the pre-F3 message shape
  expect(gitFailureReason(shape({ code: 128, err: "fatal: not a git repository" })))
    .toBe("fatal: not a git repository");
});

test("T4.3f — `timedOut` is classified BEFORE `code === -1` (the order is load-bearing)", () => {
  // THE shape that makes the order matter, and the one my original comment wrongly said cannot
  // exist: a timeout whose FORKED child still holds the pipe returns code -1 AND timedOut, measured
  //   run(["sh","-c","echo x; sleep 5"], {timeoutMs:200}) -> {code:-1, complete:false, timedOut:true}
  // Swapping the two arms reports our own 30s ceiling as an incomplete read — telling the operator
  // to re-run a job that will be killed again at the same limit. Measured: the swap left the suite
  // at 928 pass / 0 fail before this test existed.
  const forkedChildHoldsPipe = shape({ code: -1, complete: false, signal: "SIGKILL", timedOut: true });
  expect(gitFailureReason(forkedChildHoldsPipe)).toBe("timed out (SIGKILL)");
  expect(gitFailureReason(forkedChildHoldsPipe)).not.toContain("incomplete read");

  // ...and `code === -1` must also precede the `signal` arm. Measured: swapping THOSE two was green
  // too, because no shape above carried both a -1 and a non-null signal — yet proc.ts produces
  // exactly that for an EXTERNALLY killed child whose grandchild still holds the pipe.
  const externallyKilledAndHeld = shape({ code: -1, complete: false, signal: "SIGKILL", timedOut: false });
  expect(gitFailureReason(externallyKilledAndHeld)).toBe("incomplete read (no stderr)");
});
