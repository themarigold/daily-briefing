// src/provider.ts
import type { Provider, Config } from "./types";
import { ProviderError } from "./types";
import { drain, raceFlush, sinkText } from "./stream";

export const TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 5_000;   // SIGTERM → this long → SIGKILL (a TERM-ignoring child can't hang the run)
// After exit, bounded wait for the stream reads — a grandchild that inherited the pipes can hold
// them open forever, so the reads must never be awaited unconditionally. Two tiers: after a KILL the
// output is discarded anyway (short); after a NORMAL exit be generous — a slow post-wake flush must
// not get a successful run misread as empty-output (review finding).
const FLUSH_KILLED_MS = 1_000;
const FLUSH_EXITED_MS = 10_000;

/** Which flush tier applies. Extracted from an inline ternary for ONE reason: `FLUSH_EXITED_MS` is
 *  module-private, so a test cannot assert the relationship below against the constant — and pinning
 *  the constant would not be enough anyway. SWAPPING the two branches leaves both constants untouched
 *  and every test green, while dropping a race-lost attempt's `durationMs` from ~10s to ~1s — under
 *  `failFastMs`'s 5s cap, which is what the B6 ladder uses to decide a failure is a usage error it may
 *  latch on. Exporting the function pins the constant and the tier ORDER (T14/T14b). That `attempt()`
 *  actually CALLS it, rather than re-inlining a ternary, is a separate STATIC pin — every
 *  timing-sensitive test injects `flushMs`, so none of them can notice a re-inlined call site.
 *
 *  So `flushWindowMs(false, {}) > failFastMs(TIMEOUT_MS)` is now a SECURITY invariant, not a comfort
 *  margin: a future "10s feels slow, make it 3s" edit must fail loudly. It is a belt, though — the
 *  primary gate is `partialRead`, because the timing argument is false for an ERRORED sink (drain
 *  resolves fast on error, so the race is won and the duration is small). */
export const flushWindowMs = (timedOut: boolean, o: ProviderOpts): number =>
  o.flushMs ?? (timedOut ? FLUSH_KILLED_MS : FLUSH_EXITED_MS);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A copy of `env` without the named keys. Exported for `probe.ts`, which applies the same
 *  withholding to its own spawn, and for tests.
 *
 *  ⚠ Case-INSENSITIVE, and that is not defensiveness. Windows environment variable names are
 *  case-insensitive at the OS level while a spread copy is a plain JS object that is not, so an
 *  exact-key `delete` would leave `Anthropic_Api_Key` in place on the one platform where the user
 *  could not have known it mattered. This repo does target Windows — `harden.ts` carries a `win32`
 *  branch and strips `.exe/.cmd/.bat/.ps1` — so the cheap sweep is the correct default rather than a
 *  future refinement. */
export function withoutKeys(
  env: Record<string, string | undefined>, remove?: readonly string[],
): Record<string, string | undefined> {
  if (!remove?.length) return env;
  const drop = new Set(remove.map((k) => k.toLowerCase()));
  // `Object.fromEntries`, not `out[k] = v` in a loop. Assignment is a [[Set]], so a variable named
  // `__proto__` hits `Object.prototype`'s setter: assigning a string is a silent no-op and no own
  // property is created, so that variable would be DROPPED — measured, `env | grep -c '^__proto__='`
  // gives 1 without a strip and 0 with one. No pollution risk (values are strings) and dropping is
  // the safe direction, but it would quietly contradict this function's whole contract of keeping
  // every other variable intact. `fromEntries` creates own properties and preserves it.
  return Object.fromEntries(Object.entries(env).filter(([k]) => !drop.has(k.toLowerCase())));
}

/** Everything the caller can vary about how the BYO CLI is launched.
 *
 *  `cwd`/`env` are NOT cosmetic additions: `Bun.spawn` was previously called with neither, so C1/B1's
 *  narrow working directory and C1/B4's `CLAUDE_CODE_SKIP_PROMPT_HISTORY` would each have silently
 *  no-op'd — hardening that looks implemented and does nothing. Widened from the old
 *  `ProviderTimeouts` (renamed rather than extended: there were exactly two usages, both internal). */
