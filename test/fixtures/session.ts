// Slice 1.5 T1.4 — the transcript fixture builder. Every M2/M3 verify consumes it, so it lands
// FIRST and depends on no reader: it SYNTHESISES JSONL, it never parses any.
//
// Field names are taken from real CC 2.1.220 transcripts (streamed, keys only). One builder per
// line shape in §2.3's measured table, plus the shapes that table does not cover but the corpus
// contains — `attachment` and `queue-operation` lines, which exist to exercise invariant 6's
// fail-closed rule (an unrecognised shape is skipped and counted, never guessed at).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

export type Line = Record<string, unknown>;

/** The `promptSource` values the corpus actually contains (measured; "absent" is the majority case
 *  and is expressed by passing null). There is no "user" value — see humanTurn.
 *
 *  ⚠ `suggestion_accepted` was MISSING from this union until 2026-08-03 and is not hypothetical: it
 *  appears on 11 of the 96 turns that qualify as a why in a 2.1-day window — the user accepting an
 *  autocomplete rather than typing. A fixture type narrower than the corpus quietly makes a whole
 *  provenance untestable, which is the same defect as emitting a value the corpus never contains.
 *  ⚠ `sdk` marks a SCRIPT-produced prompt and is what `isAutomatedPrompt` excludes. */
export type PromptSource = "typed" | "system" | "sdk" | "queued" | "suggestion_accepted";

/** Shared envelope. `isSidechain` is the EXACT main-vs-subagent discriminator (§2.3: false on
 *  22 725/22 725 depth-1 lines, true on 47 674/47 674 subagent lines — zero exceptions either way),
 *  so it is a first-class parameter rather than something a caller has to remember to set. */
function envelope(o: {
  type: string; sessionId: string; uuid: string; ts: string;
  isSidechain?: boolean; cwd?: string; entrypoint?: string; parentUuid?: string | null;
}): Line {
  return {
    type: o.type, sessionId: o.sessionId, uuid: o.uuid, timestamp: o.ts,
    parentUuid: o.parentUuid ?? null,
    isSidechain: o.isSidechain ?? false,
    userType: "external",                 // uniformly "external" in the corpus — carries no signal (§2.3)
    cwd: o.cwd ?? "/repo",
    gitBranch: "main",
    version: "2.1.220",
    ...(o.entrypoint ? { entrypoint: o.entrypoint } : {}),
  };
}

/** §2.3 row 2 (20.7%) — `message.content` is a plain STRING. THE genuine human-typed turn, and the
 *  only shape that can ever supply a why-source. */
export function humanTurn(o: {
  sessionId: string; uuid: string; ts: string; text: string;
  isSidechain?: boolean; cwd?: string; entrypoint?: string; isCompactSummary?: boolean;
  promptSource?: PromptSource | null;
}): Line {
  // `promptSource` defaults to "typed" and can be set to null to OMIT it. Measured over ~1 000 real
  // depth-1 user lines: absent (852), "system" (70), "typed" (43), "sdk" (31), "queued" (1). An
  // earlier draft hardcoded "user", which occurs NOWHERE in the corpus — a fixture emitting an
  // impossible value is how a reader gets validated against a shape that does not exist.
  //
  // ⚠ It is NOT the discriminator. §2.3 measured and chose the mechanical shape rule (string content
  // ⇒ human, `toolUseResult` ⇒ harness); `promptSource` is carried for fidelity only. That "typed"
  // looks like a cleaner human signal is noted, not acted on — changing the discriminator is a spec
  // decision, not a fixture one.
  const src = o.promptSource === undefined ? "typed" : o.promptSource;
  return {
    ...envelope({ ...o, type: "user" }),
    message: { role: "user", content: o.text },
    ...(src === null ? {} : { promptSource: src }),
    ...(o.isCompactSummary ? { isCompactSummary: true } : {}),
  };
}

/** §2.3 row 1 (77.6%) — a `tool_result` block AND a top-level `toolUseResult`. Harness plumbing.
 *  The discriminator is mechanical: `toolUseResult` present ⇒ harness. Both markers are emitted
 *  because a fixture carrying only one would let a half-implemented discriminator pass. */
export function harnessTurn(o: {
  sessionId: string; uuid: string; ts: string; toolUseId?: string; content?: string; isSidechain?: boolean;
}): Line {
  const id = o.toolUseId ?? "toolu_01";
  return {
    ...envelope({ ...o, type: "user" }),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: o.content ?? "ok" }] },
    toolUseResult: { stdout: o.content ?? "ok", stderr: "", interrupted: false },
  };
}

/** §2.3 row 3 (1.6%) — text blocks only, no string content and no toolUseResult. NOT a human turn
 *  under the string discriminator; present so a reader that loosely treats "any user line with text"
 *  as human is caught. */
export function textBlockTurn(o: {
  sessionId: string; uuid: string; ts: string; text: string; isSidechain?: boolean;
}): Line {
  return { ...envelope({ ...o, type: "user" }), message: { role: "user", content: [{ type: "text", text: o.text }] } };
}

