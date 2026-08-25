// src/types.ts — FROZEN CONTRACTS. Only ADDITIVE, optional fields may be appended (e.g. BriefingStruct.today);
// never rename/remove/retype an existing field or change required-ness — later-slice consumers depend on the shape.

export type ActivityMeta = {
  /** `renamedFrom` (additive, defect C — EVAL day 32): the OLD path of a rename row, so evidence
   *  renderers can show the delete half; `file` stays the new-path side and remains the attribution
   *  key everywhere (subprojects/reduce untouched). */
  diffstat?: { file: string; added: number; removed: number; renamedFrom?: string }[];
  aheadBehind?: { ahead: number; behind: number };
  /** Additive: FALSE when the branch has no upstream at all. Without it `{ahead:0,behind:0}` is
   *  emitted for a purely local branch and reads as "in sync with origin" — a false claim in the
   *  day-16 B3 family. `git rev-list ...@{u}` exits 128 with no upstream and `git.ts` swallows it,
   *  leaving the zeros indistinguishable from genuine parity. MEASURED, not inferred. */
  hasUpstream?: boolean;
  /** Additive: TRUE when this branch is the repo's default (from `origin/HEAD`, falling back to a
   *  main/master heuristic). Drives suppression — see `branchStateLines`. */
  isDefaultBranch?: boolean;
  dirty?: boolean;
  uncommittedFiles?: string[]; // additive: structured working-tree paths (uncommitted kind); eventId-neutral
  [k: string]: unknown;
};

export type Activity = {
  source: "git" | "claude-code" | "codex" | "gemini" | "copilot" | "cursor"; // required
  kind: "commit" | "edit" | "command" | "prompt" | "response"
      | "uncommitted" | "branch" | "stash";                                  // required
  event_id: string;        // required — dedup / high-water-mark key
  session_id?: string;     // grouping key for map-reduce (1.5+)
  repo?: string;
  timestamp?: string;      // ISO-8601 with offset
  actor?: "user" | "assistant" | "system";
  target?: string;
  text?: string;
  meta?: ActivityMeta;
};

export type ReducedContext = {
  repos: { repo: string; summary: string; activities: Activity[] }[];
  note?: string;
};

export type BriefingStruct = {
  date: string;            // ISO date
  machineScope: string;    // hostname etc.
  provider: string;        // which CLI produced it
  resume: { repo: string; text: string; ref?: string }[];
  /** `group?` (additive, T1.3): display-cluster stamp — entries sharing a stamp render nested under
   *  one code-built story line ("<file> — N commits (dates)"). Entries are never merged, dropped or
   *  reordered in the struct, and every existing consumer that ignores the field sees the exact
   *  pre-T1.3 shape; the audit's per-commit SHA reconciliation reads member lines unchanged. */
  recap: { repo: string; text: string; evidence?: string; group?: string }[];
  suggestions: { text: string }[];
  today?: { repo: string; text: string }[]; // additive: deterministic "today so far" commits (#1)
  /** Additive: a usage-limit outage that ENDED with this briefing. `missedDays` counts briefings that
   *  did not happen, not elapsed days — see core.ts. Present only when at least one was missed, so the
   *  ordinary failover day (delivered ~10 minutes late) renders nothing. */
  outage?: { missedDays: number; label: string };
  /** Additive (defect D — EVAL day 33, user-directed): PR merges that landed IN-WINDOW (before
   *  today). Rendered deterministically as dated 🔀 lines at the foot of "What you did" — the
   *  window-shaped half of the day-9 fix (`mergedToday` covers only the same-day half). Never sent
   *  to the LLM; like `today`, it cannot be hallucinated. */
  windowMerges?: { repo: string; text: string }[];
  warnings?: string[];
  stateAsOf?: string;      // additive: local HH:MM the working-tree state was captured (volatile facts get a timestamp)
  /** Additive (day-23): the configured morning floor as "HH:MM", printed beside `stateAsOf` so a
   *  reader can see AT A GLANCE whether the briefing arrived on time or late.
   *
   *  ⚠ It states two facts and asserts NO cause. On 2026-08-08 the laptop was lid-closed until 13:01
   *  and the briefing landed at 13:08 — which MEETS this project's stated success criterion ("ready
   *  when the user first sits down", 2026-07-16 design). With no floor printed, both the author and
   *  the assistant read that as a delivery failure; an EVAL row was filed as FAILED, retracted, and
   *  then its retraction re-framed. Two printed timestamps would have prevented all of it.
   *
   *  Deliberately NOT "late because the machine was asleep": inferring a cause means asserting one,
   *  and the two most recent confident causal claims in this project — the zero-yield trigger's
   *  "allowlist decay" and the assistant's retry-loop story — were both wrong. */
  morningFloor?: string;
  /** Additive (day-21 audit): CODE-RENDERED branch state per repo, shown inside "Where you left off".
   *  Never model-authored — the day-21 failure was the claim VANISHING (`quant_stocks` sat on
   *  `chore/sign-live-policy`, the briefing never said so, and its only suggestion was framed wrong
   *  as a result). A prompt instruction cannot fix a claim that gets dropped; a deterministic render
   *  can. Same pattern as `today`. Empty/absent when every repo has nothing worth saying. */
  branchState?: { repo: string; text: string }[];
  /** Slice 1.5b (§3.5). Unit LABEL (normalised) -> the BARE anchored turn.
   *  ⚠ The BARE turn, never the framed line: the `— you wrote: "…"` frame is applied by
   *  `renderBriefing` via `transcripts/frame.ts`. This keeps G5's `verbatim` check a plain equality
   *  against `textSha` instead of requiring it to parse a frame back off, and keeps the app-owned
   *  frame out of the emittable set. */
  whys?: Record<string, string>;
};

