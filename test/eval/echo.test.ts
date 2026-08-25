// test/eval/echo.test.ts
import { test, expect } from "bun:test";
import { echoProvider } from "../../src/eval/echo";
import { buildPrompt, parseBriefing } from "../../src/generator";
import type { ReducedContext } from "../../src/types";
import type { Unit } from "../../src/subprojects";

test("echoProvider: one RECAP bullet per commit, a SUGGESTIONS bullet from uncommitted, all three headers present", async () => {
  const units: Unit[] = [
    { repo: "/r", root: "packages/api", label: "api", hasResumptionState: true, hasWindowContent: true,
      resumptionNote: "uncommitted: a.ts", dirtyFiles: ["a.ts"], latestCommitTime: "2026-07-13T10:00:00Z" },
  ];
  const ctx: ReducedContext = {
    repos: [{
      repo: "/r", summary: "1 commit",
      activities: [
        { source: "git", kind: "commit", event_id: "a1b2c3d4e5f6", repo: "/r", text: "add auth",
          meta: { diffstat: [{ file: "packages/api/a.ts", added: 5, removed: 1 }] } },
        { source: "git", kind: "uncommitted", event_id: "u", repo: "/r", meta: { uncommittedFiles: ["packages/api/a.ts"] } },
      ],
    }],
  };
  const prompt = buildPrompt(ctx, units);
  const raw = await echoProvider().generate(prompt);

  expect(raw).toContain("## RESUME");
  expect(raw).toContain("## RECAP");
  expect(raw).toContain("## SUGGESTIONS");

  // Round-trip through the real parser.
  const struct = parseBriefing(raw, { date: "2026-07-13", machineScope: "host", provider: "echo" });
  expect(struct.recap.length).toBe(1);
  expect(struct.recap[0]!.text).toContain("add auth");
  expect(struct.recap[0]!.evidence).toBe("a1b2c3d");
  expect(struct.resume.length).toBe(1);
  expect(struct.resume[0]!.repo).toBe("api");
  expect(struct.suggestions.some((s) => s.text.includes("a.ts"))).toBe(true);
});

test("echoProvider: one RECAP bullet PER COMMIT (not lumped) across two commits in one unit", async () => {
  const units: Unit[] = [
    { repo: "/r", root: null, label: "r", hasResumptionState: false, hasWindowContent: true,
      resumptionNote: "", dirtyFiles: [], latestCommitTime: "2026-07-13T10:00:00Z" },
  ];
  const ctx: ReducedContext = {
    repos: [{
      repo: "/r", summary: "2 commits",
      activities: [
        { source: "git", kind: "commit", event_id: "aaaaaaaaaaaa", repo: "/r", text: "first change",
          meta: { diffstat: [{ file: "x.ts", added: 1, removed: 0 }] } },
        { source: "git", kind: "commit", event_id: "bbbbbbbbbbbb", repo: "/r", text: "second change",
          meta: { diffstat: [{ file: "y.ts", added: 1, removed: 0 }] } },
      ],
    }],
  };
  const prompt = buildPrompt(ctx, units);
  const raw = await echoProvider().generate(prompt);
  const struct = parseBriefing(raw, { date: "2026-07-13", machineScope: "host", provider: "echo" });
  expect(struct.recap.length).toBe(2);
  expect(struct.recap[0]!.evidence).toBe("aaaaaaa");
  expect(struct.recap[1]!.evidence).toBe("bbbbbbb");
});

test("echoProvider: degraded REPO banner (no UNIT blocks) still emits all three headers, no RECAP bullets", async () => {
  const ctx: ReducedContext = { repos: [{ repo: "/r", summary: "dropped for budget", activities: [] }] };
  const prompt = buildPrompt(ctx, []);
  const raw = await echoProvider().generate(prompt);

  expect(raw).toContain("## RESUME");
  expect(raw).toContain("## RECAP");
  expect(raw).toContain("## SUGGESTIONS");

  const struct = parseBriefing(raw, { date: "2026-07-13", machineScope: "host", provider: "echo" });
  expect(struct.recap.length).toBe(0);
});

test("echoProvider: no uncommitted lines anywhere -> a single placeholder SUGGESTIONS bullet", async () => {
  const ctx: ReducedContext = {
    repos: [{
      repo: "/r", summary: "1 commit",
      activities: [
        { source: "git", kind: "commit", event_id: "cccccccccccc", repo: "/r", text: "clean commit",
          meta: { diffstat: [{ file: "z.ts", added: 1, removed: 0 }] } },
      ],
    }],
  };
  const prompt = buildPrompt(ctx, []);
  const raw = await echoProvider().generate(prompt);
  const struct = parseBriefing(raw, { date: "2026-07-13", machineScope: "host", provider: "echo" });
  expect(struct.suggestions.length).toBe(1);
});

