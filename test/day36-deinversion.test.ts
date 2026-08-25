// test/day36-deinversion.test.ts — T1.3, the day-36 inversion batch: display clustering
// (clusterRecap + render nesting), merge attribution by first-parent file plurality (mergeLabel via
// unitForFiles), the recap count header, and the audit-invariance pin (constraint 2 of the design:
// the deterministic audit layer must return IDENTICAL results on clustered and flat renders).
import { test, expect, describe } from "bun:test";
import { clusterRecap, generateBriefing } from "../src/generator";
import { renderBriefing } from "../src/render";
import { unitForFiles, unitForCommit } from "../src/subprojects";
import { extractCitedShas, missingSameDay, coverageGaps } from "../src/audit";
import { listPrMerges } from "../src/git";
import { runCore } from "../src/core";
import { localMidnight } from "../src/time";
import { buildRepo, commitFiles, branchCommit, mergeBranchWith } from "./fixtures/build-repo";
import type { ReducedContext, Activity, BriefingStruct, Config, Provider } from "../src/types";

const commit = (sha: string, repo: string, diffstat: { file: string; added: number; removed: number }[], iso: string): Activity =>
  ({ source: "git", kind: "commit", event_id: sha, repo, timestamp: iso, text: `c-${sha}`, meta: { diffstat } });

const ctxOf = (acts: Activity[]): ReducedContext => ({ repos: [{ repo: "/r", summary: "", activities: acts }] });

const d18 = "2026-08-18T10:00:00-07:00", d19 = "2026-08-19T10:00:00-07:00";

describe("clusterRecap — pure", () => {
  test("two entries whose commits share a dominant file are stamped with one group; a third on another file is not", () => {
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "core/ledger.py", added: 10, removed: 2 }], d18),
      commit("bbbb222", "/r", [{ file: "core/ledger.py", added: 7, removed: 1 }, { file: "tests/t.py", added: 1, removed: 0 }], d19),
      commit("cccc333", "/r", [{ file: "other.py", added: 3, removed: 0 }], d18),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
      { repo: "app", text: "three", evidence: "cccc333" },
    ], ctx);
    expect(out[0]!.group).toBe("core/ledger.py — 2 commits (Aug 18–19)");
    expect(out[1]!.group).toBe(out[0]!.group);
    expect(out[2]!.group).toBeUndefined();
    // presentation-only: text/evidence/order untouched
    expect(out.map((e) => e.text)).toEqual(["one", "two", "three"]);
    expect(out.map((e) => e.evidence)).toEqual(["aaaa111", "bbbb222", "cccc333"]);
  });

  test("same-day cluster renders a single date, not a range", () => {
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "f.ts", added: 1, removed: 0 }], d18),
      commit("bbbb222", "/r", [{ file: "f.ts", added: 1, removed: 0 }], d18),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
    ], ctx);
    expect(out[0]!.group).toBe("f.ts — 2 commits (Aug 18)");
  });

  test("unresolved, absent, or ambiguous-prefix evidence leaves the entry ungrouped", () => {
    const ctx = ctxOf([
      // two commits sharing a prefix make a short citation ambiguous
      commit("abc1234deadbeef00", "/r", [{ file: "f.ts", added: 1, removed: 0 }], d18),
      commit("abc1234feedface11", "/r", [{ file: "f.ts", added: 1, removed: 0 }], d18),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "no evidence" },
      { repo: "app", text: "unknown sha", evidence: "9999999" },
      { repo: "app", text: "ambiguous", evidence: "abc1234" },
      { repo: "app", text: "ambiguous too", evidence: "abc1234" },
    ], ctx);
    expect(out.every((e) => e.group === undefined)).toBe(true);
  });

  test("dominant file is max added+removed churn; a tie takes the FIRST diffstat row", () => {
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "first.ts", added: 2, removed: 0 }, { file: "second.ts", added: 1, removed: 1 }], d18),
      commit("bbbb222", "/r", [{ file: "first.ts", added: 5, removed: 0 }], d18),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "tie goes first", evidence: "aaaa111" },
      { repo: "app", text: "plain", evidence: "bbbb222" },
    ], ctx);
    expect(out[0]!.group).toContain("first.ts");
    expect(out[1]!.group).toBe(out[0]!.group);
  });

  test("different labels never share a cluster; decorated labels cluster with their bare form (norm)", () => {
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "f.ts", added: 1, removed: 0 }], d18),
      commit("bbbb222", "/r", [{ file: "f.ts", added: 1, removed: 0 }], d18),
      commit("cccc333", "/r", [{ file: "f.ts", added: 1, removed: 0 }], d18),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "plain", evidence: "aaaa111" },
      { repo: "**app**", text: "decorated", evidence: "bbbb222" },
      { repo: "elsewhere", text: "other label", evidence: "cccc333" },
    ], ctx);
    expect(out[0]!.group).toBeDefined();
    expect(out[1]!.group).toBe(out[0]!.group);   // norm("**app**") === norm("app")
    expect(out[2]!.group).toBeUndefined();       // different label — own (singleton) key
  });
});

