// Slice 1.5 T0.2 — `excludeCommitPatterns` commits are RETAINED (tagged `meta.excluded`) instead of
// dropped at the git layer, so a bot commit can still vote for a sub-project root and mark window
// content. Every consumer downstream must ignore it. These pins are written to go RED if the
// retention leaks into a consumer it must not reach — each one discriminates, none is trivially true.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveUnits, rankUnits } from "../src/subprojects";
import { orderResumeByRank } from "../src/generator";
import { runCore } from "../src/core";
import { buildRepo } from "./fixtures/build-repo";
import type { Activity, Config, BriefingStruct } from "../src/types";

// `ResumeLine` is a private alias in generator.ts — derive it the same way rather than widening its API.
type ResumeLine = BriefingStruct["resume"][number];

const CFG: Config = { provider: { cli: "c", argv: [], promptVia: "stdin" } };
const commit = (repo: string, id: string, iso: string, file: string, excluded?: true): Activity => ({
  source: "git", kind: "commit", event_id: id, repo, timestamp: iso, text: `c ${id}`,
  meta: { diffstat: [{ file, added: 1, removed: 0 }], ...(excluded ? { excluded: true } : {}) },
});

// ── PIN 1 — an excluded commit must never reach `latestCommitTime`, the sole recency key in
// `rankUnits`. Both units carry EQUAL `hasResumptionState` (a one-unit or unequal-tier fixture would
// be order-stable for the wrong reason), and the excluded commit is the NEWEST thing in the repo —
// so admitting it into `u.commits` flips alpha ahead of beta, in rankUnits AND in the RESUME order.
test("T0.2: an excluded commit does not enter u.commits, so it cannot re-rank a unit", async () => {
  const repo = mkdtempSync(join(tmpdir(), "dba-t02-rank-"));
  for (const d of ["alpha", "beta"]) mkdirSync(join(repo, d), { recursive: true });
  const cfg: Config = { ...CFG, subprojects: [{ repo, roots: ["alpha", "beta"] }] };

  const acts: Activity[] = [
    commit(repo, "a1", "2026-07-06T09:00:00.000Z", "alpha/a.ts"),
    commit(repo, "b1", "2026-07-06T10:00:00.000Z", "beta/b.ts"),
    commit(repo, "bot", "2026-07-06T11:00:00.000Z", "alpha/a.ts", true), // newest overall, alpha's root
    // both units dirty → EQUAL hasResumptionState, so latestCommitTime is what decides the order
    { source: "git", kind: "uncommitted", event_id: "u", repo,
      meta: { uncommittedFiles: ["alpha/a.ts", "beta/b.ts"] } },
  ];
  const { units } = await resolveUnits(acts, [], [repo], cfg);
  const alpha = units.find((u) => u.root === "alpha")!;
  const beta = units.find((u) => u.root === "beta")!;
  expect(alpha.hasResumptionState).toBe(beta.hasResumptionState); // the tie the pin depends on
  expect(alpha.latestCommitTime).toBe("2026-07-06T09:00:00.000Z"); // NOT the 11:00 bot commit
  expect(beta.latestCommitTime).toBe("2026-07-06T10:00:00.000Z");

  const ranked = rankUnits(units);
  expect(ranked.map((u) => u.label)).toEqual(["beta", "alpha"]); // flips to alpha-first if the bot commit lands in commits
  const resume: ResumeLine[] = [{ repo: "alpha", text: "resume alpha" }, { repo: "beta", text: "resume beta" }];
  expect(orderResumeByRank(resume, ranked).map((r) => r.repo)).toEqual(["beta", "alpha"]);

  // …but it DID vote: the bot commit's root is alpha, and it marks alpha as having window content.
  expect(alpha.hasWindowContent).toBe(true);
});

// ── PIN 2 — an excluded-only unit is not active, so it never reaches `survivors` and therefore never
// reaches `labelUnits`. Both roots are named "core" IN THE SAME REPO: labelUnits counts basename
// collisions over the SURVIVOR set, so if the excluded-only unit were admitted the count would hit 2
// and tier-2 would qualify BOTH labels to "<repo>/core". (Deliberately same-repo: the catch-all label
// comes from `repoLabelFor(repo, repos)`, which qualifies against the full REPO list and so would not
// discriminate this behaviour at all.)
test("T0.2: an excluded-only unit never reaches labelUnits, so it cannot qualify a sibling's label", async () => {
  const repo = mkdtempSync(join(tmpdir(), "dba-t02-label-"));
  for (const d of ["alpha/core", "beta/core"]) mkdirSync(join(repo, d), { recursive: true });
  const cfg: Config = { ...CFG, subprojects: [{ repo, roots: ["alpha/core", "beta/core"] }] };

  const acts: Activity[] = [
    commit(repo, "r1", "2026-07-06T09:00:00.000Z", "alpha/core/a.ts"),
    commit(repo, "bot", "2026-07-06T10:00:00.000Z", "beta/core/b.ts", true),
  ];
  const { units } = await resolveUnits(acts, [], [repo], cfg);
  expect(units.map((u) => u.root)).toEqual(["alpha/core"]); // the excluded-only root produced NO unit
  expect(units[0]!.label).toBe("core");                     // unqualified — a phantom sibling forces "<repo>/core"
});

// ── PIN 3 — the retained commit must leave NO trace in the reduced context or the prompt: `reduce`
// (and so `knownShas`, `bucketActivities`, `buildPrompt`) is fed the filtered list. Asserted
// differentially against the identical run with no exclude pattern, so the pin fails both if the
// filter is removed AND if the fixture ever stops producing a real commit.
//
// NOTE — this is deliberately NOT the plan's stated "bot-only day ⇒ emptyWindow: true" receipt. That
// receipt is unachievable: git.ts:464 emits a `branch` activity for ANY repo with a branch name, so
// `activities` is never empty for a scanned repo — the assertion was equally false BEFORE T0.2 and
// pins nothing. Plan defect, recorded rather than silently satisfied.
test("T0.2: a retained excluded commit reaches neither the reduced ctx nor the prompt", async () => {
  const iso = () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 1); return d.toISOString(); };
  const dir = await buildRepo([{ file: "vault.txt", content: "v", isoDate: iso() }]);
  const provider = { generate: async () => "## RESUME\n- [x] r\n## RECAP\n- [x] d\n## SUGGESTIONS\n- n" };
  const base: Config = { repos: [dir], excludeCommitPatterns: ["^add vault\\.txt$"], lookbackCapDays: 30,
    provider: { cli: "echo", argv: [], promptVia: "stdin" } };

  const excl = await runCore(base, { provider, netProbe: async () => true });
  const ctxCommits = (c: typeof excl.ctx) => c.repos.flatMap((r) => r.activities.filter((a) => a.kind === "commit"));
  expect(ctxCommits(excl.ctx)).toEqual([]);                    // no commit survived into the reduced ctx
  expect(excl.promptText ?? "").not.toContain("add vault.txt");

  // Control: identical run, no exclude pattern — the SAME commit DOES reach both sinks.
  const kept = await runCore({ ...base, excludeCommitPatterns: [] }, { provider, netProbe: async () => true }, true);
  expect(ctxCommits(kept.ctx).length).toBe(1);
  expect(kept.promptText ?? "").toContain("add vault.txt");
});