export type ProviderOpts = {
  timeoutMs?: number;
  killGraceMs?: number;
  flushMs?: number;
  cwd?: string;
  /** MERGED over `process.env`, never used as a replacement — see the spawn call. */
  env?: Record<string, string>;
  /** Variable names to REMOVE from the child's environment, applied after the merge above.
   *
   *  Deletion rather than an allowlist, deliberately: `provider.ts`'s spawn comment records that
   *  handing `Bun.spawn` a bare env object "was measured leaving `HOME=UNSET` — which kills the
   *  provider's auth". A merged copy minus named keys keeps every other variable intact.
   *
   *  Today's only user is the credential mode (`provider.credential`): withholding
   *  `ANTHROPIC_API_KEY` makes the `claude` CLI use its logged-in subscription instead of billing
   *  API credits. An ambient key silently re-billed a subscription to API credits for weeks
   *  precisely because this process's environment was handed to the child wholesale. */
  envDelete?: readonly string[];
  /** Sink for warnings raised DURING a call. A callback rather than an array on the provider, because
   *  `hardenedProvider` builds a FRESH `BYOCliProvider` per ladder rung (harden.ts's `build`), so an
   *  instance array would be discarded with the instance that raised it. Not a caller-settable knob:
   *  the wrapper installs its own after spreading `opts`, and wins. */
  onWarning?: (w: string) => void;
};

// Retry a provider call on transient failures (nonzero-exit / timeout / empty-output — a
// wake-before-wifi morning exits nonzero; empty-output can be a flaky CLI). missing-binary is
// permanent and any non-ProviderError is a bug: both rethrow immediately. Used by the morning
// run AND the audit judge (which timed out in production before it was covered).
export async function withRetry<T>(
  fn: () => Promise<T>, delaysMs: number[], sleeper: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      // `usage-limit` is permanent for this run for the same reason `missing-binary` is: no number of
      // retries makes a usage wall go away before its reset.
      if (!(e instanceof ProviderError) || e.code === "missing-binary" || e.code === "usage-limit" || attempt >= delaysMs.length) throw e;
      console.error(`provider failed (${e.code}); retrying in ${Math.round(delaysMs[attempt]! / 1000)}s (attempt ${attempt + 1} of ${delaysMs.length})…`);
      await sleeper(delaysMs[attempt]!);
    }
  }
}

/** The classification predicate lives in `account.ts` and is imported, not re-declared: two copies of
 *  the same rule drift into "the provider classifies a limit whose message the parser cannot read".
 *  Anchored on "hit your … limit", so it crosses neither the U+00B7 separator nor the apostrophe in the
 *  real message, and it covers the session wall as well as the weekly one. */
export { LIMIT_RE as USAGE_LIMIT_RE } from "./account";
import { LIMIT_RE as USAGE_LIMIT_RE } from "./account";

/** Shape gate, applied PER STREAM. Returns the matched LINE, or undefined.
 *
 *  Matching the phrase alone is not safe: this tool's own briefing is generated from repository logs
 *  that contain the sentence verbatim, and the audit judge quotes it back — so an unrelated nonzero
 *  exit carrying that text would bench a HEALTHY account for days. A real limit rejection is one short
 *  line (74 chars measured); a briefing body is kilobytes. So the stream must be short AND the match
 *  must sit at its end. Per stream, not concatenated: the CLI writes the real error to stdout while
 *  stderr may carry an unrelated advisory. */
export function limitMatch(out: string, err: string, maxChars = 2000, tailChars = 200): string | undefined {
  for (const stream of [out, err]) {
    const t = stream.trim();
    if (!t || t.length > maxChars) continue;
    if (!USAGE_LIMIT_RE.test(t.slice(-tailChars))) continue;
    const line = t.split(/\r?\n/).find((l) => USAGE_LIMIT_RE.test(l));
    if (line) return line.trim();
  }
  return undefined;
}

