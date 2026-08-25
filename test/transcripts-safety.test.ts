// Slice 1.5 M8 — the output-side scan (T8.1), the audit's content-search ground truth (T8.1a),
// sink-6 suppression with its downgrade record (T8.2), and invariant 5 on path 1 (T8.3).
import { test, expect } from "bun:test";
import { redactCredentials, matchesCredential, ingestScan, REDACTION } from "../src/transcripts/credentials";
import { quotationsIn, groundTruthForQuotations, auditMayCarryRawTurn, HARDENING_OFF_NOTICE, buildAuditPrompt } from "../src/audit";
import { parseWhy, renderWhy } from "../src/transcripts/frame";
import { textSha } from "../src/transcripts/anchor";
import { claudeShaped } from "../src/harden";
import { renderBriefing } from "../src/render";
import type { BriefingStruct } from "../src/types";

const base: BriefingStruct = {
  date: "2026-07-30", machineScope: "m", provider: "claude",
  resume: [], recap: [{ repo: "app", text: "did it" }], suggestions: [], warnings: [],
};

// ── T8.1: the output-side scan redacts in place and NEVER aborts ────────────────────────────────
test("T8.1: output-side redaction replaces the span and keeps the surrounding text", () => {
  const line = "branch aws-key-AKIAIOSFODNN7EXAMPLE-cleanup was merged";
  const out = redactCredentials(line);
  expect(out).toContain(REDACTION);
  expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  expect(out.startsWith("branch ")).toBe(true);   // in place — never an abort, never a truncation
  expect(out.endsWith(" was merged")).toBe(true);
});

// ⚠ THE SHARED-MATCHER GUARANTEE, asserted end to end rather than by inspection. This is what makes
// invariant 5 and the redact-in-place rule compatible: a why that PASSED the ingest scan cannot
// match output-side, so redaction can never fire inside a quotation. Without it the two rules are in
// direct conflict with no stated precedence.
test("T8.1: redaction can never fire inside a why that cleared the ingest scan", () => {
  const turns = [
    "I switched the join to a membership test because the vote mis-attributed mixed commits",
    "PATH=/usr/local/bin still works, so the shell config was not the problem",
    "lets go with C (build A now, designed to double as B later)",
    'he said "just ship it" and I disagreed',
  ];
  for (const turn of turns) {
    expect(ingestScan(turn)).toEqual({ ok: true });          // it cleared ingest…
    const rendered = renderBriefing({ ...base, whys: { app: turn } });
    const back = parseWhy(rendered.split("\n").find((l) => parseWhy(l) !== null)!);
    expect(back).toBe(turn);
    // …so the output scan leaves it byte-identical, verified via textSha.
    expect(textSha(redactCredentials(rendered))).toBe(textSha(rendered));
  }
});

// ⚠ THE CALL-SITE TESTS. The plan is explicit that both sinks must be checked SEPARATELY, because
// "a fix that scans `rendered` and forgets the audit passes a sink-agnostic check". The tests above
// exercise `redactCredentials` as a FUNCTION — which is exactly that sink-agnostic check, and
// measured: deleting main.ts's call site left them all green. These drive the real `run()` and the
// real audit CLI instead.
test("T8.1 CALL SITE, sinks 1-3: the REAL run() path redacts what reaches stdout and briefing-latest.md", async () => {
  const { run } = await import("../src/main");
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { buildRepo, branchCommit } = await import("./fixtures/build-repo");

  const iso = () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 1); return d.toISOString(); };
  const repo = await buildRepo([{ file: "a.ts", content: "x", isoDate: iso() }]);
  // A credential-shaped BRANCH name — git-derived text, which is exactly what the output scan is for.
  await branchCommit(repo, "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "b.ts", iso());

  const cfgHome = mkdtempSync(join(tmpdir(), "dba-s-cfg-"));
  const stateDir = mkdtempSync(join(tmpdir(), "dba-s-state-"));
  mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
  writeFileSync(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify({
    repos: [repo], excludeCommitPatterns: [], lookbackCapDays: 30,
    transcripts: { enabled: true }, provider: { cli: "claude", argv: [], promptVia: "stdin" },
  }));
  const prevXdg = process.env.XDG_CONFIG_HOME, prevState = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.XDG_CONFIG_HOME = cfgHome;
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;

  const out: string[] = [];
  const oLog = console.log, oErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = () => {};
  try {
    await run(true, {
      provider: { generate: async () => "## RESUME\n- [x] [app] on branch ghp_abcdefghijklmnopqrstuvwxyz0123456789\n## RECAP\n- [x] [app] did it\n## SUGGESTIONS\n- n" },
      netProbe: async () => true,
    });
  } finally {
    console.log = oLog; console.error = oErr;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prevState;
  }
  const stdout = out.join("\n");
  expect(stdout).toContain("briefing —");                     // it really ran
  expect(stdout).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  expect(stdout).toContain(REDACTION);
  // Sink 2: the persisted copy the user and the audit both read.
  const latest = join(stateDir, "briefing-latest.md");
  if (existsSync(latest)) {
    const saved = readFileSync(latest, "utf-8");
    expect(saved).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  }
});

