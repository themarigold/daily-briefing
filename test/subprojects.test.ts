import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootOf } from "../src/subprojects";
import type { Config } from "../src/types";

const CFG: Config = { provider: { cli: "c", argv: [], promptVia: "stdin" } };

test("rootOf: segment-boundary match, not raw prefix", () => {
  expect(rootOf("packages/api/x.ts", ["packages/api"])).toBe("packages/api");
  expect(rootOf("packages/api-gateway/x.ts", ["packages/api"])).toBeNull(); // not a prefix by segment
});
test("rootOf: deepest wins for nested roots", () => {
  expect(rootOf("packages/api/x.ts", ["packages", "packages/api"])).toBe("packages/api");
});
test("rootOf: exact directory path matches", () => {
  expect(rootOf("packages/api", ["packages/api"])).toBe("packages/api");
});
test("rootOf: no match → null", () => {
  expect(rootOf("README.md", ["packages/api"])).toBeNull();
});

test("expandRoots: '*' → immediate dirs, excludes node_modules/.git/submodules", async () => {
  const { expandRoots } = await import("../src/subprojects");
  const root = mkdtempSync(join(tmpdir(), "dba-exp-"));
  for (const d of ["pkg-a", "pkg-b", "node_modules", ".hidden"]) mkdirSync(join(root, d), { recursive: true });
  mkdirSync(join(root, "sub", ".git"), { recursive: true }); // a submodule/nested repo
  const roots = (await expandRoots(root, ["*"])).sort();
  expect(roots).toEqual(["pkg-a", "pkg-b"]); // no node_modules, .hidden, or sub
});
test("expandRoots: '!'-negation excludes a matched dir", async () => {
  const { expandRoots } = await import("../src/subprojects");
  const root = mkdtempSync(join(tmpdir(), "dba-exp2-"));
  for (const d of ["packages/api", "packages/web"]) mkdirSync(join(root, d), { recursive: true });
  const roots = (await expandRoots(root, ["packages/*", "!packages/web"])).sort();
  expect(roots).toEqual(["packages/api"]);
});
test("expandRoots: leading './' is tolerated", async () => {
  const { expandRoots } = await import("../src/subprojects");
  const root = mkdtempSync(join(tmpdir(), "dba-exp3-"));
  mkdirSync(join(root, "app"), { recursive: true });
  expect(await expandRoots(root, ["./app"])).toEqual(["app"]);
});
test("expandRoots: recursive glob excludes node_modules at ANY depth (segment-wise skip)", async () => {
  const { expandRoots } = await import("../src/subprojects");
  const root = mkdtempSync(join(tmpdir(), "dba-exp4-"));
  mkdirSync(join(root, "packages/api"), { recursive: true });
  mkdirSync(join(root, "packages/node_modules/vendor"), { recursive: true });
  const roots = await expandRoots(root, ["packages/**"]);
  expect(roots).not.toContain("packages/node_modules/vendor");
  expect(roots).toContain("packages/api");
});

