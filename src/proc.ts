// src/proc.ts — spawn a child, collect both pipes without hanging, and report FACTS about the read.
//
// F2. Extracted from `scripts/audit.ts` (2026-07-26) — where it was unreachable by tests, since that
// file ends in a bare `main().catch(...)` and importing it would run the whole audit. It lives in
// `src/` because every test in this suite imports from `src/`; nothing else imports it, and it makes
// no claim to be a general-purpose spawn abstraction.
//
// The bug: the original awaited `Promise.all([stdout.text(), stderr.text()])` BEFORE `p.exited`, with
// no flush race at all — strictly worse than the `runGit` bug #116 fixed, which at least awaited
// `exited` first. `.text()` resolves only at EOF, so a backgrounded grandchild holding the inherited
// pipe hangs the audit forever. Unlike the gold-case fixtures, the audit runs against the REAL repos.
//
// POLICY LIVES WITH THE CALLER — still true after F1, though stream.ts's wording changed: the flush
// RACE moved into stream.ts (it was four textually identical blocks), while every conclusion drawn
// from a partial read stayed with its caller. This function concludes nothing about what
// a partial read MEANS; it reports the facts and lets each call site decide. The two current callers
// reach the same verdict for different reasons, and both are fail-closed:
//   - the `git` wrapper: "" is a LEGITIMATE git result (clean tree, no in-window commits), so treating
//     a partial read as success fabricates a quiet day — the hazard #116 exists to prevent.
//   - the regeneration call: its output is graded, not read by a human. `provider.ts` deliberately
//     RETURNS a partial briefing because a person gets something rather than nothing; that asymmetry
//     does not transfer to a measuring instrument, where a truncated briefing scored as whole yields a
//     confidently wrong EVAL.md row.
//
// `code` is ALSO forced to -1 on an incomplete stdout. That is fact-reporting rather than policy:
// `code` already means "did this invocation produce trustworthy output" — a spawn throw has always
// mapped to -1 — and it makes the safe behaviour the default. Both existing call sites already gate
// on `code`, so the fix routes into their failure branch with no edit, and a future call site that
// never reads `complete` still cannot mistake a partial read for success. (What each call site then
// REPORTS is a separate question, and getting it wrong is how a fail-closed read still produced a
// confidently wrong audit — see scripts/audit.ts's degraded-read handling.)
//
// `complete` means STDOUT REACHED EOF. It does NOT mean "the payload is whole": a child killed by a
// signal closes its fds, so a truncated payload can arrive with `complete: true`. `code` is the only
// guard in that case, which is what makes the `?? 1` below load-bearing rather than incidental.
import { drain, raceFlush, sinkText } from "./stream";

export type RunResult = {
  out: string;
  err: string;
  /** Real exit code, or -1 when the invocation produced no trustworthy output (spawn threw, or
   *  stdout did not reach EOF). A command that legitimately failed keeps its own code — -1 must stay
   *  meaningful as "do not trust `out`", not become a catch-all for failure. */
  code: number;
  /** Did STDOUT reach EOF? See the header: this is not the same as "the payload is whole". */
  complete: boolean;
  /** False only when `Bun.spawn` itself threw, so no process ever ran and no pipe ever existed.
   *  Distinct from `!complete`, which means a pipe existed and did not finish — the two call for
   *  different operator advice, and conflating them told the operator to re-run an audit whose
   *  binary was missing. */
  spawned: boolean;
  /** The signal that killed the child (e.g. "SIGKILL"), else null. Preserved because `code` collapses
   *  a signal death into 1, and an OOM-killed generator is otherwise indistinguishable from an
   *  ordinary failure exit — `provider.ts` surfaces this for the same reason. */
  signal: string | null;
  /** Did OUR OWN `timeoutMs` fire? Without this the ceiling we impose is indistinguishable from an
   *  external kill, so the audit's 20-minute limit wore an OOM costume and sent the operator hunting
   *  the wrong problem — and, worse, the message advised re-running a job that would be killed again
   *  at the same limit. `provider.ts` keeps an explicit flag for exactly this ambiguity.
   *
   *  HEURISTIC, stated as one, in BOTH directions: we infer it from elapsed-vs-limit plus the kill
   *  signal we configured, because `Bun.spawn` reports no "your timeout fired" fact.
   *  False positive: an external SIGKILL landing at or after the limit reads as ours.
   *  False negative: `Date.now()` is wall-clock, not monotonic, so a backward clock step during the
   *  run can make our own kill read as external. Consumers must phrase it as what was observed rather
   *  than as a fact about causation. Still strictly better than the previous state, in which OUR kill
   *  was ALWAYS misattributed. */
  timedOut: boolean;
};