export type TokenBudget = { maxChars: number };

export interface Provider {
  generate(prompt: string): Promise<string>; // throws ProviderError on failure
}

// `usage-limit`: the CLI reported a subscription usage wall (weekly or session) with a reset time.
// PERMANENT for this run — retrying cannot succeed until the reset — so it bypasses BOTH withRetry's
// schedule and withHardeningLadder's rungs. See provider.ts for the classification rules (shape-gated,
// so a briefing that merely QUOTES a limit message is not mistaken for one).
export type ProviderErrorCode = "missing-binary" | "nonzero-exit" | "empty-output" | "timeout" | "usage-limit";

export class ProviderError extends Error {
  // `warnings`: pre-formatted, ready-to-print pipeline-warning strings (discIssues + warnings) carried
  // out by core.ts so the shell can still print them on a provider failure (T1 fix — see core.ts).
  // `net`: the net-gate outcome, likewise attached so the shell still prints the "waited…/calling
  // anyway (forced run)" diagnostic on a provider failure (the single most useful line when the
  // failure was network-caused). Both are set by runCore's catch, read by run()'s catch.
  net?: { online: boolean; waitedMs: number };
  // `durationMs`: how long the failing attempt took (C1/B6). Load-bearing, not diagnostic garnish —
  // `withRetry` sleeps 135s internally and passes nothing out, so an outer wrapper cannot time the final
  // attempt itself. Without this the ladder's "failed fast, so it smells like a usage error rather than a
  // network hiccup" trigger has no way to fire at all.
  durationMs?: number;
  /** True when the message may contain bytes from a stream that never reached EOF or that errored
   *  mid-read (C1). The B6 fast path refuses to latch `disableHardening` on such an error: its
   *  evidence is a rejection phrase found in output that is, by construction, possibly truncated —
   *  and the timing argument that used to cover this is FALSE for an errored sink, which resolves
   *  fast enough to pass the fail-fast gate. */
  partialRead?: boolean;
  constructor(public code: ProviderErrorCode, message: string, public warnings?: string[]) {
    super(message);
    this.name = "ProviderError";
  }
}

