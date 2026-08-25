import type { BriefingStruct, ReducedContext, Activity } from "../types";
import type { Unit } from "../subprojects";
import type { PathIssue } from "../protectedPath";

export type Finding = {
  case: string;
  // Collision 1 (§5): this union is CLOSED — widened for G5, then G6, then G7.
  check: "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7";
  // Collision 2: `rule` is closed too, and all six G5 names must be added.
  // ⚠ Collision 3: G5's attribution rule is `why-attribution`, NOT `attribution` — that name is
  // already G1's (checks.ts), and reusing it makes the two indistinguishable in output.
  // ⚠ Collision 6 (G6, 2026-08-10): the RESUME-staleness rule is NOT called `freshness` — that name
  // is G5's, and it asks an entirely different question (does an anchored transcript turn fall
  // inside the scan window). It is `recency`, reserved when G6 landed and CLAIMED BY G7 the same
  // day. Same trap as Collision 3, caught before it shipped rather than after.
  rule:
    | "evidence" | "attribution" | "coverage" | "fabrication" | "structure" | "denylist"
    | "anchor" | "freshness" | "why-attribution" | "scope" | "verbatim" | "surface"
    | "redundancy" | "recency";
  severity: "fail" | "warn";
  detail: string;
};

export type CommitSpec = {
  files: string[];
  content?: string;
  daysAgo: number;
  /** Minutes past the `daysAgo` noon pin. Default 0. Needed because noon is an EXACT pin, so two
   *  commits sharing a `daysAgo` are otherwise byte-identical in time — see `dateFor` in
   *  test/fixtures/eval-repo.ts. G7 (`recency`) cannot be exercised without it. */
  minutesAfter?: number;
  message?: string;
  expectUnit: string | null;
};

export type RepoSpec = {
  commits: CommitSpec[];
  uncommitted?: string[];
  workspaceManifest?: Record<string, string>;
};

export type GoldCase = {
  name: string;
  failureMode: string;
  build: RepoSpec;
  requiredCoverageGaps?: string[];
  subprojectRoots?: string[];
  core?: boolean;
  /** Slice 1.5b (T8.6) — a transcript corpus for this case, synthesised against the eval repo's own
   *  file paths so the REAL join runs (discover -> read -> transform -> select -> segment -> join).
   *  A synthetic `TranscriptEvidence` would skip every stage the why depends on.
   *
   *  ⚠ Carrying this also flips `transcripts.enabled` on for the case: `run-case.ts` builds its
   *  Config inline with the field ABSENT, so the default (false) would yield zero whys and every G5
   *  check would no-op — making the case look green while asserting nothing. */
  transcripts?: {
    /** Turns in order. `editsFiles` are repo-relative and become allowlisted `tool_use` inputs.
     *
     *  ⚠ `minutesBeforeEdit` is in MINUTES, and small values are deliberate. §3.2's membership rule
     *  requires the turn to share the segment's LOCAL DAY as well as precede its first edit, so a
     *  turn placed hours earlier can cross local midnight and silently yield `no-qualifying-turn` —
     *  making the case pass while producing no why. Measured: a 3-hour offset did exactly that. */
    turns: { text: string; minutesBeforeEdit?: number; editsFiles?: string[] }[];
  };
};

export type CheckInput = {
  caseName: string;
  struct: BriefingStruct;
  rawText: string;
  promptText: string;
  ctx: ReducedContext;
  units: Unit[];
  emptyWindow: boolean;
  gitShaSet: Set<string>;
  fileInventory: Set<string>;
  shaToUnit: Map<string, { repo: string; root: string | null }>;
  commitMessages: Map<string, string>;
  denylist: string[];
  /** ⚠ Collision 4: none of `anchor`, `freshness`, `why-attribution` or `verbatim` is computable
   *  from `struct` / `ctx` / `units` — the evidence has to be carried. `run-case.ts` constructs it.
   *
   *  ⚠ Collision 5: G5's no-op predicate gates on THIS being present — i.e. on the CASE carrying
   *  transcript evidence — and NOT on the struct containing a why. A struct-shaped predicate
   *  silently defeats MUT8: a why rendered as its own standalone bullet leaves no why-shaped field,
   *  so every check would no-op and the mutation would pass. That is precisely the failure the
   *  mutation discipline exists to catch. */
  transcripts?: import("../transcripts/scan").TranscriptEvidence;
  /** ⚠ Collision 7 (G7): the SAME-DAY items the prompt showed the model, exactly as `core.ts` derived
   *  them — NOT recomputed here. `recency` asks whether a RESUME bullet anchored on the newest
   *  same-day work, so it needs the very list `buildDoneBlock` rendered. Recomputing it from `ctx`
   *  would be a second copy of a decision-feeding derivation, which is the drift fixed in #177.
   *
   *  ⚠ G7's no-op predicate gates on THIS being NON-EMPTY — i.e. on the CASE having same-day
   *  commits — not on the struct. Same rule as G5's (Collision 5): a struct-shaped predicate makes
   *  the check silently vacuous on the cases that matter.
   *
   *  ⚠ REQUIRED, NOT OPTIONAL, AND THAT IS THE POINT. `transcripts?` above is optional, so deleting
   *  its line in run-case.ts still COMPILES and silently makes every G5 check vacuous — the comment
   *  there can only warn. This field cannot be dropped that way: omitting it is a `tsc` error, the
   *  same mechanical guard `RULE_TIER` uses in thresholds.ts. Pass `[]` for "this case has no
   *  same-day commits"; that is a real state (7 of the 8 gold cases) and G7 no-ops on it. */
  doneToday: import("../types").DoneItem[];
};

export type Check = (i: CheckInput) => Finding[];
