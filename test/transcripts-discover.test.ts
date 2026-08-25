// Slice 1.5 T1.3 / T1.3a — discovery (§3.6) and the recursive subagent glob (§2.2).
import { test, expect } from "bun:test";
import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSelfPrompt, SELF_PROMPT_FINGERPRINT, HISTORICAL_PROMPT_HEADERS, skipByMtime, discoverDepth1,
  discoverSubagents, SUBAGENT_GLOB,
} from "../src/transcripts/discover";
import { PROMPT_HEADER, buildPrompt } from "../src/generator";
import { buildSession, buildProjectTree, humanTurn } from "./fixtures/session";

const tmp = () => mkdtempSync(join(tmpdir(), "dba-disc-"));
const TS = "2026-07-30T10:00:00.000Z";
const PAST = 0; // window start at the epoch => nothing is skipped by mtime

// ── T1.3: the self-ingestion fingerprint ─────────────────────────────────────────────────────────
// The guard's whole value is that it cannot drift from the prompt. Asserting against buildPrompt's
// REAL output (not a literal) is what makes that true.
//
// ⚠ THE ORIGINAL COMMENT HERE CLAIMED A PROTECTION THIS TEST DOES NOT HAVE, and the claim cost a
// live defect on 2026-08-17. It read: "reword the prompt without updating the constant and this
// fails." It cannot. `SELF_PROMPT_FINGERPRINT` IS `PROMPT_HEADER` (discover.ts:11), so both sides of
// line 23 move together and the assertion is a tautology that survives ANY rename. What it actually
// pins is that `buildPrompt` still LEADS with the header — worth having, but not drift protection.
// The real risk a rename creates is HISTORICAL: transcripts already on disk carry the OLD header and
// silently stop being recognised as ours. That is what the next test covers, and it is the one that
// would have caught `db22f092`.
test("T1.3: the fingerprint matches the REAL prompt buildPrompt emits", () => {
  const prompt = buildPrompt({ repos: [] }, []);
  expect(prompt.startsWith(SELF_PROMPT_FINGERPRINT)).toBe(true);
  expect(SELF_PROMPT_FINGERPRINT).toBe(PROMPT_HEADER);
  expect(isSelfPrompt(prompt)).toBe(true);
});

test("T1.3: a self-prompt from an OLDER version is STILL excluded (frozen literal, survives renames)", () => {
  // ⚠ FROZEN LITERAL ON PURPOSE — deriving this from HISTORICAL_PROMPT_HEADERS would make it drift
  // with the very list it exists to police, reproducing the tautology documented above. If a future
  // rename drops this string from the list, THIS LINE must fail.
  const OLD_2026_08_16 =
    "You are writing a developer's resumption-focused morning briefing from LOCAL GIT ACTIVITY on THIS machine only.";
  expect(isSelfPrompt(`${OLD_2026_08_16}\n\nREPOS: /Users/x/foo\n- abc1234 did a thing`)).toBe(true);
  expect(HISTORICAL_PROMPT_HEADERS).toContain(OLD_2026_08_16);

  // A genuinely foreign prompt must still be KEPT — the guard widening must not become a catch-all.
  expect(isSelfPrompt("You are writing a developer's changelog from LOCAL GIT ACTIVITY.")).toBe(false);
});

test("T1.3: this app's own prompt is excluded; another tool's sdk-cli session is KEPT", () => {
  expect(isSelfPrompt(buildPrompt({ repos: [] }, []))).toBe(true);

  // ⚠ The case §2.1 insists on: `entrypoint: "sdk-cli"` marks EVERY headless `claude -p` job on the
  // machine — vault_autolog, ai_news, /loop — and those are other tools' transcripts, i.e. legitimate
  // evidence. A guard broad enough to exclude them would discard real work (290 of 327 recent
  // transcripts carry that entrypoint, only a minority of them ours).
  const otherTool = humanTurn({ sessionId: "s", uuid: "u", ts: TS, entrypoint: "sdk-cli",
    text: "Summarise today's AI news into the vault." });
  expect(isSelfPrompt((otherTool.message as { content: string }).content)).toBe(false);

  // Non-string content and absent turns must not throw or match.
  for (const v of [undefined, null, 42, [], { content: "x" }]) expect(isSelfPrompt(v)).toBe(false);
});

