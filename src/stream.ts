// src/stream.ts — the shared child-process stream primitive: accumulate a `ReadableStream` into an
// observable sink that can be abandoned, plus the flush RACE that every caller runs against it.
//
// Extracted from git.ts (2026-07-26); converged with `probe.ts`'s `capped` and the four hand-rolled
// flush races in F1 (2026-08-03). Before F1 the read loop existed four times over — `runGit`,
// `BYOCliProvider.generate`, `probe.ts`'s `capped`, and `proc.ts`'s `run` — and the copies had
// DRIFTED on a correctness property: probe's lacked the `canceled` guard below.
//
// WHAT IS SHARED: the read loop, the optional byte cap, and `raceFlush`. The race moved in here
// deliberately, REVERSING this file's original ruling that "the flush race belongs to the callers".
// That ruling was written when the race was four textually identical blocks differing only in a sink
// accessor; keeping it out bought no policy separation and cost a shared pin. Measured at the time:
// the `||`-not-`&&` abandon property was pinned at only two of the four sites, and `git.ts` and
// `probe.ts` had NO abandonment coverage at all.
//
// WHAT IS NOT SHARED — every policy still stays with its caller, and this is the line to hold:
// fail-closed vs swallow, one flush tier vs two, which sink gates the result, and what a partial
// read MEANS. `runGit` throws IncompleteReadError; `BYOCliProvider.generate` returns partial output
// with a warning; `probe.ts` returns an anomaly; `proc.ts` forces `code = -1`. Four different
// conclusions from the same mechanism.

export type Sink = {
  chunks: Uint8Array[];
  complete: boolean;
  errored: boolean;
  /** The read stopped because it EXCEEDED `maxBytes` (strictly — exactly `maxBytes` is not
   *  truncated). Never SET after `abandon()`, per the freeze in `drain` — but do NOT read that as
   *  `truncated ⇒ !canceled`: a sink that truncated FIRST is then normally canceled by `raceFlush`,
   *  because `truncated` suppresses `complete` and the abandon gate fires on `!complete`. That is
   *  the ordinary shape for every truncated help text in probe.ts, not an edge case. */
  truncated: boolean;
  /** `abandon()` was called. Required + initialized (not optional) so callers can assert `false`:
   *  an already-closed stream never fires its source's `cancel()` hook, so this flag is the ONLY
   *  observable for "was not abandoned". */
  canceled: boolean;
  error?: unknown;
};

/** Read `s` into an outer sink. Returns the sink (observable while the read is still pending) and
 *  the read's completion promise. Accumulating — rather than `new Response(s).text()` — matters:
 *  `.text()` resolves only at EOF, so racing it against a flush window yields "" instead of the
 *  bytes already received, discarding real output on a stream that is merely held open. All four
 *  callers spawn children whose grandchildren can inherit the pipes and hold them open past the
 *  child's exit — but they use the recovered bytes differently: the provider RETURNS partial stdout,
 *  while `runGit` deliberately discards it and fails closed, needing the accumulation only for
 *  stderr's text in its nonzero-exit message.
 *
 *  `opts.maxBytes` applies a SOFT cap: checked AFTER appending a chunk, so it overshoots by up to one
 *  read chunk (measured ~150 KB over a 256 KB cap in probe.ts). Tightening it would mean bounding the
 *  read size too, which buys nothing — `cancel()` is best-effort (a SIGPIPE-ignoring child kept
 *  running), so the real bound is the spawn timeout, not this. Semantics are `!== undefined`, NOT
 *  truthiness: `maxBytes: 0` caps immediately rather than meaning "unbounded".
 *
 *  A truncated drain does NOT release its own reader — it `break`s out of the loop and leaves the
 *  reader attached. The caller's `abandon()` does the release, which `raceFlush` performs
 *  automatically because `truncated` suppresses `complete`. Stated because `maxBytes` otherwise
 *  reads as self-contained: a caller that used `drain` with a cap and never abandoned would bound
 *  its own memory but leak the reader.
 *
 *  ⚠ `truncated` can LIE by omission, deliberately. Post-abandon it stays false even when the bytes
 *  already exceeded the cap (see the freeze below), so a sink may hold more than `maxBytes` with
 *  `truncated === false`. `complete` stays honest in every case; read the two together, as probe does.
 */