/** §2.3 row 4 (0.1%) — `document` blocks. */
export function documentTurn(o: {
  sessionId: string; uuid: string; ts: string; isSidechain?: boolean;
}): Line {
  return {
    ...envelope({ ...o, type: "user" }),
    message: { role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBER" } }] },
  };
}

/** An assistant line carrying `tool_use` blocks — the ONLY thing a subagent file may be read for
 *  (§3.2: `tool_use.input` path fields, never turn text). `paths` map to Edit/Write-style inputs. */
export function assistantToolUse(o: {
  sessionId: string; uuid: string; ts: string; paths: string[];
  tool?: string; isSidechain?: boolean;
}): Line {
  const tool = o.tool ?? "Edit";
  return {
    ...envelope({ ...o, type: "assistant" }),
    message: {
      role: "assistant",
      content: o.paths.map((p, i) => ({
        type: "tool_use", id: `toolu_${i}`, name: tool, caller: "assistant", input: { file_path: p },
      })),
    },
  };
}

/** Shapes the corpus contains that §2.3's table does not cover. Invariant 6 requires these to be
 *  SKIPPED AND COUNTED, never guessed at — `queue-operation` in particular has no `message` at all,
 *  so a reader that assumes one throws. `journal.jsonl` lines are of this class too (§2.2 item 1:
 *  the recursive subagent glob ingests 14 of them, and they are deliberately NOT name-excluded). */
export function unrecognisedLine(o: { sessionId: string; ts: string; kind?: "attachment" | "queue-operation" }): Line {
  if ((o.kind ?? "queue-operation") === "queue-operation") {
    return { type: "queue-operation", operation: "enqueue", sessionId: o.sessionId, timestamp: o.ts, content: "x" };
  }
  return { ...envelope({ type: "attachment", sessionId: o.sessionId, uuid: "att-1", ts: o.ts }), attachment: { type: "file" } };
}

/** Write one session file. Returns its absolute path. Lines are written verbatim and in order —
 *  the builder never reorders or validates, so a fixture can encode a malformed corpus on purpose. */
export function buildSession(o: { dir: string; sessionId: string; lines: Line[]; fileName?: string }): string {
  const path = join(o.dir, o.fileName ?? `${o.sessionId}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, o.lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return path;
}

/** Write a raw (possibly invalid) line — for the truncated-JSON / oversize-line cases that
 *  `buildSession` cannot express because it serialises objects. */
export function buildRawSession(o: { dir: string; fileName: string; raw: string }): string {
  const path = join(o.dir, o.fileName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, o.raw, "utf-8");
  return path;
}

/** The §2.2 layout, BOTH subagent tiers. A non-recursive glob matches only `subagents/*.jsonl` —
 *  1 884 of 2 906 files, 65%, and under-reads SILENTLY — so T1.3a's fixture must contain the second
 *  tier (`subagents/workflows/wf_<id>/`) or the test passes with a non-recursive glob.
 *  Returns every file written, tagged by tier, so a test can assert on the set rather than a count. */
export function buildProjectTree(o: {
  root: string; project: string; sessionId: string; ts: string;
}): { depth1: string; subagentTier1: string; subagentTier2: string; journal: string } {
  const projDir = join(o.root, o.project);
  const sessDir = join(projDir, o.sessionId);
  const line = (uuid: string, sidechain: boolean) =>
    [assistantToolUse({ sessionId: o.sessionId, uuid, ts: o.ts, paths: ["src/a.ts"], isSidechain: sidechain })];

  return {
    depth1: buildSession({ dir: projDir, sessionId: o.sessionId, lines: line("u-main", false) }),
    subagentTier1: buildSession({ dir: join(sessDir, "subagents"), sessionId: "sa-1", lines: line("u-sa1", true) }),
    // The SECOND tier — nested one level deeper under `workflows/wf_<id>/`.
    subagentTier2: buildSession({
      dir: join(sessDir, "subagents", "workflows", "wf_abc123"), sessionId: "agent-1",
      fileName: "agent-a7ac260d69c8bfe77.jsonl", lines: line("u-sa2", true),
    }),
    // A THIRD file shape in the same tier — a workflow journal, not an agent transcript.
    journal: buildSession({
      dir: join(sessDir, "subagents", "workflows", "wf_abc123"), sessionId: "journal",
      fileName: "journal.jsonl", lines: [unrecognisedLine({ sessionId: "journal", ts: o.ts })],
    }),
  };
}

/** ⚠ Windows path fixtures (§5, R6). `unitKeyForAbsolutePath` normalises separators
 *  (`subprojects.ts`), and the BEHAVIOURAL assertion already exists and is green at
 *  `test/shared-bucketer.test.ts:69` — landed with T0.1. These exist so the JOIN-level confirmation
 *  (T3.3) can show the join actually routes through that bucketer rather than doing its own
 *  string work, which is the only part R6 leaves open. */
export const WINDOWS_PATHS = {
  repo: "C:\\Users\\dev\\code\\myrepo",
  absFile: "C:\\Users\\dev\\code\\myrepo\\src\\a.ts",
  relPosix: "src/a.ts",
} as const;

export function windowsToolUseSession(o: { dir: string; sessionId: string; ts: string }): string {
  return buildSession({
    dir: o.dir, sessionId: o.sessionId,
    lines: [assistantToolUse({ sessionId: o.sessionId, uuid: "u-win", ts: o.ts, paths: [WINDOWS_PATHS.absFile] })],
  });
}
