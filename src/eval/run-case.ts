// src/eval/run-case.ts — runCase(): the eval harness that wires the whole pipeline together and
// scores a gold case. Builds a synthetic repo (buildEvalRepo), runs the REAL pipeline (runCore) on
// it with an injected Provider, applies an optional post-pipeline `mutate` hook (fault injection),
// and scores the result with the CHECKS array (G1-G7 as of 2026-08-11 — the count is deliberately
// not restated here: it was written as "four" and was stale by three rules within the week). Bidirectional integrity between the synthetic repo's
// ground truth and what the pipeline actually windowed is asserted with a thrown Error — a
// mis-authored gold case is a bug in the case, not a Finding about the product.
import { buildEvalRepo } from "../../test/fixtures/eval-repo";
import { runCore } from "../core";
import { run, type RunResult } from "../proc";
import { INFRA_DENYLIST } from "../subprojects";
import { CHECKS } from "./checks";
import type { Config, Provider, BriefingStruct } from "../types";
import type { GoldCase, Finding, CheckInput } from "./types";
import type { DoneItem } from "../types";

/** F3 — the fourth and last hand-rolled child-process read in the codebase, converged onto `run()`.
 *
 *  The last one on any path C1 bounds — `config.ts`'s `resolveCliPath` keeps the same shape and is
 *  deliberately unconverged (its own comment cites C1 rev 3.4), so "the last in the codebase" would
 *  be wrong. It had the same shape the other three had: `await new Response(p.stdout).text()` BEFORE
 *  `p.exited`, with no flush race. `.text()` resolves only at EOF, so a grandchild holding the
 *  inherited pipe hangs it forever. Unreachable in practice on the tiny synthetic fixture repos this
 *  harness builds — except under a global `core.fsmonitor` — which is why it was filed as hygiene
 *  rather than a bug. `run()` bounds it with DEFAULT_TIMEOUT_MS (30s) and DEFAULT_FLUSH_MS (500ms).
 *
 *  ⚠ THE `code` GATE IS LOAD-BEARING, not defensive. Before, `.text()` awaited EOF, so this could
 *  HANG but never truncate. `run()` races a flush window, so a partial read is now possible — and a
 *  short `rev-list --all` would silently shrink `gitShaSet`, making correctly-cited SHAs look
 *  FABRICATED and producing a false `fail` row. `proc.ts` forces `code = -1` on an incomplete stdout,
 *  so gating on `code !== 0` converts that into a throw. Hang becomes throw; truncation is
 *  unreachable. Never relax this gate to `!r.complete` or to a stderr check.
 *
 *  ⚠ `code === -1` is NOT iff-incomplete: `proc.ts`'s outer catch returns it for a spawn failure too
 *  (measured: `run(["definitely-not-a-real-binary-xyz"])` -> `{code:-1, spawned:false}`). Hence the
 *  `spawned` arm first — reporting a missing `git` as "incomplete read" is exactly the conflation
 *  `git.ts` and `proc.ts` are documented to prevent.
 *
 *  Exported for tests only — see test/eval/run-case.gitlines.test.ts. Its in-module callers are the
 *  two below; nothing outside this module should use it. */
