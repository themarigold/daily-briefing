// test/eval/gold.test.ts — every gold case in src/eval/cases.ts runs clean through runCase.
//
// ⚠ THE LOOP IS THE LOAD-BEARING GUARD. A previous form named cases one-by-one, so a case that
// existed only in GOLD_CASES never ran under `bun test` and first executed against a live model via
// `bun run eval`. That is how `same-day-recency` shipped with a permanent integrity throw while the
// suite stayed green (2026-08-11 review). Adding a GOLD_CASES entry is now enough to get a base
// runCase coverage; case-specific extra asserts live below the loop.
import { test, expect } from "bun:test";
import { runCase } from "../../src/eval/run-case";
import { echoProvider } from "../../src/eval/echo";
import { GOLD_CASES } from "../../src/eval/cases";
import { renderBriefing } from "../../src/render";
import { parseWhy } from "../../src/transcripts/frame";
import { textSha } from "../../src/transcripts/anchor";

// ── Universal: every GOLD_CASES entry under bun test ───────────────────────────
for (const gc of GOLD_CASES) {
  test(`gold case: ${gc.name} completes runCase with no fail findings`, async () => {
    const { pass, findings, struct, doneToday } = await runCase(gc, echoProvider());
    expect(pass).toBe(true);
    expect(findings.filter((f) => f.severity === "fail")).toEqual([]);

    // Case-specific extras that a green "no fails" alone would not pin.
    if (gc.name === "no-files-date") {
      // D4a: a no-diffstat commit's trailing date must never reach recap text.
      expect(struct.recap.length).toBeGreaterThan(0);
      for (const r of struct.recap) {
        expect(r.text).not.toMatch(/\d{4}-\d{2}-\d{2}\s*$/);
      }
      expect(struct.recap.some((r) => r.text.includes("chore: trigger CI"))).toBe(true);
    }

    if (gc.name === "same-day-recency") {
      // G7 non-vacuity: two same-day commits must land in the today layer (not the window).
      // Integrity used to require every authored SHA in in-window ctx, so this case permanently
      // threw — the loop above is not enough without these today-layer pins.
      expect((struct.today ?? []).length).toBe(2);
      expect(struct.today!.some((t) => t.text.includes("EARLIER same-day commit"))).toBe(true);
      expect(struct.today!.some((t) => t.text.includes("LATER same-day commit"))).toBe(true);
      // ⚠ THE PIN THAT ACTUALLY GUARDS G7, added 2026-08-11. The three assertions above check
      // `struct.today`; G7 gates on `doneToday` (= core's `todaySuppress`), a SIBLING derivation of
      // the same source with its own failure modes — it skips empty subjects and resolves unit
      // labels separately. A change emptying `todaySuppress` alone would re-vacuate G7 on its only
      // real-data case with everything green, which is the Collision-5 failure this case exists to
      // prevent. The deterministic G7 tests all hand-build `doneToday`, so nothing else covers it.
      expect(doneToday.length).toBe(2);
      expect(doneToday.some((d) => d.subject.includes("EARLIER same-day commit"))).toBe(true);
      expect(doneToday.some((d) => d.subject.includes("LATER same-day commit"))).toBe(true);
      // ⚠ NOT `severity === "fail"`: `g7Recency` hardcodes `warn` (checks.ts), so a fail-filter is
      // vacuous — it read as a G7 pin while pinning nothing. What is falsifiable is that this
      // fixture, whose RESUME is model-generated, produced no recency finding for the wrong reason:
      // assert the rule RAN (via doneToday above) and that any finding it emits is warn-severity.
      for (const f of findings.filter((f) => f.check === "G7")) expect(f.severity).toBe("warn");
    }
  });
}

// Tripwire: the loop above iterates GOLD_CASES, so this only fails if the array is empty or the
// test file is imported without the loop running (it should not happen — pin the count for greps).
test("GOLD_CASES is non-empty and the gold suite covers every entry", () => {
  expect(GOLD_CASES.length).toBeGreaterThanOrEqual(1);
  // Source of truth is cases.ts; if this drifts from the live EVAL.md inventory, update EVAL.md.
  // 8 as of 2026-08-11 (same-day-recency). Bumping is correct only with a considered new case.
  expect(GOLD_CASES.length).toBe(8);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Slice 1.5 T8.6 — the transcript-carrying gold case (extra invariants beyond "no fail findings").
//
// ⚠ THE PLAN CALLS THIS INVARIANTS 1 AND 2's SOLE NON-VACUITY VEHICLE, and the phrasing is exact.
// Every other assertion of those invariants runs against a hand-built struct. This is the only place
// a why travels the WHOLE real path — discover → read → transform → select → segment → anchor →
// join → projection → render — and is then checked against what actually came out.
//
// The universal loop already ran this case for pass/no-fail. These asserts need a second run so a
// failure names the invariant, not a generic green.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
test("T8.6: the transcript gold case produces a REAL why through the whole pipeline", async () => {
  const gc = GOLD_CASES.find((c) => c.name === "transcript-why");
  expect(gc).toBeDefined();
  const r = await runCase(gc!, echoProvider());

  // The premise, asserted first — without it everything below is vacuous.
  expect(r.struct.whys).toBeDefined();
  const entries = Object.entries(r.struct.whys!);
  expect(entries.length).toBe(1);
  const [label, turn] = entries[0]!;
  expect(turn).toContain("membership test");

  // G5 ran (the case carries evidence, so the no-op predicate did not fire) and found nothing.
  expect(r.findings.filter((f) => f.check === "G5")).toEqual([]);
  expect(r.pass).toBe(true);

  // ── INVARIANT 1: never creates a bullet. The why's label must belong to a unit that ALREADY has
  // at least one surviving bullet, and the bullet count must be unchanged by the why's presence.
  const bullets = [...r.struct.recap, ...r.struct.resume];
  expect(bullets.length).toBeGreaterThan(0);
  const carrying = bullets.filter((b) => b.repo.toLowerCase().includes(label.toLowerCase().slice(0, 8)));
  expect(carrying.length).toBeGreaterThan(0);

  // ── INVARIANT 2: never attaches to SUGGESTIONS, never to `today`.
  for (const s of r.struct.suggestions) {
    expect(s.text).not.toBe(turn);
    expect(parseWhy(s.text)).toBeNull();
  }
  for (const t of r.struct.today ?? []) {
    expect(t.text).not.toBe(turn);
    expect(parseWhy(t.text)).toBeNull();
  }

  // ── And it actually RENDERS, exactly once, byte-equal to the turn.
  const lines = renderBriefing(r.struct).split("\n");
  const whyLines = lines.filter((l) => parseWhy(l) !== null);
  expect(whyLines.length).toBe(1);
  expect(textSha(parseWhy(whyLines[0]!)!)).toBe(textSha(turn));

  // The why line introduces a bullet — it is never the last line of its section.
  const idx = lines.indexOf(whyLines[0]!);
  expect(lines[idx + 1]).toContain("•");
});