/** Phrases that PROVE a CLI rejected a flag rather than failing for some other reason. */
export const FLAG_REJECTION_RE = /unknown option|unrecognized (option|argument)|illegal option|not defined|invalid option/i;

/** Anything faster than this smells like a usage error, not a real provider call (measured rejection at
 *  87-94 ms). Capped so a short configured timeout cannot make the window swallow genuine failures. */
export const failFastMs = (timeoutMs: number) => Math.min(5_000, timeoutMs / 10);

type Laddered = {
  runtimeWarnings: string[];
  hardeningActive(): boolean;
  disableHardening(reason: string): void;
  probeWithoutHardening<T>(fn: () => Promise<T>): Promise<T>;
};

/**
 * C1/B6, the AMBIGUOUS rung — for a failure that is nonzero-but-inconclusive, where stderr does not
 * prove anything and the fast path inside the provider cannot fire.
 *
 * Wraps the whole `withRetry` CALL, deliberately not placed inside the provider: `withRetry` passes
 * nothing to `fn`, and `scripts/eval.ts` has no `withRetry` at all, so a provider-internal attempt
 * counter would be unsound there. It runs only once withRetry has exhausted its attempts, which is the
 * point — it relocates the misattribution window (a network failure that looks like a usage error) from
 * t≈0.09s, peak wake-before-wifi hazard, out to t≈135s where it is near zero. It does not eliminate it.
 *
 * `once` must be a SINGLE attempt, not another `withRetry` run: re-running the whole schedule per rung
 * would cost 9 provider calls and ~10 minutes instead of the intended worst case of 5 calls.
 */
export async function withHardeningLadder<T>(
  hp: Laddered, run: () => Promise<T>, once: () => Promise<T>, timeoutMs = TIMEOUT_MS,
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    // Nothing injected ⇒ nothing to back off from. The `timeout` clause is redundant GIVEN core.ts's
    // shared-timeout wiring — it passes the same `cfg.provider.timeoutMs` here and to the provider, so a
    // timeout's duration is ~10x `failFastMs` and the gate below already excludes it. That is a
    // cross-file invariant, NOT a property of this function: a caller that passed a larger timeoutMs here
    // than the provider used would make this clause load-bearing. Keep it.
    // `usage-limit` bails out here too, and this gate is NOT optional: the ladder wraps withRetry
    // (core.ts composes them that way), so suppressing retries alone leaves two more doomed spawns per
    // tick. A limit rejection also returns FAST (~4.5s measured, vs a 5000ms failFastMs), so the
    // duration gate below would not catch it.
    if (!(e instanceof ProviderError) || e.code === "timeout" || e.code === "usage-limit" || !hp.hardeningActive()) throw e;
    // Failed SLOWLY ⇒ it reached the provider and did real work, so our flags are not the story.
    if ((e.durationMs ?? Infinity) > failFastMs(timeoutMs)) throw e;

    // Rung 1: one more attempt WITH flags. Succeeding here means the failure was transient and the
    // hardening is fine — the most likely explanation, so it is tested first and costs nothing to keep.
    try { return await once(); } catch { /* still failing — now it is worth suspecting the flags */ }

    // Rung 2: the same single attempt with flags suppressed but NOT yet latched. Only a SUCCESS here
    // earns the conclusion; latching first and reverting on failure would let one transient error
    // permanently downgrade the posture.
    try {
      const out = await hp.probeWithoutHardening(once);
      hp.disableHardening("the provider CLI failed with hardening flags injected and succeeded without them, so hardening flags are disabled for the rest of this run — the CLI appears to reject one of them");
      return out;
    } catch {
      // Inconclusive: it failed bare too, so the flags were never the cause. Conclude NOTHING and keep
      // hardening; rethrow the original failure, which is the one that describes the real problem.
      throw e;
    }
  }
}

export class BYOCliProvider implements Provider {
  constructor(private cfg: Config["provider"], private t: ProviderOpts = {}) {}