export async function gitLines(args: string[], cwd: string): Promise<string[]> {
  const r = await run(["git", "-C", cwd, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${gitFailureReason(r)}`);
  return r.out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Classify a failed `RunResult` into one operator-facing cause. Extracted from `gitLines` so each
 *  arm — and their ORDER — can be pinned directly: driving them through a spawn fake is impossible,
 *  because `gitLines` hardcodes `run()`'s defaults and a fake cannot reach Bun's `timeout`. Three
 *  arms shipped unpinned before this extraction (checkpoint review measured deleting the `timedOut`
 *  arm, swapping it with the `-1` arm, and deleting the `signal` arm as all leaving the suite green).
 *
 *  ⚠ THE ORDER IS LOAD-BEARING, and my first explanation of why was FALSE — corrected here because
 *  it argued against its own conclusion. It claimed a timeout always returns `code: 1, complete:
 *  true` and never `-1`; if that were so, the `timedOut` and `-1` arms would be mutually exclusive
 *  and their order would not matter at all. Measured, BOTH shapes occur:
 *      run(["sh","-c","echo x; exec sleep 5"], {timeoutMs:200}) -> {code:1,  complete:true,  timedOut:true}
 *      run(["sh","-c","echo x; sleep 5"],      {timeoutMs:200}) -> {code:-1, complete:false, timedOut:true}
 *  The second is a FORKED child holding the pipe past our kill — i.e. the wedged-git-hook case this
 *  whole convergence is about. So `timedOut` must precede the `-1` arm, or the 30s ceiling gets
 *  misreported as an incomplete read and the operator is told to re-run a job that will be killed
 *  again at the same limit (`proc.ts` keeps `timedOut` for exactly this).
 *
 *  Exported for tests only. */
export function gitFailureReason(r: RunResult): string {
  return !r.spawned      ? `could not run git (${r.err})`
       : r.timedOut      ? `timed out (${r.signal ?? "killed"})`
       : r.code === -1   ? `incomplete read (${r.err || "no stderr"})`
       : r.signal        ? `killed (signal ${r.signal})`
       :                   (r.err || `exit ${r.code}`);
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1]!;
}


/** T8.6 — synthesise a transcript corpus for a gold case, against the eval repo's REAL absolute
 *  paths so `unitKeyForAbsolutePath` can bucket them and the join actually runs.
 *
 *  ⚠ Timing is what makes the case non-vacuous. §3.2's membership rule takes the nearest qualifying
 *  turn AT OR BEFORE the segment's first edit, so a turn dated after its own edit yields NO why and
 *  the case would pass while proving nothing. Each turn is therefore placed strictly before the
 *  edit it explains. */
async function buildEvalTranscripts(
  repoDir: string, spec: NonNullable<GoldCase["transcripts"]>,
): Promise<string> {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "dba-eval-tx-"));
  const proj = join(root, "-eval-proj");
  mkdirSync(proj, { recursive: true });

  const now = Date.now();
  const lines: Record<string, unknown>[] = [];
  const env = (type: string, uuid: string, ts: string) => ({
    type, sessionId: "eval-session", uuid, timestamp: ts, parentUuid: null,
    isSidechain: false, userType: "external", cwd: repoDir, gitBranch: "main", version: "2.1.220",
  });

  spec.turns.forEach((t, i) => {
    // ⚠ Both anchored a few minutes back, and CLOSE TOGETHER. Membership needs the turn to precede
    // the first edit AND share its LOCAL DAY; a turn placed hours earlier can cross local midnight,
    // which yields `no-qualifying-turn` and a silently vacuous case (measured — a 3-hour offset did).
    const editAt = new Date(now - 10 * 60_000).toISOString();
    const turnAt = new Date(now - (10 + (t.minutesBeforeEdit ?? 5)) * 60_000).toISOString();
    // `promptSource: "typed"` — a script-produced prompt is excluded by `isAutomatedPrompt`, so a
    // fixture omitting this would silently produce zero whys.
    lines.push({ ...env("user", `u${i}`, turnAt), promptSource: "typed", message: { role: "user", content: t.text } });
    if (t.editsFiles?.length) {
      lines.push({
        ...env("assistant", `a${i}`, editAt),
        message: { role: "assistant", content: t.editsFiles.map((f, j) => ({
          type: "tool_use", id: `t${i}-${j}`, name: "Edit", input: { file_path: join(repoDir, f) },
        })) },
      });
    }
  });

  writeFileSync(join(proj, "eval-session.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return root;
}

export async function runCase(
  gc: GoldCase,
  provider: Provider,
  deps?: { mutate?: (s: BriefingStruct) => BriefingStruct },
): Promise<{ pass: boolean; findings: Finding[]; struct: BriefingStruct; doneToday: DoneItem[] }> {
  const { dir, shaToUnit, commitMessages, shaToDaysAgo } = await buildEvalRepo(gc.build);

  // T8.6 — synthesise a transcript corpus against THIS repo's real paths, so the actual join runs.
  const txRoot = gc.transcripts ? await buildEvalTranscripts(dir, gc.transcripts) : undefined;

  const cfg: Config = {
    repos: [dir],
    excludeCommitPatterns: [],
    lookbackCapDays: 30,
    // ⚠ `claude` (not `echo`) whenever the case carries transcripts: the A4 gate disables the
    // feature for a non-claude-shaped CLI, so `echo` would silently yield zero whys.
    provider: { cli: gc.transcripts ? "claude" : "echo", argv: [], promptVia: "stdin" },
    subprojects: gc.subprojectRoots ? [{ repo: dir, roots: gc.subprojectRoots }] : undefined,
    ...(txRoot ? { transcripts: { enabled: true, root: txRoot } } : {}),
  };

  const r = await runCore(cfg, { provider, netProbe: async () => true, persistHealth: async () => {} });

  // --- Bidirectional integrity asserts (mis-authored case, NOT Findings) ---
  //
  // ⚠ Window vs same-day are TWO buckets (extractor.ts): commits with daysAgo >= 1 land in the
  // post-reduce in-window `ctx`; daysAgo === 0 land in `today` / `todaySuppress`. Requiring EVERY
  // authored SHA in ctx made the G7 gold case (`same-day-recency`) permanently throw while unit
  // tests stayed green — measured 2026-08-11. Split the assert to match the product's split.
  const ctxCommitShas = new Set<string>();
  for (const repo of r.ctx.repos) {
    for (const act of repo.activities) {
      if (act.kind === "commit") ctxCommitShas.add(act.event_id);
    }
  }
  const todaySubjects = new Set<string>();
  for (const t of r.struct.today ?? []) todaySubjects.add(t.text);
  for (const d of r.todaySuppress ?? []) todaySubjects.add(d.subject);

  for (const [sha, daysAgo] of shaToDaysAgo) {
    if (daysAgo === 0) {
      // Same-day: must surface in the today layer (subject match — today text may carry a short SHA
      // suffix; todaySuppress subjects are raw). Message is the ground-truth subject.
      const msg = commitMessages.get(sha) ?? "";
      // Exact subject (todaySuppress) or `subject (shortsha)` (struct.today). No bare
      // `includes(msg)` — a short subject would false-match a longer sibling's line.
      const inToday =
        todaySubjects.has(msg) ||
        [...todaySubjects].some((s) => s === msg || s.startsWith(`${msg} (`));
      if (!inToday) {
        throw new Error(
          `mis-authored case: same-day commit ${sha} ("${msg}") is not in today/todaySuppress`,
        );
      }
      continue;
    }
    // In-window (daysAgo >= 1): must appear in post-reduce ctx.
    if (!ctxCommitShas.has(sha)) {
      throw new Error(`mis-authored case: authored commit ${sha} is not in the post-reduce in-window ctx`);
    }
  }
  for (const sha of ctxCommitShas) {
    if (!shaToUnit.has(sha)) {
      throw new Error(`mis-authored case: in-window ctx commit ${sha} is not in shaToUnit (ground truth)`);
    }
  }
  for (const path of gc.build.uncommitted ?? []) {
    if (INFRA_DENYLIST.some((d) => path.includes(d))) continue; // infra paths are DELIBERATELY filtered from the prompt at the unit source (#14) — legitimately absent
    if (!r.promptText.includes(path)) {
      throw new Error(`mis-authored case: uncommitted path "${path}" does not appear in promptText`);
    }
  }

  const struct = deps?.mutate ? deps.mutate(r.struct) : r.struct;

  const gitShaSet = new Set(await gitLines(["rev-list", "--all"], dir));
  const fileInventory = new Set<string>();
  for (const f of await gitLines(["ls-files"], dir)) {
    fileInventory.add(f);
    fileInventory.add(basename(f));
  }
  for (const f of gc.build.uncommitted ?? []) {
    fileInventory.add(f);
    fileInventory.add(basename(f));
  }

  const input: CheckInput = {
    caseName: gc.name,
    struct,
    rawText: r.rawText,
    promptText: r.promptText,
    ctx: r.ctx,
    units: r.units,
    emptyWindow: r.emptyWindow,
    gitShaSet,
    fileInventory,
    shaToUnit,
    commitMessages,
    denylist: [...INFRA_DENYLIST],
    // ⚠ G5's no-op predicate gates on THIS. Omitting it makes every G5 check silently vacuous.
    transcripts: r.transcripts,
    // ⚠ Same for G7 (`recency`): omitting this makes it vacuous on every case. The list is taken
    // from runCore, not rebuilt, so the check compares against exactly what the prompt showed.
    doneToday: r.todaySuppress ?? [],
  };

  const findings = CHECKS.flatMap((c) => c({ ...input, struct }));
  const pass = !findings.some((f) => f.severity === "fail");
  // `struct` is also returned (not just used internally) so callers like scripts/eval.ts's
  // opt-in --judge can render the actual generated briefing for the adversarial judge prompt
  // without re-wiring buildEvalRepo/runCore themselves. Purely additive — existing callers that
  // destructure `{ pass, findings }` are unaffected.
  // `doneToday` is returned so a gold-case test can pin G7's NON-VACUITY against the list G7
  // actually gates on. `struct.today` is a SIBLING derivation of the same source (core.ts) with its
  // own failure modes — it drops nothing, while `todaySuppress` skips empty subjects and resolves
  // unit labels separately — so asserting on it proved the wrong thing.
  return { pass, findings, struct, doneToday: input.doneToday };
}
