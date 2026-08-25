// Slice 1.5 M7 — frame (T7.1), projection (T7.3), render (T7.4), invariant 1 (T7.5),
// health-write ordering (T7.6) and the decision-shape filter (T7.7).
import { test, expect } from "bun:test";
import { renderBriefing } from "../src/render";
import { renderWhy, parseWhy, isWhyLine, WHY_PREFIX } from "../src/transcripts/frame";
import { isTaskShaped } from "../src/transcripts/taskShape";
import { selectTurn } from "../src/transcripts/select";
import { textSha } from "../src/transcripts/anchor";
import { runCore } from "../src/core";
import { emptyEvidence, type TranscriptRunCounters } from "../src/transcripts/scan";
import { unitKey } from "../src/subprojects";
import { buildRepo } from "./fixtures/build-repo";
import type { BriefingStruct, Config } from "../src/types";

const yesterdayNoon = () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 1); return d.toISOString(); };
const base: BriefingStruct = {
  date: "2026-07-30", machineScope: "t", provider: "claude",
  resume: [], recap: [], suggestions: [{ text: "next" }], warnings: [],
};

import { join } from "node:path";

/** A real git repo at a CHOSEN path with one in-window commit. `buildRepo` picks its own mkdtemp
 *  name, so it cannot produce two repos sharing a basename — which is the whole point here. */
