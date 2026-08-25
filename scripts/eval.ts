// scripts/eval.ts — the live `bun run eval` release gate (Task 10). Runs each selected
// GOLD_CASES entry (src/eval/cases.ts) through the REAL pipeline with the REAL provider
// (the hardened BYO provider — e.g. the `claude` CLI) N=3 times, and applies `verdictForRuns`'s pure
// threshold policy (src/eval/thresholds.ts, TDD'd in test/eval/thresholds.test.ts) to decide
// pass/fail per case. Replaces the old ad-hoc grounding-audit dump — see EVAL.md's "superseded"
// note — now that the gold-case scoring machinery (runCase/CHECKS/GOLD_CASES) exists.
//
// Flags:
//   --case <name>   run only the named gold case (default: every entry in GOLD_CASES)
//   --json          emit a machine-readable { pass, posture, postureDetail, truncated, perRule, findings } object
//                    instead of the
//                    human report (perRule is the presentational worst-of across cases:
//                    fail > flaky > pass — it never changes the exit code)
//   --judge         additionally run the non-gating adversarial LLM judge (buildAuditPrompt,
//                    src/audit.ts:126) once per case and print its verdict; it NEVER affects the
//                    exit code — gold cases are synthetic, so the judge's ground truth is the
//                    case's own authored `build` spec, not real git history
//
// This is NOT run in `bun test` — it calls the real provider CLI and can take minutes per case.
// Manual smoke: `bun run eval --case day8-tie`
import { loadConfig, resolveAccounts } from "../src/config";
import { resolveForScript } from "../src/account";
import { homedir } from "node:os";
import { hardenedProvider } from "../src/harden";
import type { Provider } from "../src/types";
import { postureLine, posturePhrase, mergeWarnings, isTruncationWarning } from "../src/eval/posture";
import { runCase } from "../src/eval/run-case";
import { GOLD_CASES } from "../src/eval/cases";
import { verdictForRuns, type VerdictLabel, type Verdict } from "../src/eval/thresholds";
import { buildAuditPrompt } from "../src/audit";
import { renderBriefing } from "../src/render";
import type { GoldCase, Finding } from "../src/eval/types";

const RUNS_PER_CASE = 3;

const argv = process.argv.slice(2);
function flagValue(name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}
const caseFilter = flagValue("--case");
const jsonMode = argv.includes("--json");
const judgeMode = argv.includes("--judge");

// The gold case's own authored `build` spec IS its ground truth (that's what defines the
// failure mode it exercises) — there's no real git history to reconstruct like the daily audit.
function gitFactsFromGoldCase(gc: GoldCase): string {
  const lines = gc.build.commits.map(
    (c, i) =>
      `  commit ${i + 1} (daysAgo=${c.daysAgo}): "${c.message ?? "(no message)"}" — files: ${c.files.join(", ")} — expectUnit: ${c.expectUnit ?? "(catch-all)"}`,
  );
  const uncommitted = gc.build.uncommitted?.length
    ? `  uncommitted: ${gc.build.uncommitted.join(", ")}`
    : "  uncommitted: (none)";
  return [
    `GOLD CASE "${gc.name}" — synthetic ground truth authored by the harness (this IS the truth, not a fallible reconstruction):`,
    `failureMode under test: ${gc.failureMode}`,
    ...lines,
    uncommitted,
  ].join("\n");
}

function deterministicFromFindings(findings: Finding[]): string[] {
  return findings.filter((f) => f.severity === "fail").map((f) => `[${f.check}/${f.rule}] ${f.detail}`);
}

const RULE_RANK: Record<VerdictLabel, number> = { pass: 0, flaky: 1, fail: 2 };
function worstOf(a: VerdictLabel | undefined, b: VerdictLabel): VerdictLabel {
  if (!a) return b;
  return RULE_RANK[b] > RULE_RANK[a] ? b : a;
}

// Preserves scripts/audit.ts's "Suggested EVAL.md row" shape (audit.ts:~213): same 7-column
// pipe table. Column 1 stays the "…" fill-yourself placeholder (audit.ts does the same); column
// 2 is the case name (in place of a calendar Date — this measures a gold case, not a day);
// column 3 is the gate verdict emoji (in place of Ground); (a)/(b) are blank (not applicable to
// a synthetic case); Notes summarizes which rules flagged.
function evalMdRow(gc: GoldCase, verdict: Verdict, warnings: readonly string[] = []): string {
  const flags = Object.entries(verdict.perRule)
    .filter(([, v]) => v !== "pass")
    .map(([rule, v]) => `${rule}:${v.toUpperCase()}`);
  const gateEmoji = verdict.pass ? "✅" : "❌";
  // Posture rides in Notes rather than an eighth column (C2): the value is the boring word "full" on
  // almost every run, and a new column would reshape every historical row of a hand-maintained table.
  // But a row recorded under UNKNOWN hardening cannot honestly be compared with a later one, so it is
  // never omitted — a gate that cannot state the posture it measured is not a gate.
  return `| … | ${gc.name} | ${gateEmoji} | ? |  |  | live gate (${RUNS_PER_CASE}x): ${flags.length ? flags.join(", ") : "0 flag(s)"}; ${postureLine(warnings)} |`;
}