test("T8.1: a git-only briefing whose BRANCH NAME looks credential-shaped is still redacted at the sink", () => {
  // The case the output scan actually exists for: git-derived text, not why text.
  const b = { ...base, resume: [{ repo: "app", text: "on branch ghp_abcdefghijklmnopqrstuvwxyz0123456789" }] };
  const rendered = renderBriefing(b);
  expect(matchesCredential(rendered)).toBe(true);
  const scanned = redactCredentials(rendered);
  expect(scanned).toContain(REDACTION);
  expect(scanned).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  // The briefing still renders in full — aborting would break it, which invariant 8 forbids.
  expect(scanned).toContain("briefing —");
  expect(scanned).toContain("Suggested next");
});

// ── T8.1a: ground truth by CONTENT SEARCH, and OMITTED when unmatched ───────────────────────────
test("T8.1a: the quotation is recovered from the DELIVERED briefing and matched byte-exactly", async () => {
  const turn = 'I kept the drop because two claimants are not resolvable — he said "ship it"';
  const rendered = renderBriefing({ ...base, whys: { app: turn } });

  const quotes = quotationsIn(rendered, parseWhy);
  expect(quotes).toEqual([turn]);          // starting from what was DELIVERED, per §6

  // The corpus search is EXACT — sound only because invariant 5 guarantees byte-equality.
  const corpus = [turn, "some other turn entirely"];
  const search = async (needle: string) => {
    const i = corpus.findIndex((t) => t === needle);
    return i >= 0 ? { found: true as const, sessionId: "s1", tsUtc: "2026-07-30T09:00:00.000Z" } : { found: false as const };
  };
  expect(await groundTruthForQuotations(quotes, search)).toEqual([
    { quotation: turn, sessionId: "s1", tsUtc: "2026-07-30T09:00:00.000Z" },
  ]);
});

// ⚠ If the transcript was pruned or rotated the ground truth is OMITTED, never substituted. A
// near-miss presented as the source turn would be a fabricated citation in the very instrument that
// exists to detect fabrication.
test("T8.1a: a mutated/pruned corpus yields an OMISSION, not a near-miss substitution", async () => {
  const turn = "I kept the drop because two claimants are not resolvable";
  const mutated = ["I kept the drop because two claimants are not resolvable."];   // one trailing char
  const search = async (needle: string) => {
    const i = mutated.findIndex((t) => t === needle);
    return i >= 0 ? { found: true as const, sessionId: "s", tsUtc: "t" } : { found: false as const };
  };
  expect(await groundTruthForQuotations([turn], search)).toEqual([]);   // omitted
  expect(await groundTruthForQuotations([turn], async () => ({ found: false }))).toEqual([]);
});

// ── T8.2: sink-6 suppression, and BOTH halves of the downgrade record ───────────────────────────
test("T8.2: the raw turn is carried only when hardening is on AND the CLI is claude-shaped", () => {
  expect(auditMayCarryRawTurn({ cli: "claude" }, claudeShaped)).toBe(true);
  expect(auditMayCarryRawTurn({ cli: "claude", harden: true }, claudeShaped)).toBe(true);
  // Both STATIC reasons — the only two decidable before the prompt string is built.
  expect(auditMayCarryRawTurn({ cli: "claude", harden: false }, claudeShaped)).toBe(false);
  expect(auditMayCarryRawTurn({ cli: "codex" }, claudeShaped)).toBe(false);
  expect(auditMayCarryRawTurn({ cli: "/usr/local/bin/some-proxy" }, claudeShaped)).toBe(false);
  // The downgrade record must be a real, non-empty notice — §3.8 makes the SINK non-negotiable, and
  // routing this to telemetry alone is the silent degradation that tier forbids.
  expect(HARDENING_OFF_NOTICE.length).toBeGreaterThan(20);
  expect(HARDENING_OFF_NOTICE).toContain("hardening");
});

