// test/stream.test.ts — direct unit tests for the shared drain primitive and the shared flush race.
//
// These live here, not in a caller's test file, because the properties they pin are UNOBSERVABLE
// through any single caller. Two of them are the reason F1 exists at all:
//   - the `canceled` guard: before F1, `probe.ts`'s copy of the read loop lacked it, and no test in
//     the suite could see that. MEASURED: deleting the guard turned exactly ONE test red repo-wide
//     before F1 and **36** after it, because `raceFlush`'s `await` makes the ordering load-bearing at
//     every one of the four sites instead of nowhere.
//   - the `||`-not-`&&` abandon guard: only `provider.ts` and `proc.ts` pinned it; `git.ts` and
//     `probe.ts` would both have survived the weakening silently. That is what a shared pin buys.
// Moved out of git.incomplete-read.test.ts when `drain` was extracted to src/stream.ts (2026-07-26).
import { test, expect, spyOn } from "bun:test";
import { drain, raceFlush, sinkText } from "../src/stream";

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

/** A never-EOF stream that reports whether its reader was really cancelled.
 *
 *  COPIED (not imported) from proc.incomplete-read.test.ts:268 — it is module-local there, and
 *  importing one test file into another would re-register that file's tests. Matches existing repo
 *  style, where eofStream/neverEofStream are likewise duplicated across these files.
 *
 *  Observing the SOURCE's `cancel()` hook rather than `sink.canceled` is deliberate: the mutation
 *  `abandon = () => { sink.canceled = true; }` (dropping `reader.cancel()`) passes a flag assertion
 *  and is caught only by this. See provider.incomplete-read.test.ts:174, which records that mutation. */
function heldWithCancelFlag(): { stream: ReadableStream<Uint8Array>; wasCancelled: () => boolean } {
  let cancelled = false;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) { await Bun.sleep(5); c.enqueue(enc.encode("noise\n")); },   // keeps producing, never closes
    cancel() { cancelled = true; },
  });
  return { stream, wasCancelled: () => cancelled };
}

test("an ABANDONED drain never marks its sink complete", async () => {
  // `abandon()` cancels the reader, and cancelling resolves the PENDING `read()` as `{done: true}` —
  // byte-identical to a real EOF. Without the `canceled` guard the loop then sets complete = true on a
  // stream we gave up on, turning a held pipe back into a fabricated quiet SUCCESS.
  const d = drain(neverEofStream(["partial"]));
  d.abandon();
  await d.done;
  expect(d.sink.complete).toBe(false);
});

test("a drain that reaches EOF normally DOES mark its sink complete (the guard is not over-broad)", async () => {
  const d = drain(eofStream(["all of it\n"]));
  await d.done;
  expect(d.sink.complete).toBe(true);
  expect(d.sink.errored).toBe(false);
  expect(d.sink.truncated).toBe(false);
});

test("drain RESOLVES — never rejects — when the stream errors, recording it on the sink", async () => {
  // Load-bearing for BYOCliProvider.generate, which dropped its per-read `.catch(() => {})` on the
  // strength of this contract. A rejection here would escape `attempt()` as a non-ProviderError, and
  // withRetry rethrows those with ZERO retries — so a transient read error would kill the morning.
  // MUTATION (verified red): remove drain's try/catch so `done` rejects → the test fails with the raw
  // "boom" rejection instead of resolving.
  const enc = new TextEncoder();
  const d = drain(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode("partial")); c.error(new Error("boom")); },
  }));
  await d.done;                       // must not throw
  expect(d.sink.errored).toBe(true);
  expect(d.sink.complete).toBe(false);
  expect(String((d.sink.error as Error)?.message)).toContain("boom");
});

test("a multi-byte UTF-8 sequence split across chunks decodes ONCE, not per chunk", async () => {
  // `sinkText` concatenates and decodes once. Decoding per chunk turns a sequence straddling a chunk
  // boundary into two U+FFFDs — and chunk boundaries are set by the OS pipe, not by us, so this is a
  // real shape rather than a contrived one.
  // MUTATION (verified red): `sink.chunks.map(c => new TextDecoder().decode(c)).join("")` →
  // the assertion receives "caf�� briefing".
  const d = drain(new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([0x63, 0x61, 0x66, 0xC3]));           // "caf" + first byte of é
      c.enqueue(new Uint8Array([0xA9, 0x20, 0x62, 0x72, 0x69, 0x65, 0x66, 0x69, 0x6E, 0x67])); // "© briefing" tail
      c.close();
    },
  }));
  await d.done;
  expect(sinkText(d.sink)).toBe("café briefing");
});

// ── F1: the byte cap (T1.3.1-3, 7-9) ────────────────────────────────────────────────────────────