type Attempt = Awaited<ReturnType<typeof runCase>>;

async function runOneCase(gc: GoldCase, provider: Provider): Promise<{ attempts: Attempt[]; verdict: Verdict }> {
  // 3 concurrent live provider calls per case (concurrency 3, within the brief's 3-4 range).
  // A ProviderError from a transient CLI hiccup is already retried inside runCore/generateBriefing
  // (src/core.ts's own withRetry around the provider call) before it ever reaches here — so a
  // successful attempt after a retry is scored exactly like any other run, never flagged specially.
  const attempts = await Promise.all(Array.from({ length: RUNS_PER_CASE }, () => runCase(gc, provider)));
  const verdict = verdictForRuns(attempts.map((a) => a.findings));
  return { attempts, verdict };
}

async function runJudge(gc: GoldCase, provider: Provider, attempt: Attempt): Promise<string> {
  const prompt = buildAuditPrompt({
    briefing: renderBriefing(attempt.struct),
    gitFacts: gitFactsFromGoldCase(gc),
    popup: null,
    popupConfigured: false, // gold cases structurally have no popup — omit the VS POPUP section entirely
    deterministic: deterministicFromFindings(attempt.findings),
  });
  return provider.generate(prompt);
}

type CaseResult = { gc: GoldCase; verdict: Verdict; findings: Finding[]; error?: string; warnings?: string[] };

