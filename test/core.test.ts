import { test, expect } from "bun:test";
import { runCore } from "../src/core";
import { buildRepo, branchCommit, mergeBranchWith } from "./fixtures/build-repo";
import type { Config } from "../src/types";

const yesterdayNoon = () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 1); return d.toISOString(); };
const todayNoon = () => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.toISOString(); };
const stub = { generate: async () => "## RESUME\n- [x] resume\n## RECAP\n- [x] did it | evidence: HEADSHA\n## SUGGESTIONS\n- next" };
// mkCfg: a minimal valid Config for a synthetic repo (Config shape at types.ts:58-68).
const mkCfg = (repos: string[]): Config => ({
  repos, excludeCommitPatterns: [], lookbackCapDays: 30,
  provider: { cli: "echo", argv: [], promptVia: "stdin" },
});

// Real merge-commit fixture (mirrors test/extractor.test.ts:188's real-merge case) for a TODAY PR-merge.
// HELPER CONTRACT: dates the branch + merge commits at `Date.parse(isoAfter) + 3_600_000` — strictly ≥1s
// later than `isoAfter` (git dates are second-granular; a same-second tie would sink the merge line below
// a commit dated at `isoAfter` under the stable sort) — while staying inside today.
async function makeTodayPrMerge(dir: string, opts: { prNum: string; branch: string; isoAfter: string }): Promise<void> {
  const isoDate = new Date(Date.parse(opts.isoAfter) + 3_600_000).toISOString();
  await branchCommit(dir, opts.branch, `${opts.branch}.txt`, isoDate);
  await mergeBranchWith(dir, opts.branch, `Merge pull request #${opts.prNum} from acme/${opts.branch}`, isoDate);
}

test("runCore returns struct/rawText/promptText/ctx/units/runDate for a normal day", async () => {
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const cfg = mkCfg([dir]);
  const r = await runCore(cfg, { provider: stub, netProbe: async () => true });
  expect(r.emptyWindow).toBe(false); expect(r.blocked).toBe(false);
  expect(r.promptText).toContain("UNIT");         // proves the REAL prompt was built and passed to the provider
  expect(r.rawText).toContain("## RECAP");
  expect(typeof r.runDate).toBe("string");
});

test("runCore threads cfg.provider.timeoutMs into the REAL provider — a short config timeout times out [Tier-3 #8]", async () => {
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const cfg: Config = { repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30,
    provider: { cli: "sleep", argv: ["5"], promptVia: "stdin", timeoutMs: 100 } }; // 5s sleep, 100ms config timeout
  // NO deps.provider → the real hardenedProvider(cfg.provider, { timeoutMs }) is used. With the wiring it times
  // out at ~100ms (ProviderError "timeout"); reverting core.ts's pass-through → 120s default → sleep finishes
  // with empty stdout → "empty-output" instead. Pins the config→provider timeout thread.
  await expect(runCore(cfg, { netProbe: async () => true, retryDelaysMs: [], sleep: async () => {} }))
    .rejects.toMatchObject({ code: "timeout" });
});

test("runCore: today commits + a today PR-merge become an ALREADY-DONE-TODAY block (SHA-free, merge sorted by its real date)", async () => {
  // Window commit (yesterday) so body is non-empty; a today commit; a today PR-merge dated STRICTLY AFTER the
  // today commit. NOTE: buildRepo hard-codes the subject `add <file>` (test/fixtures/build-repo.ts) — it has NO
  // `message` field — so assert on "add t.ts", not a custom string. Create the today PR-merge with the SAME
  // real-merge mechanism the extractor test uses at test/extractor.test.ts:188 (a "Merge pull request #77
  // from acme/feat/y" 2-parent commit via branchCommit + mergeBranchWith, build-repo.ts:63/78) — factored
  // into the local `makeTodayPrMerge(dir, { prNum, branch, isoAfter })` helper above. HELPER CONTRACT: it
  // dates the branch + merge commits at `Date.parse(isoAfter) + 3_600_000` (i.e. STRICTLY LATER, ≥1s — git
  // dates are second-granular, so dating the merge AT `isoAfter` ties `add t.ts`'s whenMs and, with the
  // stable sort + commits-pushed-before-merges, sinks the merge line BELOW `add t.ts` → the ordering
  // assertion below false-fails on the CORRECT implementation). Keep the +1h inside today (before
  // tomorrow-midnight).
  const dir = await buildRepo([
    { file: "w.ts", content: "x", isoDate: yesterdayNoon() }, // window → body non-empty
    { file: "t.ts", content: "y", isoDate: todayNoon() },     // today commit, subject "add t.ts"
  ]);
  await makeTodayPrMerge(dir, { prNum: "77", branch: "feat/y", isoAfter: todayNoon() }); // helper dates it +1h → strictly newer
  let captured = "";
  const stub = { generate: async (p: string) => { captured = p; return "## RESUME\n- x\n## RECAP\n- did | evidence: HEAD\n## SUGGESTIONS\n- next"; } };
  await runCore(mkCfg([dir]), { provider: stub, netProbe: async () => true });
  expect(captured).toContain("ALREADY DONE TODAY (context only");
  expect(captured).toContain("add t.ts");                 // today commit subject present
  expect(captured).toContain("Merged #77 (feat/y)");      // today PR-merge present (rev-5 §1 merged-row fix)
  expect(captured).not.toMatch(/DONE \[[^\]]+\]: add t\.ts \([0-9a-f]{7}\)/); // no SHA appended
  // The merge is newer than the today commit → its DONE line must sort FIRST. A `whenMs: 0` merge (i.e.
  // NOT using Date.parse(m.timestamp)) would sort LAST — so this ordering assertion pins the §1 merged-date fix:
  expect(captured.indexOf("Merged #77 (feat/y)")).toBeLessThan(captured.indexOf("add t.ts"));
});

test("runCore: rendered today PR-merge line credits the merge SHA; prompt suppress-context stays SHA-free [pre-spec B2a]", async () => {
  // The audit's day-13/23 "unverifiable Merged #NNN" gap: m.sha is carried through MergedToday but
  // dropped at render. The rendered `today` line (struct.today) must carry a 7-hex SHA like the commit
  // lines do — while the prompt's suppress subject (core.ts:141) stays SHA-free by design (a mutation
  // appending the SHA there must fail this test).
  const dir = await buildRepo([{ file: "w.ts", content: "x", isoDate: yesterdayNoon() }]);
  await makeTodayPrMerge(dir, { prNum: "77", branch: "feat/y", isoAfter: todayNoon() });
  let prompt = "";
  const cap = { generate: async (p: string) => { prompt = p; return "## RESUME\n- x\n## RECAP\n- did | evidence: HEAD\n## SUGGESTIONS\n- next"; } };
  const r = await runCore(mkCfg([dir]), { provider: cap, netProbe: async () => true });
  const merged = (r.struct.today ?? []).find((t) => t.text.includes("Merged #77"));
  expect(merged).toBeTruthy();
  expect(merged!.text).toMatch(/🔀 Merged #77 \(feat\/y\) \([0-9a-f]{7}\)/);   // rendered line: SHA credited
  expect(prompt).toContain("Merged #77 (feat/y)");                             // suppress subject present…
  expect(prompt).not.toMatch(/Merged #77 \(feat\/y\) \([0-9a-f]{7}\)/);        // …but SHA-free in the prompt
});