test("T1.3.1 — a read past maxBytes sets truncated and does NOT set complete", async () => {
  // `complete` means "reached EOF"; a capped read did not. probe.ts's anomaly gate reads the two
  // together (`!complete && !truncated`), so conflating them would make a truncated help text look
  // like a held pipe — or vice versa.
  const d = drain(eofStream(["0123456789", "0123456789"]), { maxBytes: 5 });
  await d.done;
  expect(d.sink.truncated).toBe(true);
  expect(d.sink.complete).toBe(false);
  // ⚠ And the cap must actually CAP. MUTATION this kills: `break` -> `continue` on the cap path.
  // Under `continue`, `truncated` is still set and `complete` still suppressed, so every FLAG
  // assertion in this file stays green while `drain` reads the stream to EOF and retains all of it.
  // Here that is 20 bytes against a 5-byte cap, hence the `<= 10` bound (one chunk of overshoot);
  // the same mutation against probe's 400,000-byte cap fixture retains 327,680 bytes. That is the
  // entire purpose of `maxBytes`
  // (bounding memory against a runaway CLI's help text) going unpinned. Bound is one chunk of
  // overshoot, because the cap is soft by design.
  expect(sinkText(d.sink).length).toBeLessThanOrEqual(10);
});

test("T1.3.2 — with NO maxBytes a large multi-chunk stream never truncates and keeps every byte", async () => {
  // Fixture is deliberately > 256 KB (MAX_HELP_BYTES, the one real cap in the codebase) and spread
  // across many chunks: a small fixture would pass even if the "unbounded" default were secretly
  // some large number, and would not exercise the concat path at a chunk boundary at all.
  const chunk = "y".repeat(8_192);
  const n = 40;                                   // 327,680 bytes > 256 KB
  const d = drain(eofStream(Array(n).fill(chunk)));
  await d.done;
  expect(d.sink.truncated).toBe(false);
  expect(d.sink.complete).toBe(true);
  expect(sinkText(d.sink).length).toBe(chunk.length * n);   // assert bytes RECOVERED, not just the flag
});

test("T1.3.3 — maxBytes: 0 caps immediately (the check is `!== undefined`, not truthiness)", async () => {
  // MUTATION this kills: `if (maxBytes && bytes > maxBytes)`. Under truthiness, 0 reads as "no cap"
  // and an unbounded read ships as a capped one. No other test distinguishes 0 from undefined.
  // Fixture must be NON-EMPTY: with check-after-append, a 0-cap empty stream reaches EOF and sets
  // complete = true / truncated = false, which is identical under both operators.
  const d = drain(eofStream(["x"]), { maxBytes: 0 });
  await d.done;
  expect(d.sink.truncated).toBe(true);
  expect(d.sink.complete).toBe(false);
});

test("T1.3.9 — exactly maxBytes bytes is NOT truncated (pins `>` against `>=`)", async () => {
  // The ONLY test that discriminates `bytes > maxBytes` from `bytes >= maxBytes`: T1.3.1 (over-cap),
  // T1.3.2 (no cap) and T1.3.3 (zero cap) behave identically under both. Without this the off-by-one
  // ships green, and the audit byte-identity receipt cannot express it either (single-chunk fixture).
  const d = drain(eofStream(["01234"]), { maxBytes: 5 });   // exactly at the cap
  await d.done;
  expect(d.sink.truncated).toBe(false);
  expect(d.sink.complete).toBe(true);
});

test("T1.3.7 — abandoning BEFORE the cap leaves both truncated and complete false", async () => {
  // Pins the `canceled` guard on `complete` in the presence of a cap: without `!sink.canceled`,
  // cancel() resolves the pending read as EOF and the loop sets complete = true.
  const d = drain(neverEofStream(["tiny"]), { maxBytes: 1_000 });
  d.abandon();
  await d.done;
  expect(d.sink.truncated).toBe(false);
  expect(d.sink.complete).toBe(false);
});

test("T1.3.8 — a chunk landing AFTER abandon cannot set truncated (the freeze)", async () => {
  // Pins `if (!sink.canceled) sink.truncated = true`. `reader.cancel()` is async, so a chunk already
  // delivered to the pending read() still lands; without the freeze it would set `truncated` after a
  // caller's gate had read it, flipping probe's `!complete && !truncated` anomaly into a silent ok.
  // ORDERING PROPERTY, not a reproduced production bug: measured 0/200 through raceFlush, because
  // cancel() resets the queue and microtask drains are atomic. Deterministic here (no timers) —
  // measured 0/30 failures frozen, 30/30 unfrozen.
  const enc = new TextEncoder();
  const d = drain(new ReadableStream<Uint8Array>({
    start(c) { for (let i = 0; i < 8; i++) c.enqueue(enc.encode("0123456789")); /* never closes */ },
  }), { maxBytes: 16 });
  await Promise.resolve();   // let the first read land, leaving a read pending mid-flight
  d.abandon();
  await d.done;
  expect(d.sink.truncated).toBe(false);
  expect(d.sink.complete).toBe(false);
});

// ── F1: the shared flush race (T1.3.4-6) ────────────────────────────────────────────────────────

