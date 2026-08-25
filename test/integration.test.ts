// test/integration.test.ts — cross-cutting integration tests (Task 17 Step 1b): each of these
// spans multiple tasks' code, so they live here rather than in any single unit's test file.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepo, commitFiles } from "./fixtures/build-repo";
import { listCommits, runGit } from "../src/git";
import { localMidnight } from "../src/time";
import { resolveUnits, rankUnits, unitForCommit, type Unit } from "../src/subprojects";
import { reduce } from "../src/reduce";
import { buildPrompt, generateBriefing } from "../src/generator";
import { run } from "../src/main";
import { hardenedProvider } from "../src/harden";
import { latestBriefingPath, markerExists } from "../src/marker";
import type { Config, Provider, Activity } from "../src/types";

function withEnv(cfgObj: unknown): () => void {
  const cfgHome = mkdtempSync(join(tmpdir(), "dba-cfg-"));
  const stateDir = mkdtempSync(join(tmpdir(), "dba-state-"));
  mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
  writeFileSync(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify(cfgObj));
  const prevXdg = process.env.XDG_CONFIG_HOME, prevState = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.XDG_CONFIG_HOME = cfgHome;
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
  return () => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prevState;
  };
}

function captureConsole() {
  const out: string[] = [], err: string[] = [];
  const oLog = console.log, oErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  return { out, err, restore: () => { console.log = oLog; console.error = oErr; } };
}

const CFG: Config = { provider: { cli: "c", argv: [], promptVia: "stdin" } };

// Hermetic default wrapper (mirrors test/main.test.ts's runT — test-hardening, review follow-up):
// this file's one run() call is force=true with real repo activity, so it reaches the network gate;
// without an injected netProbe that falls through to the real defaultNetProbe → live TCP egress.
// Route it through the same override-everything pattern (no `now` default needed here since the
// only call is force=true, which bypasses the morning-floor gate regardless of the clock).
function runT(force: boolean, deps: Parameters<typeof run>[1] = {}) {
  return run(force, { netProbe: async () => true, netGraceMs: 30, netPollMs: 10, ...deps });
}

// ---- 1) Single-project byte-identical: no-subprojects repo, 2 in-window commits ----
// Asserts the majority (non-monorepo) path still produces ONE repo-level "UNIT <label>" banner
// and no per-unit split — the common case must not regress from the sub-project-splitting work.
test("integration: single-project (no subprojects) repo with 2 in-window commits → ONE UNIT banner, no per-unit split", async () => {
  const day = new Date(2026, 6, 6);
  const repo = await buildRepo([
    { file: "a.ts", content: "a", isoDate: new Date(2026, 6, 6, 10, 0).toISOString() },
    { file: "b.ts", content: "b", isoDate: new Date(2026, 6, 6, 11, 0).toISOString() },
  ]);
  const start = localMidnight(day);
  const end = localMidnight(new Date(2026, 6, 7));
  const activities = await listCommits(repo, start, end, { emails: ["test@example.com"] });
  expect(activities.length).toBe(2); // sanity: real commits, real diffstat (not hand-built)

  // No subprojects entry for this repo, and no workspace manifest (package.json/Cargo.toml/go.work)
  // exists in it → resolveUnits must resolve exactly ONE catch-all unit (root: null).
  const { units } = await resolveUnits(activities, [], [repo], CFG);
  expect(units.length).toBe(1);
  expect(units[0]!.root).toBeNull();

  const ctx = reduce(activities, { maxChars: 999_999 });
  const prompt = buildPrompt(ctx, rankUnits(units));
  const unitBanners = prompt.match(/^UNIT /gm) ?? [];
  expect(unitBanners.length).toBe(1); // ONE repo-level banner
  expect(prompt).toContain(`UNIT ${units[0]!.label} —`);
  // No per-unit split: neither commit's own sub-path leaks in as a SEPARATE banner label.
});