test("detectJs: package.json array-form workspaces", async () => {
  const { detectJs } = await import("../src/subprojects");
  const root = mkdtempSync(join(tmpdir(), "dba-js-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  expect(await detectJs(root)).toEqual(["packages/*"]);
});
test("detectJs: Yarn-classic object-form workspaces", async () => {
  const { detectJs } = await import("../src/subprojects");
  const root = mkdtempSync(join(tmpdir(), "dba-js2-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["apps/*"] } }));
  expect(await detectJs(root)).toEqual(["apps/*"]);
});
test("detectJs: pnpm-workspace.yaml", async () => {
  const { detectJs } = await import("../src/subprojects");
  const root = mkdtempSync(join(tmpdir(), "dba-js3-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - './libs/*'\n");
  expect(await detectJs(root)).toEqual(["libs/*"]);
});
test("detectRust: Cargo [workspace].members minus exclude", async () => {
  const { detectRust } = await import("../src/subprojects");
  const root = mkdtempSync(join(tmpdir(), "dba-rs-"));
  writeFileSync(join(root, "Cargo.toml"), `[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/legacy"]\n`);
  expect(await detectRust(root)).toEqual(["crates/*", "!crates/legacy"]);
});
test("detectJs: null when no JS manifest", async () => {
  const { detectJs } = await import("../src/subprojects");
  expect(await detectJs(mkdtempSync(join(tmpdir(), "dba-js4-")))).toBeNull();
});

test("parseGoWork: single-line + block use, comments, quotes, ./ strip; ignores replace/require", async () => {
  const { parseGoWork } = await import("../src/subprojects");
  const { roots } = parseGoWork([
    "go 1.22",
    "use ./api  // the api module",
    "use (",
    '  "./web"',
    "  ./cli",
    ")",
    "replace example.com/x => ./vendored",
  ].join("\n"));
  expect(roots.sort()).toEqual(["api", "cli", "web"]);
});
test("resolveProjectRoots: a repo with no go.work contributes no go-derived roots or warnings", async () => {
  const { resolveProjectRoots } = await import("../src/subprojects");
  const root = mkdtempSync(join(tmpdir(), "dba-go2-"));
  const { roots, warnings } = await resolveProjectRoots(root, CFG);
  expect(roots).toEqual([]);
  expect(warnings).toEqual([]);
});

test("resolveProjectRoots: config replaces detection", async () => {
  const { resolveProjectRoots } = await import("../src/subprojects");
  const root = mkdtempSync(join(tmpdir(), "dba-rpr-"));
  mkdirSync(join(root, "a"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  const cfg: Config = { ...CFG, subprojects: [{ repo: root, roots: ["*"] }] };
  const { roots } = await resolveProjectRoots(root, cfg);
  expect(roots).toEqual(["a"]); // config's "*", not the manifest's packages/*
});
test("resolveProjectRoots: polyglot Cargo + go.work → union", async () => {
  const { resolveProjectRoots } = await import("../src/subprojects");
  const root = mkdtempSync(join(tmpdir(), "dba-poly-"));
  mkdirSync(join(root, "crates/core"), { recursive: true });
  mkdirSync(join(root, "gomod"), { recursive: true });
  writeFileSync(join(root, "Cargo.toml"), `[workspace]\nmembers = ["crates/*"]\n`);
  writeFileSync(join(root, "go.work"), "use ./gomod\n");
  const { roots } = await resolveProjectRoots(root, CFG);
  expect(roots.sort()).toEqual(["crates/core", "gomod"]);
});
test("resolveProjectRoots: non-empty roots resolving to zero dirs → warn", async () => {
  const { resolveProjectRoots } = await import("../src/subprojects");
  const root = mkdtempSync(join(tmpdir(), "dba-warn-"));
  const cfg: Config = { ...CFG, subprojects: [{ repo: root, roots: ["packages/*"] }] };
  const { roots, warnings } = await resolveProjectRoots(root, cfg);
  expect(roots).toEqual([]);
  expect(warnings.join(" ")).toMatch(/resolved to zero/i);
});
test("resolveProjectRoots: auto-detected manifest whose roots resolve to zero directories → warn (no config, detection branch)", async () => {
  const { resolveProjectRoots } = await import("../src/subprojects");
  const root = mkdtempSync(join(tmpdir(), "dba-autozero-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  // packages/ contains only a nested-git-repo dir → expandRoots' hasGitEntry skip excludes it,
  // yielding zero net directories even though a manifest WAS found (non-empty globs).
  mkdirSync(join(root, "packages/sub/.git"), { recursive: true });
  const { roots, warnings } = await resolveProjectRoots(root, CFG);
  expect(roots).toEqual([]);
  expect(warnings.join(" ")).toMatch(/resolved to zero directories/i);
});
test("resolveProjectRoots: explicit roots:[] → single-unit, no warn", async () => {
  const { resolveProjectRoots } = await import("../src/subprojects");
  const root = mkdtempSync(join(tmpdir(), "dba-empty-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  const cfg: Config = { ...CFG, subprojects: [{ repo: root, roots: [] }] };
  const { roots, warnings } = await resolveProjectRoots(root, cfg);
  expect(roots).toEqual([]);
  expect(warnings).toEqual([]);
});
test("resolveProjectRoots: malformed manifest → warning, no crash", async () => {
  const { resolveProjectRoots } = await import("../src/subprojects");
  const root = mkdtempSync(join(tmpdir(), "dba-bad-"));
  writeFileSync(join(root, "Cargo.toml"), "[workspace]\nmembers = [unterminated"); // genuinely-invalid TOML (unterminated array)
  const { roots, warnings } = await resolveProjectRoots(root, CFG);
  expect(roots).toEqual([]);
  expect(warnings.join(" ")).toMatch(/detection failed/i);
});
test("resolveProjectRoots: Cargo [workspace].exclude drops the excluded member end-to-end", async () => {
  const { resolveProjectRoots } = await import("../src/subprojects");
  const root = mkdtempSync(join(tmpdir(), "dba-cargoex-"));
  for (const d of ["crates/core", "crates/legacy"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "Cargo.toml"), `[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/legacy"]\n`);
  const { roots } = await resolveProjectRoots(root, CFG);
  expect(roots).toContain("crates/core");
  expect(roots).not.toContain("crates/legacy"); // exclude → !-negation → absent from the final roots
});
test("resolveProjectRoots: go.work 'use ../shared' → skipped + warned", async () => {
  const { resolveProjectRoots } = await import("../src/subprojects");
  const root = mkdtempSync(join(tmpdir(), "dba-esc-"));
  mkdirSync(join(root, "in"), { recursive: true });
  writeFileSync(join(root, "go.work"), "use ./in\nuse ../shared\n");
  const { roots, warnings } = await resolveProjectRoots(root, CFG);
  expect(roots).toEqual(["in"]);
  expect(warnings.join(" ")).toMatch(/resolves outside the repo/i);
});
test("resolveProjectRoots: go.work with ONLY escaping use dirs → roots [] but STILL warned (early-return ordering)", async () => {
  const { resolveProjectRoots } = await import("../src/subprojects");
  const root = mkdtempSync(join(tmpdir(), "dba-allesc-"));
  writeFileSync(join(root, "go.work"), "use ../shared\nuse ../../other\n"); // zero net globs — must still warn
  const { roots, warnings } = await resolveProjectRoots(root, CFG);
  expect(roots).toEqual([]);
  expect(warnings.join(" ")).toMatch(/resolves outside the repo/i);
});

test("labeling: two repos both packages/api → A/api, B/api", async () => {
  const { labelUnits, repoLabelFor } = await import("../src/subprojects");
  const repos = ["/x/A", "/x/B"];
  const m = labelUnits([
    { repo: "/x/A", root: "packages/api" }, { repo: "/x/B", root: "packages/api" },
  ], repos);
  expect(m.get("/x/A\x00packages/api")).toBe("A/api");
  expect(m.get("/x/B\x00packages/api")).toBe("B/api");
});
test("labeling: repo myrepo + sub-project myrepo → catch-all 'myrepo' vs 'myrepo/myrepo'", async () => {
  const { labelUnits } = await import("../src/subprojects");
  const m = labelUnits([
    { repo: "/x/myrepo", root: null }, { repo: "/x/myrepo", root: "myrepo" },
  ], ["/x/myrepo"]);
  expect(m.get("/x/myrepo\x00")).toBe("myrepo");        // catch-all stays bare
  expect(m.get("/x/myrepo\x00myrepo")).toBe("myrepo/myrepo");
});
test("labeling: two same-basename roots in one repo → full-path qualified", async () => {
  const { labelUnits } = await import("../src/subprojects");
  const m = labelUnits([
    { repo: "/x/r", root: "packages/api" }, { repo: "/x/r", root: "apps/api" },
  ], ["/x/r"]);
  expect(m.get("/x/r\x00packages/api")).toBe("r/packages/api");
  expect(m.get("/x/r\x00apps/api")).toBe("r/apps/api");
});
test("labeling: unique base stays bare", async () => {
  const { labelUnits } = await import("../src/subprojects");
  const m = labelUnits([{ repo: "/x/r", root: "packages/web" }], ["/x/r"]);
  expect(m.get("/x/r\x00packages/web")).toBe("web");
});

import type { Activity } from "../src/types";
const commit = (files: string[]): Activity => ({
  source: "git", kind: "commit", event_id: "x", meta: { diffstat: files.map((f) => ({ file: f, added: 1, removed: 0 })) },
});

test("unitForCommit: plurality bucket", () => {
  expect(require("../src/subprojects").unitForCommit(commit(["packages/api/a", "packages/api/b", "packages/web/c"]), ["packages/api", "packages/web"])).toBe("packages/api");
});
test("unitForCommit: a top-vote tie → catch-all (null), not an arbitrary lex pick", () => {
  const { unitForCommit } = require("../src/subprojects");
  // No clear owner (1 file each) → the commit is cross-cutting, so it belongs to the repo catch-all,
  // NOT arbitrarily to the lexicographically-first root (the old behavior — that caused the day-8 misattribution).
  expect(unitForCommit(commit(["apps/x/a", "packages/y/b"]), ["apps/x", "packages/y"])).toBeNull();
});
test("unitForCommit: cross-cutting infra commit (STATE.md sync spanning sub-projects) → catch-all", () => {
  const { unitForCommit } = require("../src/subprojects");
  // Mirrors day-8's `8b4e2b9` ("nightly autolog status sync"): accountant_ai/STATE.md + daily_briefing/STATE.md,
  // 1 each → tie → catch-all, NOT [accountant_ai].
  expect(unitForCommit(commit(["accountant_ai/STATE.md", "daily_briefing/STATE.md"]), ["accountant_ai", "daily_briefing"])).toBeNull();
});
test("unitForCommit: a clear plurality still wins (no over-catch)", () => {
  const { unitForCommit } = require("../src/subprojects");
  // Guard must NOT over-catch: 2 files in api vs 1 in web is a clear owner → api, not catch-all.
  expect(unitForCommit(commit(["packages/api/a", "packages/api/b", "packages/web/c"]), ["packages/api", "packages/web"])).toBe("packages/api");
});
test("unitForCommit: all-null → null (catch-all)", () => {
  const { unitForCommit } = require("../src/subprojects");
  expect(unitForCommit(commit(["README.md"]), ["packages/api"])).toBeNull();
});
test("composeResumptionNote: diverged branch shows BOTH numbers + all clauses", () => {
  const { composeResumptionNote } = require("../src/subprojects");
  expect(composeResumptionNote({ files: ["a.ts"], ahead: 2, behind: 3, stashes: 1, detached: false }))
    .toBe("uncommitted: a.ts; ahead 2, behind 3; 1 stash(es)");
});
test("composeResumptionNote: stash-only", () => {
  const { composeResumptionNote } = require("../src/subprojects");
  expect(composeResumptionNote({ files: [], ahead: 0, behind: 0, stashes: 1, detached: false })).toBe("1 stash(es)");
});

// helper: a repo with two dirty sub-projects
test("resolveUnits: two dirty sub-projects both surface as Tier-1 units", async () => {
  const { resolveUnits, rankUnits } = await import("../src/subprojects");
  const repo = mkdtempSync(join(tmpdir(), "dba-ru-"));
  for (const d of ["packages/api", "packages/web"]) mkdirSync(join(repo, d), { recursive: true });
  const cfg: Config = { ...CFG, subprojects: [{ repo, roots: ["packages/*"] }] };
  const uncommitted: Activity = {
    source: "git", kind: "uncommitted", event_id: "u", repo,
    meta: { uncommittedFiles: ["packages/api/a.ts", "packages/web/b.ts"] },
  };
  const { units } = await resolveUnits([uncommitted], [], [repo], cfg);
  const dirty = units.filter((u) => u.hasResumptionState).map((u) => u.label).sort();
  expect(dirty).toEqual(["api", "web"]);
  expect(rankUnits(units).every((u, i, a) => i === 0 || (a[i-1]!.hasResumptionState || !u.hasResumptionState))).toBe(true);
});

test("resolveUnits: ahead-N clean catch-all is Tier-1 with a resumptionNote", async () => {
  const { resolveUnits } = await import("../src/subprojects");
  const repo = mkdtempSync(join(tmpdir(), "dba-ahead-"));
  const branch: Activity = {
    source: "git", kind: "branch", event_id: "b", repo, target: "main",
    text: "On branch main (ahead 2, behind 0)", meta: { aheadBehind: { ahead: 2, behind: 0 } },
  };
  const { units } = await resolveUnits([branch], [], [repo], CFG);
  const cat = units.find((u) => u.root === null)!;
  expect(cat.hasResumptionState).toBe(true);
  expect(cat.resumptionNote).toBe("ahead 2");
});

test("resolveUnits: idle in-sync repo (branch ahead 0 behind 0, clean) → no units", async () => {
  const { resolveUnits } = await import("../src/subprojects");
  const repo = mkdtempSync(join(tmpdir(), "dba-idle-"));
  const branch: Activity = { source: "git", kind: "branch", event_id: "b", repo, target: "main",
    text: "On branch main (ahead 0, behind 0)", meta: { aheadBehind: { ahead: 0, behind: 0 } } };
  const { units } = await resolveUnits([branch], [], [repo], CFG);
  expect(units).toEqual([]);
});

test("resolveUnits: same-day-only clean sub-project unit is KEPT + labeled, but hasWindowContent=false", async () => {
  const { resolveUnits } = await import("../src/subprojects");
  const repo = mkdtempSync(join(tmpdir(), "dba-sdo-"));
  mkdirSync(join(repo, "packages/api"), { recursive: true });
  const cfg: Config = { ...CFG, subprojects: [{ repo, roots: ["packages/*"] }] };
  const todayCommit: Activity = { source: "git", kind: "commit", event_id: "t1", repo, timestamp: "2026-07-13T10:00:00Z", meta: { diffstat: [{ file: "packages/api/x.ts", added: 1, removed: 0 }] } };
  const { units } = await resolveUnits([], [todayCommit], [repo], cfg); // window empty; only a `today` commit
  const api = units.find((u) => u.label === "api")!;
  expect(api).toBeDefined();                // KEPT so "Today so far" can label it (Task 15)
  expect(api.hasWindowContent).toBe(false); // but excluded from RECAP/RESUME at render time
});

test("resolveUnits: detached HEAD → Tier-1 catch-all with a 'detached HEAD' note", async () => {
  const { resolveUnits } = await import("../src/subprojects");
  const repo = mkdtempSync(join(tmpdir(), "dba-det-"));
  const branch: Activity = { source: "git", kind: "branch", event_id: "b", repo, target: "HEAD", text: "Detached HEAD at abc1234", meta: { aheadBehind: { ahead: 0, behind: 0 } } };
  const { units } = await resolveUnits([branch], [], [repo], CFG);
  expect(units[0]!.hasResumptionState).toBe(true);
  expect(units[0]!.resumptionNote).toBe("detached HEAD");
});

test("resolveUnits: a stash → catch-all only, Tier-1, with a stash note", async () => {
  const { resolveUnits } = await import("../src/subprojects");
  const repo = mkdtempSync(join(tmpdir(), "dba-stash-"));
  const stash: Activity = { source: "git", kind: "stash", event_id: "s", repo, target: "stash@{0}", text: "stash@{0}: WIP on main", meta: {} };
  const { units } = await resolveUnits([stash], [], [repo], CFG);
  expect(units.length).toBe(1);
  const cat = units[0]!;
  expect(cat.root).toBeNull();                 // stash is repo-level → catch-all, never a sub-project root
  expect(cat.hasResumptionState).toBe(true);
  expect(cat.resumptionNote).toBe("1 stash(es)");
});

test("resolveUnits: an unknown-repo subprojects entry → warning", async () => {
  const { resolveUnits } = await import("../src/subprojects");
  const repo = mkdtempSync(join(tmpdir(), "dba-unk-"));
  const cfg: Config = { ...CFG, subprojects: [{ repo: "/does/not/exist", roots: ["*"] }] };
  const branch: Activity = { source: "git", kind: "branch", event_id: "b", repo, target: "main", text: "On branch main (ahead 1, behind 0)", meta: { aheadBehind: { ahead: 1, behind: 0 } } };
  const { warnings } = await resolveUnits([branch], [], [repo], cfg);
  expect(warnings.join(" ")).toMatch(/not in the resolved repo set/i);
});

test("resolveUnits: repo label disambiguates against the FULL repos list, not just active repos (no day-to-day flip)", async () => {
  const { resolveUnits } = await import("../src/subprojects");
  // Two repos share basename "dupe"; only the first is active today (a branch signal). The catch-all's
  // label must be parent-qualified ("A/dupe") BECAUSE both repos are in the threaded `repos` list — it
  // must NOT flip to bare "dupe" on a day the sibling is quiet. (Fake paths never touched on disk;
  // resolveProjectRoots finds no manifest → catch-all only.)
  const active = "/tmp/A/dupe", inactive = "/tmp/B/dupe";
  const branch: Activity = { source: "git", kind: "branch", event_id: "b", repo: active, target: "main",
    text: "On branch main (ahead 1, behind 0)", meta: { aheadBehind: { ahead: 1, behind: 0 } } };
  const withSibling = await resolveUnits([branch], [], [active, inactive], CFG);
  const withoutSibling = await resolveUnits([branch], [], [active], CFG);
  expect(withSibling.units[0]!.label).toBe("A/dupe");   // qualified against the inactive sibling
  expect(withoutSibling.units[0]!.label).toBe("dupe");  // bare when the sibling isn't in the list — the flip we prevent
});

test("rankUnits: no resumption state anywhere → pure most-recent-commit order (degrade-to-today, non-confounded)", () => {
  const { rankUnits } = require("../src/subprojects");
  const u = (label: string, t: string): any => ({ repo: "/r", root: label, label, hasResumptionState: false, hasWindowContent: true, resumptionNote: "", dirtyFiles: [], latestCommitTime: t });
  // NEWER unit ("zulu", 11:00) is alphabetically LAST — so recency and label-sort DISAGREE. Expect the
  // newer one first: fails if the recency comparator is missing (→ label sort would put "alpha" first).
  const ranked = rankUnits([u("alpha", "2026-07-13T08:00:00Z"), u("zulu", "2026-07-13T11:00:00Z")]);
  expect(ranked.map((x: any) => x.label)).toEqual(["zulu", "alpha"]);
});
test("rankUnits: a dirty unit outranks a MORE-RECENT clean unit (Tier-1 beats recency, non-confounded)", () => {
  const { rankUnits } = require("../src/subprojects");
  // "zeta" (dirty, OLDER) must beat "alpha" (clean, NEWER): fails if the tier check is removed (→ label
  // sort would put "alpha" first) OR if recency were mis-prioritized (→ newer "alpha" first).
  const dirtyOld: any = { repo: "/r", root: "zeta", label: "zeta", hasResumptionState: true, hasWindowContent: true, resumptionNote: "uncommitted: a", dirtyFiles: ["a"], latestCommitTime: "2026-07-13T08:00:00Z" };
  const cleanNew: any = { repo: "/r", root: "alpha", label: "alpha", hasResumptionState: false, hasWindowContent: true, resumptionNote: "", dirtyFiles: [], latestCommitTime: "2026-07-13T11:00:00Z" };
  expect(rankUnits([cleanNew, dirtyOld])[0]!.label).toBe("zeta");
});
test("excluded-root: real pipeline — config ['packages','packages/*','!packages/legacy'] keeps parent+sibling, drops legacy; a legacy file folds into the surviving parent", async () => {
  const { resolveProjectRoots, rootOf } = await import("../src/subprojects");
  const repo = mkdtempSync(join(tmpdir(), "dba-excl-"));
  for (const d of ["packages/api", "packages/legacy"]) mkdirSync(join(repo, d), { recursive: true });
  const cfg: Config = { ...CFG, subprojects: [{ repo, roots: ["packages", "packages/*", "!packages/legacy"] }] };
  const { roots } = await resolveProjectRoots(repo, cfg);
  expect(roots).toContain("packages");
  expect(roots).toContain("packages/api");
  expect(roots).not.toContain("packages/legacy");                  // excluded by !-negation through the real expandRoots
  expect(rootOf("packages/legacy/x.ts", roots)).toBe("packages");  // deepest SURVIVING ancestor
});
test("excluded-root variant (a): '!'-excluded subtree with NO surviving parent root → catch-all (rootOf null)", async () => {
  const { resolveProjectRoots, rootOf } = await import("../src/subprojects");
  const repo = mkdtempSync(join(tmpdir(), "dba-excl2-"));
  for (const d of ["packages/api", "packages/legacy"]) mkdirSync(join(repo, d), { recursive: true });
  const cfg: Config = { ...CFG, subprojects: [{ repo, roots: ["packages/*", "!packages/legacy"] }] }; // NO bare "packages" root
  const { roots } = await resolveProjectRoots(repo, cfg);
  expect(roots).toContain("packages/api");
  expect(roots).not.toContain("packages/legacy");
  expect(rootOf("packages/legacy/x.ts", roots)).toBeNull(); // no surviving ancestor → catch-all
});

test("resolveProjectRoots: a PARTIALLY dead root list warns per-root, not only when all fail [Tier-5]", async () => {
  const { resolveProjectRoots } = await import("../src/subprojects");
  const repo = mkdtempSync(join(tmpdir(), "dba-roots-"));
  mkdirSync(join(repo, "alpha"), { recursive: true });
  mkdirSync(join(repo, "beta"), { recursive: true });
  const cfg = { subprojects: [{ repo, roots: ["alpha", "beta", "gone", "pkgs/*"] }] } as any;
  const { roots, warnings } = await resolveProjectRoots(repo, cfg);
  expect(roots.sort()).toEqual(["alpha", "beta"]);
  // The regression this exists for: before, ANY surviving root silenced the check entirely, so a
  // typo'd sub-project kept rendering under the catch-all label with nothing said.
  expect(warnings.filter((w) => w.includes('"gone"')).length).toBe(1);
  expect(warnings.some((w) => w.includes("resolved to zero directories"))).toBe(false); // not all-dead
  // A glob matching nothing today is not a mistake and must NOT warn — otherwise every optional
  // workspace pattern becomes daily noise.
  expect(warnings.some((w) => w.includes("pkgs/*"))).toBe(false);
});
