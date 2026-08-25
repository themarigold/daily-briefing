// Slice 1.5 §3.6 — transcript discovery (T1.3) and the recursive subagent glob (T1.3a).
//
// Enumeration only: this module decides WHICH files the scan may open, never what is inside them.
// Reading and parsing land in M2.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { PROMPT_HEADER } from "../generator";

/** §3.6's self-ingestion guard, re-exported from its single source of truth in generator.ts so it
 *  cannot drift away from the prompt it fingerprints. */
export const SELF_PROMPT_FINGERPRINT = PROMPT_HEADER;

/** ⚠ HISTORICAL headers, and this list may only ever GROW.
 *
 *  Transcripts are append-only and `lookbackCapDays` reaches back over days when THIS APP was
 *  writing an OLDER prompt. Keying the guard on the current header alone silently un-guards every
 *  one of them: `isSelfPrompt` returns false, the app's own provider turns stop being excluded, and
 *  the briefing starts ingesting its own prompt text as the user's work.
 *
 *  MEASURED 2026-08-17, and it is why this list exists: the first-wake rename dropped "morning" from
 *  `PROMPT_HEADER` and a probe confirmed `isSelfPrompt(<old self-prompt>)` flipped **true → false**.
 *  It shipped in `db22f092` — the SAME commit that widened `audit.ts`'s header matcher to accept both
 *  spellings for exactly this reason. One half of the coupling was seen and the other was not,
 *  because `discover.ts` merely CONSUMES the constant and so never appeared in the diff under review.
 *
 *  ⚠ Whenever `PROMPT_HEADER` changes, append its previous value here as a FROZEN LITERAL. Do not
 *  derive these from anything — a derived entry drifts with the thing it is meant to outlive. */
export const HISTORICAL_PROMPT_HEADERS = [
  // Until 2026-08-17 (dropped with the first-wake scope decision).
  "You are writing a developer's resumption-focused morning briefing from LOCAL GIT ACTIVITY on THIS machine only.",
  // Until 2026-08-18 (the "Daily briefing" final-name decision, user-directed). Appended per the
  // rule above BEFORE the header changed — the 08-17 regression was doing these in the other order.
  "You are writing a developer's resumption-focused briefing from LOCAL GIT ACTIVITY on THIS machine only.",
] as const;

const ALL_SELF_PROMPT_FINGERPRINTS: readonly string[] = [SELF_PROMPT_FINGERPRINT, ...HISTORICAL_PROMPT_HEADERS];

/** True when a user turn is THIS APP talking to its own provider. Prefix, not equality: the prompt
 *  continues with the run's git context, so only the header is stable.
 *
 *  ⚠ Deliberately narrow. It does NOT key on `entrypoint: "sdk-cli"`, which marks every headless
 *  `claude -p` job on the machine — most of them other tools whose transcripts are legitimate
 *  evidence (§2.1). A broad guard would discard real work; §3.6 accepts the stated residual that a
 *  second tool WRAPPING this app's prompt would not be caught (no such tool exists today). */
export function isSelfPrompt(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const t = text.trimStart();
  // Current header OR any historical one — see HISTORICAL_PROMPT_HEADERS for why the list is required
  // and why it may only grow. Guarding is fail-CLOSED here by design: a missed match does not error,
  // it silently admits the app's own prompt as user evidence.
  return ALL_SELF_PROMPT_FINGERPRINTS.some((f) => t.startsWith(f));
}

/** A file is skippable when it cannot possibly hold an in-window line. Transcripts are APPEND-ONLY,
 *  so an mtime before the window start proves the last write predates the window.
 *
 *  ⚠ SKIP-ONLY, per §3.6 — it may exclude, never include. A recent mtime says nothing about whether
 *  any line falls in the window (a file touched this morning may hold only last week's turns), so
 *  this can never stand in for reading timestamps. An unstattable file is NOT skipped: failing open
 *  here costs a wasted read, failing closed would silently drop evidence. */
export async function skipByMtime(path: string, windowStartMs: number): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.mtimeMs < windowStartMs;
  } catch {
    return false;
  }
}

async function globFiles(root: string, pattern: string): Promise<string[]> {
  const out: string[] = [];
  try {
    // `onlyFiles` keeps directories out; `followSymlinks: false` keeps a symlinked project dir from
    // walking outside the transcript root (and from cycling).
    for await (const rel of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true, followSymlinks: false, dot: false })) {
      out.push(join(root, rel));
    }
  } catch {
    return []; // an unreadable/absent root is "no transcripts", never a throw — the feature is optional
  }
  return out.sort(); // deterministic order: the join's tie-breaks must not depend on readdir order
}

/** T1.3 — depth-1 sessions: `<root>/<project>/<session>.jsonl`. Unaffected by the subagent tiers. */
export const DEPTH1_GLOB = "*/*.jsonl";

// T1.3a — the subagent glob. ⚠ It MUST recurse. A non-recursive variant (a single star where the
// globstar is) matches 1 884 of 2 906 files — 65% — and under-reads SILENTLY, so the empty-join
// escalation would appear to work while missing a third of the evidence (§2.2 item 1). The two tiers
// are `<session>/subagents/` and `<session>/subagents/workflows/wf_<id>/`.
//
// ⚠ The recursive glob also ingests the 14 `journal.jsonl` workflow journals. They are deliberately
// NOT name-excluded: invariant 6's fail-closed rule handles them, since any line whose shape is
// unrecognised is skipped and counted. Name-excluding would encode an assumption that the tier is
// homogeneous, which it is not.
// (Line comments, not JSDoc: a glob's `*` immediately before a `/` closes a block comment.)
export const SUBAGENT_GLOB = "*/*/subagents/**/*.jsonl";

export type Discovered = { path: string; tier: "depth1" | "subagent" };

/** Enumerate depth-1 session files, applying the skip-only mtime prefilter. */
export async function discoverDepth1(root: string, windowStartMs: number): Promise<string[]> {
  const all = await globFiles(root, DEPTH1_GLOB);
  const keep = await Promise.all(all.map(async (p) => (await skipByMtime(p, windowStartMs)) ? null : p));
  return keep.filter((p): p is string => p !== null);
}

/** Enumerate subagent files across BOTH tiers, applying the same prefilter.
 *
 *  ⚠ §3.2 restricts what these files may be read FOR — `tool_use.input` path fields only, never turn
 *  text, so a subagent file can never supply a why-source. That restriction belongs to the reader
 *  (M2/M3), not here: this function's contract is enumeration. The assertion for it lives in T3.4,
 *  where evidence of what was read actually exists — at M1 the orchestrator is a stub returning
 *  empty evidence, so "contributes no why-source" is trivially true of every input, including if the
 *  restriction were never built at all. */
export async function discoverSubagents(root: string, windowStartMs: number): Promise<string[]> {
  const all = await globFiles(root, SUBAGENT_GLOB);
  const keep = await Promise.all(all.map(async (p) => (await skipByMtime(p, windowStartMs)) ? null : p));
  return keep.filter((p): p is string => p !== null);
}

// ⚠ There is deliberately NO `discoverAll`. §3.6 makes the subagent tier ESCALATE-ON-EMPTY, so
// enumerating both unconditionally would pay the recursive glob (~2 906 files) on every run AND make
// `counters.escalated` / `escalationSkipped` meaningless — they would record a decision no code ever
// took. The caller (T4.1) must call `discoverDepth1` first and reach for `discoverSubagents` only on
// an empty join, which is what makes those counters mean something.
