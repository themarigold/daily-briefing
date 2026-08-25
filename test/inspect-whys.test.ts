// Slice 1.5 T6.1 — the A3 tool writes NOTHING, anywhere.
//
// ⚠ Verified by snapshotting cwd, TMPDIR and supportDir() around a REAL CLI invocation via
// Bun.spawn — deliberately NOT an in-process spy. A spy records zero calls whatever the child
// writes, and a `Bun.write`/`fs` blacklist misses `Bun.file().writer()`, `Bun.$` and grandchildren.
// The tool's stdout is the only persistence surface 1.5a has (§3.4 sink 7); it must not create a
// second one.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInspectOptions, formatReport, summarizeOverlap, type Candidate } from "../scripts/inspect-whys";
import { textSha } from "../src/transcripts/anchor";

/** Every file under `dir`, with its size and mtime — enough to catch a new OR modified file. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      const p = join(d, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else out.set(p, `${st.size}:${st.mtimeMs}`);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const diff = (before: Map<string, string>, after: Map<string, string>) =>
  [...after].filter(([p, v]) => before.get(p) !== v).map(([p]) => p);

test("T6.1: a real CLI invocation creates and modifies NO file in cwd, TMPDIR or the state dir", async () => {
  const base = mkdtempSync(join(tmpdir(), "dba-a3-"));
  const cfgDir = join(base, "cfg", "daily-briefing");
  const state = join(base, "state");
  const tx = join(base, "transcripts");
  const cwd = join(base, "cwd");
  const tmp = join(base, "tmp");
  for (const d of [cfgDir, state, tx, cwd, tmp]) mkdirSync(d, { recursive: true });

  // A repo the tool can resolve, so it runs its real path rather than bailing early.
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify({
    repos: [repo], excludeCommitPatterns: [], lookbackCapDays: 30,
    transcripts: { enabled: true, root: tx },
    provider: { cli: "echo", argv: [], promptVia: "stdin" },
  }));

  const before = [cwd, tmp, state].map(snapshot);
  const proc = Bun.spawn(["bun", "run", "scripts/inspect-whys.ts", "--days=1"], {
    cwd: process.cwd(),
    env: { ...process.env, XDG_CONFIG_HOME: join(base, "cfg"), DAILY_BRIEFING_STATE_DIR: state, TMPDIR: tmp, HOME: base },
    stdout: "pipe", stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const after = [cwd, tmp, state].map(snapshot);

  for (let i = 0; i < before.length; i++) expect(diff(before[i]!, after[i]!)).toEqual([]);
  expect(out).toContain("A3 retrospective replay");   // it really ran, so the zero above is meaningful
});

test("T6.1: option parsing takes days/limit and falls back on garbage", () => {
  expect(parseInspectOptions(["--days=7", "--limit=3"], "/r")).toMatchObject({ days: 7, limit: 3, root: "/r" });
  expect(parseInspectOptions([], "/r")).toMatchObject({ days: 49, limit: 0 });
  for (const bad of ["--days=0", "--days=-4", "--days=abc"]) expect(parseInspectOptions([bad], "/r").days).toBe(49);
});

// ⚠ T6.3 — invariant 5 on PATH 2. The check lives in `formatReport` itself, not only here, so a
// replay that would print a mutated quotation fails loudly rather than feeding a corrupted sample
// into GATE-R3 — the one place a silent corruption would change a product decision.
test("T6.3: formatReport refuses to print a quotation that is not byte-equal to its anchor", () => {
  const good: Candidate = {
    unitKey: "r\x00a", label: "a", localDay: "2026-07-30",
    quotation: "I moved the join behind a policy\n", textSha: textSha("I moved the join behind a policy\n"),
    sessionId: "s1", segmentPaths: ["a/x.ts"], commitSubjects: ["feat: thing"], fileCount: 1, questionShaped: false,
  };
  expect(formatReport({ candidates: [good], unitsEligible: 1, days: 49 })).toContain("you wrote:");

  const tampered: Candidate = { ...good, quotation: good.quotation.trim() };   // a TRIM is enough
  expect(() => formatReport({ candidates: [tampered], unitsEligible: 1, days: 49 }))
    .toThrow(/invariant 5/);
});

test("T6.3: the report shows the quotation AND the unit-day's commit subjects side by side", () => {
  // R3's question is comparative — "does the quotation add information the SUBJECTS lack" — so a
  // report showing only one side cannot be judged at all.
  const c: Candidate = {
    unitKey: "r\x00a", label: "alpha", localDay: "2026-07-30",
    quotation: "switching to a membership test", textSha: textSha("switching to a membership test"),
    sessionId: "abcdef123456", segmentPaths: ["a/x.ts"], commitSubjects: ["feat: bucketer", "fix: labels"],
    fileCount: 7, questionShaped: true,
  };
  const r = formatReport({ candidates: [c], unitsEligible: 1, days: 49, daysReplayed: 40 });
  expect(r).toContain("switching to a membership test");
  expect(r).toContain("feat: bucketer");
  expect(r).toContain("fix: labels");
  expect(r).toContain("7 files");
  expect(r).toContain("question-shaped");
  expect(r).toContain("alpha");
});


test("A9 summarizeOverlap: equal sets → all both", () => {
  const s = new Set(["d1\x00u1", "d1\x00u2"]);
  const o = summarizeOverlap(s, s);
  expect(o).toEqual({ both: 2, curve1Only: 0, curve2Only: 0, curve1: 2, curve2: 2 });
});

test("A9 summarizeOverlap: disjoint → no both", () => {
  const o = summarizeOverlap(new Set(["a"]), new Set(["b"]));
  expect(o).toEqual({ both: 0, curve1Only: 1, curve2Only: 1, curve1: 1, curve2: 1 });
});

test("A9 summarizeOverlap: partial + same unit two days count twice", () => {
  const cons = new Set(["2026-08-01\x00u", "2026-08-02\x00u", "2026-08-01\x00v"]);
  const strict = new Set(["2026-08-01\x00u", "2026-08-03\x00u"]);
  const o = summarizeOverlap(cons, strict);
  expect(o.both).toBe(1);
  expect(o.curve1Only).toBe(2);
  expect(o.curve2Only).toBe(1);
  expect(o.curve1).toBe(3);
  expect(o.curve2).toBe(2);
});