// ---- 2) Stage-3 survival: reduce() drops a dirty repo's ctx entry; RESUME still surfaces it ----
// Backfill (orderResumeByRank) draws from the independently-computed `Unit[]`, not from `ctx` — so
// a repo dropped by reduce()'s stage-3 truncation still gets its RESUME line, even with no RECAP banner.
test("integration: reduce() stage-3 drop of a dirty repo's ctx entry still surfaces via RESUME backfill (not ctx)", async () => {
  const repoAActs: Activity[] = [
    { source: "git", kind: "commit", event_id: "aaa1111111111111111111111111111111111", repo: "/repoA",
      text: "small change", meta: { diffstat: [{ file: "a.ts", added: 1, removed: 0 }] } },
  ];
  const repoBActs: Activity[] = [
    { source: "git", kind: "commit", event_id: "bbb2222222222222222222222222222222222", repo: "/repoB",
      text: "x".repeat(3000), meta: { diffstat: [{ file: "b.ts", added: 1, removed: 0 }] } },
  ];
  const allActs = [...repoAActs, ...repoBActs];

  // Find a maxChars where reduce() genuinely reaches its stage-3 tail-drop (not stage-2's
  // collapse-to-summaries, not the ultimate empty-repos fallback) and drops EXACTLY repoB,
  // keeping repoA. Searched empirically rather than hardcoded, so this stays robust to minor
  // wording/format changes inside reduce() as long as a partial stage-3 drop is still reachable.
  let maxChars = -1;
  for (let m = 50; m <= 500; m++) {
    const ctx = reduce(allActs, { maxChars: m });
    if (ctx.repos.length === 1 && ctx.repos[0]!.repo === "/repoA" && /dropped \d+ repo\(s\)/.test(ctx.note ?? "")) {
      maxChars = m;
      break;
    }
  }
  expect(maxChars).toBeGreaterThan(0); // sanity: found a genuine stage-3 partial-drop budget

  const ctx = reduce(allActs, { maxChars });
  expect(ctx.repos.map((r) => r.repo)).toEqual(["/repoA"]); // repoB's ctx entry is GONE
  expect(ctx.note ?? "").toContain("dropped 1 repo(s)");

  // Units are resolved independently of reduce()/ctx (as the real pipeline does) — repoB's Unit
  // still carries its dirty resumption state.
  const units: Unit[] = [
    { repo: "/repoA", root: null, label: "repoA", hasResumptionState: false, hasWindowContent: true,
      resumptionNote: "", dirtyFiles: [], latestCommitTime: "2026-07-12T09:00:00Z" },
    { repo: "/repoB", root: null, label: "repoB", hasResumptionState: true, hasWindowContent: true,
      resumptionNote: "uncommitted: dirty.ts", dirtyFiles: ["dirty.ts"], latestCommitTime: null },
  ];
  const fake: Provider = { generate: async () =>
    `## RESUME\n- [repoA] resume A\n## RECAP\n- [repoA] did small change | evidence: aaa1111\n## SUGGESTIONS\n- x` };
  const b = await generateBriefing(ctx, fake, { date: "2026-07-13", machineScope: "m", provider: "c" }, units);

  // repoB's RESUME line survives via backfill (drawn from Unit, not ctx) even though ctx dropped it.
  const repoBResume = b.resume.find((r) => r.repo === "repoB");
  expect(repoBResume).toBeDefined();
  expect(repoBResume!.text).toBe("uncommitted: dirty.ts");

  // ...yet repoB's RECAP banner is genuinely absent (no evidence for it in this run's ctx).
  const prompt = buildPrompt(ctx, rankUnits(units));
  expect(prompt).not.toContain("repoB");
});

// ---- 3) today/drift/recap agree on the same unit label ----
// Real git plumbing throughout: a REAL multi-file commit's diffstat drives unitForCommit's
// majority-root vote (not a hand-built Activity.meta.diffstat), and a full run() through main.ts
// exercises three INDEPENDENTLY-computed label paths (today-so-far in main.ts, the drift warning
// in workingTreeDriftWarnings, and the RECAP "UNIT <label>" banner in buildPrompt) — they must agree.
test("integration: unitForCommit's plurality vote on a REAL multi-file commit's diffstat resolves to the majority root", async () => {
  const repo = mkdtempSync(join(tmpdir(), "dba-plurality-"));
  await runGit(["init", "-q", "-b", "main"], repo);
  await runGit(["config", "user.email", "test@example.com"], repo);
  await runGit(["config", "user.name", "Test"], repo);
  mkdirSync(join(repo, "packages/api"), { recursive: true });
  mkdirSync(join(repo, "packages/web"), { recursive: true });
  const iso = new Date(2026, 6, 6, 10, 0).toISOString();
  // ONE real commit spanning 3 files: 2 in packages/api, 1 in packages/web — majority is api.
  await commitFiles(repo, ["packages/api/a.ts", "packages/api/b.ts", "packages/web/c.ts"], { isoDate: iso });

  const start = localMidnight(new Date(2026, 6, 6));
  const end = localMidnight(new Date(2026, 6, 7));
  const acts = await listCommits(repo, start, end, { emails: ["test@example.com"] });
  expect(acts.length).toBe(1);
  expect(acts[0]!.meta?.diffstat?.length).toBe(3); // real diffstat, not hand-built

  expect(unitForCommit(acts[0]!, ["packages/api", "packages/web"])).toBe("packages/api");
});