async function main() {
  const realCfg = await loadConfig();
  const cases = caseFilter ? GOLD_CASES.filter((c) => c.name === caseFilter) : GOLD_CASES;
  if (caseFilter && !cases.length) {
    console.error(`no gold case named "${caseFilter}" (known: ${GOLD_CASES.map((c) => c.name).join(", ")})`);
    process.exit(2);
  }

  const results: CaseResult[] = [];

  for (const gc of cases) {
    if (!jsonMode) console.log(`\n=== ${gc.name} (${RUNS_PER_CASE}x live) ===`);
    // Hoisted ABOVE the try for the same reason the judge provider was: errors that bypass core's own
    // provider-call catch — runCase's mis-authored-case asserts, a gitLines throw — arrive with no
    // `.warnings`, so a hardening latch from an earlier successful generate would be dropped from the
    // ERROR line. I fixed this shape for the judge and left it here.
    // The eval generator honours the same limit marks — otherwise an eval run during an outage piles
    // RUNS_PER_CASE concurrent calls onto a walled account. It records nothing itself: the case runs
    // through runCore with an INJECTED provider, and runCore's recording is gated on having built the
    // provider itself, precisely so a developer's eval cannot write a user-facing outage into live state.
    const evalAcct = await resolveForScript(resolveAccounts(realCfg.provider.accounts, homedir()).accounts, new Date());
    const caseProvider = hardenedProvider(realCfg.provider, {
      timeoutMs: realCfg.provider.timeoutMs, ...(evalAcct.env ? { env: evalAcct.env } : {}),
    });
    try {
      const { attempts, verdict } = await runOneCase(gc, caseProvider);
      const findings = attempts.flatMap((a) => a.findings);
      // Three sources because a warning can hide in three places: core folds the provider's into
      // `struct.warnings` on the success path, the provider itself keeps them, and the error path below
      // reads them off the thrown ProviderError.
      const warnings = mergeWarnings(...attempts.map((a) => a.struct), caseProvider);
      results.push({ gc, verdict, findings, warnings });

      if (!jsonMode) {
        console.log(`failureMode: ${gc.failureMode}`);
        attempts.forEach((a, i) => {
          const fails = a.findings.filter((f) => f.severity === "fail");
          console.log(`  run ${i + 1}: ${a.findings.length} finding(s), ${fails.length} fail`);
        });
        console.log(`  perRule: ${JSON.stringify(verdict.perRule)}`);
        console.log(`  verdict: ${verdict.pass ? "PASS" : "FAIL"}`);
        console.log(`  ${postureLine(warnings)}`);
        console.log(evalMdRow(gc, verdict, warnings));
      }

      if (judgeMode) {
        if (!jsonMode) console.log(`  running judge (non-gating)…`);
        // Hoisted ABOVE the try so the catch can still read its warnings: declared inside, a hardening
        // latch during a FAILED judge call was lost — the very category this commit calls the sharpest.
        // audit.ts got this right; this did not.
        // Same treatment as the audit judge, and the same trade-off: inheriting failover keeps the eval
        // runnable during an outage, at the cost of the instrument possibly differing between runs — so
        // the account is recorded in the row rather than left implicit.
        const judgeAcct = await resolveForScript(resolveAccounts(realCfg.provider.accounts, homedir()).accounts, new Date());

        const judgeProvider = hardenedProvider(realCfg.provider, {
          timeoutMs: 240_000, ...(judgeAcct.env ? { env: judgeAcct.env } : {}),
        });
        try {
          const judged = await runJudge(gc, judgeProvider, attempts[0]!);
          // The judge runs on its OWN provider instance which never passes through runCore, so unlike the
          // main path nothing else will ever surface these — they are lost, not merely unprinted.
          // `postureLine` folds in a truncation mark, which also UN-SUPPRESSES the line below: a judge
          // whose verdict was cut off but whose hardening was fine would otherwise render exactly
          // "posture: full" and print nothing at all.
          // Account provenance rides on the posture line, matching audit.ts: the judge inherits
          // failover, so which account judged can differ between runs and must not do so invisibly.
          const jw = `${postureLine(mergeWarnings(judgeProvider))}${judgeAcct.account?.label ? ` · account: ${judgeAcct.account.label}` : ""}`;
          // stderr fallback like every neighbouring line: this was the one posture line that vanished
          // entirely in --json mode, which is exactly the mode automation runs.
          if (jw !== "posture: full") { if (jsonMode) console.error(`[${gc.name}] judge ${jw}`); else console.log(`  judge ${jw}`); }
          if (!jsonMode) console.log(`  --- judge ---\n${judged}\n`);
          else console.error(`[${gc.name}] judge:\n${judged}`); // keep stdout machine-clean in --json mode
        } catch (e) {
          const jp = postureLine(mergeWarnings(judgeProvider, e));
          const msg = `judge failed (non-gating, ignored): ${e}${jp === "posture: full" ? "" : ` [${jp}]`}`;
          if (!jsonMode) console.log(`  ${msg}`);
          else console.error(`[${gc.name}] ${msg}`);
        }
      }
    } catch (e) {
      // `String(e)` alone dropped the `.warnings` core.ts attaches to a ProviderError for precisely this
      // case — "hardening was disabled, and THEN it failed" is the single most useful thing to know here,
      // and it was the one path that provably lost it.
      const caught = mergeWarnings(caseProvider, e);
      const posture = postureLine(caught);
      const msg = posture === "posture: full" ? String(e) : `${String(e)} [${posture}]`;
      results.push({ gc, verdict: { pass: false, perRule: {} }, findings: [], error: msg, warnings: caught });
      if (!jsonMode) console.log(`  ERROR (case did not complete — treated as a gate FAIL): ${msg}`);
      else console.error(`[${gc.name}] ERROR: ${msg}`);
    }
  }

  const anyCaseFails = results.some((r) => !r.verdict.pass || r.error);

  if (jsonMode) {
    const perRule: Record<string, VerdictLabel> = {};
    const findings: Finding[] = [];
    for (const r of results) {
      for (const [rule, v] of Object.entries(r.verdict.perRule)) perRule[rule] = worstOf(perRule[rule], v);
      findings.push(...r.findings);
    }
    // `posture` in the MACHINE-READABLE output, not only the human one. This is the form automation
    // consumes to decide whether a gate run counts, and it previously carried no posture at all — so the
    // one consumer that could act on it programmatically was the one that could not see it. Aggregated
    // across every case: the run is `full` only if all of them were.
    const allWarnings = [...new Set(results.flatMap((r) => r.warnings ?? []))];
    console.log(JSON.stringify({
      pass: !anyCaseFails, posture: posturePhrase(allWarnings), postureDetail: postureLine(allWarnings), truncated: allWarnings.some(isTruncationWarning),
      perRule, findings,
    }, null, 2));
  } else {
    console.log(`\n=== SUMMARY ===`);
    for (const r of results) console.log(`${r.gc.name}: ${r.error ? "ERROR" : r.verdict.pass ? "PASS" : "FAIL"}`);
  }

  process.exit(anyCaseFails ? 1 : 0);
}

main();