describe("clusterRecap — call site (generateBriefing wires it)", () => {
  test("bullets citing same-dominant-file commits come back stamped from generateBriefing itself", async () => {
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "core/ledger.py", added: 4, removed: 1 }], d18),
      commit("bbbb222", "/r", [{ file: "core/ledger.py", added: 2, removed: 2 }], d19),
    ]);
    const stub: Provider = {
      generate: async () => [
        "## RESUME", "- [app] resume",
        "## RECAP",
        "- [app] first | evidence: aaaa111",
        "- [app] second | evidence: bbbb222",
        "## SUGGESTIONS", "- next",
      ].join("\n"),
    };
    const b = await generateBriefing(ctx, stub, { date: "2026-08-25", machineScope: "h", provider: "claude" }, []);
    expect(b.recap.length).toBe(2);
    expect(b.recap[0]!.group).toContain("core/ledger.py — 2 commits");
    expect(b.recap[1]!.group).toBe(b.recap[0]!.group);
  });
});

const struct = (over: Partial<BriefingStruct>): BriefingStruct => ({
  date: "2026-08-25", machineScope: "t", provider: "claude",
  resume: [], recap: [], suggestions: [], ...over,
} as BriefingStruct);

describe("render — group-aware nesting", () => {
  test("first group entry emits a story line, members nest with ◦; ungrouped entries stay flat; every entry renders exactly once", () => {
    const g = "core/ledger.py — 2 commits (Aug 18–19)";
    const text = renderBriefing(struct({
      recap: [
        { repo: "app", text: "one", evidence: "aaaa111", group: g },
        { repo: "app", text: "flat", evidence: "cccc333" },
        { repo: "app", text: "two", evidence: "bbbb222", group: g },   // non-adjacent member
      ],
    }));
    const lines = text.split("\n");
    const story = lines.findIndex((l) => l.includes(g) && l.includes("•"));
    expect(story).toBeGreaterThan(-1);
    // both members nested DIRECTLY under the story line, hoisted above the flat entry
    expect(lines[story + 1]).toBe("      ◦ [app] one  (aaaa111)");
    expect(lines[story + 2]).toBe("      ◦ [app] two  (bbbb222)");
    expect(lines[story + 3]).toBe("   • [app] flat  (cccc333)");
    // exactly once each
    for (const sha of ["aaaa111", "bbbb222", "cccc333"]) {
      expect(lines.filter((l) => l.includes(sha)).length).toBe(1);
    }
  });

  test("an ungrouped struct renders the exact flat bullet shape (pre-T1.3), plus the count header", () => {
    const text = renderBriefing(struct({
      recap: [
        { repo: "app", text: "one", evidence: "aaaa111" },
        { repo: "app", text: "two", evidence: "bbbb222" },
      ],
    }));
    const lines = text.split("\n");
    expect(lines).toContain("▶ What you did — 2 commits");
    expect(lines).toContain("   • [app] one  (aaaa111)");
    expect(lines).toContain("   • [app] two  (bbbb222)");
    expect(text).not.toContain("◦");
  });

  test("singular count header; empty recap keeps the plain header and placeholder", () => {
    expect(renderBriefing(struct({ recap: [{ repo: "a", text: "x" }] }))).toContain("▶ What you did — 1 commit\n");
    const empty = renderBriefing(struct({}));
    expect(empty).toContain("▶ What you did\n");
    expect(empty).toContain("(no commits in the window)");
  });

  test("windowMerges foot is label-grouped (stable sort), preserving in-label order", () => {
    const text = renderBriefing(struct({
      windowMerges: [
        { repo: "zeta", text: "🔀 Merged #2 (b) (Aug 19)  (bbbb222)" },
        { repo: "alpha", text: "🔀 Merged #1 (a) (Aug 18)  (aaaa111)" },
        { repo: "zeta", text: "🔀 Merged #3 (c) (Aug 20)  (cccc333)" },
      ],
    }));
    const idx = (n: string) => text.indexOf(n);
    expect(idx("#1")).toBeLessThan(idx("#2"));
    expect(idx("#2")).toBeLessThan(idx("#3"));   // stable within zeta
  });
});

