// Slice 1.5 M3 — segments/membership (T3.1), anchors (T3.2), the join (T3.3), escalation (T3.4),
// anchor resolution (T3.4a), A9 (T3.5), outcome-verb (T3.6/T3.6a), credentials at the unit scope
// (T3.6b), and health/telemetry (T3.7/T3.8).
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { buildSegments, turnForSegment, makeBucketer, localDayOf, segmentKey } from "../src/transcripts/segments";
import { textSha, makeAnchor, matchesAnchor, resolveAnchor } from "../src/transcripts/anchor";
import { joinEvidence, buildUnitFiles, shouldEscalate, whySourceFor, whySourcesAdopted, countAdoptedWhys } from "../src/transcripts/join";
import { hasOutcomeVerb, OUTCOME_VERBS } from "../src/transcripts/outcomeVerb";
import {
  emptyHealth, mergeRun, zeroYieldStreak, evaluateTriggers, selfTest, isQuestionShaped,
  serialiseHealth, bucketStartToCommit, HYSTERESIS_N,
} from "../src/transcripts/health";
import { emptyCounters, type TranscriptWhySource } from "../src/transcripts/scan";
import { unitKey } from "../src/subprojects";
import { selectTurn } from "../src/transcripts/select";
import type { Activity, Config } from "../src/types";

const CFG: Config = { provider: { cli: "c", argv: [], promptVia: "stdin" } };
const prose = (s: string, n = 60) => (s + " ").repeat(Math.ceil(n / (s.length + 1))).slice(0, Math.max(n, s.length));
const REPO = "/repo";
const K = (root: string | null) => unitKey(REPO, root);
const bucketAB = (abs: string): string | null =>
  abs.startsWith(`${REPO}/a/`) ? K("a") : abs.startsWith(`${REPO}/b/`) ? K("b") : abs.startsWith(`${REPO}/`) ? K(null) : null;

const turn = (sessionId: string, uuid: string, tsUtc: string, text: string, order = 0) =>
  ({ sessionId, uuid, tsUtc, text, order });

// ── T3.1: the POSITIONAL membership rule, with the plan's DISCRIMINATING two-instruction fixture ──
// ⚠ A one-instruction fixture is green under a naive "first qualifying turn of the session"
// implementation, so it cannot fail against the likeliest wrong build. Two instructions — I1 before
// unit A's first edit, I2 BETWEEN A's and B's first edits — force A→I1 and B→I2.
test("T3.1: two instructions discriminate — A takes I1, B takes I2 (a naive 'first turn' build fails)", () => {
  const I1 = "I am starting on unit A because the bucketer keeps mis-attributing its nested root";
  const I2 = "now switching to unit B — the label collision there needs the parent qualifier";
  const candidates = [
    turn("s1", "u1", "2026-07-30T09:00:00.000Z", I1, 0),
    turn("s1", "u2", "2026-07-30T11:00:00.000Z", I2, 1),
  ];
  const paths = [
    { sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/a/x.ts` },  // A's first edit
    { sessionId: "s1", tsUtc: "2026-07-30T12:00:00.000Z", path: `${REPO}/b/y.ts` },  // B's first edit
  ];
  const { segments, firstEdit } = buildSegments(paths, bucketAB);
  const segA = segments.find((s) => s.unitKey === K("a"))!;
  const segB = segments.find((s) => s.unitKey === K("b"))!;

  expect(turnForSegment(segA, firstEdit.get(segmentKey(segA))!, candidates)!.text).toBe(I1);
  expect(turnForSegment(segB, firstEdit.get(segmentKey(segB))!, candidates)!.text).toBe(I2); // NOT I1
});

test("T3.1: no qualifying turn BEFORE the first edit ⇒ that segment has no why (never borrow the next)", () => {
  const later = turn("s1", "u1", "2026-07-30T14:00:00.000Z", prose("a turn written well after the edit"), 0);
  const { segments, firstEdit } = buildSegments(
    [{ sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/a/x.ts` }], bucketAB);
  const seg = segments[0]!;
  expect(turnForSegment(seg, firstEdit.get(segmentKey(seg))!, [later])).toBeNull();
});

test("T3.1: a path under a known repo but no sub-root buckets to the CATCH-ALL, not dropped", () => {
  // Dropping it would give every single-project repo 0% coverage.
  const { segments, pathsUnresolvable } = buildSegments(
    [{ sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/README.md` }], bucketAB);
  expect(segments[0]!.unitKey).toBe(K(null));
  expect(pathsUnresolvable).toBe(0);
  // …while a path under NO configured repo drops THAT PATH ONLY.
  const out = buildSegments([{ sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: "/elsewhere/z.ts" }], bucketAB);
  expect(out.segments).toEqual([]);
  expect(out.pathsUnresolvable).toBe(1);
});

// ⚠ DISCRIMINATING BY CONSTRUCTION: the infra path here buckets to a REAL unit (the catch-all), so
// a build that only dropped paths the bucketer rejects is green on the previous test and red here.
// That was the actual production shape — `.claude/worktrees/<wt>/<subproject>/…` is repo-relative,
// matches no sub-root, and so credited worktree work to the umbrella repo's catch-all.
test("T3.1: an infra path is dropped even though it WOULD bucket to the catch-all", () => {
  const infra = `${REPO}/.claude/worktrees/wt/dba/src/main.ts`;
  expect(bucketAB(infra)).toBe(K(null));                        // …it really would have landed on a unit
  const out = buildSegments([{ sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: infra }], bucketAB);
  expect(out.segments).toEqual([]);
  expect(out.pathsUnresolvable).toBe(1);
});

test("T3.1: infra drops THAT PATH ONLY — a sibling real path still constitutes its segment", () => {
  const { segments } = buildSegments([
    { sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/.claude/worktrees/wt/a/x.ts` },
    { sessionId: "s1", tsUtc: "2026-07-30T11:00:00.000Z", path: `${REPO}/a/real.ts` },
  ], bucketAB);
  expect(segments.length).toBe(1);
  expect(segments[0]!.unitKey).toBe(K("a"));
  expect(segments[0]!.paths).toEqual([`${REPO}/a/real.ts`]);    // the infra path is not evidence of work
});