// ---- D4a: the commit line now carries a trailing date; echo must not leak it into RECAP text ----
test("echoProvider: NO-FILES commit — the trailing date is stripped, not leaked into the bullet", async () => {
  // THE case that breaks. filesPart is CONDITIONAL (generator.ts:65-67), so an empty-diffstat commit
  // emits no " — files:" marker at all — a files-keyed strip finds no anchor and the date lands
  // inside <text>, giving `- [r] chore: trigger CI — 2026-07-30 | evidence: …`. A with-files fixture
  // passes either way and proves nothing, which is why this one is primary.
  const prompt = "UNIT r — 1 commit(s)\n  - (commit) [35e3573] chore: trigger CI — 2026-07-30";
  const out = await echoProvider().generate(prompt);
  expect(out).toContain("chore: trigger CI");
  expect(out).not.toContain("2026-07-30");
});
test("echoProvider: WITH-FILES commit — files suffix still stripped (date is masked by it here)", async () => {
  // NB: this case cannot pin the DATE strip — the pre-existing " — files:" truncation already
  // removes everything after that marker, date included. Deleting the date strip entirely leaves
  // this test green (measured). The date strip is pinned by the NO-FILES and own-date cases below.
  const prompt = "UNIT r — 1 commit(s)\n  - (commit) [abc1234] subject — files: a.ts, b.ts — 2026-07-28";
  const out = await echoProvider().generate(prompt);
  expect(out).toContain("subject");
  expect(out).not.toContain("a.ts");
  expect(out).not.toContain("2026-07-28");
});
test("echoProvider: a subject containing its OWN ' — <date>' survives; only the trailing one is stripped", async () => {
  // Pins the `$` anchor specifically. The subject carries an em-dash-then-date of its own, so an
  // UNANCHORED /  — \d{4}-\d{2}-\d{2}/ strips the FIRST occurrence — the subject's — and leaves the
  // generator's trailing date behind, corrupting both ends.
  //   anchored:   "backfill — 2026-07-01 — 2026-07-30"  →  "backfill — 2026-07-01"   ✅
  //   unanchored: "backfill — 2026-07-01 — 2026-07-30"  →  "backfill — 2026-07-30"   ❌
  // No files suffix here on purpose: with one, the files strip masks the difference and the test
  // passes either way (measured — the first version of this test did exactly that).
  const prompt = "UNIT r — 1 commit(s)\n  - (commit) [abc1234] backfill — 2026-07-01 — 2026-07-30";
  const out = await echoProvider().generate(prompt);
  expect(out).toContain("backfill — 2026-07-01");
  expect(out).not.toContain("2026-07-30");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Slice 1.5b (T8.6) — the ADVERSARIAL echo, redefined for quotation.
//
// ⚠ It attacks the LABEL→UNIT JOIN, which is what quotation actually made fragile: the render step
// and the `whys` projection both key on `norm(label)`, and `repoLabel` is not injective. These
// assert that a briefing built from deliberately hostile labels still renders every bullet, and
// that a why never lands on the wrong one.
import { adversarialEchoProvider } from "../../src/eval/echo";
import { renderBriefing } from "../../src/render";
import { parseWhy, isWhyLine } from "../../src/transcripts/frame";

const advStruct = async (whys?: Record<string, string>) => {
  const raw = await adversarialEchoProvider({ realLabel: "app" }).generate("");
  const b = parseBriefing(raw, { date: "2026-07-30", machineScope: "m", provider: "p", warnings: [] });
  return { ...b, ...(whys ? { whys } : {}) };
};

test("adversarial echo: every bullet still renders, whatever the labels do", async () => {
  const s = await advStruct();
  const out = renderBriefing(s);
  // No label shape may cost a bullet — invariant 1's converse, and the failure a join bug produces.
  expect(s.recap.length).toBe(4);
  expect(s.resume.length).toBe(2);
  for (const b of [...s.recap, ...s.resume]) expect(out).toContain(b.text);
});

test("adversarial echo: a label matching NO unit renders bare — the why is dropped, not the bullet", async () => {
  const s = await advStruct({ "no-such-unit": "this why must never appear" });
  const out = renderBriefing(s);
  // The projection is what drops an orphan why in production; here the RENDER must also not invent
  // a line for a label whose unit does not exist.
  expect(out).toContain("did work under a label matching no unit");
  // …and if it did render, it would be attached to a unit the run never produced.
  const whyLines = out.split("\n").filter(isWhyLine);
  expect(whyLines.length).toBeLessThanOrEqual(1);
});

test("adversarial echo: norm-colliding decorated labels resolve to ONE why line, never three", async () => {
  // `[app]`, `[**app**]` and `[APP.]` all norm to "app". The render step emits before the FIRST
  // matching bullet and never again — three lines here would mean the same quotation printed three
  // times in one morning's briefing, which is exactly what the per-bullet design was killed for.
  const s = await advStruct({ app: "one line, not three" });
  const lines = renderBriefing(s).split("\n");
  expect(lines.filter(isWhyLine).length).toBe(1);
  expect(parseWhy(lines.find(isWhyLine)!)).toBe("one line, not three");
});

test("adversarial echo: a unit with bullets in BOTH sections emits its why in RECAP only", async () => {
  const s = await advStruct({ app: "recap only" });
  const lines = renderBriefing(s).split("\n");
  const i = lines.findIndex(isWhyLine);
  expect(lines.filter(isWhyLine).length).toBe(1);
  // The pre-pass decides this: RESUME renders BEFORE RECAP, so inline emission would put it there.
  expect(lines.slice(0, i).some((l) => l.includes("What you did"))).toBe(true);
  // …and the RESUME bullet for the same unit still renders, bare.
  expect(lines.some((l) => l.includes("resume the real unit"))).toBe(true);
});