export function drain(s: ReadableStream<Uint8Array>, opts?: { maxBytes?: number }): {
  sink: Sink; done: Promise<void>; abandon: () => void;
} {
  const sink: Sink = { chunks: [], complete: false, errored: false, truncated: false, canceled: false };
  const reader = s.getReader();
  const maxBytes = opts?.maxBytes;
  let bytes = 0;   // closure-local, not a Sink field: only the cap check reads it
  const done = (async () => {
    try {
      for (;;) {
        const { done: eof, value } = await reader.read();
        if (eof) break;
        if (!value) continue;
        sink.chunks.push(value);
        bytes += value.byteLength;
        if (maxBytes !== undefined && bytes > maxBytes) {
          // FREEZE: `canceled` gates `truncated` for the same reason it gates `complete` below.
          // `abandon()` calls `reader.cancel()`, which is ASYNC — a chunk already delivered to the
          // pending `read()` still lands, so without this guard a post-abandon chunk could set
          // `truncated` after a caller's gate had already read it. probe.ts's anomaly gate is
          // `!complete && !truncated`, so that flip would turn "a child is holding the pipe"
          // (fail-closed, inject nothing) into a silent `ok` on partially-read help.
          // DEFENCE-IN-DEPTH, not a fixed live bug: measured 0/200 through `raceFlush`, because
          // once `cancel()` runs the queue is reset and microtask drains are atomic. Same footing as
          // the `complete` guard below — cheap, and it makes the ordering irrelevant instead of
          // relying on it.
          if (!sink.canceled) sink.truncated = true;
          break;
        }
      }
      // NOT `complete = true` unconditionally: `abandon()` cancels the reader, which resolves the
      // pending `read()` as `{done: true}` — so a stream we gave up on would otherwise mark itself
      // complete and turn a held pipe back into a fabricated quiet SUCCESS. Nor on a truncated read:
      // `complete` means "reached EOF", and a capped read did not.
      if (!sink.canceled && !sink.truncated) sink.complete = true;
    } catch (err) {
      // `done` must NEVER reject, for two reasons:
      //  - runGit attaches its first handler only after `await p.exited`, and real git takes
      //    macrotask-scale time to exit. A rejection inside that window had nobody listening — an
      //    unhandled rejection that escaped runGit entirely (no caller's catch ever saw it).
      //  - a raw stream error propagating out of runGit is NOT an IncompleteReadError, so every
      //    `orElse` site would swallow it (resolveAuthor → "" = NO AUTHOR FILTER) and extractor's
      //    inner catch would route it to a `not-a-repo` issue, which is not isInaccessible — the
      //    fabricated quiet day this whole fix exists to prevent.
      // Recording it instead leaves `complete` false, so each caller's own gate classifies it.
      sink.errored = true;
      sink.error = err;
    }
  })();
  // Release the reader when we've given up on it, or a held grandchild that keeps WRITING would
  // grow `chunks` unboundedly for the rest of the process. Safe after a normal finish, and idempotent.
  const abandon = () => { sink.canceled = true; reader.cancel().catch(() => {}); };
  return { sink, done, abandon };
}

/** Race two pending drains against a flush window, then release whatever is still held.
 *
 *  Called AFTER `await child.exited` at every site — only then is a still-open pipe evidence of a
 *  holder rather than a child still working. Returns when either both reads finish or `flushMs`
 *  elapses; it never rejects and never concludes anything. What a partial read MEANS is the caller's.
 *
 *  The `||` is LOAD-BEARING and is why this is shared at all: with `&&`, a ONE-SIDED hold (complete
 *  stdout, held stderr) never releases the held reader, and a still-writing grandchild grows its sink
 *  for the life of the process. Under a both-streams-held fixture the two operators are
 *  indistinguishable — only a one-sided hold separates them, which is why the pins in
 *  test/stream.test.ts use one.
 *
 *  ⚠ This function is `async`, so `await raceFlush(...)` puts a MICROTASK BOUNDARY between the
 *  abandon and whatever the caller reads next. That is safe for `complete` and `truncated` by
 *  construction — `canceled` freezes both — but NOT for `chunks`, `errored` or `error`, which can
 *  still be mutated by a late continuation. Accepted, and stated rather than discovered: the
 *  direction is more data (a caller may see one more chunk) and more accuracy (`runGit`'s
 *  `IncompleteReadError` throw may branch its message where it previously did not), never a
 *  fail-closed decision turning fail-open.
 *
 *  ⚠ One direction the sentence above does NOT cover, named because it is the only verdict flip in
 *  the change: `BYOCliProvider.generate`'s `empty-output` gate reads `sink.errored`, and there the
 *  drift runs the OTHER way — a late `errored` turns the provider's deliberate fail-OPEN (return the
 *  partial briefing with a truncation warning) into a thrown `empty-output`, and flips `partialRead`.
 *  `UNVERIFIED` and believed unconstructible: our own `abandon()` calls `reader.cancel()`, which per
 *  spec FULFILS a pending read rather than rejecting it, so this needs a genuine mid-stream error
 *  landing in exactly that microtask. Recorded rather than argued away — the direction is
 *  fail-closed-to-the-user (no briefing beats a wrong one), which is why it is accepted.
 */
export async function raceFlush(
  a: ReturnType<typeof drain>, b: ReturnType<typeof drain>, flushMs: number,
): Promise<void> {
  // Clearable timer rather than a bare sleep: at ~110 git calls per tick, leaving each losing timer
  // alive holds the event loop open for no reason. No test can observe that from inside `bun test`
  // (the runner never exits), so test/stream.test.ts pins the `clearTimeout` with a spy.
  let flush: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([a.done, b.done]),
      new Promise<void>((r) => { flush = setTimeout(r, flushMs); }),
    ]);
  } finally {
    // `finally`, not `.then()` on the winning branch: `done` no longer rejects, but the race can
    // still be lost to the timer, and the timer must be cleared and the readers released on every
    // exit from this block.
    if (flush) clearTimeout(flush);
    if (!a.sink.complete || !b.sink.complete) { a.abandon(); b.abandon(); }
  }
}

// One decode over the concatenated bytes, never per-chunk: a multi-byte UTF-8 sequence split
// across a chunk boundary would otherwise decode as two U+FFFDs.
export function sinkText(sink: Sink): string {
  return new TextDecoder().decode(Buffer.concat(sink.chunks));
}