describe("audit invariance — the constraint-2 pin", () => {
  const g = "f.ts — 2 commits (Aug 18)";
  const flat = struct({
    recap: [
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
      { repo: "other", text: "three", evidence: "cccc333" },
    ],
  });
  const clustered = struct({
    recap: [
      { repo: "app", text: "one", evidence: "aaaa111", group: g },
      { repo: "app", text: "two", evidence: "bbbb222", group: g },
      { repo: "other", text: "three", evidence: "cccc333" },
    ],
  });

  test("extractCitedShas, missingSameDay and coverageGaps are identical on clustered vs flat renders", () => {
    const a = renderBriefing(flat), b = renderBriefing(clustered);
    expect(new Set(extractCitedShas(b))).toEqual(new Set(extractCitedShas(a)));
    const day = ["aaaa111", "bbbb222", "cccc333", "dddd444"];
    expect(missingSameDay(day, b)).toEqual(missingSameDay(day, a));
    const repos = [{ repo: "/r", labels: ["app", "other"], commits: 3 }];
    expect(coverageGaps(repos as never, b)).toEqual(coverageGaps(repos as never, a));
  });
});

describe("unitForFiles — the extracted plurality vote", () => {
  test("unique plurality wins; even tie returns null (catch-all); empty returns null", () => {
    expect(unitForFiles(["sub/a.ts", "sub/b.ts", "other/c.ts"], ["sub", "other"])).toBe("sub");
    expect(unitForFiles(["sub/a.ts", "other/c.ts"], ["sub", "other"])).toBe(null);
    expect(unitForFiles([], ["sub"])).toBe(null);
  });

  test("unitForCommit still delegates (behaviour-preserving extraction)", () => {
    const a = commit("aaaa111", "/r", [{ file: "sub/a.ts", added: 1, removed: 0 }, { file: "sub/b.ts", added: 1, removed: 0 }, { file: "x.ts", added: 1, removed: 0 }], d18);
    expect(unitForCommit(a, ["sub"])).toBe("sub");
  });
});

describe("listPrMerges — first-parent files", () => {
  test("a PR merge carries the branch's files (first-parent numstat)", async () => {
    const day = (h: number) => new Date(2026, 6, 6, h, 0).toISOString();
    const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: day(9) }]);
    await branchCommit(repo, "feat-cool", "sub/f.txt", day(10));
    await mergeBranchWith(repo, "feat-cool", "Merge pull request #42 from acme/feat/cool-thing", day(11));
    const merges = await listPrMerges(repo, localMidnight(new Date(2026, 6, 6)), localMidnight(new Date(2026, 6, 7)), { emails: ["test@example.com"] });
    expect(merges.length).toBe(1);
    expect(merges[0]!.files).toEqual(["sub/f.txt"]);
  });
});