test("integration: today so far / drift warning / RECAP banner all agree on the same unit label ('api')", async () => {
  // Repo directory literally named "api" (single-project, no subprojects split): repoLabelFor's
  // basename disambiguation is the ONE labeling function every path below routes through — main.ts's
  // "Today so far" fallback, workingTreeDriftWarnings' repo-level drift label, and buildPrompt's
  // catch-all UNIT banner — so all three MUST land on the same string if none of them regressed.
  const parent = mkdtempSync(join(tmpdir(), "dba-agree-"));
  const repo = join(parent, "api");
  mkdirSync(repo);
  await runGit(["init", "-q", "-b", "main"], repo);
  await runGit(["config", "user.email", "test@example.com"], repo);
  await runGit(["config", "user.name", "Test"], repo);

  const yesterdayIso = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
  const yesterdaySha = await commitFiles(repo, ["a.ts", "b.ts"], { isoDate: yesterdayIso }); // in-window, real 2-file commit
  await commitFiles(repo, ["c.ts"], { isoDate: new Date().toISOString() });                  // today's commit
  writeFileSync(join(repo, "a.ts"), "changed");                                              // dirty at run-time

  const cleanup = withEnv({ repos: [repo], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  let capturedPrompt = "";
  const provider: Provider = {
    async generate(prompt: string) {
      capturedPrompt = prompt;
      return `## RESUME\n- [api] resume here\n## RECAP\n- [api] did api work | evidence: ${yesterdaySha.slice(0, 7)}\n## SUGGESTIONS\n- follow up`;
    },
  };
  try {
    const code = await runT(true, { provider, statusNow: async () => "" }); // force drift: clean at render time
    expect(code).toBe(0);

    // RECAP banner: buildPrompt's UNIT banner for the (only) catch-all unit.
    expect(capturedPrompt).toContain("UNIT api");

    const rendered = await Bun.file(latestBriefingPath()).text();
    // "Today so far": computed deterministically in main.ts (never sent to the model).
    expect(rendered).toMatch(/Today so far[\s\S]*\[api\]/);
    // Drift warning: computed independently via repoLabelFor/repoLabel in workingTreeDriftWarnings.
    expect(rendered).toContain("working-tree changed while generating: [api]");
    // The model's own RECAP echo parses through with the same label.
    expect(rendered).toMatch(/What you did[\s\S]*\[api\]/);
  } finally { cap.restore(); cleanup(); }
});

// ---- 4) M1: monorepo split drops the idle catch-all — buildPrompt must not resurrect it ----
// In a subprojects-split repo, ALL commits vote to sub-project roots via unitForCommit, so the
// repo's catch-all (root=null) only ever accumulates the always-emitted, benign `branch` Activity.
// resolveUnits correctly drops that idle catch-all (hasResumptionState=false → isActive=false). But
// buildPrompt's bucketing is independent of resolveUnits' filtering — it must also skip a bucket that
// has no matching Unit AND carries zero commits/files, or it resurrects a spurious empty UNIT banner
// for a unit resolveUnits already decided doesn't exist.
test("integration: monorepo subprojects split drops the idle catch-all's branch signal — buildPrompt emits no spurious empty UNIT banner", async () => {
  const repo = mkdtempSync(join(tmpdir(), "dba-monorepo-"));
  await runGit(["init", "-q", "-b", "main"], repo);
  await runGit(["config", "user.email", "test@example.com"], repo);
  await runGit(["config", "user.name", "Test"], repo);
  mkdirSync(join(repo, "packages/api"), { recursive: true });
  const iso = new Date(2026, 6, 6, 10, 0).toISOString();
  await commitFiles(repo, ["packages/api/a.ts"], { isoDate: iso });

  const start = localMidnight(new Date(2026, 6, 6));
  const end = localMidnight(new Date(2026, 6, 7));
  const commitActs = await listCommits(repo, start, end, { emails: ["test@example.com"] });
  expect(commitActs.length).toBe(1); // real commit, real diffstat — votes to packages/api

  // The always-emitted, idle branch signal (in sync, clean) — lands in the repo's catch-all only.
  // ⚠ `isDefaultBranch` / `hasUpstream` are what PRODUCTION now emits for this shape (git.ts), and
  // they are what makes it idle. Without them `isBranchNotable` treats the activity as notable —
  // absent metadata deliberately REPORTS rather than hides, since defaulting to the suppressing
  // values would silently swallow every branch line. This fixture predated those fields; carrying
  // them keeps the test's intent (an idle branch must not leak into the prompt) and makes it match
  // what the pipeline actually produces. It still discriminates: break the predicate and the line
  // leaks again.
  const branchAct: Activity = {
    source: "git", kind: "branch", event_id: "b", repo, target: "main",
    text: "On branch main (ahead 0, behind 0)",
    meta: { aheadBehind: { ahead: 0, behind: 0 }, isDefaultBranch: true, hasUpstream: true },
  };
  const activities = [...commitActs, branchAct];

  const cfg: Config = { ...CFG, subprojects: [{ repo, roots: ["packages/*"] }] };
  const { units } = await resolveUnits(activities, [], [repo], cfg);
  // resolveUnits correctly drops the idle catch-all — only the sub-project unit survives.
  expect(units.length).toBe(1);
  expect(units[0]!.root).toBe("packages/api");

  const ctx = reduce(activities, { maxChars: 999_999 });
  const prompt = buildPrompt(ctx, rankUnits(units));

  // No spurious empty UNIT banner for the catch-all resolveUnits already dropped, and no leaked
  // idle branch line.
  expect(prompt).not.toMatch(/UNIT \S+ — 0 commit\(s\), 0 file\(s\) touched/);
  expect(prompt).not.toContain("On branch main (ahead 0, behind 0)");
});

// ---- 5) nested-root divergence: buildPrompt/today bucketing must use resolveUnits' REAL roots ----
// resolveUnits buckets commits against the FULL candidate root set (["a","a/x","z"]); the nested
// child "a/x" never independently wins a unit (no commit/file votes for it alone), so it's absent
// from the "survivor" subset (rootsForRepo). Recomputing unitForCommit against that SUBSET reroutes
// a/x's vote up to "a" via rootOf's deepest-present fallback, creating a false a=2/z=2 tie that
// lexicographic tie-break resolves to "a" — the WRONG unit vs. resolveUnits' real "z" pick.
test("integration: buildPrompt buckets against resolveUnits' real (full) roots, not the survivor subset, for nested project roots", async () => {
  const repo = mkdtempSync(join(tmpdir(), "dba-nested-"));
  await runGit(["init", "-q", "-b", "main"], repo);
  await runGit(["config", "user.email", "test@example.com"], repo);
  await runGit(["config", "user.name", "Test"], repo);
  mkdirSync(join(repo, "a/x"), { recursive: true });
  mkdirSync(join(repo, "z"), { recursive: true });

  const iso = new Date(2026, 6, 6, 10, 0).toISOString();
  // ONE real commit: 1 file directly under a/, 1 under a/x/, 2 under z/ — plurality vote is z (2).
  await commitFiles(repo, ["a/f1.ts", "a/x/f2.ts", "z/f3.ts", "z/f4.ts"], { isoDate: iso });
  // Unrelated dirty file directly under a/ so unit "a" survives INDEPENDENTLY of the nested child a/x
  // (a/x itself never gets a vote of its own, so it won't survive into the "units" subset).
  writeFileSync(join(repo, "a/unrelated.ts"), "dirty");

  const start = localMidnight(new Date(2026, 6, 6));
  const end = localMidnight(new Date(2026, 6, 7));
  const commitActs = await listCommits(repo, start, end, { emails: ["test@example.com"] });
  expect(commitActs.length).toBe(1);
  expect(commitActs[0]!.meta?.diffstat?.length).toBe(4); // real diffstat, not hand-built

  const uncommitted: Activity = {
    source: "git", kind: "uncommitted", event_id: "u", repo,
    meta: { uncommittedFiles: ["a/unrelated.ts"] },
  };
  const activities = [...commitActs, uncommitted];

  const cfg: Config = { ...CFG, subprojects: [{ repo, roots: ["a", "a/x", "z"] }] };
  const { units, rootsByRepo } = await resolveUnits(activities, [], [repo], cfg);

  const fullRoots = rootsByRepo.get(repo)!;
  expect(fullRoots.sort()).toEqual(["a", "a/x", "z"]);
  expect(unitForCommit(commitActs[0]!, fullRoots)).toBe("z"); // resolveUnits' real pick (a=1, a/x=1, z=2)

  const survivorRoots = units.filter((u) => u.repo === repo && u.root !== null).map((u) => u.root!);
  expect(survivorRoots.sort()).toEqual(["a", "z"]); // "a/x" never won its own unit — dropped from the subset
  // Survivor-subset recompute is STILL a divergence from the full-roots pick ("z"): a/x's vote reroutes
  // onto "a" → false tie a=2/z=2 → the cross-cutting guard now yields catch-all (null), not the old wrong "a".
  // Either way it's ≠ "z", which is exactly why buildPrompt must bucket against the threaded full roots.
  expect(unitForCommit(commitActs[0]!, survivorRoots)).toBeNull();

  const ctx = reduce(activities, { maxChars: 999_999 });
  const ranked = rankUnits(units);
  const zLabel = units.find((u) => u.root === "z")!.label;
  const shortSha = commitActs[0]!.event_id!.slice(0, 7);

  // Threading rootsByRepo through buildPrompt must render the commit under the SAME unit
  // resolveUnits assigned ("z"), not the rerouted "a".
  const prompt = buildPrompt(ctx, ranked, rootsByRepo);
  const idxCommit = prompt.indexOf(`[${shortSha}]`);
  expect(idxCommit).toBeGreaterThan(-1);
  const headers = [...prompt.matchAll(/^UNIT (.+?) —/gm)].map((m) => ({ label: m[1]!, idx: m.index! }));
  const owner = [...headers].reverse().find((h) => h.idx < idxCommit)?.label;
  expect(owner).toBe(zLabel);
});


// ---- F4: the parse gate must see the MODEL's output, not our own backfill ----
test("F4: a briefing that parsed into nothing does NOT stamp the day, even though backfill fills resume", async () => {
  // The gate existed before this test and was very nearly decorative. `generateBriefing` backfills a
  // resume bullet for every Tier-1 unit the model omitted, and that runs BEFORE main's check — so a
  // model returning pure garbage still arrived with a non-empty `struct.resume` and stamped the day.
  // On a machine with any dirty repo (`hasResumptionState`) that is most mornings. Since C1 the
  // provider may deliberately return a TRUNCATED result, which turns "parsed into nothing" from a
  // theoretical case into a reachable one — so the gate has to actually work.
  //
  // MUTATION (verified red): derive `parsedEmpty` from `r.struct` instead of `r.rawText` →
  // `expect(received).toBe(expected)  Expected: 1  Received: 0`, and the marker is written.
  const repo = await buildRepo([
    { file: "a.ts", content: "a", isoDate: new Date(Date.now() - 20 * 3600 * 1000).toISOString() },
  ]);
  writeFileSync(join(repo, "a.ts"), "dirty");   // guarantees hasResumptionState → backfill has something to add
  const cleanup = withEnv({ repos: [repo], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  const provider: Provider = { async generate() { return "the model said something with no headers at all"; } };
  try {
    const code = await runT(true, { provider });
    expect(code).toBe(1);
    expect(cap.err.join(" ")).toContain("did not parse into any section");
    expect(await markerExists()).toBe(false);
  } finally { cap.restore(); cleanup(); }
});

test("F4: a WELL-FORMED briefing still stamps (the gate is not over-broad)", async () => {
  const repo = await buildRepo([
    { file: "a.ts", content: "a", isoDate: new Date(Date.now() - 20 * 3600 * 1000).toISOString() },
  ]);
  const cleanup = withEnv({ repos: [repo], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  const provider: Provider = {
    async generate() { return "## RESUME\n- [x] pick up here\n## RECAP\n- [x] did a thing\n## SUGGESTIONS\n- next"; },
  };
  try {
    expect(await runT(true, { provider })).toBe(0);
    expect(await markerExists()).toBe(true);
  } finally { cap.restore(); cleanup(); }
});


// ---- H2: the truncation warning must reach the USER, and the day must still stamp ----
test("integration: a truncated briefing is delivered WITH its warning, and still stamps the day", async () => {
  // The provider's fail-open is only defensible if the user is told, and until now nothing pinned the
  // whole hop: provider -> onWarning -> the wrapper's runtimeWarnings -> core's late merge into
  // struct.warnings -> renderBriefing. Each link had a test; the chain did not.
  //
  // It also pins the deliberate ASYMMETRY with the gate above it: a briefing known to be cut off DOES
  // stamp (it carries real model content plus a warning), whereas one that parsed into nothing does
  // not. Those two decisions live in different files and a reader would otherwise have to infer it.
  const repo = await buildRepo([
    { file: "a.ts", content: "a", isoDate: new Date(Date.now() - 20 * 3600 * 1000).toISOString() },
  ]);
  const cleanup = withEnv({ repos: [repo], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } });
  const cap = captureConsole();
  // A real child whose grandchild holds stdout open past the flush window — the actual pathology, not
  // a stubbed warning — and routed through `hardenedProvider`, which is the production shape and the
  // only shape that carries the warning. That is worth stating: `core` reads warnings STRUCTURALLY off
  // the provider object it was handed (`runtimeWarningsOf`), and a bare `BYOCliProvider` deliberately
  // has no `runtimeWarnings` array — the funnel lives in the wrapper because `build()` constructs a
  // fresh provider per ladder rung. Written first with a bare provider, this test failed with the
  // warning missing from the rendered briefing: the chain really does depend on the wrapper. Both
  // production (core.ts builds one) and the eval harness (scripts/eval.ts:129) use it.
  const provider = hardenedProvider(
    { cli: "sh", argv: ["-c", "printf '## RESUME\\n- [x] pick up here\\n## RECAP\\n- [x] did a thing\\n'; sleep 3 &"], promptVia: "stdin" } as any,
    { flushMs: 200 } as any,
  );
  try {
    expect(await runT(true, { provider })).toBe(0);
    expect(await markerExists()).toBe(true);                       // truncation does NOT block the stamp
    const rendered = await Bun.file(latestBriefingPath()).text();
    expect(rendered).toContain("may be cut off at the end");       // ...but the user is told
    expect(rendered).toContain("pick up here");                    // and the recovered content shipped
  } finally { cap.restore(); cleanup(); }
});

// ── day-21 follow-up: the branch must reach the MODEL, inside the unit block ─────────────────────
test("integration: a NOTABLE branch is repeated into each unit block — the model can make the join", async () => {
  // ⚠ WHY THIS EXISTS, and why #148 did not close it. #148 renders branch state deterministically
  // into "Where you left off", which guarantees the fact is DISPLAYED — but it runs at render time,
  // so it corrects the model's bullet after the fact rather than informing it. `bucketActivities`
  // sends branch/stash to the repo CATCH-ALL, so the model saw `On branch …` under the repo heading
  // while writing bullets headed with a SUB-PROJECT label. On 2026-08-06 it never made the join:
  // it framed a `policy.toml` edit on `chore/sign-live-policy` as an item23 tail and advised
  // committing it "tying it to that work". It was a signing chore.
  const repo = mkdtempSync(join(tmpdir(), "dba-branchunit-"));
  await runGit(["init", "-q", "-b", "main"], repo);
  await runGit(["config", "user.email", "test@example.com"], repo);
  await runGit(["config", "user.name", "Test"], repo);
  mkdirSync(join(repo, "packages/api"), { recursive: true });
  const iso = new Date(2026, 6, 6, 10, 0).toISOString();
  await commitFiles(repo, ["packages/api/a.ts"], { isoDate: iso });
  const commitActs = await listCommits(repo, localMidnight(new Date(2026, 6, 6)), localMidnight(new Date(2026, 6, 7)), { emails: ["test@example.com"] });

  const branchAct: Activity = {
    source: "git", kind: "branch", event_id: "b", repo, target: "chore/sign-live-policy",
    text: "On branch chore/sign-live-policy (no upstream)",
    meta: { aheadBehind: { ahead: 0, behind: 0 }, isDefaultBranch: false, hasUpstream: false },
  };
  const cfg: Config = { ...CFG, subprojects: [{ repo, roots: ["packages/*"] }] };
  const { units } = await resolveUnits([...commitActs, branchAct], [], [repo], cfg);
  const prompt = buildPrompt(reduce([...commitActs, branchAct], { maxChars: 999_999 }), rankUnits(units));

  // The branch appears INSIDE the sub-project's UNIT block, not only under the repo catch-all.
  const unitIdx = prompt.indexOf("UNIT api");
  expect(unitIdx).toBeGreaterThan(-1);
  const nextUnit = prompt.indexOf("UNIT ", unitIdx + 1);
  const block = prompt.slice(unitIdx, nextUnit === -1 ? undefined : nextUnit);
  expect(block).toContain("chore/sign-live-policy");
});

test("⚠ an IDLE branch never reaches the model, even when the catch-all bucket is POPULATED", () => {
  // THE day-22 gap. `isBranchNotable` gated the two RENDERED outputs (#148, #149) but the raw
  // Activity still arrived in the catch-all and rendered whenever that bucket held other content. On
  // 2026-08-07 the model built a false repo-level claim from exactly that: "[personal_code] Clean on
  // `main` (ahead 0, behind 0) — nothing pending to resume", two bullets below its own "[scratchpad]
  // Uncommitted work sitting in `scratchpad/`" — and scratchpad/ is INSIDE personal_code.
  //
  // ⚠ The existing pin cannot catch this: `integration: monorepo subprojects split drops the idle
  // catch-all's branch signal` uses a fixture whose catch-all is EMPTY and therefore dropped. Here it
  // is POPULATED — a repo-root commit — which is the shape that actually occurs.
  const repo = "/mono";
  const idle: Activity = {
    source: "git", kind: "branch", event_id: "b", repo, target: "main",
    text: "On branch main (ahead 0, behind 0)",
    meta: { aheadBehind: { ahead: 0, behind: 0 }, isDefaultBranch: true, hasUpstream: true },
  };
  const commit: Activity = {
    source: "git", kind: "commit", event_id: "c1", repo, timestamp: "2026-07-30T12:00:00.000Z",
    text: "root-level change", meta: { diffstat: [{ file: "README.md", added: 1, removed: 0 }] },
  };
  const ctx = reduce([commit, idle], { maxChars: 999_999 });
  const prompt = buildPrompt(ctx, rankUnits([{ repo, root: null, label: "mono", hasResumptionState: false,
    hasWindowContent: true, resumptionNote: "", dirtyFiles: [], latestCommitTime: null }]));

  expect(prompt).toContain("root-level change");            // the bucket IS populated and rendered…
  expect(prompt).not.toContain("On branch main");           // …but the idle branch is not in it
});

test("a NOTABLE branch still reaches the catch-all — the filter is not over-broad", () => {
  const repo = "/mono";
  const notable: Activity = {
    source: "git", kind: "branch", event_id: "b", repo, target: "chore/x",
    text: "On branch chore/x (no upstream)",
    meta: { aheadBehind: { ahead: 0, behind: 0 }, isDefaultBranch: false, hasUpstream: false },
  };
  const commit: Activity = {
    source: "git", kind: "commit", event_id: "c1", repo, timestamp: "2026-07-30T12:00:00.000Z",
    text: "root-level change", meta: { diffstat: [{ file: "README.md", added: 1, removed: 0 }] },
  };
  const prompt = buildPrompt(reduce([commit, notable], { maxChars: 999_999 }),
    rankUnits([{ repo, root: null, label: "mono", hasResumptionState: false, hasWindowContent: true,
      resumptionNote: "", dirtyFiles: [], latestCommitTime: null }]));
  expect(prompt).toContain("chore/x");
});