async function repoAt(dir: string, file: string, iso: string): Promise<void> {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const git = async (args: string[], env: Record<string, string> = {}) => {
    const p = Bun.spawn(["git", "-C", dir, ...args], { env: { ...process.env, ...env } as Record<string, string>, stdout: "pipe", stderr: "pipe" });
    await p.exited;
  };
  await git(["init", "-q", "-b", "main", "."]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.com"]);
  writeFileSync(join(dir, file), "x");
  await git(["add", "."]);
  await git(["commit", "-q", "-m", `add ${file}`], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
}

/** Two REAL repos whose LABELS collide, each with an in-window commit.
 *
 *  ⚠ Sharing only the repo basename is NOT enough: `repoLabel` qualifies a collision with ONE parent
 *  segment, so `<tmpA>/proj` and `<tmpB>/proj` render distinctly. The PARENT basename must match too
 *  — which is exactly the scar comment's own example, `/u/a/x/api` and `/u/b/x/api` both rendering
 *  `x/api`. Measured: the first version of this fixture produced two units with two distinct labels,
 *  so the collision tests asserted nothing. */
async function collidingRepos(): Promise<{ r1: string; r2: string }> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const b1 = mkdtempSync(join(tmpdir(), "dba-cA-"));
  const b2 = mkdtempSync(join(tmpdir(), "dba-cB-"));
  const r1 = join(b1, "shared", "proj"), r2 = join(b2, "shared", "proj");
  await repoAt(r1, "a.ts", yesterdayNoon());
  await repoAt(r2, "b.ts", yesterdayNoon());
  return { r1, r2 };
}

// ── T7.1: the frame round-trips ──────────────────────────────────────────────────────────────────
test("T7.1: parse(render(turn)) === turn for awkward real shapes", () => {
  for (const turn of [
    "prepare the HN + RETRY_RC2 fix PR now, as well as any remaining issues.",
    'he said "just ship it" and I disagreed',                 // the turn contains the suffix char
    "lets go with C (build A now, designed to double as B later)",
    "why is § 3.2 → §3.5 inconsistent — em-dashes, ünïcode, 日本語",
    'nested "quotes" inside "quotes" everywhere',
    "",
  ]) {
    expect(parseWhy(renderWhy(turn))).toBe(turn);
  }
  // ⚠ A first-match parse would truncate at the turn's OWN quote and return a fragment, which then
  // fails byte-equality against textSha and looks like corruption rather than a parsing bug.
  expect(parseWhy(renderWhy('a "quoted" turn'))).toBe('a "quoted" turn');
  expect(isWhyLine("   • [repo] an ordinary bullet")).toBe(false);
  expect(parseWhy("not a why line at all")).toBeNull();
});

// ── T7.4: the render rules ───────────────────────────────────────────────────────────────────────
const withWhys = (b: Partial<BriefingStruct>) => renderBriefing({ ...base, ...b }).split("\n");

test("T7.4: a unit in RECAP gets its line in RECAP only — never both, never RESUME", () => {
  // ⚠ The pre-pass exists because renderBriefing emits RESUME BEFORE RECAP; without it the line
  // would land in RESUME, which is the opposite of intent.
  const lines = withWhys({
    resume: [{ repo: "app", text: "resume it" }],
    recap: [{ repo: "app", text: "did it" }],
    whys: { app: "I switched to a membership test" },
  });
  const whyLines = lines.filter(isWhyLine);
  expect(whyLines.length).toBe(1);
  const idx = lines.findIndex(isWhyLine);
  expect(lines.slice(0, idx).some((l) => l.includes("What you did"))).toBe(true);   // it is in RECAP
});

test("T7.4: a unit absent from RECAP gets its line in RESUME", () => {
  const lines = withWhys({
    resume: [{ repo: "app", text: "resume it" }],
    recap: [{ repo: "other", text: "did other" }],
    whys: { app: "why I left it half-done" },
  });
  const idx = lines.findIndex(isWhyLine);
  expect(idx).toBeGreaterThan(-1);
  expect(lines.slice(0, idx).some((l) => l.includes("Where you left off"))).toBe(true);
  expect(lines.slice(0, idx).some((l) => l.includes("What you did"))).toBe(false);
});

test("T7.4: NON-CONTIGUOUS bullets for one label emit the line once, before the first", () => {
  const lines = withWhys({
    recap: [{ repo: "app", text: "a" }, { repo: "other", text: "b" }, { repo: "app", text: "c" }],
    whys: { app: "one line only" },
  });
  expect(lines.filter(isWhyLine).length).toBe(1);
  const i = lines.findIndex(isWhyLine);
  expect(lines[i + 1]).toContain("[app] a");     // immediately before the FIRST matching bullet
});

test("inv2/T7.4: a why never attaches to `today` or to `suggestions`", () => {
  // ⚠ today's bullets carry the same unit labels; quoting against them would attribute a turn to
  // commits §3.2 deliberately excludes from unitFiles.
  const lines = withWhys({
    recap: [], resume: [],
    today: [{ repo: "app", text: "committed this morning" }],
    whys: { app: "must not appear" },
  });
  expect(lines.filter(isWhyLine).length).toBe(0);
  expect(lines.join("\n")).not.toContain("must not appear");

  // ⚠ The `suggestions` half, asserted rather than assumed. It is STRUCTURALLY impossible — a
  // SuggestionLine carries only `text` and no label to join on — but "impossible by shape" is
  // exactly the kind of claim that stops being true when a field is added later, and invariant 2
  // names suggestions explicitly. This is what would fail if one were.
  const withSug = withWhys({
    recap: [], resume: [],
    suggestions: [{ text: "next thing to do" }],
    whys: { app: "must not appear", "next thing to do": "nor must this" },
  });
  expect(withSug.filter(isWhyLine).length).toBe(0);
  expect(withSug.join("\n")).not.toContain("nor must this");
});

test("T7.4: model label variants are absorbed by norm", () => {
  for (const label of ["**app**", "App", "app."]) {
    const lines = withWhys({ recap: [{ repo: label, text: "did it" }], whys: { app: "matched anyway" } });
    expect(lines.filter(isWhyLine).length).toBe(1);
  }
});

test("T7.4: a git-only briefing is byte-identical with whys absent vs empty", () => {
  const b = { ...base, resume: [{ repo: "app", text: "r" }], recap: [{ repo: "app", text: "d" }] };
  expect(renderBriefing(b)).toBe(renderBriefing({ ...b, whys: {} }));
});

// ── T7.4 / invariant 5 at SINKS 1-3: the rendered quotation is byte-equal to its anchor ─────────
//
// ⚠ THE COUPLING THIS PINS. `renderBriefing` ends in `L.map(stripControl)`, which deletes every byte
// in [\x00-\x1f\x7f-\x9f] — so a why containing any of them would persist NOT byte-equal to the turn
// `textSha` covers, falsifying invariant 5 at sinks 1-3. The only thing preventing that is that
// select.ts stage 6 rejects EXACTLY that class. Measured at C7: every turn stripControl would mutate
// is rejected by the pipeline, and every turn the pipeline admits renders byte-equal.
//
// Nothing tested that coupling AT THE SINK — stage 6's class is pinned in select.ts's own tests and
// the frame round-trip is pinned in frame.ts's, but neither joins them. This test is the join, so
// changing EITHER class without the other turns it red. That is precisely what the spec demands:
// "Any future change to stripControl must change this rule in the same commit."
test("T7.4/inv5: every turn the pipeline ADMITS renders byte-equal; every turn it rejects would have been mutated", () => {
  const corpus = [
    "I switched the join to a membership test because the vote mis-attributed mixed commits",
    "lets go with C (build A now, designed to double as B later)",
    'he said "just ship it" and I disagreed, so I kept the drop',
    "why is §3.2 → §3.5 inconsistent — em-dashes, ünïcode, 日本語 all the way down",
    "why I did it\n",                                   // trailing newline
    "line one\nline two about the work in progress",     // embedded newline
    "before\x7fafter the work was done and dusted here",  // DEL — neither C0 nor C1
    "before\x9fafter the work was done and dusted here",  // C1
    "col1\tcol2 explaining exactly what changed here",    // tab
  ];
  let admitted = 0, rejected = 0;
  for (const turn of corpus) {
    const ok = selectTurn(turn).ok;
    const line = renderBriefing({ ...base, recap: [{ repo: "app", text: "did" }], whys: { app: turn } })
      .split("\n").find(isWhyLine);
    const rendered = line ? parseWhy(line) : null;
    if (ok) {
      admitted++;
      expect(rendered).not.toBeNull();
      // The actual invariant-5 assertion: byte-equality via textSha, not string similarity.
      expect(textSha(rendered!)).toBe(textSha(turn));
    } else {
      rejected++;
      // The rejected ones are exactly those the sink WOULD have mutated — which is why stage 6 has
      // to exist at all. If this stops holding, the two classes have drifted apart.
      if (rendered !== null) expect(textSha(rendered)).not.toBe(textSha(turn));
    }
  }
  expect(admitted).toBeGreaterThanOrEqual(4);   // the corpus really exercises both sides
  expect(rejected).toBeGreaterThanOrEqual(4);
});

// ── T7.5: invariant 1 — drops the why, never the bullet ─────────────────────────────────────────
test("T7.5: a why whose label matches NO bullet renders nothing, and every bullet still renders", () => {
  const lines = withWhys({
    recap: [{ repo: "app", text: "did it" }],
    whys: { "a-unit-with-no-bullets": "orphan why" },
  });
  expect(lines.filter(isWhyLine).length).toBe(0);
  expect(lines.join("\n")).toContain("[app] did it");     // the bullet is untouched
  expect(lines.join("\n")).not.toContain("orphan why");
});

// ── T7.3: the projection, with the collision test over ALL units ────────────────────────────────
const runWithUnits = async (extraRepo?: string) => {
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const repos = extraRepo ? [dir, extraRepo] : [dir];
  const sourcesFor = [dir];   // the repo the run ACTUALLY sees — passing a different one silently
                              // produces a unitKey matching no unit, which is a vacuous pass
  const cfg: Config = { repos, excludeCommitPatterns: [], lookbackCapDays: 30,
    transcripts: { enabled: true }, provider: { cli: "claude", argv: [], promptVia: "stdin" } };
  let counters: TranscriptRunCounters | null = null;
  const r = await runCore(cfg, {
    provider: { generate: async () => "## RESUME\n- [x] r\n## RECAP\n- [x] d | evidence: HEADSHA\n## SUGGESTIONS\n- n" },
    netProbe: async () => true,
    persistHealth: async (_d, c) => { counters = c; },
    scan: async (o) => {
      const e = emptyEvidence(o.window);
      for (const repo of sourcesFor) {
        const k = unitKey(repo, null);
        e.sources.set(k, { unitKey: k, text: "a decision-shaped turn about this unit",
          anchor: { sessionId: "s", uuid: "u", tsUtc: o.window.startUtc, textSha: textSha("a decision-shaped turn about this unit"), unitKey: k } });
        // ⚠ A source with NO segment is incoherent evidence — G5's `why-attribution` rejects it, and
        // rightly: the join can only produce a source when a segment satisfied ATTRIB. Caught when
        // G5 was wired in; the fixture had been asserting a why the pipeline could never emit.
        e.segments.push({ sessionId: "s", unitKey: k, localDay: o.window.startUtc.slice(0, 10), paths: ["a.ts"] });
      }
      return { evidence: e, degraded: [] };
    },
  });
  return { r, counters, dir };
};

test("T7.3: a unit with a why projects into struct.whys under norm(label)", async () => {
  const { r } = await runWithUnits();
  expect(r.struct.whys).toBeDefined();
  // Keyed by norm(label), NOT by unitKey — struct bullets carry a label, so a unitKey-keyed map
  // would be unjoinable at render time.
  expect(Object.keys(r.struct.whys!).every((k) => !k.includes("\x00"))).toBe(true);
  expect(Object.values(r.struct.whys!)[0]).toBe("a decision-shaped turn about this unit");
});

// ⚠ THE collision case, and the one the obvious implementation gets wrong: unit A HAS a why, unit B
// shares norm(label) and has NONE. Scoping the collision test to why-producing units finds no
// collision — and the render join, which walks every bullet's label, then puts A's quotation above
// B's bullets. Cross-repo mis-attribution, which nothing downstream catches.
test("T7.3: A has a why, B shares the label and has none ⇒ NEITHER renders [collision over ALL units]", async () => {
  const { r1, r2 } = await collidingRepos();
  let counters: TranscriptRunCounters | null = null;
  const res = await runCore(
    { repos: [r1, r2], excludeCommitPatterns: [], lookbackCapDays: 30, transcripts: { enabled: true },
      provider: { cli: "claude", argv: [], promptVia: "stdin" } } as Config,
    {
      provider: { generate: async () => "## RESUME\n- [x] r\n## RECAP\n- [x] d\n## SUGGESTIONS\n- n" },
      netProbe: async () => true,
      persistHealth: async (_d, c) => { counters = c; },
      scan: async (o) => {
        const e = emptyEvidence(o.window);
        const k = unitKey(r1, null);      // ONLY r1 has a why
        e.sources.set(k, { unitKey: k, text: "must not be attributed to the other repo",
          anchor: { sessionId: "s", uuid: "u", tsUtc: o.window.startUtc, textSha: textSha("must not be attributed to the other repo"), unitKey: k } });
        return { evidence: e, degraded: [] };
      },
    });

  // ⚠ ASSERT the premise. An earlier version SKIPPED when labels did not collide — and the fixture
  // produced ZERO units, so both this test and T7.6 asserted nothing at all while passing.
  const labels = res.units.map((u) => u.label);
  expect(res.units.length).toBe(2);
  expect(new Set(labels).size).toBe(1);          // the labels really do collide

  expect(res.struct.whys?.[labels[0]!]).toBeUndefined();   // dropped, fail-closed
  expect(counters!.drops["label-collision"]).toBeGreaterThanOrEqual(1);
  // ⚠ And the WIDER pre-mortem risk-5 counter, which is distinct: `drops["label-collision"]` counts
  // only collisions that COST a why, whereas `labelCollisions` counts the colliding UNITS. Both
  // units collide here, so it must be 2 — the plan's "otherwise unknown until 1.5b" figure.
  expect(counters!.labelCollisions).toBe(2);
  // …and the rendered briefing carries no quotation at all.
  expect(renderBriefing(res.struct).split("\n").filter(isWhyLine).length).toBe(0);
});

// ── T7.6: the ORDERING assertion — the paired half of T4.9 ──────────────────────────────────────
// ⚠ T4.9's own receipt could not decide this: the projection did not exist yet, so a synthetic
// post-scan mutation could not distinguish "after the scan" from "after the projection". THIS is
// the assertion that does, because `label-collision` is written ONLY by the projection.
test("T7.6: label-collision survives into the PERSISTED record, so the write runs after the projection", async () => {
  const { r1, r2 } = await collidingRepos();
  let persisted: TranscriptRunCounters | null = null;
  const res = await runCore(
    { repos: [r1, r2], excludeCommitPatterns: [], lookbackCapDays: 30, transcripts: { enabled: true },
      provider: { cli: "claude", argv: [], promptVia: "stdin" } } as Config,
    {
      provider: { generate: async () => "## RESUME\n- [x] r\n## RECAP\n- [x] d\n## SUGGESTIONS\n- n" },
      netProbe: async () => true,
      persistHealth: async (_d, c) => { persisted = JSON.parse(JSON.stringify(c)); },
      scan: async (o) => {
        const e = emptyEvidence(o.window);
        const k = unitKey(r1, null);
        e.sources.set(k, { unitKey: k, text: "a turn",
          anchor: { sessionId: "s", uuid: "u", tsUtc: o.window.startUtc, textSha: textSha("a turn"), unitKey: k } });
        return { evidence: e, degraded: [] };
      },
    });
  expect(res.units.length).toBe(2);
  expect(new Set(res.units.map((u) => u.label)).size).toBe(1);   // the premise, asserted
  expect(persisted).not.toBeNull();
  // Moving the health write ABOVE the projection turns this RED: the counter is incremented only by
  // the projection, so an earlier write persists a zero.
  expect(persisted!.drops["label-collision"]).toBeGreaterThanOrEqual(1);
});

// ── T7.7: the decision-shape filter, using the GATE's own candidates as the fixture ─────────────
// ⚠ The six the gate judged noise are the fixture; the ones it judged signal are the CONTROL. A
// filter asserted only on synthetic strings would not show it works on the sample that justified it.
test("T7.7: suppresses the gate's task-instruction candidates, keeps its decision-shaped ones", () => {
  const SUPPRESS = [
    "run the day 18 audit, then commit and push any changes to EVAL.md",
    "update the EVAL.md file with the findings",
    "fill the day-5 EVAL.md row and do a session update",
    "run /deep-review auto on the implementation plan",
    "log this in EVAL.md, then open the daily_briefing_application.md file in VSCode",
    "start executing PR-2-eval subagent-driven now",
  ];
  const KEEP = [
    "lets go with C (build A now, designed to double as B later)",
    "yes, fix both fetchers. Also we should make it so that if certain sources are unavailable, then we should pull more heavily from the remaining sources.",
    "yes, implement #1 and #2. Also for the optional #3, are we sure that this is an issue?",
    "Would it be better to do suggestion-grounding + thematic grouping now or in a later slice?",
    "lets go with these recommendations. For Textract, is this the same AWS credentials that I used last month?",
    "we should address issue #1, but #2 is not an issue.",
  ];
  for (const t of SUPPRESS) expect(isTaskShaped(t)).toBe(true);
  for (const t of KEEP) expect(isTaskShaped(t)).toBe(false);
});

test("T7.7: the documented defeats are NOT caught — stated, not claimed closed", () => {
  // Lexical, not semantic (R7). A filter claimed to close a class it only samples is worse than one
  // with stated limits.
  expect(isTaskShaped("Its a new day. Do a bun run audit for today")).toBe(false);  // verb not at the start
  expect(isTaskShaped("the EVAL.md row needs filling")).toBe(false);                // a task as a statement
  // A turn that opens as a task but carries a REASON is deliberately kept.
  expect(isTaskShaped("update the parser because the frame now has a suffix")).toBe(false);
});