describe("merge attribution — runCore integration", () => {
  test("a PR merge whose files sit under a configured sub-project root carries that unit's label in Today-so-far AND the window foot", async () => {
    const yesterday = () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 1); return d.toISOString(); };
    const today = () => { const d = new Date(); d.setHours(8, 0, 0, 0); return d.toISOString(); };
    const dir = await buildRepo([{ file: "sub/w.ts", content: "x", isoDate: yesterday() }]);
    // yesterday's in-window PR merge → windowMerges; today's → Today-so-far. Both under sub/.
    await branchCommit(dir, "feat-a", "sub/a.txt", yesterday());
    await mergeBranchWith(dir, "feat-a", "Merge pull request #7 from o/feat/a", new Date(Date.parse(yesterday()) + 3600e3).toISOString());
    await branchCommit(dir, "feat-b", "sub/b.txt", today());
    await mergeBranchWith(dir, "feat-b", "Merge pull request #8 from o/feat/b", new Date(Date.parse(today()) + 3600e3).toISOString());
    const cfg: Config = {
      repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30,
      provider: { cli: "echo", argv: [], promptVia: "stdin" },
      subprojects: [{ repo: dir, roots: ["sub"] }],
    };
    const stub: Provider = { generate: async () => "## RESUME\n- [x] r\n## RECAP\n- [x] c | evidence: HEAD\n## SUGGESTIONS\n- n" };
    const r = await runCore(cfg, { provider: stub, netProbe: async () => true });
    const subUnit = r.units.find((u) => u.root === "sub");
    expect(subUnit).toBeDefined();
    const todayMerge = (r.struct.today ?? []).find((t) => t.text.includes("Merged #8"));
    expect(todayMerge).toBeDefined();
    expect(todayMerge!.repo).toBe(subUnit!.label);           // NOT the bare repo label
    const windowMerge = (r.struct.windowMerges ?? []).find((m) => m.text.includes("Merged #7"));
    expect(windowMerge).toBeDefined();
    expect(windowMerge!.repo).toBe(subUnit!.label);
  });
});

