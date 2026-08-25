// test/eval/mutations.test.ts — mutation self-tests: the load-bearing proof that each eval
// CHECK (src/eval/checks.ts) can actually FAIL (or, for a deliberate WARN-tier rule like G2's
// file-claims, actually fire at all). Each test picks a GOLD_CASES entry, applies a
// `deps.mutate` transform (a pure `(s) => s'` clone/modify of the pipeline's real BriefingStruct
// output) that corrupts it in one specific way, and asserts the corrupted run produces the
// expected finding. Unlike gold.test.ts (asserts real gold cases pass clean), these assert the
// checks already fail/warn correctly on a known-bad struct — RED-first doesn't apply. A mutant
// that unexpectedly produces no finding means the corresponding check is broken; that is
// reported, never hidden by weakening the assertion.
import { test, expect } from "bun:test";
import { runCase } from "../../src/eval/run-case";
import { echoProvider } from "../../src/eval/echo";
import { GOLD_CASES } from "../../src/eval/cases";

function findCase(name: string) {
  const gc = GOLD_CASES.find((c) => c.name === name);
  if (!gc) throw new Error(`gold case "${name}" not found in GOLD_CASES`);
  return gc;
}

// --- 1. planted fabrication -------------------------------------------------------------------
// A git- AND prompt-absent hex token planted into a recap bullet's prose. day1-fabrication's own
// commit message ("revert deadbee1234") contains a DIFFERENT token, so this new token isn't
// exempted by the citing bullet's own commit message either -> G2 fabrication fail.
test("mutation: planted fabrication — git+prompt-absent hex token in recap prose -> G2 fabrication fail", async () => {
  const gc = findCase("day1-fabrication");
  const { pass, findings } = await runCase(gc, echoProvider(), {
    mutate: (s) => ({
      ...s,
      recap: s.recap.map((b, idx) => (idx === 0 ? { ...b, text: `${b.text} see deadc0debeef1234` } : b)),
    }),
  });
  expect(pass).toBe(false);
  expect(findings.some((f) => f.check === "G2" && f.rule === "fabrication" && f.severity === "fail")).toBe(true);
});

// --- 2. attribution-swap -----------------------------------------------------------------------
// nested-root has exactly 2 recap bullets (one per named unit: packages/app/plugin,
// packages/app). Swap BOTH bullets' [label]s with each other -> both are now misattributed to a
// DIFFERENT real unit's label -> two G1 attribution fails. (day8-tie was considered per the brief
// but only ever produces ONE recap bullet under the tied-commit catch-all, and its non-window
// packages/a/packages/b roots never enter `units` — there's no second addressable unit to swap
// with. nested-root gives a real ≥2-unit swap.)
test("mutation: attribution-swap — nested-root's two bullets swap [label]s -> G1 attribution fail (both bullets)", async () => {
  const gc = findCase("nested-root");
  const { pass, findings } = await runCase(gc, echoProvider(), {
    mutate: (s) => {
      if (s.recap.length !== 2) throw new Error("expected nested-root to produce exactly 2 recap bullets");
      const [b0, b1] = s.recap;
      return { ...s, recap: [{ ...b0!, repo: b1!.repo }, { ...b1!, repo: b0!.repo }] };
    },
  });
  expect(pass).toBe(false);
  const attrFails = findings.filter((f) => f.check === "G1" && f.rule === "attribution" && f.severity === "fail");
  expect(attrFails.length).toBe(2);
});

// --- 3. wrong-[label] --------------------------------------------------------------------------
// Distinct shape from #2: relabel ONLY bullet0 to bullet1's (real, different) unit label; bullet1
// is left untouched and stays correctly attributed. One-sided relabel -> exactly ONE G1
// attribution fail (vs. #2's mutual swap -> two).
test("mutation: wrong-[label] — nested-root's bullet0 relabeled to bullet1's unit (one-sided, not a swap) -> G1 attribution fail (single bullet)", async () => {
  const gc = findCase("nested-root");
  const { pass, findings } = await runCase(gc, echoProvider(), {
    mutate: (s) => {
      if (s.recap.length !== 2) throw new Error("expected nested-root to produce exactly 2 recap bullets");
      const otherLabel = s.recap[1]!.repo;
      return { ...s, recap: s.recap.map((b, idx) => (idx === 0 ? { ...b, repo: otherLabel } : b)) };
    },
  });
  expect(pass).toBe(false);
  const attrFails = findings.filter((f) => f.check === "G1" && f.rule === "attribution" && f.severity === "fail");
  expect(attrFails.length).toBe(1);
});

