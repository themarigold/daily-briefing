// Slice 1.5 T2.2 — the readable/emittable transform (§3.3).
//
// readable = the transform may consult. emittable = may reach a prompt or a sink.
// EMITTABLE SET: the anchored source turn text. Nothing else.
//
// Readable-not-emittable: sessionId, uuid, tsUtc, textSha, gitBranch, entrypoint, isSidechain,
// isMeta, isCompactSummary, edited paths, `toolUseResult`'s PRESENCE (never its content), and
// `message.content`'s TYPE (string vs array, never the array's contents).
// ⚠ `cwd` is NOT readable — §2.1 bans it on every reading path, and nothing here consults it.
//
// Not-readable at all: every line type other than `user`/`assistant` (explicitly including
// `ai-title`, which hallucinates, and `pr-link`); a block's rendered content where the block type is
// not `text` (`thinking`, `tool_result` content, top-level `toolUseResult`); the entire
// `tool-results/` directory.
//
// ⚠ ONE named structural exception: `tool_use.input.file_path` and `tool_use.input.notebook_path`,
// read AS PATHS ONLY — never treated as prose, never scanned as text, never emittable. Without it
// the not-readable tier would forbid §3.2's own attribution mechanism.
import { basename } from "node:path";
import { isHumanTurn, isSubagentLine, isExcludedMeta, isAutomatedPrompt, humanTurnText, type Line } from "./discriminate";
import type { DropReason } from "./scan";

/** §3.2 step 1's TOOL ALLOWLIST: `Edit` and `Write` only — ⚠ NOT `Read`.
 *
 *  Harvesting `input.file_path` from EVERY `tool_use` is the looser predicate §2.4 says inflates
 *  ambiguity, and it does so SILENTLY: a session that merely read a file would claim that unit, so
 *  two sessions collide and drop-on-ambiguity discards a why that should have been attributed.
 *  `MultiEdit` and `NotebookEdit` are fail-closed-tolerant future entries — zero occurrences in the
 *  corpus today, but they are writes by definition, so admitting them cannot loosen the predicate. */
export const TOOL_ALLOWLIST: readonly string[] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/** The path-carrying input fields of the allowlisted tools — the §3.3 structural exception. */
const PATH_FIELDS = ["file_path", "notebook_path"] as const;

export type PathRecord = { sessionId: string; tsUtc: string; path: string };
export type TurnRecord = { sessionId: string; uuid: string; tsUtc: string; text: string };

export type TransformOutcome = {
  /** Allowlisted `tool_use` paths — attribution evidence. Available from BOTH tiers. */
  paths: PathRecord[];
  /** Candidate human turns. ⚠ Depth-1 ONLY: §3.2 restricts subagent files to `tool_use.input` path
   *  fields, never turn text, so a subagent line can never supply a why-source. */
  turns: TurnRecord[];
  /** Lines whose shape is unrecognised — skipped and COUNTED, never guessed at (invariant 6). */
  unrecognised: number;
};

/** ⚠ §3.2's sessionId FILENAME FALLBACK. 2.3% of depth-1 lines carry no `sessionId`; the
 *  `<session-uuid>.jsonl` filename is authoritative and always present. Without this those ~2 800
 *  lines either drop silently or collapse under one `undefined` key — MERGING DISTINCT SESSIONS,
 *  which defeats session-collapse and drop-on-ambiguity at once. */
export function sessionIdFor(line: Line, filePath: string): string {
  const sid = line.sessionId;
  if (typeof sid === "string" && sid.length > 0) return sid;
  return basename(filePath).replace(/\.jsonl$/, "");
}

const asArray = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((b): b is Record<string, unknown> => !!b && typeof b === "object") : [];

/** Rule 2 of §3.3's three fail-closed ingest rules — NORMALIZE-AND-REJECT-ON-CHANGE. If normalising
 *  a field alters it, reject the field. Applied to paths: a path that is not already its own
 *  normalised form is refused rather than silently rewritten, because a rewritten path would join
 *  against a unit the user never touched.
 *  ⚠ Unicode normalisation only. Separator conversion is NOT normalisation here — Windows paths are
 *  handled downstream by `unitKeyForAbsolutePath`, which is the single owner of that rule (R6). */
export function acceptPath(p: unknown): p is string {
  return typeof p === "string" && p.length > 0 && p.normalize("NFC") === p;
}

/** Transform ONE line. `tier` decides whether turn text may be read at all. */
export function transformLine(
  line: Line, filePath: string, tier: "depth1" | "subagent",
): { paths: PathRecord[]; turn: TurnRecord | null; recognised: boolean } {
  const type = line.type;
  // Not-readable at all: every line type other than `user`/`assistant`. `ai-title` (5 909 lines,
  // hallucinates) and `pr-link` are explicitly in this bucket, as are `queue-operation`/`attachment`
  // and anything CC adds next — the rule is an ALLOWLIST of two, not a denylist.
  if (type !== "user" && type !== "assistant") return { paths: [], turn: null, recognised: false };

  const ts = typeof line.timestamp === "string" ? line.timestamp : "";
  const sessionId = sessionIdFor(line, filePath);
  const m = line.message;
  const content = m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>).content : undefined;

  // ── The structural exception: allowlisted `tool_use` input paths, read as paths only.
  const paths: PathRecord[] = [];
  for (const b of asArray(content)) {
    if (b.type !== "tool_use") continue;                       // `thinking`/`tool_result` content is not-readable
    if (typeof b.name !== "string" || !TOOL_ALLOWLIST.includes(b.name)) continue;
    const input = b.input;
    if (!input || typeof input !== "object") continue;
    for (const f of PATH_FIELDS) {
      const v = (input as Record<string, unknown>)[f];
      if (acceptPath(v)) paths.push({ sessionId, tsUtc: ts, path: v });
    }
  }

  // ── Candidate turn text. Depth-1 only, and never from an excluded-meta line.
  let turn: TurnRecord | null = null;
  if (tier === "depth1" && !isSubagentLine(line) && !isExcludedMeta(line) && !isAutomatedPrompt(line) && isHumanTurn(line)) {
    const text = humanTurnText(line)!;
    const uuid = typeof line.uuid === "string" ? line.uuid : "";
    turn = { sessionId, uuid, tsUtc: ts, text };               // VERBATIM — pre-cap, pre-trim, pre-normalise
  }
  return { paths, turn, recognised: true };
}

/** `drops` is threaded rather than derived: `unrecognised-shape` is an enumerated DropReason, and a
 *  code counted only as a local number has NO WRITER — the exact defect class the plan's coverage
 *  table exists to prevent (three separate spec rounds each found one). C3 asserts every M2/M3 code
 *  can be triggered, which is only decidable if the code is actually written somewhere. */
export function transformLines(
  lines: Line[], filePath: string, tier: "depth1" | "subagent", drops?: Partial<Record<DropReason, number>>,
): TransformOutcome {
  const out: TransformOutcome = { paths: [], turns: [], unrecognised: 0 };
  for (const l of lines) {
    const r = transformLine(l, filePath, tier);
    if (!r.recognised) {
      out.unrecognised++;
      if (drops) drops["unrecognised-shape"] = (drops["unrecognised-shape"] ?? 0) + 1;
      continue;
    }
    out.paths.push(...r.paths);
    if (r.turn) out.turns.push(r.turn);
  }
  return out;
}