export type RunOpts = {
  input?: string;
  cwd?: string;
  /** How long to keep reading AFTER the child exits, for bytes still in flight. Per-call because it
   *  is genuine tuning: a git invocation and a full briefing regeneration have different profiles. */
  flushMs?: number;
  /** Hard ceiling on the child itself, enforced by `Bun.spawn` + SIGKILL. Without it the flush race
   *  bounds only the POST-EXIT read, so a child that never exits hangs exactly as the original bug
   *  did — reached by a different route (a wedged git hook or an unresponsive network mount rather
   *  than a pipe-holding grandchild), with the identical user-visible symptom. */
  timeoutMs?: number;
};

/** Mirrors git.ts's GIT_FLUSH_MS: most callers here are git invocations, and the audit makes several
 *  per repo. A too-short window costs a LOUD failure, never silent bad data — so this errs short. */
export const DEFAULT_FLUSH_MS = 500;

/** Mirrors git.ts's GIT_TIMEOUT_MS, since the dominant caller runs the same binary over the same
 *  repos that `runGit` bounds at the same value. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export async function run(cmd: string[], opts?: RunOpts): Promise<RunResult> {
  let o: ReturnType<typeof drain> | undefined;
  let e: ReturnType<typeof drain> | undefined;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  try {
    const p = Bun.spawn(cmd, {
      cwd: opts?.cwd,
      stdin: opts?.input !== undefined ? "pipe" : undefined,
      stdout: "pipe",
      stderr: "pipe",
      // Bounded like runGit, for the same reason and against the same repos. Without `timeout` the
      // flush race bounds only the POST-EXIT read, so a child that never exits hangs exactly as the
      // original bug did. `killSignal` must be SIGKILL, not Bun's default SIGTERM: a wedged child that
      // traps or ignores TERM — a stuck hook is the named scenario — would otherwise never die and
      // `await p.exited` would hang anyway, reinstating the very symptom this bounds.
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });

    o = drain(p.stdout);
    e = drain(p.stderr);

    if (opts?.input !== undefined) {
      // Guarded as `BYOCliProvider.generate` guards its prompt write, which this originally failed
      // to carry over. An unguarded EPIPE — a child that exits before consuming stdin — escaped to the
      // outer catch, which discarded BOTH the child's real exit code and the stdout already collected,
      // and could not abandon the readers because they were scoped inside the `try`.
      //
      // NOTE on why this write is safe to await: an earlier revision of this comment claimed Bun
      // buffers the whole stdin payload, so `end()` could never block. That is FALSE and was measured:
      // against a child that never reads stdin (`sh -c "sleep 20"`), a 10 MB `end()` does not resolve.
      // What actually made the 10 MB `cat` round-trip work is the STDOUT side — Bun eagerly drains a
      // child's stdout into its own buffer at the fd level, so `cat` never blocked and kept consuming
      // stdin. The conclusion that the classic deadlock cannot occur here still holds, but not for the
      // reason first given; the `timeout` above is what actually bounds a child that stops reading.
      try {
        // `write()` returns a number for small payloads and a PROMISE above ~1 MB (measured, and
        // reproduced independently). The promise was discarded, so an async rejection could not be
        // seen by this enclosing catch, which only ever gets a SYNCHRONOUS throw — as its own
        // comment below says.
        //
        // ⚠ RESOLVED, and NOT in this hunk's favour — it prevents nothing observable today.
        // An earlier revision called the failure mode "contested" after two runs disagreed. They
        // reconcile: the discriminator is simply whether the harness also caught `end()`. Measured
        // against this exact shape (5 MB write, child never reads, SIGKILL at the deadline):
        //     catchWrite=false catchEnd=false -> unhandled=1
        //     catchWrite=false catchEnd=true  -> unhandled=0   <- this code WITHOUT the line below
        //     catchWrite=true  catchEnd=true  -> unhandled=0   <- this code WITH it
        // `end()`'s promise is awaited-with-catch two lines down, and always was, so it already
        // covers the write. The original "1 unhandled rejection" came from a probe script that never
        // called `end()` at all — a confound, not evidence for the `write()` path.
        // KEPT ANYWAY, as a cheap hedge rather than a fix: it costs nothing, and it is the one thing
        // standing between us and a Bun version where `write()` returns a Promise and `end()` does
        // not. Do not read the `fix:` in its commit subject as a behaviour change; there isn't one.
        //
        // ATTACHED, NOT AWAITED, and that is deliberate. An earlier revision awaited it, mirroring
        // `end()` below. Checkpoint review measured that the `await` is unpinned (dropping it leaves
        // the suite green) and buys nothing the `.catch()` does not: the rejection is handled either
        // way. What it DID add was a new event-loop yield between `write()` and `end()` on a
        // delivery-path call, defended by no test. Matching provider.ts's non-awaited form keeps this
        // a pure no-op-plus-catch at both sites.
        const wrote = p.stdin!.write(opts.input);
        if (wrote instanceof Promise) wrote.catch(() => {});   // async EPIPE
        const ended = p.stdin!.end();
        if (ended instanceof Promise) await ended.catch(() => {});   // async EPIPE
      } catch { /* sync EPIPE — the exit code below is the real signal */ }
    }

    await p.exited;

    // Only AFTER exit is a still-open pipe evidence of a holder rather than a child still working.
    const flushMs = opts?.flushMs ?? DEFAULT_FLUSH_MS;
    await raceFlush(o, e, flushMs);

    // ⚠ THIS COMMENT WAS INVERTED BY F1, and the correction matters. It used to read: "Safe to read
    // after the `finally` because there is no `await` between them, so `drain`'s continuation cannot
    // interleave … synchronicity is what makes it correct HERE, and crediting the guard alone
    // overstates it." `raceFlush` is `async`, so there IS now an await between the abandon and this
    // read — the exact "one future `await` inserted between them" that stream.ts warned about.
    // The guard is now the whole reason this is correct, not defence-in-depth: `canceled` freezes
    // both `complete` and `truncated`, so the value read here is identical to the value at the
    // moment the abandon ran. That is provable rather than incidental — between those two points the
    // only mutations are drain continuations, which can set `complete` only when NOT canceled.
    // Measured: deleting `!sink.canceled` turns 1 test red before F1 and **36** after it.
    const complete = o.sink.complete;   // STDOUT only: stderr is diagnostics, not the payload, and
                                        // gating on it would fail a chatty-but-successful command.
    // Inferred, not reported by Bun — see `timedOut`'s doc for why this is a heuristic.
    const timedOut = p.signalCode === "SIGKILL" && Date.now() - startedAt >= timeoutMs;
    return {
      out: sinkText(o.sink),
      err: sinkText(e.sink),
      // `?? 1` is load-bearing, not defensive: `exitCode` is null for a signal death, and a killed
      // child EOFs its pipes — so `complete` is true and the -1 forcing never fires. Defaulting to 0
      // instead would hand a SIGKILL-truncated briefing to the caller as a clean success.
      code: complete ? (p.exitCode ?? 1) : -1,
      complete,
      spawned: true,
      signal: p.signalCode ?? null,
      timedOut,
    };
  } catch (err) {
    // Abandon whatever was attached: the readers are hoisted precisely so this path can release them.
    o?.abandon();
    e?.abandon();
    return { out: "", err: String(err), code: -1, complete: false, spawned: false, signal: null, timedOut: false };
  }
}