// --- 4. file-not-in-diffstat (Option C — uniformly WARN-tier) -----------------------------------
// Plants a path in recap prose that is in NEITHER the cited commit's diffstat NOR the global
// fileInventory (a wholly fabricated, non-existent file — not just a real file cited under the
// wrong commit). This used to be silently ignored (checks.ts's file-claims sub-check did
// `if (!inInventory) continue;`) — the approved Option C design closes that gap by making ALL
// file-claim mismatches uniformly warn-tier, rather than promoting inventory-absent paths to a
// hard fail. SHA fabrication remains the only hard-fail fabrication tier; a warn does NOT flip
// `pass` to false.
test("mutation: file-not-in-diffstat — inventory-absent fabricated path in recap prose -> G2 fabrication warn (pass unaffected)", async () => {
  const gc = findCase("nested-root");
  const { pass, findings } = await runCase(gc, echoProvider(), {
    mutate: (s) => ({
      ...s,
      recap: s.recap.map((b, idx) =>
        idx === 0 ? { ...b, text: `${b.text} also touched totally/nonexistent/fakepath.ts` } : b,
      ),
    }),
  });
  expect(pass).toBe(true);
  expect(findings.some((f) => f.check === "G2" && f.rule === "fabrication" && f.severity === "warn")).toBe(true);
  expect(findings.filter((f) => f.severity === "fail")).toEqual([]);
});

// --- 5. dropped-commit -------------------------------------------------------------------------
// Remove a recap bullet entirely so its in-window commit is no longer cited by any bullet -> G1
// coverage fail (cited 0 times).
test("mutation: dropped-commit — remove a recap bullet, leaving its in-window commit uncited -> G1 coverage fail", async () => {
  const gc = findCase("nested-root");
  const { pass, findings } = await runCase(gc, echoProvider(), {
    mutate: (s) => ({ ...s, recap: s.recap.slice(1) }),
  });
  expect(pass).toBe(false);
  expect(findings.some((f) => f.check === "G1" && f.rule === "coverage" && f.severity === "fail")).toBe(true);
});

// --- 6. mega-bullet ----------------------------------------------------------------------------
// Merge bullet1's evidence SHA into bullet0's evidence field, violating G1's exactly-one-SHA
// rule for bullet0 -> G1 evidence fail. (Side effect: bullet1's commit is now uncited, which also
// trips a G1 coverage fail — that's expected and doesn't weaken the assertion under test.)
test("mutation: mega-bullet — one recap bullet carries two evidence SHAs -> G1 evidence fail", async () => {
  const gc = findCase("nested-root");
  const { pass, findings } = await runCase(gc, echoProvider(), {
    mutate: (s) => {
      if (s.recap.length !== 2) throw new Error("expected nested-root to produce exactly 2 recap bullets");
      const [b0, b1] = s.recap;
      const merged = `${b0!.evidence ?? ""} ${b1!.evidence ?? ""}`.trim();
      return { ...s, recap: [{ ...b0!, evidence: merged }, b1!] };
    },
  });
  expect(pass).toBe(false);
  expect(findings.some((f) => f.check === "G1" && f.rule === "evidence" && f.severity === "fail")).toBe(true);
});

// --- 7. removed-suppression-filter ---------------------------------------------------------------
// Simulates generateBriefing's post-parse INFRA_DENYLIST filter (Task 8) regressing: re-inject
// the exact `.claude/worktrees/` suggestion text it strips back into struct.suggestions. Proves
// G4 itself still catches a denylisted suggestion when one survives (the filter is a defense in
// depth, not the only line of defense).
test("mutation: removed-suppression-filter — day5-worktrees' stripped .claude/worktrees/ suggestion re-injected -> G4 denylist fail", async () => {
  const gc = findCase("day5-worktrees");
  const { pass, findings } = await runCase(gc, echoProvider(), {
    mutate: (s) => ({
      ...s,
      suggestions: [...s.suggestions, { text: "review uncommitted .claude/worktrees/x" }],
    }),
  });
  expect(pass).toBe(false);
  expect(findings.some((f) => f.check === "G4" && f.rule === "denylist" && f.severity === "fail")).toBe(true);
});

// --- 8. clean PASS control ----------------------------------------------------------------------
test("mutation control: clean run (no mutate) passes", async () => {
  const { pass, findings } = await runCase(findCase("nested-root"), echoProvider());
  expect(pass).toBe(true);
  expect(findings.filter((f) => f.severity === "fail")).toEqual([]);
});

