// test/reduce.test.ts
import { test, expect } from "bun:test";
import { reduce, summarize, STAGE1_LIST_CAP } from "../src/reduce";
import type { Activity } from "../src/types";

const A = (over: Partial<Activity>): Activity => ({ source: "git", kind: "commit", event_id: "x", ...over });

test("reduce groups activities by repo", () => {
  const ctx = reduce([A({ repo: "/r1", text: "c1" }), A({ repo: "/r2", text: "c2" }), A({ repo: "/r1", text: "c3" })], { maxChars: 9999 });
  expect(ctx.repos.map((r) => r.repo).sort()).toEqual(["/r1", "/r2"]);
  expect(ctx.repos.find((r) => r.repo === "/r1")!.activities.length).toBe(2);
});

test("reduce keeps the context within budget (real byte check, not just a note)", () => {
  const big = A({ repo: "/r1", text: "x".repeat(500) });
  const ctx = reduce([big], { maxChars: 200 });
  expect(JSON.stringify(ctx).length).toBeLessThanOrEqual(200);
  expect(ctx.note).toBeDefined();
});

test("reduce stage 1 caps oversized meta lists (the real git bulk), not just text, before dropping activities [Tier-5]", () => {
  // A pathological commit with a huge diffstat — this is where git-only activity size actually lives;
  // trimming only `text` (a one-line subject) would leave it over budget and skip to the
  // evidence-destroying stage 2 (activities: []).
  const huge = A({
    repo: "/r1", text: "subject",
    meta: { diffstat: Array.from({ length: 5000 }, (_, i) => ({ file: `src/file-${i}.ts`, added: 1, removed: 0 })) },
  });
  const full = JSON.stringify(reduce([huge], { maxChars: 9_999_999 })).length;
  expect(full).toBeGreaterThan(50_000); // the untrimmed context really is huge
  const ctx = reduce([huge], { maxChars: 10_000 });
  expect(JSON.stringify(ctx).length).toBeLessThanOrEqual(10_000);
  // Stage 1 handled it by CAPPING the diffstat — the activity (and its SHA/first-N-file evidence)
  // survives, rather than being dropped wholesale by stage 2.
  const acts = ctx.repos[0]?.activities ?? [];
  expect(acts.length).toBe(1);
  expect(acts[0]!.meta!.diffstat!.length).toBe(STAGE1_LIST_CAP);
});

test("reduce stage 3 drops repos from the tail and stays within budget, measured WITH the attached note [Tier-5]", () => {
  const acts = Array.from({ length: 200 }, (_, i) => A({ repo: `/repos/a-longish-repo-path-number-${i}`, text: "" }));
  const ctx = reduce(acts, { maxChars: 3000 });
  expect(JSON.stringify(ctx).length).toBeLessThanOrEqual(3000); // the note is real bytes — must be counted
  expect(ctx.repos.length).toBeGreaterThan(0);
  expect(ctx.repos.length).toBeLessThan(200);
  // kept repos are a prefix (tail-dropped), preserving grouping order
  expect(ctx.repos.map((r) => r.repo)).toEqual(acts.slice(0, ctx.repos.length).map((a) => a.repo!));
  expect(ctx.note).toContain("dropped");
});

test("reduce never returns an over-budget context, even below the empty-with-note skeleton [Tier-5]", () => {
  const acts = Array.from({ length: 10 }, (_, i) => A({ repo: `/r${i}` }));
  // 20 chars: too small for {"repos":[],"note":"..."} but >= {"repos":[]} (12) — must drop the note.
  const ctx = reduce(acts, { maxChars: 20 });
  expect(JSON.stringify(ctx).length).toBeLessThanOrEqual(20);
  expect(ctx.repos).toEqual([]);
  expect(ctx.note).toBeUndefined();
});

test("reduce keeps the truncation note when the budget admits the empty-with-note skeleton [Tier-5]", () => {
  const acts = Array.from({ length: 10 }, (_, i) => A({ repo: `/some/longer/repo/path/number-${i}` }));
  const ctx = reduce(acts, { maxChars: 60 });
  expect(JSON.stringify(ctx).length).toBeLessThanOrEqual(60);
  expect(ctx.repos).toEqual([]);
  expect(ctx.note).toBe("context truncated to fit budget");
});

test("reduce stage 1 preserves a text-less activity's undefined text (target fallback not shadowed) [Tier-5]", () => {
  // A text-less signal (here a branch activity with only `target`) plus a huge diffstat forces stage 1.
  // The trim must NOT coerce text to "" — generator renders `a.text ?? a.target ?? ""`, so a coerced ""
  // would shadow the target. Assert the trimmed activity keeps target and leaves text undefined.
  const branchSignal = A({
    source: "git", kind: "branch", repo: "/r1", target: "feature/big-refactor", text: undefined,
    meta: { diffstat: Array.from({ length: 5000 }, (_, i) => ({ file: `src/file-${i}.ts`, added: 1, removed: 0 })) },
  });
  const ctx = reduce([branchSignal], { maxChars: 10_000 });
  expect(JSON.stringify(ctx).length).toBeLessThanOrEqual(10_000);
  const act = ctx.repos[0]?.activities[0];
  expect(act).toBeDefined();
  expect(act!.text).toBeUndefined();           // NOT coerced to ""
  expect(act!.target).toBe("feature/big-refactor");
});

test("reduce stage 3 never emits a misleading 'dropped 0 repo(s)' note [Tier-5]", () => {
  // The stage-2 note is ~19 chars longer than the stage-3 zero-drop note, so there is a band of
  // budgets where stage 3 runs (stage-2 shape overflows) yet every repo still fits under the shorter
  // note. Sweep across it: the note must never lie, and the band must actually be exercised.
  const acts = Array.from({ length: 30 }, (_, i) => A({ repo: `/repo-${i}`, text: "" }));
  let sawAllKept = false;
  for (let mc = 2300; mc <= 2700; mc++) {
    const ctx = reduce(acts, { maxChars: mc });
    expect(JSON.stringify(ctx).length).toBeLessThanOrEqual(mc);
    expect(ctx.note ?? "").not.toContain("dropped 0");
    if (ctx.repos.length === acts.length && ctx.note?.startsWith("context reduced to fit")) sawAllKept = true;
  }
  expect(sawAllKept).toBe(true); // non-vacuous: the all-kept-with-shorter-note band was hit
});

test("summarize: N commits, M files, dirty flag", () => {
  const c = (files: string[]): Activity => ({ source: "git", kind: "commit", event_id: "x", meta: { diffstat: files.map((f) => ({ file: f, added: 1, removed: 0 })) } });
  expect(summarize([c(["a"]), c(["a", "b"])], true)).toBe("2 commit(s), 2 file(s) touched, uncommitted work present");
  expect(summarize([], false)).toBe("0 commit(s), 0 file(s) touched");
});
