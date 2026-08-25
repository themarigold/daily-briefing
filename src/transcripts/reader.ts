// Slice 1.5 T2.1 — the streaming JSONL reader.
//
// Two properties matter, and both are correctness rather than polish:
//
// 1. BOUNDED LINE, sized off the SUBAGENT maximum. Depth-1's longest line is 1 484 365 chars; the
//    subagent tier's is 3 798 052 — 2.6x larger. A cap derived from the depth-1 figure silently
//    skips real subagent lines on the empty-join ESCALATION path, which is exactly where §2.2 warns
//    under-reading is invisible.
// 2. YIELDING. `runCore` starts the scan before `generate` and awaits it after, so a synchronous
//    multi-megabyte parse would block the event loop and stall the very call it overlaps with.
//    Invariant 8 forbids the transcript feature degrading the git briefing.
import { open } from "node:fs/promises";

/** Sized off the subagent maximum (3 798 052) with headroom, NOT the depth-1 one. */
export const MAX_LINE_CHARS = 4_500_000;

/** How many lines to process between yields. Small enough that one slice stays well inside the
 *  50 ms block bound even on a pathological file, large enough that yielding is not itself the cost. */
export const LINES_PER_SLICE = 256;

export type ReadTally = { linesRead: number; linesSkipped: number; parseFailures: number };

/** Hand control back to the event loop. `setImmediate` (macrotask) rather than a microtask — a
 *  resolved-promise await stays inside the same macrotask and would NOT let pending I/O or the
 *  provider call progress, which is the entire point. */
const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Stream one JSONL file, yielding parsed objects.
 *
 *  Fail-closed per line, never per file: an over-cap or unparseable line is SKIPPED AND COUNTED
 *  (invariant 6) while the rest of the file still contributes. A file-level throw would discard good
 *  evidence because of one bad line — and `journal.jsonl`, which the recursive subagent glob
 *  deliberately ingests, is full of lines this reader is not meant to understand. */
export async function* readJsonl(
  path: string, tally: ReadTally,
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    return; // an unreadable file is "no evidence", never a throw — the feature is optional
  }
  try {
    let pending = "";
    let sinceYield = 0;
    // Read in chunks and split on newlines ourselves: a line-oriented helper that buffers a whole
    // 3.8 MB line before handing it over would defeat the cap, which must be enforced as the buffer
    // grows rather than after.
    for await (const chunk of fh.createReadStream({ encoding: "utf-8", highWaterMark: 1 << 20 })) {
      pending += chunk as string;
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        const parsed = consume(line, tally);
        if (parsed) yield parsed;
        if (++sinceYield >= LINES_PER_SLICE) { sinceYield = 0; await yieldToLoop(); }
      }
      // The cap applies to the ACCUMULATING buffer too. Without this an unterminated 100 MB line
      // would be held whole in memory before ever being measured.
      if (pending.length > MAX_LINE_CHARS) { tally.linesSkipped++; pending = ""; }
    }
    if (pending.length > 0) {
      const parsed = consume(pending, tally);
      if (parsed) yield parsed;
    }
  } catch {
    // A mid-stream I/O error keeps whatever was already yielded. Counted as a skip so the run's
    // accounting still balances rather than silently shrinking.
    tally.linesSkipped++;
  } finally {
    await fh.close().catch(() => {});
  }
}

function consume(line: string, tally: ReadTally): Record<string, unknown> | null {
  if (line.length === 0) return null;                       // blank separator, not a line
  tally.linesRead++;
  if (line.length > MAX_LINE_CHARS) { tally.linesSkipped++; return null; }
  try {
    const o = JSON.parse(line);
    if (!o || typeof o !== "object" || Array.isArray(o)) { tally.parseFailures++; return null; }
    return o as Record<string, unknown>;
  } catch {
    tally.parseFailures++;                                  // truncated tail line, or a non-JSON line
    return null;
  }
}

export function emptyTally(): ReadTally {
  return { linesRead: 0, linesSkipped: 0, parseFailures: 0 };
}