  /** Raise a runtime warning. The try/catch is not decoration: `warn` runs immediately before a
   *  SUCCESSFUL return, and a throwing hook would surface as a non-ProviderError, which `withRetry`
   *  rethrows with ZERO retries — a warning hook killing a morning that had already worked. */
  private warn(w: string): void {
    try { this.t.onWarning?.(w); } catch { /* a warning must never fail the call it describes */ }
  }

  async generate(prompt: string): Promise<string> {
    // Stamp every ProviderError with how long the attempt took — see ProviderError.durationMs.
    const startedAt = performance.now();
    try {
      return await this.attempt(prompt);
    } catch (e) {
      if (e instanceof ProviderError && e.durationMs === undefined) e.durationMs = Math.round(performance.now() - startedAt);
      throw e;
    }
  }

  private async attempt(prompt: string): Promise<string> {
    const argv = this.cfg.promptVia === "arg" ? [...this.cfg.argv, prompt] : this.cfg.argv;
    // Always open stdin as a pipe so `proc` has a concrete type (avoids a strict-mode error from
    // `ReturnType<typeof Bun.spawn>` widening stdin to number|undefined). For arg-mode we just end it.
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn([this.cfg.cli, ...argv], {
        stdin: "pipe", stdout: "pipe", stderr: "pipe",
        // Both spread conditionally so that omitting them is byte-identical to the previous call —
        // this widening must not change behaviour for a caller that passes neither.
        ...(this.t.cwd !== undefined ? { cwd: this.t.cwd } : {}),
        // MERGE, never replace. `Bun.spawn`'s `env` REPLACES the environment wholesale, so passing
        // `{CLAUDE_CODE_SKIP_PROMPT_HISTORY:"1"}` alone was measured leaving `HOME=UNSET` — which
        // kills the provider's auth and violates the invariant's own preserved-user-config clause.
        // Ours spreads LAST so an explicit key beats an inherited one of the same name (an inherited
        // `…SKIP_PROMPT_HISTORY=0` must not defeat the hardening we are applying).
        // ⚠ The condition now covers `envDelete` too, which changes one property this comment used
        // to claim: with a credential mode resolved on every run, an explicit `env` object is passed
        // on essentially every spawn, including the non-claude path that previously got none. The
        // MERGE is what makes that safe — the object is `process.env` plus/minus named keys, never a
        // replacement — but "omitting them is byte-identical to the previous call" is no longer the
        // common case, and saying so is cheaper than someone rediscovering it.
        ...(this.t.env !== undefined || this.t.envDelete?.length
          ? { env: withoutKeys({ ...process.env, ...this.t.env }, this.t.envDelete) }
          : {}),
      });
    } catch (e: any) {
      // ENOENT does NOT reliably mean "binary not found" — that comment was wrong and the correction
      // matters. Measured: an unreachable `cwd` makes Bun report `ENOENT … posix_spawn '<the binary>'`,
      // naming the BINARY for a DIRECTORY problem. Classifying that as missing-binary was actively
      // harmful, because withRetry treats missing-binary as PERMANENT: the morning died with zero
      // retries and told the user to install a CLI that was installed and working. So when WE supplied a
      // cwd, ENOENT/EACCES/ENOTDIR is reported as retryable and NAMES THE DIRECTORY instead.
      // Other synchronous spawn failures (E2BIG — argv too long, reachable with promptVia:"arg" and a
      // large prompt; EACCES on a non-executable binary) are real, different failures either way.
      const cwdBlamed = this.t.cwd !== undefined && ["ENOENT", "EACCES", "ENOTDIR"].includes(e?.code);
      if (cwdBlamed) {
        throw new ProviderError("nonzero-exit", `Failed to spawn ${this.cfg.cli} (${e?.code}) — its working directory ${this.t.cwd} may not exist, not be a directory, or not be searchable`);
      }
      if (e?.code === "ENOENT") {
        throw new ProviderError("missing-binary", `CLI not found: ${this.cfg.cli}. Install it or set provider.cli.`);
      }
      throw new ProviderError("nonzero-exit", `Failed to spawn ${this.cfg.cli} (${e?.code ?? "spawn error"}): ${e?.message ?? String(e)}`);
    }
    try {
      // `write()` returns a NUMBER for small payloads and a PROMISE for large ones (measured
      // threshold: 500 KB -> number, 1 MB -> Promise). The promise was discarded, which LOOKS like a
      // hole — an async EPIPE escaping as an unhandled rejection instead of reaching withRetry.
      // ⚠ It is not one today: measured, catching `end()`'s promise (which this code has always
      // done, one line below) already covers the write, so removing the line below changes nothing
      // observable. Kept as a cheap hedge against a Bun version where the two diverge — see the
      // fuller measurement in proc.ts, which carries the same hunk for the same reason.
      //
      // Not reachable UNDER THE DEFAULT BUDGET, which is why it was safe to change on the delivery
      // path: `reduce.ts` bounds the context at `DEFAULT_BUDGET.maxChars = 200_000`, well under the
      // ~1 MB threshold, so `write()` returns a number and this branch is never taken. Two honest
      // qualifications, both corrected from an earlier revision of this comment: `reduce` bounds the
      // CONTEXT JSON rather than the assembled prompt, and `tokenBudget` is user-settable with no
      // upper bound — so a user who raises it far enough can reach this branch.
      if (this.cfg.promptVia === "stdin") {
        const wrote = proc.stdin.write(prompt);
        if (wrote instanceof Promise) wrote.catch(() => {}); // async EPIPE — the exit code is the real signal
      }
      const ended = proc.stdin.end();
      if (ended instanceof Promise) ended.catch(() => {}); // swallow async EPIPE from a child that already exited
    } catch { /* sync EPIPE — ignore; exit code handled below */ }
    // Ordering is load-bearing:
    //  - the stream reads START first (concurrent drain — a chatty child must never fill the pipe
    //    buffer and deadlock while we wait on `exited`),
    //  - we AWAIT `proc.exited` (bounded: on timeout SIGTERM fires, and killGraceMs later SIGKILL —
    //    a TERM-trapping child can't hang us),
    //  - then we RACE the reads against a short flush window instead of awaiting them outright —
    //    a grandchild that inherited the pipes can keep them open after the child died, and an
    //    un-raced `.text()` would then never see EOF.
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      // Boundary guard: if the child exited right at the deadline (timers can be serviced
      // before the exit continuation runs), don't mislabel a finished run as timed out.
      if (proc.exitCode !== null) return;
      timedOut = true;
      proc.kill();
      killTimer = setTimeout(() => { try { proc.kill(9); } catch { /* already gone */ } }, this.t.killGraceMs ?? KILL_GRACE_MS);
    }, this.t.timeoutMs ?? TIMEOUT_MS);
    // Both streams ACCUMULATE into observable sinks. `.text()` resolves only at EOF, so racing it
    // against the flush window yielded "" instead of the bytes already received — discarding a
    // complete briefing as empty-output, and blanking the nonzero-exit diagnostic to "(no output)"
    // (both measured). The sinks are also what keep the two streams INDEPENDENT: a grandchild holding
    // only stderr must not cost us a fully-read stdout. That independence used to come from assigning
    // each stream separately as it EOF'd; it now comes from the sinks being readable mid-flight, so a
    // single combined await is correct here where it was a bug before.
    // The per-read `.catch(() => {})` is deliberately NOT carried over: `drain`'s `done` never rejects
    // by construction (stream.ts records the error on the sink instead), pinned by "drain resolves —
    // never rejects — when the stream errors" in test/stream.test.ts. If that regressed, the rejection
    // would escape `attempt()` as a non-ProviderError, which withRetry rethrows with ZERO retries.
    const o = drain(proc.stdout), e = drain(proc.stderr);
    // The `const reads = Promise.all([o.done, e.done])` hoist above `await proc.exited` is GONE (F1):
    // `raceFlush` builds it internally, i.e. after the exit await. It was defence against an
    // unhandled rejection in the pre-exit window, and it is safe to lose only because `drain`'s
    // `done` never rejects by construction — pinned by "drain RESOLVES — never rejects" in
    // test/stream.test.ts. Recorded rather than silently dropped: `tsc` would not have flagged the
    // leftover local, so this could have rotted into a dead variable instead of a deliberate removal.
    try {
      await proc.exited;
      // Kept as its own statement, deliberately: T14c is a comment-stripped SOURCE scan for
      // `flushWindowMs(timedOut`, and it is the only thing that can see the two-tier flush window at
      // all — every timing-sensitive test here injects `flushMs`. Inlining this into the call, or
      // passing `this.t.flushMs ?? DEFAULT` instead, collapses the post-exit window from 10s to 500ms
      // on the post-wake 7:20 run and leaves the whole suite green. T14c now also asserts the local
      // is actually THREADED into raceFlush, because the scan alone matched the severed form.
      const flushMs = flushWindowMs(timedOut, this.t);
      await raceFlush(o, e, flushMs);
    } finally {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    }
    // `const`, computed after both `finally`s, mirroring git.ts's `const out = sinkText(...)`. The
    // previous `let out = "", err = ""` initializers were dead on every path that reads them.
    const out = sinkText(o.sink), err = sinkText(e.sink);
    // Any bytes we are about to put into an error message may be a PARTIAL read. Deliberately
    // over-broad (it is set even when the message ends up carrying no bytes): over-stamping only costs
    // the B6 fast path a latch it would otherwise take, falling back to the normal retry schedule;
    // under-stamping costs a hardening bypass. T17 pins that it is not stamped unconditionally.
    //
    // UNMEASURED, and worth being honest about: if the real CLI routinely leaves a helper process on
    // STDERR — the very condition that motivated this change — then every ladder-relevant error is
    // stamped and the fast path effectively never fires, reverting its measured 3.09s/2 calls to
    // 138.4s/5. Still the correct direction (a rejection phrase read out of a stream we know is
    // incomplete is not evidence), but a real cost, and nobody has checked which way it goes.
    // Checking needs a run against the paid CLI, so it is deferred rather than assumed away.
    const partialRead = !o.sink.complete || o.sink.errored || !e.sink.complete || e.sink.errored;
    const stamp = (err2: ProviderError): ProviderError => { err2.partialRead = partialRead; return err2; };

    if (timedOut) throw stamp(new ProviderError("timeout", `${this.cfg.cli} timed out`));
    // exitCode null WITHOUT our timeout = the child was killed by an EXTERNAL signal (OOM SIGKILL, a
    // crash) — a real failure but NOT a timeout. Retryable (nonzero-exit), with the signal named.
    if (proc.exitCode === null) throw stamp(new ProviderError("nonzero-exit", `${this.cfg.cli} was killed (signal ${proc.signalCode ?? "unknown"})`));
    if (proc.exitCode !== 0) {
      // ENOENT sometimes surfaces as a nonzero exit rather than a spawn throw. Gate on exit 127 —
      // the shell's actual command-not-found code. Without it, ANY wrapper whose usage text
      // contains "not found" (a shim rejecting an unknown flag) is classified missing-binary, which
      // withRetry treats as PERMANENT: zero retries, and a "CLI not found" message about a binary
      // that exists. A genuinely absent binary already throws ENOENT at the spawn above, so this is
      // a pure narrowing — it can only reclassify missing-binary → nonzero-exit, never the reverse.
      // GATED on a complete read. This classifier decides on stderr CONTENT, and `missing-binary` is
      // PERMANENT in withRetry (zero retries, "install a CLI" advice). Measured: with a held pipe an
      // exit-127 child yields a retryable `nonzero-exit`; ungated, partial stderr flips it to an
      // unrecoverable failure about a binary that exists — on exactly the machine this change targets.
      if (!partialRead && proc.exitCode === 127 && /not found|ENOENT/i.test(err)) throw stamp(new ProviderError("missing-binary", `CLI not found: ${this.cfg.cli}`));
      // Surface the CLI's diagnostic from BOTH streams. `claude` writes its real error (usage/session
      // limits, auth) to STDOUT while also printing a benign advisory to stderr when an auth env var
      // is set — so a stderr-preferred diag rendered a blank "claude exited 1:" for the 2026-07-11
      // launchd failure, and an "only if stderr is empty" fallback never fires on the machines that
      // most need it. Include both, tagged, so neither cause is thrown away.
      const parts: string[] = [];
      if (err.trim()) parts.push(err.slice(0, 300));
      if (out.trim()) parts.push(`(stdout) ${out.slice(0, 300)}`);
      const diag = parts.length ? parts.join(" | ") : "(no output)";
      // A subscription usage wall (weekly or session) is not a transient failure: retrying cannot
      // succeed until the reset, so it is classified separately and treated as PERMANENT by both
      // withRetry and withHardeningLadder. Measured 2026-08-23: a real limit rejection returns in
      // ~4.5s, under failFastMs (5000ms), so WITHOUT the ladder gate it costs three spawns per tick.
      //
      // Classified on the FULL streams, never on `diag` — `diag` is two 300-char slices, so matching
      // it would cap detection at 600 characters and a chattier failure would silently restore the
      // old behaviour. But full-stream matching alone is dangerous in the other direction: this
      // tool's own briefing is generated from logs that contain this exact sentence (measured: 59
      // occurrences in briefing.log), and the audit judge quotes it back. Hence the SHAPE gate.
      const limited = limitMatch(out, err);
      if (limited && !partialRead) {
        // The matched line rides at the FRONT of the message: core.ts needs the reset instant, and
        // its catch sees only a ProviderError whose `diag` is already truncated. Carrying the line
        // here avoids a fourth additive field on the frozen-contract types.ts.
        throw stamp(new ProviderError("usage-limit", `${limited} — ${this.cfg.cli} exited ${proc.exitCode}: ${diag}`));
      }
      throw stamp(new ProviderError("nonzero-exit", `${this.cfg.cli} exited ${proc.exitCode}: ${diag}`));
    }
    // A BROKEN READ is not a held pipe. `drain` records a mid-stream failure on the sink instead of
    // rejecting, so without this the bytes salvaged before the error would be returned as a success.
    // Fail closed here and stay retryable — unlike an incomplete read, an errored one gives no reason
    // to believe the bytes we have are all the child meant to write.
    // POSITION IS LOAD-BEARING: this must stay BELOW the exitCode checks. Hoisted above them, a
    // nonzero exit with an errored stdout becomes `empty-output` and discards the diagnostic that
    // half this change exists to rescue.
    if (o.sink.errored) throw stamp(new ProviderError("empty-output", `${this.cfg.cli}: reading its output failed mid-stream`));
    if (!out.trim()) throw stamp(new ProviderError("empty-output", `${this.cfg.cli} returned no output`));
    // DELIBERATE FAIL-OPEN, and the opposite of what git.ts does two modules over. `o.sink.complete`
    // may be false here: a grandchild held the pipe past the flush window, so we have bytes but never
    // saw EOF. We return them. runGit fails closed on exactly this condition because "" is a
    // legitimate git result, so a partial payload there fabricates a quiet day; for the provider ""
    // is never legitimate, and the alternative is discarding a briefing that is — in the shape that
    // actually causes this — complete apart from its EOF. Pinned by "a truncated stdout is returned
    // rather than discarded" so the fail-open is a decision, not an accident.
    if (!o.sink.complete) {
      // Emitted as an INLINE template literal, deliberately. test/posture.test.ts scans src/ for
      // warning literals at their emission site and fails on any it cannot classify; a helper call
      // (`this.warn(TRUNCATION_WARNING(cli))`) is invisible to that scan, so the guard would silently
      // stop covering this channel. The sentinel substring therefore appears both here and in
      // `isTruncationWarning` — that duplication is the cost of being visible, and it is pinned.
      // "this result", not "the briefing": the same provider serves the audit and eval JUDGES, whose
      // output is a prose verdict. Must contain no POSTURE_MARKERS substring, or EVAL.md rows flip to
      // `degraded`.
      this.warn(`${this.cfg.cli} exited successfully but its output stream never closed — a background process is holding it open, so this result was built from what had already arrived and may be cut off at the end`);
    }
    return out;
  }
}
