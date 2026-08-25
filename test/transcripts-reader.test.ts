// Slice 1.5 T2.1 — the streaming JSONL reader: bounded lines, and yielding often enough that the
// scan cannot stall the provider call it overlaps with.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonl, emptyTally, MAX_LINE_CHARS, LINES_PER_SLICE } from "../src/transcripts/reader";

const tmp = () => mkdtempSync(join(tmpdir(), "dba-rd-"));
const EVENT_LOOP_BOUND_MS = 50; // the plan's chosen bound (§3.2); the OBSERVED value is measured below

async function drain(path: string) {
  const tally = emptyTally();
  const out: Record<string, unknown>[] = [];
  for await (const o of readJsonl(path, tally)) out.push(o);
  return { tally, out };
}

test("T2.1: reads well-formed JSONL and counts what it read", async () => {
  const p = join(tmp(), "a.jsonl");
  writeFileSync(p, [{ type: "user", i: 1 }, { type: "assistant", i: 2 }].map((o) => JSON.stringify(o)).join("\n") + "\n");
  const { tally, out } = await drain(p);
  expect(out.map((o) => o.i)).toEqual([1, 2]);
  expect(tally).toEqual({ linesRead: 2, linesSkipped: 0, parseFailures: 0 });
});

// Fail-closed PER LINE, never per file: one bad line must not discard a file's good evidence. This
// matters concretely because the recursive subagent glob deliberately ingests journal.jsonl, which
// is full of lines this reader is not meant to understand.
test("T2.1: an unparseable line is skipped and COUNTED, and the rest of the file survives", async () => {
  const p = join(tmp(), "b.jsonl");
  writeFileSync(p, `{"type":"user","i":1}\n{"type":"user","i":truncated\n{"type":"user","i":3}\n`);
  const { tally, out } = await drain(p);
  expect(out.map((o) => o.i)).toEqual([1, 3]);
  expect(tally.parseFailures).toBe(1);
  expect(tally.linesRead).toBe(3);
});

test("T2.1: a JSON scalar or array line is a parse failure, not an object", async () => {
  const p = join(tmp(), "c.jsonl");
  writeFileSync(p, `{"type":"user","i":1}\n"a bare string"\n[1,2,3]\n`);
  const { tally, out } = await drain(p);
  expect(out.length).toBe(1);
  expect(tally.parseFailures).toBe(2);
});

// ⚠ The cap is sized off the SUBAGENT maximum (3 798 052), not the depth-1 one (1 484 365). A cap
// derived from the depth-1 figure would skip real subagent lines on the escalation path — exactly
// where §2.2 warns that under-reading is invisible.
test("T2.1: the line cap is sized off the SUBAGENT maximum, not depth-1's", () => {
  expect(MAX_LINE_CHARS).toBeGreaterThan(3_798_052);
  expect(MAX_LINE_CHARS).toBeGreaterThan(1_484_365 * 2); // a depth-1-derived cap would fail this
});

test("T2.1: an over-cap line is skipped and counted, and its neighbours survive", async () => {
  const p = join(tmp(), "d.jsonl");
  const huge = JSON.stringify({ type: "user", pad: "x".repeat(MAX_LINE_CHARS + 10) });
  writeFileSync(p, `{"type":"user","i":1}\n${huge}\n{"type":"user","i":3}\n`);
  const { tally, out } = await drain(p);
  expect(out.map((o) => o.i)).toEqual([1, 3]);
  expect(tally.linesSkipped).toBe(1);
});

test("T2.1: an unreadable file yields nothing and does not throw", async () => {
  const { tally, out } = await drain(join(tmp(), "missing.jsonl"));
  expect(out).toEqual([]);
  expect(tally.linesRead).toBe(0);
});