export type Config = {
  repos?: string[];
  discoverRoots?: string[];
  excludeRepos?: string[]; // repos to drop from BOTH explicit `repos` and discovery — by absolute path or basename (e.g. a stale/work checkout you don't want in the briefing)
  author?: { names?: string[]; emails?: string[] };
  // `harden` (C1/B9, additive+optional per this file's frozen-contract rule): default TRUE. All-or-nothing —
  // a partial opt-out (re-enabling tools via `--tools default`) would silently drop ALL MCP servers, measured
  // 2 → 0, with no way for the user to decline. `false` also skips the capability probe entirely.
  // `credential` picks WHICH credential the spawned CLI may use, by controlling whether
  // `ANTHROPIC_API_KEY` is passed to it. "subscription" (the default, and what an omitted field
  // resolves to) withholds the key so the CLI uses its logged-in session; "env-api-key" passes
  // whatever is in the environment through. Default-on because the failure it prevents is silent
  // and costs money: an ambient key re-billed a subscription to API credits for weeks.
  // `accounts`: ordered failover list. Absent/empty ⇒ the CLI's own default login, i.e. today's behaviour
  // exactly (no CLAUDE_CONFIG_DIR is set). `label` is what limit marks are keyed by and must be unique;
  // `configDir` absent means "use the default login", which is how the primary is expressed without
  // rewriting a working setup. NEVER written to process.env — that variable also resolves the transcript
  // scan root (config.ts resolveTranscripts), so exporting it would silently blank transcript evidence.
  provider: { cli: string; argv: string[]; promptVia: "stdin" | "arg"; timeoutMs?: number; harden?: boolean; credential?: "subscription" | "env-api-key"; accounts?: { label: string; configDir?: string }[] };
  /** Extra argv for the AUDIT JUDGE only — the briefing generator never sees it.
   *
   *  ⚠ The judge is the INSTRUMENT; the briefing is what it measures. You want the instrument at
   *  least as sharp as the thing it grades, and the judge's findings have been the sharpest signal in
   *  this project's record (it caught the day-21 branch misframing, the day-22 self-referential
   *  blindness, and the suggestion duplication). Degrading it to save allowance is the worst trade
   *  available, so it gets its own knob rather than inheriting the generator's.
   *
   *  Typical use: `["--model", "opus"]` while `provider.argv` pins a cheaper model for the daily run.
   *  Appended AFTER `provider.argv`, so it wins on a repeated flag. */
  auditJudgeArgv?: string[]; // timeoutMs: per-provider-call timeout (default 120s) — raise for a slow local model / big multi-repo window
  tokenBudget?: TokenBudget;
  lookbackCapDays?: number;
  excludeCommitPatterns?: string[]; // subjects matching any (regex) are tagged `meta.excluded` as bot/auto noise (#3)
  subprojects?: { repo: string; roots: string[] }[]; // additive: per-repo project-root globs; [] = force single-unit despite a manifest
  morningTime?: string;              // additive: 24h "HH:MM" local floor; below it, scheduled runs no-op. Default "07:20".
  // Slice 1.5 (§3.6). `enabled` defaults FALSE — 1.5a is a dark launch. `root` overrides the
  // resolution order in resolveTranscripts(); omit it and the default `~/.claude/projects` applies,
  // which is REQUIRED rather than a convenience: initConfig returns early when a config already
  // exists (config.ts), so every existing install would otherwise have no root and the feature
  // would be inert with no diagnostic. Shape errors WARN and disable — never throw (B1 style).
  transcripts?: { enabled?: boolean; root?: string };
  networkProbeHosts?: { host: string; port: number }[]; // additive: TCP connectivity-probe targets; [] disables the gate (local/offline providers). Default anycast 1.1.1.1:443 / 8.8.8.8:443.
};

/**
 * One piece of TODAY's work handed to the model as suppress-context, and the unit of comparison for
 * `postcheck`'s freshness check. Built in `core.ts` from same-day activities AND same-day merges.
 *
 * ⚠ Named here because this shape was spelled INLINE in four places — `Meta`, `buildDoneBlock`,
 * `buildPrompt` and `core.ts`'s builder — while `postcheck` declared a named copy. Four spellings of
 * one contract is how the two sides drift, which is the same class of defect that put a divergent
 * `norm` in `postcheck` (see `subprojects.ts`).
 *
 * `subject` is the RAW, untruncated commit subject (or `Merged #N (branch)` for a merge). The prompt
 * shows a `STAGE1_TEXT_CAP`-sliced copy, so anything matching against it must consider both forms.
 */
export type DoneItem = { label: string; subject: string; whenMs: number };