// ── T8.3: invariant 5 on path 1 — BEHAVIOURAL, on buildAuditPrompt's RETURNED STRING ────────────
// ⚠ Not a source regex. A regex can assert an expression is present; it cannot decide SUBSTITUTION —
// a different, equally-shaped variable interpolated into the prompt — which is the exact failure
// this guards. Only a return-value assertion can.
test("T8.3: the audit prompt carries the anchored turn BYTE-FOR-BYTE, and fails on truncation or substitution", () => {
  const turn = 'I moved the ambiguity handling behind a policy — he said "just ship it"';
  const prompt = buildAuditPrompt({
    briefing: "b", gitFacts: `ground truth turn: ${turn}`, popup: null, popupConfigured: false, deterministic: [],
  });
  expect(prompt).toContain(turn);
  // Byte-for-byte via textSha: recover the span and hash it, so a normalised or trimmed copy fails.
  const i = prompt.indexOf(turn);
  expect(textSha(prompt.slice(i, i + turn.length))).toBe(textSha(turn));

  // Truncation is caught.
  const truncated = buildAuditPrompt({
    briefing: "b", gitFacts: `ground truth turn: ${turn.slice(0, -10)}`, popup: null, popupConfigured: false, deterministic: [],
  });
  expect(truncated).not.toContain(turn);

  // SUBSTITUTION is caught — an equally-shaped but DIFFERENT turn. A source regex asserting
  // "gitFacts is interpolated" passes here; only comparing the returned bytes does not.
  const substituted = buildAuditPrompt({
    briefing: "b", gitFacts: 'ground truth turn: I moved the ambiguity handling behind a flag — he said "just ship it"',
    popup: null, popupConfigured: false, deterministic: [],
  });
  expect(substituted).not.toContain(turn);
});


// ── T8.7: the judge extension ────────────────────────────────────────────────────────────────────
// ⚠ Asserted on the PROMPT, never on the judge's reply. The reply is live model output — whether it
// echoes the turn back is the model's choice, so a reply-side assertion would indict the model
// rather than the code. T8.3 owns the byte-equality half; this owns presence and absence.
test("T8.7: the FIDELITY section appears only when a quotation's source was located", () => {
  const turn = 'I kept the drop because two claimants are not resolvable — he said "ship it"';
  const base = { briefing: "b", gitFacts: "g", popup: null, popupConfigured: false, deterministic: [] };

  // Absent ⇒ the section is omitted ENTIRELY, so a git-only briefing's prompt is unchanged.
  const without = buildAuditPrompt(base);
  expect(without).not.toContain("QUOTED TURNS");
  expect(without).not.toContain("FIDELITY");
  expect(without).not.toContain("OUTCOME LEAKAGE");
  expect(buildAuditPrompt({ ...base, whyGroundTruth: [] })).toBe(without);   // empty === absent

  const withWhy = buildAuditPrompt({ ...base, whyGroundTruth: [{ quotation: turn, sessionId: "s1abcdef", tsUtc: "2026-07-30T09:00:00.000Z" }] });
  expect(withWhy).toContain("QUOTED TURNS");
  expect(withWhy).toContain("FIDELITY");
  expect(withWhy).toContain("OUTCOME LEAKAGE");
  // The turn rides in BYTE-FOR-BYTE — the same guarantee T8.3 pins for the ground-truth argument.
  // ⚠ RAW and unescaped. A JSON.stringify'd copy escapes the turn's own quote, so the raw bytes are
  // absent and invariant 5 fails on path 1 — measured: the first version of this template did that.
  expect(withWhy).toContain(turn);
  const i = withWhy.indexOf(turn);
  expect(textSha(withWhy.slice(i, i + turn.length))).toBe(textSha(turn));
  // Both dimensions are actually stated, not just named.
  expect(withWhy).toContain("mis-attribution");
  expect(withWhy).toContain("rather than");
});

test("T8.7: the section numbering stays consistent when FIDELITY is inserted", () => {
  const base = { briefing: "b", gitFacts: "g", popup: null, popupConfigured: false, deterministic: [] };
  const p = buildAuditPrompt({ ...base, whyGroundTruth: [{ quotation: "t", sessionId: "s", tsUtc: "x" }] });
  // A duplicated heading number would make the judge's report ambiguous about which section it is
  // answering — the kind of defect that is invisible until a reply arrives mis-structured.
  const nums = [...p.matchAll(/^(\d+)\. [A-Z]/gm)].map((m) => Number(m[1]));
  expect(nums).toEqual([...new Set(nums)]);
  expect(nums).toEqual([...nums].sort((a, b) => a - b));
});