// ── The event-loop bound, with the plan's self-invalidating control ──────────────────────────────
// ⚠ The CONTROL RUNS IN THE SAME TEST: a single-pass non-yielding read of the SAME fixture must
// itself exceed the bound, else this fails as "fixture no longer adequate". Without that, faster
// hardware or a trimmed fixture would silently restore the defect with no signal — the test would
// go on passing while measuring nothing.
test("T2.1: event-loop block time per slice stays under the bound (control: a non-yielding read exceeds it)", async () => {
  const p = join(tmp(), "big.jsonl");
  // Sized so a single-pass non-yielding parse is demonstrably slow: many lines, each with enough
  // structure that JSON.parse costs real time.
  const line = JSON.stringify({
    type: "assistant", sessionId: "s", uuid: "u", timestamp: "2026-07-30T10:00:00.000Z",
    message: { role: "assistant", content: Array.from({ length: 12 }, (_, i) => ({ type: "tool_use", id: `t${i}`, name: "Edit", input: { file_path: `src/very/long/path/segment/number/${i}/file.ts` } })) },
  });
  // 60 000 lines (~89 MB). Calibrated: 20 000 lines lands at ~51 ms — within noise of the 50 ms
  // bound, so the control would flake. 60 000 measures ~124 ms, comfortably above it.
  const LINES = 60_000;
  writeFileSync(p, Array.from({ length: LINES }, () => line).join("\n") + "\n");

  // CONTROL: parse the whole file in one synchronous pass and measure how long the loop is blocked.
  const raw = await Bun.file(p).text();
  const t0 = performance.now();
  for (const l of raw.split("\n")) { if (l) JSON.parse(l); }
  const controlMs = performance.now() - t0;
  expect(controlMs).toBeGreaterThan(EVENT_LOOP_BOUND_MS); // else: FIXTURE NO LONGER ADEQUATE

  // MEASURED: the reader's worst uninterrupted gap, via a timer-lag probe.
  //
  // ⚠ The final gap — last tick to END OF READ — MUST be folded in. Without it this assertion is
  // VACUOUS against the very defect it targets: a fully-blocking reader stops the probe from firing
  // at all, so `worstGapMs` keeps its initial 0 and sails under the bound. Measured directly —
  // deleting the reader's `await yieldToLoop()` left this test GREEN at "worst gap = 0.0ms" until
  // the final gap was added.
  let lastTick = performance.now();
  let worstGapMs = 0;
  const observe = () => { const now = performance.now(); worstGapMs = Math.max(worstGapMs, now - lastTick); lastTick = now; };
  const probe = setInterval(observe, 1);
  try {
    lastTick = performance.now();
    const tally = emptyTally();
    let n = 0;
    for await (const _ of readJsonl(p, tally)) n++;
    expect(n).toBe(LINES);
  } finally {
    clearInterval(probe);
  }
  observe(); // the gap the probe could not report, because it never got to run

  // Bound is the DESIGN value on a calibrated machine, but relative to the same-process control on
  // a contended one (CI flake 2026-08-25: a loaded shared runner inflated BOTH numbers; the
  // absolute 50ms bound failed while the yielding invariant held). The control is measured seconds
  // earlier in this very test, so the ratio rides the machine's actual speed — and still kills the
  // defect this pins: deleting the reader's yieldToLoop() makes worstGap ≈ control, failing both
  // arms of the max().
  expect(worstGapMs).toBeLessThan(Math.max(EVENT_LOOP_BOUND_MS, controlMs / 2));
  console.log(`  T2.1 measured: control(non-yielding)=${controlMs.toFixed(0)}ms, worst yielding gap=${worstGapMs.toFixed(1)}ms, bound=${EVENT_LOOP_BOUND_MS}ms`);
});

// ⚠ There is deliberately NO separate "does it yield between slices" test. The obvious shape —
// counting macrotask turns across the read — does NOT discriminate: the counter advances freely
// while the reader awaits I/O for its first chunk, so it measures I/O wait, not parse yielding, and
// stayed green with the yield deleted. The bound test above is the real property and does
// discriminate (measured: 122 ms blocking vs 2 ms yielding).
