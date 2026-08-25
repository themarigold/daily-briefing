// test/render.morning-floor.test.ts — floor AND actual time, both stated, no cause inferred.
//
// WHY THIS EXISTS (day 23, 2026-08-08). The laptop was lid-closed until 13:01 and the briefing landed
// at 13:08. That MEETS this project's stated success criterion — "ready when the user first sits
// down" (2026-07-16 wake-triggered-delivery design, which superseded forcing a wake after an
// overnight test proved a lid-closed battery laptop cannot be woken from userspace).
//
// With only ONE timestamp printed, that success was indistinguishable from a failure. It was misread
// as one by two readers in sequence: an EVAL row was filed as DELIVERY FAILED, retracted, and then
// the retraction's own framing had to be corrected. Two printed timestamps prevent all of it.
import { test, expect } from "bun:test";
import { renderBriefing } from "../src/render";
import type { BriefingStruct } from "../src/types";

const base: BriefingStruct = {
  date: "2026-08-08", machineScope: "m", provider: "claude",
  resume: [{ repo: "r", text: "resume here" }], recap: [], suggestions: [],
};

// ⚠ RE-FRAMED 2026-08-17 (scope decision, user-directed): the deliverable is a FIRST-WAKE briefing,
// so the stamp names the delivery "first wake" and the floor as the thing it is past. The day-23
// property below is UNCHANGED and load-bearing — both times still printed, no cause inferred. Note
// the header comment above already described first-wake as the success criterion in July; the label
// is catching up to the design, not changing it.
test("floor and actual time are BOTH printed", () => {
  const out = renderBriefing({ ...base, stateAsOf: "13:08", morningFloor: "07:20" });
  expect(out).toContain("first wake past 07:20");
  expect(out).toContain("state as of 13:08");
});

test("⚠ NO cause is asserted — only the two facts", () => {
  // Deliberate. Inferring "late because the machine was asleep" means asserting a cause, and the two
  // most recent confident causal claims in this project were both WRONG: the zero-yield trigger's
  // "allowlist or discriminator decay" (day 21, refuted by its own telemetry) and the retry-loop
  // story behind the first day-23 row (refuted by pmset). A reader can see 07:20 vs 13:08 and draw
  // their own conclusion; the tool should not draw it for them.
  const out = renderBriefing({ ...base, stateAsOf: "13:08", morningFloor: "07:20" });
  for (const claim of ["asleep", "late", "missed", "failed", "delayed"]) {
    expect(out.toLowerCase()).not.toContain(claim);
  }
});

test("an ON-TIME briefing reads naturally — the line is not late-only", () => {
  const out = renderBriefing({ ...base, stateAsOf: "07:21", morningFloor: "07:20" });
  expect(out).toContain("first wake past 07:20 · state as of 07:21");
});

test("no floor ⇒ still framed as first wake, so an older struct renders sensibly", () => {
  const out = renderBriefing({ ...base, stateAsOf: "09:00" });
  expect(out).toContain("(first wake · state as of 09:00)");
  expect(out).not.toContain("past");            // no floor ⇒ nothing to be past
});

test("no stateAsOf ⇒ no stamp at all, floor or not", () => {
  // The floor alone is meaningless — it is a comparison or it is noise.
  //
  // ⚠ THIS ASSERTION WAS REWRITTEN 2026-08-17 BECAUSE THE RENAME WOULD HAVE MADE IT VACUOUS. It read
  // `not.toContain("morning floor")` — a string the renderer can no longer emit under ANY input, so
  // it would have passed forever while testing nothing. Same class as the two archive tests measured
  // unable to fail on 2026-08-14. It now names the string the renderer actually produces.
  const out = renderBriefing({ ...base, morningFloor: "07:20" });
  expect(out).not.toContain("first wake");
  expect(out).not.toContain("07:20");
  expect(out).toContain("▶ Where you left off\n");
});

test("⚠ the EMPTY-WINDOW / offline-skip struct carries the floor too", async () => {
  // `runCore` builds the struct in TWO places: `mkStruct` for the provider-less paths (empty window,
  // offline skip) and the normal post-generation path. MEASURED: removing `morningFloor` from
  // `mkStruct` alone left all 1029 tests green — the main.test.ts wiring pin only drives the normal
  // path. A quiet day is exactly when a reader most needs to know whether the briefing is on time,
  // because there is no content to judge it by.
  const { runCore } = await import("../src/core");
  const repo = "/definitely/not/a/repo";           // no activity ⇒ the provider-less empty-window path
  const r = await runCore(
    { repos: [repo], morningTime: "05:30", provider: { cli: "claude", argv: [], promptVia: "stdin" } },
    { netProbe: async () => true, netGraceMs: 1, netPollMs: 1 },
    true,
  );
  expect(r.struct.morningFloor).toBe("05:30");
});