// ── T1.3: the mtime prefilter is SKIP-ONLY ───────────────────────────────────────────────────────
test("T1.3: mtime skips only files whose last write predates the window", async () => {
  const dir = tmp();
  const old = buildSession({ dir, sessionId: "old", lines: [humanTurn({ sessionId: "old", uuid: "u", ts: TS, text: "x" })] });
  const fresh = buildSession({ dir, sessionId: "fresh", lines: [humanTurn({ sessionId: "fresh", uuid: "u", ts: TS, text: "x" })] });
  const windowStart = new Date("2026-07-30T00:00:00Z").getTime();
  utimesSync(old, new Date("2026-07-01T00:00:00Z"), new Date("2026-07-01T00:00:00Z"));
  utimesSync(fresh, new Date("2026-07-30T12:00:00Z"), new Date("2026-07-30T12:00:00Z"));

  expect(await skipByMtime(old, windowStart)).toBe(true);
  expect(await skipByMtime(fresh, windowStart)).toBe(false);
  // Fails OPEN on an unstattable path: a wasted read is cheap, silently dropping evidence is not.
  expect(await skipByMtime(join(dir, "does-not-exist.jsonl"), windowStart)).toBe(false);
});

// ── T1.3a: the glob MUST recurse ─────────────────────────────────────────────────────────────────
// A non-recursive `*/*/subagents/*.jsonl` matches tier 1 only — 1 884 of 2 906 files, 65% — and
// under-reads SILENTLY. This fixture contains both tiers precisely so that glob cannot pass.
test("T1.3a: BOTH subagent tiers are enumerated (a non-recursive glob fails this)", async () => {
  const root = tmp();
  const t = buildProjectTree({ root, project: "-Users-me-repo", sessionId: "sess-1", ts: TS });

  const found = await discoverSubagents(root, PAST);
  expect(found).toContain(t.subagentTier1);
  expect(found).toContain(t.subagentTier2);   // the tier a non-recursive glob misses
  expect(found).toContain(t.journal);         // NOT name-excluded — invariant 6 handles it at read time
  expect(found).not.toContain(t.depth1);      // depth-1 is a separate tier

  // Pin the pattern itself, so a "simplification" back to a single `*` is a red test, not a silent
  // 35% under-read that every other assertion would still pass.
  expect(SUBAGENT_GLOB).toContain("**");
});

test("T1.3a: depth-1 discovery is unaffected by the subagent tiers", async () => {
  const root = tmp();
  const t = buildProjectTree({ root, project: "-Users-me-repo", sessionId: "sess-1", ts: TS });
  const d1 = await discoverDepth1(root, PAST);
  expect(d1).toEqual([t.depth1]); // exactly the depth-1 file, no subagent file leaking in
});

// §3.6 makes the subagent tier ESCALATE-ON-EMPTY. The two enumerators stay separate so a caller must
// take that decision explicitly — a combined helper would pay the ~2 906-file recursive glob every
// run and make `counters.escalated`/`escalationSkipped` record a decision no code ever took.
test("T1.3a: the two tiers are enumerated by SEPARATE calls, so escalation stays a caller decision", async () => {
  const root = tmp();
  const t = buildProjectTree({ root, project: "-Users-me-repo", sessionId: "sess-1", ts: TS });
  const d1 = await discoverDepth1(root, PAST);
  expect(d1).toEqual([t.depth1]);                       // the cheap tier alone — no subagent cost paid
  const sa = await discoverSubagents(root, PAST);       // only reached on an empty join
  expect(sa.length).toBeGreaterThan(0);
  expect(d1.some((p) => sa.includes(p))).toBe(false);   // disjoint: no file is counted in both tiers
});

test("T1.3: an absent or unreadable transcript root is 'no transcripts', not a throw", async () => {
  const missing = join(tmp(), "nope");
  expect(await discoverDepth1(missing, PAST)).toEqual([]);
  expect(await discoverSubagents(missing, PAST)).toEqual([]);
});

test("T1.3: discovery order is deterministic — the join's tie-breaks must not depend on readdir", async () => {
  const root = tmp();
  for (const s of ["c", "a", "b"]) {
    buildSession({ dir: join(root, "-proj"), sessionId: s, lines: [humanTurn({ sessionId: s, uuid: "u", ts: TS, text: "x" })] });
  }
  const found = await discoverDepth1(root, PAST);
  expect(found).toEqual([...found].sort());
});