// ⚠ The plan's second discriminating fixture: a repo ABSENT from resolveUnits' rootsByRepo but
// owning sub-roots must bucket to the SUB-ROOT unit, not the catch-all. Without the
// resolveProjectRoots fallback the "I worked here but committed nothing" case is silently lost —
// which is exactly what RESUME exists to surface.
test("T3.1: a repo absent from rootsByRepo still buckets to its SUB-ROOT via the resolveProjectRoots fallback", async () => {
  const repo = mkdtempSync(pjoin(tmpdir(), "dba-m3-"));
  for (const d of ["packages/api", "packages/web"]) mkdirSync(pjoin(repo, d), { recursive: true });
  const cfg: Config = { ...CFG, subprojects: [{ repo, roots: ["packages/*"] }] };

  const emptyMap = new Map<string, string[]>();               // the repo produced ZERO activities
  const bucket = await makeBucketer([repo], emptyMap, cfg);
  expect(bucket(`${repo}/packages/api/x.ts`)).toBe(unitKey(repo, "packages/api"));
  expect(bucket(`${repo}/packages/api/x.ts`)).not.toBe(unitKey(repo, null));  // NOT the catch-all
});

// ── T3.2: textSha's byte domain ──────────────────────────────────────────────────────────────────
test("T3.2: a trailing-newline turn hashes to the value the emitter later compares", () => {
  const withNl = "I rewrote the join to drop on ambiguity\n";
  const anchor = makeAnchor({ sessionId: "s", uuid: "u", tsUtc: "2026-07-30T10:00:00.000Z", unitKey: K("a"), text: withNl });
  expect(anchor.textSha).toBe(textSha(withNl));
  expect(matchesAnchor(anchor, withNl)).toBe(true);
  // ⚠ A trimmed hash domain would make G5's `verbatim` pass on every sub-600-char fixture and fail
  // 100% on real data. These MUST differ.
  expect(matchesAnchor(anchor, withNl.trim())).toBe(false);
  expect(textSha(withNl)).not.toBe(textSha(withNl.trim()));
});

// ── T3.4a: anchor resolution ─────────────────────────────────────────────────────────────────────
test("T3.4a: a composite matching ≥2 lines is UNRESOLVABLE and the why drops", () => {
  const t = prose("a turn that appears twice in the corpus");
  const dup = { sessionId: "s", uuid: "u", tsUtc: "2026-07-30T10:00:00.000Z", text: t };
  const anchor = makeAnchor({ ...dup, unitKey: K("a") });
  expect(resolveAnchor(anchor, [dup])).toMatchObject({ resolved: true });
  expect(resolveAnchor(anchor, [dup, { ...dup }])).toEqual({ resolved: false, matched: 2 });
  expect(resolveAnchor(anchor, [])).toEqual({ resolved: false, matched: 0 });
});

// ── T3.3: the join ───────────────────────────────────────────────────────────────────────────────
const unitA = { repo: REPO, root: "a", label: "a", hasResumptionState: false, hasWindowContent: true, resumptionNote: "", dirtyFiles: [], latestCommitTime: null };
const commit = (files: string[], excluded?: true): Activity => ({
  source: "git", kind: "commit", event_id: "c1", repo: REPO, timestamp: "2026-07-30T12:00:00.000Z", text: "c",
  meta: { diffstat: files.map((f) => ({ file: f, added: 1, removed: 0 })), ...(excluded ? { excluded: true } : {}) },
});

test("T3.3: unitFiles comes from activities and EXCLUDES meta.excluded commits (§3.1's other half)", () => {
  const files = buildUnitFiles([unitA], [commit(["a/x.ts"]), commit(["a/bot.ts"], true)], bucketAB);
  expect(files.get(K("a"))).toEqual(["a/x.ts"]);   // the bot commit's file is NOT evidence of work
});