// --- 9. quoting-exemption PASS control -----------------------------------------------------------
// day1-fabrication, unmutated: the message-quoted fake-looking SHA ("deadbee1234") must NOT be
// flagged by G2 — it's exempt because it's a substring of the citing bullet's own commit message.
test("mutation control: quoting-exemption — day1-fabrication (no mutate) passes; message-quoted fake SHA is not flagged", async () => {
  const { pass, findings } = await runCase(findCase("day1-fabrication"), echoProvider());
  expect(pass).toBe(true);
  expect(findings.filter((f) => f.severity === "fail")).toEqual([]);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Slice 1.5 T8.5 — MUT1–MUT8 for G5 (the transcript "why" checks).
//
// ⚠ Each mutation must make its NAMED rule fail, each is asserted to have actually been APPLIED,
// and the UNMUTATED case must produce no finding. That third clause is the load-bearing one: a
// suite asserting only "mutated ⇒ fails" is satisfied by a check that fails on everything, which
// proves the check is loud rather than right.
//
// ⚠ All eight run against transcript-carrying input, because G5's no-op predicate gates on the CASE
// carrying evidence — not on the struct containing a why. The grouping is about WHERE the mutation
// is applied, not about cost.
//
// These call `g5Whys` directly rather than through `runCase`: G5 needs a `TranscriptEvidence` that
// the gold-case builder does not yet synthesise (that is T8.6), and the mutations must be able to
// corrupt the evidence itself, which a runner cannot express.
import { g5Whys } from "../../src/eval/checks";
import { emptyEvidence, type TranscriptEvidence } from "../../src/transcripts/scan";
import { textSha } from "../../src/transcripts/anchor";
import { renderWhy } from "../../src/transcripts/frame";
import { unitKey } from "../../src/subprojects";
import type { CheckInput, Finding } from "../../src/eval/types";
import type { BriefingStruct } from "../../src/types";

const G5_REPO = "/repo";
const G5_KEY = unitKey(G5_REPO, null);
const G5_WINDOW = { startUtc: "2026-07-29T00:00:00.000Z", endUtc: "2026-07-31T00:00:00.000Z" };
const G5_TURN = "I switched the join to a membership test because the plurality vote mis-attributed";
const G5_UNIT = { repo: G5_REPO, root: null, label: "repo", hasResumptionState: false,
  hasWindowContent: true, resumptionNote: "", dirtyFiles: [], latestCommitTime: null };

/** A COHERENT baseline: source, anchor and segment all agree. */
function g5Baseline(): { input: CheckInput; ev: TranscriptEvidence; struct: BriefingStruct } {
  const ev = emptyEvidence(G5_WINDOW);
  ev.sources.set(G5_KEY, {
    unitKey: G5_KEY, text: G5_TURN,
    anchor: { sessionId: "s1", uuid: "u1", tsUtc: "2026-07-30T09:00:00.000Z", textSha: textSha(G5_TURN), unitKey: G5_KEY },
  });
  ev.segments.push({ sessionId: "s1", unitKey: G5_KEY, localDay: "2026-07-30", paths: ["a.ts"] });
  const struct: BriefingStruct = {
    date: "2026-07-30", machineScope: "m", provider: "claude",
    resume: [], recap: [{ repo: "repo", text: "did the thing" }],
    suggestions: [{ text: "next thing" }], warnings: [], whys: { repo: G5_TURN },
  };
  const input: CheckInput = {
    caseName: "mut", struct, rawText: "", promptText: "", ctx: { repos: [] }, units: [G5_UNIT],
    emptyWindow: false, gitShaSet: new Set(), fileInventory: new Set(),
    shaToUnit: new Map(), commitMessages: new Map(), denylist: [], doneToday: [], transcripts: ev,
  };
  return { input, ev, struct };
}

const g5Rules = (f: Finding[]) => new Set(f.map((x) => x.rule));

test("G5 mutation baseline: the UNMUTATED case produces no finding at all", () => {
  expect(g5Whys(g5Baseline().input)).toEqual([]);
});

// ── Group 1: applied via the post-pipeline struct hook ───────────────────────────────────────────
test("MUT1: a why for a unit with no satisfying segment -> why-attribution", () => {
  const { input, ev, struct } = g5Baseline();
  const other = unitKey("/other", null);
  ev.sources.set(other, { unitKey: other, text: G5_TURN,
    anchor: { sessionId: "sX", uuid: "uX", tsUtc: "2026-07-30T09:00:00.000Z", textSha: textSha(G5_TURN), unitKey: other } });
  input.units = [G5_UNIT, { ...G5_UNIT, repo: "/other", label: "other" }];
  struct.whys = { ...struct.whys, other: G5_TURN };
  expect(ev.segments.some((s) => s.unitKey === other)).toBe(false);   // the mutation IS applied
  expect(g5Rules(g5Whys(input))).toContain("why-attribution");
});

test("MUT5: a why not byte-equal to its anchored turn -> verbatim", () => {
  const { input, struct } = g5Baseline();
  struct.whys = { repo: G5_TURN + " " };                              // ONE trailing space
  expect(struct.whys.repo).not.toBe(G5_TURN);                         // applied
  expect(g5Rules(g5Whys(input))).toContain("verbatim");
});

test("MUT6: a why containing an enumerated completion verb -> scope", () => {
  const { input, ev, struct } = g5Baseline();
  const outcome = "fixed the plurality vote and the mixed-commit case is done now";
  struct.whys = { repo: outcome };
  ev.sources.get(G5_KEY)!.text = outcome;
  ev.sources.get(G5_KEY)!.anchor.textSha = textSha(outcome);          // keep verbatim clean…
  const r = g5Rules(g5Whys(input));
  expect(r).toContain("scope");                                       // …so ONLY scope fires
  expect(r).not.toContain("verbatim");
});

test("MUT7: a why attached to a SUGGESTIONS item -> surface", () => {
  const { input, struct } = g5Baseline();
  struct.suggestions = [{ text: G5_TURN }];
  expect(g5Rules(g5Whys(input))).toContain("surface");
});

// ⚠ MUT8 is the mutation a struct-shaped no-op predicate would let through: a why rendered as its
// own standalone bullet leaves NO why-shaped field. Gating on the CASE keeps it detectable.
test("MUT8: a why rendered as its own standalone bullet -> surface, and ONLY surface", () => {
  const { input, struct } = g5Baseline();
  struct.recap = [...struct.recap, { repo: "repo", text: renderWhy(G5_TURN) }];
  const r = g5Rules(g5Whys(input));
  expect(r).toContain("surface");
  expect(r).not.toContain("verbatim");          // the why itself is still byte-equal
  expect(r).not.toContain("why-attribution");
});

// ── Group 2: applied via the fixture's TranscriptEvidence ────────────────────────────────────────
test("MUT3: a corrupted textSha so the composite cannot resolve -> anchor", () => {
  const { input, ev } = g5Baseline();
  ev.sources.get(G5_KEY)!.anchor.textSha = textSha("a completely different turn");
  const r = g5Rules(g5Whys(input));
  expect(r).toContain("anchor");
  // `verbatim` fires too, and that is correct rather than sloppy — the rendered why genuinely is no
  // longer byte-equal to what the anchor claims. Asserted so the coupling is deliberate, not noticed.
  expect(r).toContain("verbatim");
});

test("MUT4: an anchored turn dated outside the scan window -> freshness", () => {
  const { input, ev } = g5Baseline();
  ev.sources.get(G5_KEY)!.anchor.tsUtc = "2020-01-01T00:00:00.000Z";
  expect(Date.parse(ev.sources.get(G5_KEY)!.anchor.tsUtc)).toBeLessThan(Date.parse(G5_WINDOW.startUtc));
  expect(g5Rules(g5Whys(input))).toContain("freshness");
});

// ── Group 3: applied via a named production seam ─────────────────────────────────────────────────
// ⚠ MUT2 requires the ambiguity drop BYPASSED — which is exactly why §3.2 made `onAmbiguity`
// injectable. With the drop live, two claimants never produce a source at all, so the mutation is
// unreachable and the check untestable.
test("MUT2: two sessions satisfy ATTRIB with the drop bypassed -> why-attribution", () => {
  const { input, ev } = g5Baseline();
  ev.segments.push({ sessionId: "s2", unitKey: G5_KEY, localDay: "2026-07-30", paths: ["b.ts"] });
  expect(new Set(ev.segments.filter((s) => s.unitKey === G5_KEY).map((s) => s.sessionId)).size).toBe(2);
  const findings = g5Whys(input);
  expect(g5Rules(findings)).toContain("why-attribution");
  expect(findings.find((f) => f.rule === "why-attribution")!.detail).toContain("ambiguity drop was bypassed");
});

// ── The no-op predicate, asserted directly ───────────────────────────────────────────────────────
test("G5 no-ops on a case carrying NO transcript evidence, whatever the struct holds", () => {
  const { input, struct } = g5Baseline();
  delete (input as { transcripts?: unknown }).transcripts;
  struct.suggestions = [{ text: G5_TURN }];   // a `surface` fail if the gate were struct-shaped
  expect(g5Whys(input)).toEqual([]);
});

// ── A9 UNION × G5 — the defect this file's own fixture shape hid ─────────────────────────────────
//
// ⚠ THE REGRESSION #181 SHIPPED. Adopting the union made `core.ts` render whys resolved by EITHER
// rule, but G5 resolved a why's evidence from `ev.sources` ALONE — the conservative map. A
// strict-majority-only why therefore had `src === undefined` and failed `why-attribution` ("not
// produced by the join"), a HARD rule; and `core.ts` is FAIL-CLOSED on any G5 fail, so it deleted
// EVERY why and emitted a user-facing withheld-quotations warning. Net effect: on exactly the days
// the union was meant to add whys, the briefing rendered NONE. Strictly worse than before.
//
// The whole suite stayed green because every fixture here seeds `ev.sources` — the conservative map
// — so no test ever constructed the state the union introduced.

/** A strict-majority-only resolution: TWO sessions claim the unit (which is why conservative
 *  dropped it), and the winning session covers the majority of its files. */
function g5StrictOnly(): { input: CheckInput; ev: TranscriptEvidence; struct: BriefingStruct } {
  const b = g5Baseline();
  const src = b.ev.sources.get(G5_KEY)!;
  b.ev.sources.delete(G5_KEY);                       // conservative did NOT resolve it
  b.ev.sourcesStrictMajority.set(G5_KEY, src);       // strict-majority did
  // The second claimant — the reason conservative dropped this unit in the first place.
  b.ev.segments.push({ sessionId: "s2", unitKey: G5_KEY, localDay: "2026-07-30", paths: ["b.ts"] });
  return b;
}

test("⚠ A9 union: a STRICT-MAJORITY-only why passes G5 — it was produced by the join", () => {
  // Pre-fix this returned a why-attribution FAIL, which fail-closed core.ts into dropping every why.
  expect(g5Whys(g5StrictOnly().input)).toEqual([]);
});

test("⚠ A9 union: multi-claimant is LEGITIMATE for a strict-majority why, not a bypassed drop", () => {
  // The second half of the same defect. Even with the source lookup fixed, the single-claimant
  // invariant would still fail this — strict-majority exists precisely to resolve multi-claimant
  // units, so `claimants > 1` is its normal state rather than evidence of a bypassed ambiguity drop.
  const f = g5Whys(g5StrictOnly().input);
  expect(f.map((x) => x.detail).join(" ")).not.toContain("ambiguity drop was bypassed");
});

test("⚠ but a why whose ANCHORED SESSION never claimed the unit still fails — the invariant that survives", () => {
  // What replaces the single-claimant rule for the strict-majority branch. The chosen session must
  // still be one of the sessions that actually worked the unit; otherwise the quotation is attributed
  // to a session with no claim on it, which is the error the whole rule exists to prevent.
  const { input, ev } = g5StrictOnly();
  const src = ev.sourcesStrictMajority.get(G5_KEY)!;
  ev.sourcesStrictMajority.set(G5_KEY, { ...src, anchor: { ...src.anchor, sessionId: "s-ghost" } });
  expect(g5Rules(g5Whys(input)).has("why-attribution")).toBe(true);
});

test("A9 union: the CONSERVATIVE single-claimant invariant is unchanged", () => {
  // The union must not weaken the original rule. A conservative-resolved why with two claimants is
  // still a bypassed ambiguity drop.
  const { input, ev } = g5Baseline();
  ev.segments.push({ sessionId: "s2", unitKey: G5_KEY, localDay: "2026-07-30", paths: ["b.ts"] });
  expect(g5Rules(g5Whys(input)).has("why-attribution")).toBe(true);
});

test("⚠ A9: a CONSERVATIVE why whose ANCHORED SESSION never claimed the unit fails — same as strict", () => {
  // Symmetric with the strict-majority ghost-session test. Before this pin, G5 only checked
  // claimants.size === 1 on the conservative branch, so a ghost sessionId with one real claimant
  // passed why-attribution (measured 2026-08-11: findings === []).
  const { input, ev } = g5Baseline();
  const src = ev.sources.get(G5_KEY)!;
  ev.sources.set(G5_KEY, { ...src, anchor: { ...src.anchor, sessionId: "s-ghost" } });
  expect(g5Rules(g5Whys(input)).has("why-attribution")).toBe(true);
});