// ── Fix-round pins (review MED-2 / MED-3 / M5 / MED-1) ───────────────────────────────────────────
describe("fix-round pins", () => {
  // MED-2: a decorated member inside a cluster must still render (the nest predicate is norm-based;
  // mutant `m.repo === r.repo` silently LOST the decorated bullet — worst failure class).
  test("render: a cluster mixing decorated and bare labels emits every member exactly once", () => {
    const g = "f.ts — 2 commits (Aug 18)";
    const text = renderBriefing(struct({
      recap: [
        { repo: "app", text: "bare", evidence: "aaaa111", group: g },
        { repo: "**app**", text: "decorated", evidence: "bbbb222", group: g },
      ],
    }));
    const lines = text.split("\n");
    expect(lines.filter((l) => l.includes("aaaa111")).length).toBe(1);
    expect(lines.filter((l) => l.includes("bbbb222")).length).toBe(1);   // the mutant drops this one
    expect(lines.filter((l) => l.includes(g)).length).toBe(1);           // one story line, not two
  });

  // MED-3: the todaySuppress mergeLabel site — reverting it to repoLabelFor survived the suite.
  // Pinned through runCore's returned todaySuppress (the DONE-block/freshness join keys on label).
  test("runCore: todaySuppress labels a today PR merge by unit, not bare repo", async () => {
    const today = () => { const d = new Date(); d.setHours(8, 0, 0, 0); return d.toISOString(); };
    const yesterday = () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 1); return d.toISOString(); };
    const dir = await buildRepo([{ file: "sub/w.ts", content: "x", isoDate: yesterday() }]);
    await branchCommit(dir, "feat-c", "sub/c.txt", today());
    await mergeBranchWith(dir, "feat-c", "Merge pull request #9 from o/feat/c", new Date(Date.parse(today()) + 3600e3).toISOString());
    const cfg: Config = {
      repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30,
      provider: { cli: "echo", argv: [], promptVia: "stdin" },
      subprojects: [{ repo: dir, roots: ["sub"] }],
    };
    const stub: Provider = { generate: async () => "## RESUME\n- [x] r\n## RECAP\n- [x] c | evidence: HEAD\n## SUGGESTIONS\n- n" };
    const r = await runCore(cfg, { provider: stub, netProbe: async () => true });
    const subUnit = r.units.find((u) => u.root === "sub");
    expect(subUnit).toBeDefined();
    const suppress = (r.todaySuppress ?? []).find((d) => d.subject.includes("Merged #9"));
    expect(suppress).toBeDefined();
    expect(suppress!.label).toBe(subUnit!.label);
  });

  // M5: the --diff-merges fallback path had zero coverage. A shimmed git that rejects the flag must
  // yield file-less merges (fail open), not a thrown briefing. Bun.spawn does NOT re-resolve
  // executables from a mutated process.env.PATH (probed), so the shim must apply at CHILD-process
  // level: run listPrMerges in a `bun -e` child whose PATH leads with the shim dir.
  test("listPrMerges falls open to file-less merges when git rejects --diff-merges", async () => {
    const day = (h: number) => new Date(2026, 6, 6, h, 0).toISOString();
    const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: day(9) }]);
    await branchCommit(repo, "feat-old", "f.txt", day(10));
    await mergeBranchWith(repo, "feat-old", "Merge pull request #5 from o/feat/old", day(11));
    const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path");
    const shimDir = mkdtempSync(join(tmpdir(), "git-shim-"));
    const realGit = (await Bun.$`which git`.text()).trim();
    writeFileSync(join(shimDir, "git"), `#!/bin/sh
for a in "$@"; do case "$a" in --diff-merges=*) echo "error: unknown option" >&2; exit 129;; esac; done
exec "${realGit}" "$@"
`);
    chmodSync(join(shimDir, "git"), 0o755);
    const gitTs = resolve(import.meta.dir, "../src/git.ts");
    const script = `
      const { listPrMerges } = await import(${JSON.stringify(gitTs)});
      const { localMidnight } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/time.ts"))});
      const merges = await listPrMerges(${JSON.stringify(repo)}, localMidnight(new Date(2026, 6, 6)), localMidnight(new Date(2026, 6, 7)), { emails: ["test@example.com"] });
      console.log(JSON.stringify(merges.map((m) => ({ prNum: m.prNum, files: m.files }))));
    `;
    const p = Bun.spawn(["bun", "-e", script], {
      cwd: import.meta.dir,
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
      stdout: "pipe", stderr: "pipe",
    });
    await p.exited;
    const out = (await new Response(p.stdout).text()).trim();
    expect(p.exitCode).toBe(0);
    expect(JSON.parse(out)).toEqual([{ prNum: "5", files: [] }]);
  });

  // MED-1: non-ASCII path survives listPrMerges' numstat (quotePath parity with listCommits).
  test("listPrMerges returns non-ASCII merge files raw, not octal-escaped", async () => {
    const day = (h: number) => new Date(2026, 6, 6, h, 0).toISOString();
    const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: day(9) }]);
    await branchCommit(repo, "feat-uni", "café/f.txt", day(10));
    await mergeBranchWith(repo, "feat-uni", "Merge pull request #6 from o/feat/uni", day(11));
    const merges = await listPrMerges(repo, localMidnight(new Date(2026, 6, 6)), localMidnight(new Date(2026, 6, 7)), { emails: ["test@example.com"] });
    expect(merges[0]!.files).toEqual(["café/f.txt"]);
  });

  // LOW-2: duplicate citations of one commit must not inflate the story count.
  test("clusterRecap counts distinct commits, not member bullets", () => {
    const ctx = ctxOf([
      commit("aaaa111", "/r", [{ file: "f.ts", added: 1, removed: 0 }], d18),
      commit("bbbb222", "/r", [{ file: "f.ts", added: 1, removed: 0 }], d18),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "one again", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
    ], ctx);
    expect(out[0]!.group).toBe("f.ts — 2 commits (Aug 18)");   // 3 bullets, 2 commits
  });
});