test("T3.3: one claimant ⇒ a why; TWO claiming sessions ⇒ ambiguous drop, no why", () => {
  const text = "I moved the ambiguity handling behind a policy so the drop could be detected at all";
  const mk = (sessions: string[]) => {
    const paths = sessions.map((s) => ({ sessionId: s, tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/a/x.ts` }));
    const { segments, firstEdit } = buildSegments(paths, bucketAB);
    const candidates = sessions.map((s, i) => turn(s, `u${i}`, "2026-07-30T09:00:00.000Z", text, i));
    return joinEvidence({ segments, firstEdit, candidates, units: [unitA], activities: [commit(["a/x.ts"])], bucket: bucketAB });
  };
  const one = mk(["s1"]);
  expect(one.sources.get(K("a"))?.text).toBe(text);
  expect(one.unitsEligible).toBe(1);

  const two = mk(["s1", "s2"]);
  expect(two.sources.size).toBe(0);
  expect(two.drops["ambiguous"]).toBe(1);
});

test("T3.3: onAmbiguity 'keep-earliest' picks the earliest first-edit session (MUT2's detector)", () => {
  const early = "starting the refactor of the shared bucketer before anything else touches it";
  const late = "picking up the label collision work now that the bucketer landed";
  const paths = [
    { sessionId: "s2", tsUtc: "2026-07-30T13:00:00.000Z", path: `${REPO}/a/x.ts` },
    { sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/a/x.ts` },
  ];
  const { segments, firstEdit } = buildSegments(paths, bucketAB);
  const candidates = [
    turn("s1", "u1", "2026-07-30T09:00:00.000Z", early, 0),
    turn("s2", "u2", "2026-07-30T12:00:00.000Z", late, 1),
  ];
  const base = { segments, firstEdit, candidates, units: [unitA], activities: [commit(["a/x.ts"])], bucket: bucketAB };
  expect(joinEvidence({ ...base, onAmbiguity: "drop" }).sources.size).toBe(0);
  expect(joinEvidence({ ...base, onAmbiguity: "keep-earliest" }).sources.get(K("a"))?.text).toBe(early);
});

// ⚠ THE REGRESSION THIS FIX EXISTS FOR — and it is a join-level claim, not a path-level one.
// Infra segments land on the CATCH-ALL unit (a worktree path matches no sub-root), so they inflate
// that unit's claiming-session count. Two claimants is `ambiguous`, so agent-scratch noise was
// SUPPRESSING whys under the conservative rule — the umbrella repo took the loss, and the A3 replay
// showed it as personal_code both losing its own whys and absorbing other projects' work.
// Measured over 30 days before the fix: 2324 / 7673 edit-path records (30.3%) were infra.
test("T3.3: an infra-only session is not a claimant — the catch-all keeps its why instead of going ambiguous", () => {
  const unitNull = { ...unitA, root: null, label: "repo" };
  // Phrased like the one-claimant test's text on purpose: an imperative here ("start on the …")
  // is dropped by T7.7's isTaskShaped as `outcome-verb`, which would mask what this is testing.
  const text = "I moved the scratch filtering into the shared bucketer so the catch-all stopped absorbing it";
  const paths = [
    { sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/README.md` },              // real
    { sessionId: "s2", tsUtc: "2026-07-30T10:30:00.000Z", path: `${REPO}/.claude/worktrees/w/s.md` }, // scratch
  ];
  const { segments, firstEdit } = buildSegments(paths, bucketAB);
  expect(segments.map((s) => s.sessionId)).toEqual(["s1"]);      // s2 never becomes a claimant

  const candidates = [turn("s1", "u1", "2026-07-30T09:00:00.000Z", text, 0)];
  const out = joinEvidence({
    segments, firstEdit, candidates, units: [unitNull],
    activities: [commit(["README.md"])], bucket: bucketAB,
  });
  expect(out.sources.get(K(null))?.text).toBe(text);
  expect(out.drops["ambiguous"] ?? 0).toBe(0);                   // was 1 — s2's scratch made it ambiguous
});

test("T3.3: a unit with no claiming segment records no-segment", () => {
  const out = joinEvidence({
    segments: [], firstEdit: new Map(), candidates: [], units: [unitA],
    activities: [commit(["a/x.ts"])], bucket: bucketAB,
  });
  expect(out.drops["no-segment"]).toBe(1);
  expect(out.unitsEligible).toBe(1);
});

// ── T3.6a / T3.6b: the two UNIT-scoped suppressions ──────────────────────────────────────────────
// ⚠ Both fixtures carry ≥2 qualifying candidates, and the assertion is that NO SUBSTITUTE is
// emitted. Every other rejection in the pipeline ADVANCES (over-cap turn, empty segment), so
// drop-and-advance is the likely wrong implementation — and a one-candidate fixture would pass
// against it.
function twoCandidateUnit(firstText: string) {
  const paths = [{ sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/a/x.ts` }];
  const { segments, firstEdit } = buildSegments(paths, bucketAB);
  const candidates = [
    turn("s1", "u1", "2026-07-30T08:00:00.000Z", "an earlier perfectly usable substitute turn about unit a work", 0),
    turn("s1", "u2", "2026-07-30T09:00:00.000Z", firstText, 1),   // nearest at-or-before => selected
  ];
  return joinEvidence({ segments, firstEdit, candidates, units: [unitA], activities: [commit(["a/x.ts"])], bucket: bucketAB });
}

test("T3.6a: an outcome verb on the selected candidate drops the UNIT's why — no substitute", () => {
  const out = twoCandidateUnit("fixed the plurality vote and the mixed-commit case is done now");
  expect(out.sources.size).toBe(0);              // NOT the earlier substitute turn
  expect(out.drops["outcome-verb"]).toBe(1);
  // ⚠ ADOPTED curve too — asserting only sources.size left the strict-majority map free to re-ship
  // the dropped turn under the A9 union (same hole class as #181).
  expect(out.sourcesStrictMajority.size).toBe(0);
  expect(whySourceFor(out, K("a"))).toBeUndefined();
  expect(countAdoptedWhys(out)).toBe(0);
});

test("T3.6b: a credential hit on the selected candidate drops the UNIT's why — no substitute", () => {
  const out = twoCandidateUnit("re-run it with AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY to reproduce");
  expect(out.sources.size).toBe(0);
  expect(out.drops["credential-hit"]).toBe(1);
  expect(out.sourcesStrictMajority.size).toBe(0);
  expect(countAdoptedWhys(out)).toBe(0);
});

test("⚠ T7.7 + A9: a task-shaped turn is dropped from BOTH curves — union must not re-ship it", () => {
  // Sole-claimant + single-file ⇒ majority also qualifies. Before this pin, isTaskShaped only ran on
  // conservative: sources stayed empty, sourcesStrictMajority still held the turn, whySourceFor
  // shipped it. GATE-R3 was dead under the adopted union.
  const task = "run the day 18 audit, then commit and push any changes to EVAL.md";
  const out = twoCandidateUnit(task);
  expect(out.sources.size).toBe(0);
  expect(out.sourcesStrictMajority.size).toBe(0);
  expect(out.drops["outcome-verb"]).toBe(1);
  expect(whySourceFor(out, K("a"))).toBeUndefined();
  expect(countAdoptedWhys(out)).toBe(0);
});

// ⚠ Asserted over THIS task's OWN credential-bearing corpus. Re-running T2.6's fixture proves
// nothing: it contains no credential turn, so a select.ts-scoped drop would reconcile and pass with
// the defect fully live.
test("T3.6b: the six-bucket accounting still reconciles over a CREDENTIAL-BEARING corpus", () => {
  const texts = [
    "<task-notification>" + "x".repeat(80) + "</task-notification>",
    "yes", "/clear", "short",
    "y".repeat(700),
    "z".repeat(60) + "\n" + "z".repeat(60),
    "re-run with AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY to reproduce the failure",  // qualifies HERE
    "an ordinary substantive turn explaining why the join drops on ambiguity",
  ];
  const drops = Object.fromEntries((["harness-wrapped", "continuation-word", "slash-command", "turn-too-short", "over-cap-turn", "control-byte"] as const).map((r) => [r, 0]));
  let qualified = 0;
  for (const t of texts) { const r = selectTurn(t); if (r.ok) qualified++; else (drops as Record<string, number>)[r.reason]!++; }
  const six = Object.values(drops).reduce((a, b) => a + (b as number), 0);
  // The credential turn is a QUALIFIER at the pipeline level — its drop happens later, at the unit
  // scope. That is the whole point: a seventh bucket here would falsify this identity.
  expect(six + qualified).toBe(texts.length);
  expect(qualified).toBe(2);
});

test("T3.6: outcome verbs are enumerated, and the documented defeats still defeat it", () => {
  for (const v of OUTCOME_VERBS) expect(hasOutcomeVerb(`I ${v} the thing`)).toBe(true);
  // ⚠ Documented, not aspirational: lexical, not semantic. Under quotation a miss is a TIDINESS
  // failure (we quote something you really wrote), not a truthfulness one — hence R7's downgrade.
  expect(hasOutcomeVerb("turned out to be a stale cache entry")).toBe(false);
  expect(hasOutcomeVerb("sussed it out — was the token TTL")).toBe(false);
  expect(hasOutcomeVerb("I am starting on the bucketer refactor")).toBe(false);
});

// ── T3.5 / T3.4 ──────────────────────────────────────────────────────────────────────────────────
test("T3.5: two overlapping sets both over 0.5 ⇒ strict-majority drops", () => {
  const paths = [
    { sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/a/x.ts` },
    { sessionId: "s1", tsUtc: "2026-07-30T10:01:00.000Z", path: `${REPO}/a/y.ts` },
    { sessionId: "s2", tsUtc: "2026-07-30T10:02:00.000Z", path: `${REPO}/a/y.ts` },
    { sessionId: "s2", tsUtc: "2026-07-30T10:03:00.000Z", path: `${REPO}/a/z.ts` },
  ];
  const { segments, firstEdit } = buildSegments(paths, bucketAB);
  const candidates = [turn("s1", "u1", "2026-07-30T09:00:00.000Z", prose("working across x y and z"), 0),
                      turn("s2", "u2", "2026-07-30T09:30:00.000Z", prose("also working across y and z"), 1)];
  const out = joinEvidence({
    segments, firstEdit, candidates, units: [unitA],
    activities: [commit(["a/x.ts", "a/y.ts", "a/z.ts"])], bucket: bucketAB,
  });
  expect(out.sourcesStrictMajority.size).toBe(0);   // both >0.5 ⇒ ≥2 qualifiers ⇒ drop
});

test("T3.4: escalation fires only when eligible units got no why", () => {
  expect(shouldEscalate({ unitsEligible: 2, whys: 1 })).toBe(true);
  expect(shouldEscalate({ unitsEligible: 2, whys: 2 })).toBe(false);
  expect(shouldEscalate({ unitsEligible: 0, whys: 0 })).toBe(false);  // nothing to escalate FOR
});

// ── T3.7 / T3.8: health and telemetry ────────────────────────────────────────────────────────────
test("T3.8: RULE 2 — counters SUM across runs in a day, booleans OR", () => {
  const a = { ...emptyCounters(), linesRead: 10, sessionsInWindow: 1, escalated: false };
  const b = { ...emptyCounters(), linesRead: 5, sessionsInWindow: 2, escalated: true };
  let h = mergeRun(emptyHealth(), "2026-07-30", a);
  h = mergeRun(h, "2026-07-30", b);
  expect(h.days.length).toBe(1);
  expect(h.days[0]!.linesRead).toBe(15);           // summed, NOT last-run-wins
  expect(h.days[0]!.sessionsInWindow).toBe(3);
  expect(h.days[0]!.escalated).toBe(true);
});

test("T3.8: drops and byUnitFileCount merge per key, not by replacement", () => {
  const a = { ...emptyCounters() }; a.drops["ambiguous"] = 2; a.byUnitFileCount["1"].eligible = 1;
  const b = { ...emptyCounters() }; b.drops["ambiguous"] = 3; b.byUnitFileCount["1"].eligible = 4;
  const h = mergeRun(mergeRun(emptyHealth(), "2026-07-30", a), "2026-07-30", b);
  expect(h.days[0]!.drops["ambiguous"]).toBe(5);
  expect(h.days[0]!.byUnitFileCount["1"].eligible).toBe(5);
});

test("T3.8: the zero-yield streak counts QUALIFYING days only — a quiet day is not decay", () => {
  let h = emptyHealth();
  const day = (date: string, sessions: number, whys: number) =>
    mergeRun(h, date, { ...emptyCounters(), sessionsInWindow: sessions, whysConservative: whys });
  h = day("2026-07-28", 1, 0);
  h = day("2026-07-29", 0, 0);   // quiet: skipped, does NOT break the streak and does NOT extend it
  h = day("2026-07-30", 1, 0);
  expect(zeroYieldStreak(h)).toBe(2);
  expect(evaluateTriggers(h)).not.toContain("zero-yield");     // below hysteresis N=3
  h = day("2026-07-31", 1, 0);
  expect(zeroYieldStreak(h)).toBe(HYSTERESIS_N);
  expect(evaluateTriggers(h)).toContain("zero-yield");
});

// ⚠ The discriminating case is parseFailures>0 with linesRead==0 — `Infinity > threshold` fires the
// systematic-failure route on a run that read nothing. The 0/0 case is already inert (NaN > x is
// false), so a fixture using only that one CANNOT tell the guard from its absence: measured, the
// guard was deleted and this test stayed green until the Infinity case was added.
test("T3.8: a zero denominator SKIPS the parse-failure trigger rather than reading as healthy", () => {
  const none = { ...emptyCounters(), date: "2026-07-30", linesRead: 0, parseFailures: 0 };
  expect(evaluateTriggers(emptyHealth(), none)).not.toContain("parse-failure-rate");   // 0/0 = NaN, already inert
  const infinite = { ...emptyCounters(), date: "2026-07-30", linesRead: 0, parseFailures: 5 };
  expect(evaluateTriggers(emptyHealth(), infinite)).not.toContain("parse-failure-rate"); // 5/0 = Infinity
  const bad = { ...emptyCounters(), date: "2026-07-30", linesRead: 100, parseFailures: 40 };
  expect(evaluateTriggers(emptyHealth(), bad)).toContain("parse-failure-rate");
  const capped = { ...emptyCounters(), date: "2026-07-30", capTripped: true };
  expect(evaluateTriggers(emptyHealth(), capped)).toContain("cap-tripped");
});

test("T3.8: the embedded self-test checks BOTH directions", () => {
  expect(selfTest((t) => selectTurn(t).ok)).toEqual({ ok: true });
  expect(selfTest(() => true)).toEqual({ ok: false });    // stuck-open pipeline
  expect(selfTest(() => false)).toEqual({ ok: false });   // stuck-closed pipeline
});

// ⚠ §3.4 makes this a RULE, not a convention: the health file is NOT a sink. `lastWarning` was
// removed for this reason — free text in a file under supportDir() is a sink.
test("T3.8: the written record contains only numbers, booleans and enumerated codes", () => {
  let h = mergeRun(emptyHealth(), "2026-07-30", { ...emptyCounters(), linesRead: 5 });
  h.startToCommitHours[bucketStartToCommit(3)]++;
  h.labelCollisions = 2;
  const parsed = JSON.parse(serialiseHealth(h));
  const walk = (v: unknown, path: string): void => {
    if (v === null) return;
    if (typeof v === "number" || typeof v === "boolean") return;
    if (typeof v === "string") {
      // The only strings permitted are the date key and enumerated codes used as KEYS elsewhere.
      expect(/^\d{4}-\d{2}-\d{2}$/.test(v)).toBe(true);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${path}.${k}`);
  };
  walk(parsed, "$");
  expect(serialiseHealth(h)).not.toContain("/repo");   // no path, repo name or turn can appear
});

test("T3.7: the question-shaped counter fires on §2.5's worked examples", () => {
  expect(isQuestionShaped("Explain this PEP/PDP split and where the boundary should sit")).toBe(true);
  expect(isQuestionShaped("can i see a visual example of how each would look?")).toBe(true);
  expect(isQuestionShaped("why is the join dropping these")).toBe(true);
  // Counted, never filtered — an intent-shape filter is exactly the lexical heuristic R7 warns about.
  expect(isQuestionShaped("I switched the join to a membership test because of mixed commits")).toBe(false);
});

// ⚠ FOUND IN THE FINAL HARDEN LOOP. Both pre-mortem counters existed as SHAPE with no WRITER — the
// sixth instance of that class this run. `startToCommitHours` is the counter that measures whether
// the 24 h read-window margin is right instead of guessing it, and `labelCollisions` is the one the
// plan says is "otherwise unknown until 1.5b, after the gate". Both were structurally always zero.
test("T3.8: mergeRun ACCUMULATES both pre-mortem counters across runs [no-writer regression]", () => {
  const a = { ...emptyCounters() };
  a.startToCommitHours["1-4"] = 2; a.labelCollisions = 1;
  const b = { ...emptyCounters() };
  b.startToCommitHours["1-4"] = 3; b.startToCommitHours["24+"] = 1; b.labelCollisions = 4;

  let h = mergeRun(emptyHealth(), "2026-07-30", a);
  h = mergeRun(h, "2026-07-31", b);
  // Health-level, accumulated ACROSS days — not per-day, which is why they are not in TranscriptDay.
  expect(h.startToCommitHours["1-4"]).toBe(5);
  expect(h.startToCommitHours["24+"]).toBe(1);   // the bucket that says the margin is too tight
  expect(h.labelCollisions).toBe(5);
  // Same date merges too, so many runs a day do not lose them.
  const same = mergeRun(mergeRun(emptyHealth(), "2026-07-30", a), "2026-07-30", a);
  expect(same.labelCollisions).toBe(2);
});

test("T3.8: the start→commit histogram buckets the margin evidence (pre-mortem risk 4)", () => {
  expect(bucketStartToCommit(0.5)).toBe("0-1");
  expect(bucketStartToCommit(3)).toBe("1-4");
  expect(bucketStartToCommit(11)).toBe("4-12");
  expect(bucketStartToCommit(23)).toBe("12-24");
  expect(bucketStartToCommit(48)).toBe("24+");   // beyond the chosen 24 h margin — the case that matters
});

test("T3.1: localDayOf buckets by LOCAL day", () => {
  const iso = "2026-07-30T10:00:00.000Z";
  expect(localDayOf(iso)).toBe(localDayOf(new Date(iso).toISOString()));
  expect(/^\d{4}-\d{2}-\d{2}$/.test(localDayOf(iso))).toBe(true);
});

// ── T3.4a REGRESSION (2026-08-06): the resolution pass covered ONE curve ─────────────────────────
//
// WHY THIS EXISTS. `anchors.push()` happened only in the CONSERVATIVE branch, so the anchor
// resolution pass validated conservative whys and silently skipped every strict-majority one. The
// rule it enforces — "a why we cannot later verify is worse than no why: drop it rather than ship an
// unprovable quote" — therefore applied to exactly one of the two curves.
//
// Latent only because strict-majority is dark. Day-21 telemetry points at ADOPTING it (conservative
// 1,0,0,0 vs strict-majority 0,1,1,0 across four live days), and adopting it as-was would have
// shipped quotations that bypassed verification entirely.
//
// It surfaced as a COUNTER anomaly: `anchorsAttempted` read 0 on two days that recorded a
// strict-majority why. A why that never attempted an anchor cannot have been anchored — the number
// was measuring a different stage than its name claimed.

/** Two sessions claim unit A, so the CONSERVATIVE rule drops it as ambiguous; only s1 covers >0.5 of
 *  the unit's files, so STRICT-MAJORITY picks s1. That split is what isolates curve 2. */
function strictMajorityOnly(duplicateTurn: boolean) {
  const text = "starting on the ladder reconstruction because the T-1 session boundary is wrong";
  const paths = [
    { sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/a/x.ts` },
    { sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/a/y.ts` },
    { sessionId: "s2", tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/a/x.ts` },
  ];
  const { segments, firstEdit } = buildSegments(paths, bucketAB);
  const t = turn("s1", "u1", "2026-07-30T09:00:00.000Z", text, 0);
  const candidates = [
    t,
    turn("s2", "u2", "2026-07-30T09:00:00.000Z", "unrelated prose about a different unit entirely", 1),
    // ⚠ A byte-identical duplicate of s1's turn makes `resolveAnchor` return hits.length === 2, i.e.
    // UNRESOLVABLE. Realistic, not contrived: a resume-replay duplicates turns in a transcript.
    ...(duplicateTurn ? [turn("s1", "u1", "2026-07-30T09:00:00.000Z", text, 2)] : []),
  ];
  return joinEvidence({
    segments, firstEdit, candidates, units: [unitA],
    activities: [commit(["a/x.ts", "a/y.ts"])], bucket: bucketAB,
  });
}

test("T3.4a: a strict-majority why IS produced when its anchor resolves (fixture sanity)", () => {
  const r = strictMajorityOnly(false);
  expect(r.sources.size).toBe(0);                      // conservative: ambiguous, correctly dropped
  // ⚠ 1 -> 0 on 2026-08-11, and this assertion is the whole §5 accounting fix in miniature. The unit
  // IS rescued by strict-majority below, so under the adopted union it yields a why — and a unit
  // that yields is not a loss to explain. Counting it as `ambiguous` too made `unitsEligible ==
  // whys + drops` false. Conservative's own view is not lost: `whysConservative` still reads 0.
  expect(r.drops["ambiguous"] ?? 0).toBe(0);
  expect(r.sourcesStrictMajority.size).toBe(1);        // curve 2 picked s1
  expect(r.anchorsAttempted).toBe(1);                  // …and its anchor WAS evaluated
  expect(r.anchorsResolved).toBe(1);
});

test("⚠ T3.4a: an UNRESOLVABLE strict-majority anchor is DROPPED, not shipped unverified", () => {
  // THE regression case. Before the fix: sourcesStrictMajority.size === 1 (an unprovable quotation
  // survives), drops["anchor-unresolvable"] === 0, anchorsAttempted === 0.
  const r = strictMajorityOnly(true);
  expect(r.sourcesStrictMajority.size).toBe(0);
  expect(r.drops["anchor-unresolvable"]).toBe(1);
  expect(r.anchorsAttempted).toBe(1);                  // it was attempted…
  expect(r.anchorsResolved).toBe(0);                   // …and failed
  // ⚠ The §5 identity survives the RESCUE-THEN-REVOKE path, which is the subtle case: strict
  // inserted (so the `ambiguous` bump was suppressed), then the anchor pass deleted the why and
  // bumped `anchor-unresolvable`. The unit is still counted EXACTLY ONCE, under the more accurate
  // of the two reasons. Asserted rather than reasoned about, because suppression plus a later
  // deletion is exactly where an off-by-one accounting bug would hide.
  expect(r.drops["ambiguous"] ?? 0).toBe(0);
  expect(dropSum(r.drops)).toBe(1);
  expect(r.unitsEligible).toBe(countAdoptedWhys(r) + dropSum(r.drops));
});

test("⚠ T3.4a: a shared anchor is resolved ONCE — the §5 drop accounting cannot double-count", () => {
  // Both curves can pick the SAME turn for the same unit (one claiming session that also covers a
  // majority of the files). Resolving it twice would bump `anchor-unresolvable` twice for one why
  // and break the accounting identity that every drop is counted exactly once.
  // ⚠ No outcome verb: "landed"/"fixed"/etc. trip T3.6a and the unit drops BEFORE an anchor is ever
  // made, which silently turns this fixture into a no-op (measured: att=0, drops={"outcome-verb":1}).
  const text = "picking up the session-boundary work again since the ladder question is still open";
  const paths = [{ sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/a/x.ts` }];
  const { segments, firstEdit } = buildSegments(paths, bucketAB);
  const t = turn("s1", "u1", "2026-07-30T09:00:00.000Z", text, 0);
  const r = joinEvidence({
    segments, firstEdit, candidates: [t, turn("s1", "u1", "2026-07-30T09:00:00.000Z", text, 1)],
    units: [unitA], activities: [commit(["a/x.ts"])], bucket: bucketAB,
  });
  expect(r.sources.size).toBe(0);                      // both curves dropped…
  expect(r.sourcesStrictMajority.size).toBe(0);
  expect(r.drops["anchor-unresolvable"]).toBe(1);      // …on ONE counted drop, not two
  expect(r.anchorsAttempted).toBe(1);                  // and one attempt, not two
});

// ── A9: the ADOPTED curve — union with a conservative-wins tiebreak (2026-08-10, user-directed) ──
//
// The two rules are not nested (see whySourceFor's comment), so taking either alone discards
// resolutions the other soundly produced. Adopted after measuring that where BOTH fire they choose
// the SAME session 8/8 on the frozen corpus. The tiebreak is written anyway because n=8 is not proof
// and the error it would hide is quoting the user's words from a session they were not in.

const _src = (unitKey: string, sessionId: string, text: string): TranscriptWhySource => ({
  unitKey, text,
  anchor: { sessionId, uuid: `u-${sessionId}`, tsUtc: "2026-08-10T12:00:00Z", textSha: `sha-${sessionId}`, unitKey },
});

test("A9 union: conservative alone resolves it", () => {
  const e = {
    sources: new Map([["k", _src("k", "s-cons", "conservative turn")]]),
    sourcesStrictMajority: new Map<string, TranscriptWhySource>(),
  };
  expect(whySourceFor(e, "k")?.anchor.sessionId).toBe("s-cons");
});

test("⚠ A9 union: STRICT-MAJORITY ALONE resolves it — this is the coverage the union adds", () => {
  // Pre-adoption this returned undefined and the why was discarded, even though a sound rule had
  // resolved it. This assertion IS the change.
  const e = {
    sources: new Map<string, TranscriptWhySource>(),
    sourcesStrictMajority: new Map([["k", _src("k", "s-strict", "strict turn")]]),
  };
  expect(whySourceFor(e, "k")?.anchor.sessionId).toBe("s-strict");
  expect(whySourceFor(e, "k")?.text).toBe("strict turn");
});

test("⚠ A9 tiebreak: when both fire and DISAGREE, conservative wins — order is the policy", () => {
  // Never observed on the real corpus (8/8 agreement) and therefore never exercised in production.
  // Pinned precisely because it is unobservable: if someone reverses the `??`, only this fails.
  const e = {
    sources: new Map([["k", _src("k", "s-cons", "conservative turn")]]),
    sourcesStrictMajority: new Map([["k", _src("k", "s-strict", "strict turn")]]),
  };
  expect(whySourceFor(e, "k")?.anchor.sessionId).toBe("s-cons");
  expect(whySourceFor(e, "k")?.text).toBe("conservative turn");
});

test("A9 union: neither rule resolves it -> undefined", () => {
  const e = { sources: new Map<string, TranscriptWhySource>(), sourcesStrictMajority: new Map<string, TranscriptWhySource>() };
  expect(whySourceFor(e, "k")).toBeUndefined();
});

test("whySourcesAdopted / countAdoptedWhys: union size + conservative-wins match whySourceFor", () => {
  // ⚠ The helper scan.ts uses for escalation and startToCommitHours. If it drifted from
  // whySourceFor, telemetry would count a different set than the briefing renders.
  const e = {
    sources: new Map([
      ["a", _src("a", "s-cons-a", "cons a")],
      ["both", _src("both", "s-cons", "cons both")],
    ]),
    sourcesStrictMajority: new Map([
      ["b", _src("b", "s-strict-b", "strict b")],
      ["both", _src("both", "s-strict", "strict both")],
    ]),
  };
  const adopted = whySourcesAdopted(e);
  expect(countAdoptedWhys(e)).toBe(3);
  expect(adopted.size).toBe(3);
  expect([...adopted.keys()].sort()).toEqual(["a", "b", "both"]);
  for (const [k, src] of adopted) {
    expect(whySourceFor(e, k)).toEqual(src);
  }
  // Tiebreak: conservative wins on "both"
  expect(adopted.get("both")!.anchor.sessionId).toBe("s-cons");
  expect(whySourceFor(e, "both")!.anchor.sessionId).toBe("s-cons");
});

test("⚠ countAdoptedWhys is what shouldEscalate must use — sources.size alone over-escalates", () => {
  // Strict-only fills every eligible unit; conservative map is empty. Escalating on sources.size
  // would re-scan for nothing; countAdoptedWhys reports the real coverage.
  const e = {
    sources: new Map<string, TranscriptWhySource>(),
    sourcesStrictMajority: new Map([["k", _src("k", "s1", "strict-only why")]]),
  };
  expect(e.sources.size).toBe(0);
  expect(countAdoptedWhys(e)).toBe(1);
  expect(shouldEscalate({ unitsEligible: 1, whys: e.sources.size })).toBe(true);       // the bug
  expect(shouldEscalate({ unitsEligible: 1, whys: countAdoptedWhys(e) })).toBe(false); // the fix
});

// ── §5 ACCOUNTING IDENTITY UNDER THE A9 UNION ────────────────────────────────────────────────────
//
// `unitsEligible == |adopted whys| + Σ drops`. A drop counter answers exactly one question — "why
// did this eligible unit produce no why?" — so a unit that DOES produce one must not also be
// counted as a loss.
//
// ⚠ THE UNION BROKE THIS AND NOTHING CAUGHT IT. Adopting the union (#181) made a
// conservative-dropped unit renderable via strict-majority, but the conservative branch still
// bumped unconditionally. Measured 2026-08-11 before the fix: `{unitsEligible: 1,
// drops: {ambiguous: 1}, adoptedWhys: 1}` — 1 != 1 + 1. The drop counters over-reported, so a
// reader of transcript-health.json would conclude units were lost that had in fact yielded.
const dropSum = (d: Record<string, number | undefined>) =>
  Object.values(d).reduce<number>((a, b) => a + (b ?? 0), 0);

/** 2 claiming sessions (⇒ conservative AMBIGUOUS), one of which covers 2/2 files (⇒ strict wins). */
const ambiguousButMajority = () => {
  const text = prose("I am reworking the join because the plurality vote mis-attributes spanning commits");
  const paths = [
    { sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/a/x.ts` },
    { sessionId: "s1", tsUtc: "2026-07-30T10:01:00.000Z", path: `${REPO}/a/y.ts` },
    { sessionId: "s2", tsUtc: "2026-07-30T10:02:00.000Z", path: `${REPO}/a/x.ts` },
  ];
  const { segments, firstEdit } = buildSegments(paths, bucketAB);
  const candidates = [
    turn("s1", "u1", "2026-07-30T09:00:00.000Z", text, 0),
    turn("s2", "u2", "2026-07-30T09:00:00.000Z", text, 1),
  ];
  return joinEvidence({ segments, firstEdit, candidates, units: [unitA],
    activities: [commit(["a/x.ts", "a/y.ts"])], bucket: bucketAB });
};

test("⚠ §5: a unit RESCUED by strict-majority is a why, NOT also a drop", () => {
  const out = ambiguousButMajority();
  expect(out.sources.size).toBe(0);                 // conservative found it ambiguous
  expect(out.sourcesStrictMajority.size).toBe(1);   // strict-majority resolved it
  expect(countAdoptedWhys(out)).toBe(1);            // so it YIELDS under the adopted curve
  expect(dropSum(out.drops)).toBe(0);               // …and therefore is not a loss to explain
  expect(out.unitsEligible).toBe(countAdoptedWhys(out) + dropSum(out.drops));
});

test("⚠ §5: a unit NO rule rescues is still counted exactly once", () => {
  // The suppression must not swallow real drops. Two claimants, NEITHER above 0.5 coverage.
  const text = prose("I am reworking the join because the plurality vote mis-attributes spanning commits");
  const paths = [
    { sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/a/x.ts` },
    { sessionId: "s2", tsUtc: "2026-07-30T10:01:00.000Z", path: `${REPO}/a/y.ts` },
  ];
  const { segments, firstEdit } = buildSegments(paths, bucketAB);
  const candidates = [
    turn("s1", "u1", "2026-07-30T09:00:00.000Z", text, 0),
    turn("s2", "u2", "2026-07-30T09:00:00.000Z", text, 1),
  ];
  const out = joinEvidence({ segments, firstEdit, candidates, units: [unitA],
    activities: [commit(["a/x.ts", "a/y.ts", "a/z.ts", "a/w.ts"])], bucket: bucketAB });
  expect(countAdoptedWhys(out)).toBe(0);
  expect(dropSum(out.drops)).toBe(1);
  expect(out.unitsEligible).toBe(countAdoptedWhys(out) + dropSum(out.drops));
});

// ── STRICT-MAJORITY COVERAGE IS PER-FILE, NOT PER-BASENAME ───────────────────────────────────────
//
// ⚠ THE FIXTURE THAT WAS MISSING, and its absence is why a HIGH sat latent. Every pre-existing
// coverage fixture used DISTINCT basenames, so leaf-matching and path-matching agreed on all of
// them and the suite was green for the wrong reason. Three independent reviewers reproduced the
// defect on 2026-08-11; none of 1119 tests could construct the state.
//
// Shape: one unit, TWO files sharing the leaf `index.ts`, and a session that edited exactly ONE of
// them — true coverage 0.5, which the rule says must NOT qualify (`> 0.5`). Under leaf-matching the
// session was credited for both files (1.0) and cleared the bar, and because the unit is
// multi-claimant the union then RENDERED that why — quoting a session that did half the work.
test("⚠ strict-majority: same-leaf files are NOT double-counted — 1-of-2 is 0.5 and must not qualify", () => {
  const text = prose("I am reworking the join because the plurality vote mis-attributes spanning commits");
  const paths = [
    { sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/a/src/index.ts` }, // 1 of 2
    { sessionId: "s2", tsUtc: "2026-07-30T10:01:00.000Z", path: `${REPO}/a/notes.txt` },    // 2nd claimant
  ];
  const { segments, firstEdit } = buildSegments(paths, bucketAB);
  const candidates = [
    turn("s1", "u1", "2026-07-30T09:00:00.000Z", text, 0),
    turn("s2", "u2", "2026-07-30T09:00:00.000Z", text, 1),
  ];
  const out = joinEvidence({ segments, firstEdit, candidates, units: [unitA],
    activities: [commit(["a/src/index.ts", "a/lib/index.ts"])], bucket: bucketAB });

  expect(out.sources.size).toBe(0);                  // conservative: 2 claimants ⇒ ambiguous
  expect(out.sourcesStrictMajority.size).toBe(0);    // …and 0.5 is NOT > 0.5, so strict must refuse
  expect(countAdoptedWhys(out)).toBe(0);             // ⇒ the union renders nothing for this unit
  expect(dropSum(out.drops)).toBe(1);                // …and it IS a drop, counted exactly once
  expect(out.unitsEligible).toBe(countAdoptedWhys(out) + dropSum(out.drops));
});

test("strict-majority still qualifies on genuine >0.5 coverage of same-leaf files", () => {
  // The other side of the same fixture: the fix must not make the curve unreachable. Same two
  // same-leaf files, but the session edited BOTH (2/2 = 1.0), so it qualifies as it always should.
  const text = prose("I am reworking the join because the plurality vote mis-attributes spanning commits");
  const paths = [
    { sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/a/src/index.ts` },
    { sessionId: "s1", tsUtc: "2026-07-30T10:01:00.000Z", path: `${REPO}/a/lib/index.ts` },
    { sessionId: "s2", tsUtc: "2026-07-30T10:02:00.000Z", path: `${REPO}/a/notes.txt` },
  ];
  const { segments, firstEdit } = buildSegments(paths, bucketAB);
  const candidates = [
    turn("s1", "u1", "2026-07-30T09:00:00.000Z", text, 0),
    turn("s2", "u2", "2026-07-30T09:00:00.000Z", text, 1),
  ];
  const out = joinEvidence({ segments, firstEdit, candidates, units: [unitA],
    activities: [commit(["a/src/index.ts", "a/lib/index.ts"])], bucket: bucketAB });
  expect(out.sourcesStrictMajority.size).toBe(1);
  expect(out.sourcesStrictMajority.get(K("a"))?.anchor.sessionId).toBe("s1");
});

// ── §5 IDENTITY UNDER `keep-earliest` — the non-default path no fixture reached ──────────────────
//
// ⚠ Every other identity test runs under the default `onAmbiguity: "drop"`, where the two curves
// NECESSARILY share one anchor (sole claimant ⇒ same session ⇒ same turn), so the per-anchor drop
// could never double-count. `keep-earliest` is the only mode where conservative and strict can pick
// DIFFERENT sessions for one unit — and there the anchor pass bumped a drop for a unit that still
// yielded via the other curve. Reproduced 2026-08-11: `{unitsEligible: 1, adoptedWhys: 1,
// drops: {anchor-unresolvable: 1}}` — 1 != 1 + 1. Reachable via RunDeps and used live by
// `scripts/inspect-whys.ts`, i.e. by the very diagnostic that reads these counters.
test("⚠ §5 under keep-earliest: a unit whose OTHER curve survives an unresolvable anchor is not a drop", () => {
  const t1 = prose("I am starting on the earliest thread here because the ladder question is still open");
  const t2 = prose("I am reworking the join because the plurality vote mis-attributes spanning commits");
  const paths = [
    { sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/a/x.ts` },  // earliest ⇒ conservative
    { sessionId: "s2", tsUtc: "2026-07-30T10:01:00.000Z", path: `${REPO}/a/x.ts` },  // covers 2/2 ⇒ strict
    { sessionId: "s2", tsUtc: "2026-07-30T10:02:00.000Z", path: `${REPO}/a/y.ts` },
  ];
  const { segments, firstEdit } = buildSegments(paths, bucketAB);
  const candidates = [
    turn("s1", "u1", "2026-07-30T09:00:00.000Z", t1, 0),
    turn("s2", "u2", "2026-07-30T09:00:00.000Z", t2, 1),
    // A byte-identical duplicate of s1's turn ⇒ its composite matches 2 lines ⇒ UNRESOLVABLE.
    turn("s1", "u1", "2026-07-30T09:00:00.000Z", t1, 2),
  ];
  const out = joinEvidence({ segments, firstEdit, candidates, units: [unitA],
    activities: [commit(["a/x.ts", "a/y.ts"])], bucket: bucketAB, onAmbiguity: "keep-earliest" });

  expect(out.sources.size).toBe(0);                        // conservative's why was unverifiable, dropped
  expect(out.sourcesStrictMajority.size).toBe(1);          // strict's survived
  expect(countAdoptedWhys(out)).toBe(1);                   // ⇒ the unit DOES yield
  expect(out.drops["anchor-unresolvable"] ?? 0).toBe(0);   // …so it is not also a loss
  expect(out.unitsEligible).toBe(countAdoptedWhys(out) + dropSum(out.drops));
});

test("⚠ keep-earliest: when BOTH curves' anchors fail, the unit is counted exactly ONCE", () => {
  // The other half — the suppression must not swallow a real drop when nothing survives.
  const t1 = prose("I am starting on the earliest thread here because the ladder question is still open");
  const t2 = prose("I am reworking the join because the plurality vote mis-attributes spanning commits");
  const paths = [
    { sessionId: "s1", tsUtc: "2026-07-30T10:00:00.000Z", path: `${REPO}/a/x.ts` },
    { sessionId: "s2", tsUtc: "2026-07-30T10:01:00.000Z", path: `${REPO}/a/x.ts` },
    { sessionId: "s2", tsUtc: "2026-07-30T10:02:00.000Z", path: `${REPO}/a/y.ts` },
  ];
  const { segments, firstEdit } = buildSegments(paths, bucketAB);
  const candidates = [
    turn("s1", "u1", "2026-07-30T09:00:00.000Z", t1, 0),
    turn("s2", "u2", "2026-07-30T09:00:00.000Z", t2, 1),
    turn("s1", "u1", "2026-07-30T09:00:00.000Z", t1, 2),   // duplicate ⇒ s1 unresolvable
    turn("s2", "u2", "2026-07-30T09:00:00.000Z", t2, 3),   // duplicate ⇒ s2 unresolvable too
  ];
  const out = joinEvidence({ segments, firstEdit, candidates, units: [unitA],
    activities: [commit(["a/x.ts", "a/y.ts"])], bucket: bucketAB, onAmbiguity: "keep-earliest" });

  expect(countAdoptedWhys(out)).toBe(0);
  expect(out.drops["anchor-unresolvable"]).toBe(1);        // ONE unit, ONE drop — not two
  expect(out.unitsEligible).toBe(countAdoptedWhys(out) + dropSum(out.drops));
});