test("T1.3.4a — raceFlush releases a held STDOUT reader while stderr is complete (the `||`)", async () => {
  // The fixture MUST be one-sided. With both streams held, `!complete || !complete` and
  // `!complete && !complete` are both true and weakening `||` to `&&` SURVIVES — see
  // provider.incomplete-read.test.ts:159-162, which measured exactly that. Asserting the SOURCE's
  // cancel() hook rather than sink.canceled also kills the drop-reader.cancel() mutation.
  const held = heldWithCancelFlag();
  const o = drain(held.stream), e = drain(eofStream(["done\n"]));
  await raceFlush(o, e, 50);
  expect(e.sink.complete).toBe(true);
  expect(held.wasCancelled()).toBe(true);
});

test("T1.3.4b — raceFlush releases a held STDERR reader while stdout is complete (the mirror)", async () => {
  // The mirror is not redundant: it kills a `raceFlush` implementation that inspects only `a` —
  // measured, gating on `!a.sink.complete` alone leaves this the single red test.
  // (It does NOT catch a CALL SITE passing the same handle twice — `raceFlush(o, o, ms)` is
  // tsc-clean, and no stream-level test executes a call site. That is what the per-site tests in
  // git.incomplete-read.test.ts / probe.test.ts / proc.incomplete-read.test.ts are for.)
  const held = heldWithCancelFlag();
  const o = drain(eofStream(["BRIEFING\n"])), e = drain(held.stream);
  await raceFlush(o, e, 50);
  expect(o.sink.complete).toBe(true);
  expect(held.wasCancelled()).toBe(true);
});

test("T1.3.4c — raceFlush waits for BOTH reads, not the first (pins `Promise.all`, not `race`)", async () => {
  // MUTATION this kills: `Promise.all([a.done, b.done])` -> `Promise.race([...])` inside raceFlush.
  // Every other raceFlush fixture here uses streams that are instant-EOF or never-EOF, and for those
  // `all` and `race` are INDISTINGUISHABLE — so the mutation survived all seven of my original
  // red-checks. It is not theoretical: under `race`, stderr reaching EOF first ends the wait and the
  // `finally` then abandons a perfectly healthy stdout mid-read. Measured: 40,960 bytes recovered
  // correctly vs `complete=false, canceled=true` under the mutant.
  //
  // Live as of M2: `probe.ts` uses raceFlush, and `--help` with a SILENT (instantly-EOF) stderr is
  // the common shape — so this mutation would turn every probe into a spurious
  // "stdout never reached EOF" anomaly and disable provider hardening every morning.
  const enc = new TextEncoder();
  const slowButFinite = new ReadableStream<Uint8Array>({
    async start(c) {
      for (let i = 0; i < 5; i++) { await Bun.sleep(5); c.enqueue(enc.encode("x".repeat(8_192))); }
      c.close();
    },
  });
  const o = drain(slowButFinite), e = drain(eofStream([]));   // stderr EOFs immediately
  await raceFlush(o, e, 5_000);                                // window far longer than the slow read
  expect(o.sink.complete).toBe(true);                          // the slow-but-healthy stream survived
  expect(o.sink.canceled).toBe(false);                         // ...and was not abandoned
  expect(sinkText(o.sink).length).toBe(5 * 8_192);             // ...with every byte recovered
});

test("T1.3.5 — raceFlush abandons NOTHING when both reads complete (not over-broad)", async () => {
  // Kills an unconditional abandon. Asserts `sink.canceled === false` rather than a cancel() observer,
  // and that is the deliberate exception to T1.3.4's rule: MEASURED — an already-closed stream never
  // fires its source's cancel() hook (Streams-spec closed-state short-circuit), so an observer here
  // would pin nothing. This assertion is only possible because `canceled` is initialized to false.
  const o = drain(eofStream(["a"])), e = drain(eofStream(["b"]));
  await raceFlush(o, e, 50);
  expect(o.sink.complete).toBe(true);
  expect(e.sink.complete).toBe(true);
  expect(o.sink.canceled).toBe(false);
  expect(e.sink.canceled).toBe(false);
});

test("T1.3.6 — raceFlush CLEARS its flush timer when the reads win the race", async () => {
  // Pinned structurally, with a spy. A timing assertion CANNOT discriminate: Promise.race resolves the
  // moment the reads win whether or not clearTimeout ran (measured: good and leaky both 0ms). The
  // property that actually matters — not holding the event loop open, which at ~110 git calls per tick
  // is why the timer is clearable at all — shows up only as process-exit latency, and `bun test` never
  // exits per test. MUTATION (verified red): delete `if (flush) clearTimeout(flush)` → 0 calls.
  const spy = spyOn(globalThis, "clearTimeout");
  try {
    const o = drain(eofStream(["a"])), e = drain(eofStream(["b"]));
    await raceFlush(o, e, 10_000);   // a long window the reads must win
    expect(spy).toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});
