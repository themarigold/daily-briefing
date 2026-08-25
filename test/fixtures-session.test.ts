// Slice 1.5 T1.4 — the fixture builder is itself verified, because every M2/M3 verify is only as
// trustworthy as the corpus it synthesises. A builder that emitted, say, a human turn without the
// string content would make the discriminator tests pass against a shape that does not exist.
// Assertions are on the written JSONL, since the builder depends on no reader by design.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  humanTurn, harnessTurn, textBlockTurn, documentTurn, assistantToolUse, unrecognisedLine,
  buildSession, buildRawSession, buildProjectTree, windowsToolUseSession, WINDOWS_PATHS,
} from "./fixtures/session";

const tmp = () => mkdtempSync(join(tmpdir(), "dba-sess-"));
const read = (p: string) => readFileSync(p, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
const base = { sessionId: "s1", ts: "2026-07-30T10:00:00.000Z" };

// ── One fixture per line shape in §2.3's measured table ───────────────────────────────────────────
test("T1.4: human turn — string content, NO toolUseResult (§2.3 row 2, the only why-source shape)", () => {
  const [l] = read(buildSession({ dir: tmp(), sessionId: "s1", lines: [humanTurn({ ...base, uuid: "u1", text: "why I did it" })] }));
  expect(typeof l.message.content).toBe("string");   // THE human discriminator
  expect(l.message.content).toBe("why I did it");
  expect("toolUseResult" in l).toBe(false);
  expect(l.isSidechain).toBe(false);                 // depth-1 default
});

test("T1.4: harness turn — tool_result block AND top-level toolUseResult (§2.3 row 1)", () => {
  const [l] = read(buildSession({ dir: tmp(), sessionId: "s1", lines: [harnessTurn({ ...base, uuid: "u2" })] }));
  // BOTH markers, deliberately: a fixture carrying only one lets a half-implemented discriminator pass.
  expect("toolUseResult" in l).toBe(true);
  expect(l.message.content[0].type).toBe("tool_result");
  expect(typeof l.message.content).not.toBe("string");
});

test("T1.4: text-block and document turns are NOT string-content (§2.3 rows 3 and 4)", () => {
  const [t] = read(buildSession({ dir: tmp(), sessionId: "s1", lines: [textBlockTurn({ ...base, uuid: "u3", text: "hi" })] }));
  expect(Array.isArray(t.message.content)).toBe(true);
  expect(t.message.content[0].type).toBe("text");
  expect("toolUseResult" in t).toBe(false); // so `toolUseResult`-only logic would misread it as human

  const [d] = read(buildSession({ dir: tmp(), sessionId: "s1", lines: [documentTurn({ ...base, uuid: "u4" })] }));
  expect(d.message.content[0].type).toBe("document");
});

test("T1.4: isSidechain is settable and is the exact main-vs-subagent discriminator", () => {
  const [main] = read(buildSession({ dir: tmp(), sessionId: "s1", lines: [humanTurn({ ...base, uuid: "u5", text: "x" })] }));
  const [sub] = read(buildSession({ dir: tmp(), sessionId: "s2", lines: [humanTurn({ ...base, uuid: "u6", text: "x", isSidechain: true })] }));
  expect(main.isSidechain).toBe(false);
  expect(sub.isSidechain).toBe(true);
  // A subagent DISPATCH prompt is plain-string content with no toolUseResult, so the shape
  // discriminator alone calls it human — isSidechain is what resolves it (§2.3 edge case 1).
  expect(typeof sub.message.content).toBe("string");
});

test("T1.4: assistant tool_use carries input.file_path — the only field a subagent file may be read for", () => {
  const [l] = read(buildSession({ dir: tmp(), sessionId: "s1", lines: [assistantToolUse({ ...base, uuid: "u7", paths: ["src/a.ts", "src/b.ts"] })] }));
  expect(l.message.content.map((b: { type: string }) => b.type)).toEqual(["tool_use", "tool_use"]);
  expect(l.message.content.map((b: { input: { file_path: string } }) => b.input.file_path)).toEqual(["src/a.ts", "src/b.ts"]);
});

// Invariant 6: an unrecognised shape must be SKIPPED AND COUNTED, never guessed at. `queue-operation`
// has no `message` at all, so a reader that assumes one throws rather than degrading.
test("T1.4: unrecognised line shapes exist in the corpus and carry no message", () => {
  const [q] = read(buildSession({ dir: tmp(), sessionId: "s1", lines: [unrecognisedLine({ sessionId: "s1", ts: base.ts })] }));
  expect(q.type).toBe("queue-operation");
  expect("message" in q).toBe(false);
  const [a] = read(buildSession({ dir: tmp(), sessionId: "s1", lines: [unrecognisedLine({ sessionId: "s1", ts: base.ts, kind: "attachment" })] }));
  expect(a.type).toBe("attachment");
  expect("message" in a).toBe(false);
});

test("T1.4: buildRawSession can express what buildSession cannot — a truncated JSON line", () => {
  const p = buildRawSession({ dir: tmp(), fileName: "broken.jsonl", raw: '{"type":"user","message":{"content":"cut off' });
  expect(() => JSON.parse(readFileSync(p, "utf-8"))).toThrow();
});

// ── The two-tier subagent tree (§2.2) — T1.3a's fixture ───────────────────────────────────────────
test("T1.4: buildProjectTree writes BOTH subagent tiers, so a non-recursive glob cannot pass", () => {
  const root = tmp();
  const t = buildProjectTree({ root, project: "-Users-me-repo", sessionId: "sess-1", ts: base.ts });
  for (const p of Object.values(t)) expect(existsSync(p)).toBe(true);

  // Tier 1 is `<project>/<session>/subagents/*.jsonl`; tier 2 nests one level deeper under
  // `workflows/wf_*/`. A `<project>/*/subagents/*.jsonl` glob matches tier 1 only — 65% of the
  // corpus — and under-reads silently, which is the failure this fixture shape exists to expose.
  expect(t.subagentTier1).toContain(join("sess-1", "subagents"));
  expect(t.subagentTier2).toContain(join("subagents", "workflows", "wf_abc123"));
  expect(t.subagentTier2.endsWith(".jsonl")).toBe(true);
  // The third file shape in tier 2: a workflow journal, deliberately NOT name-excluded (§2.2 item 1).
  expect(t.journal.endsWith("journal.jsonl")).toBe(true);
  expect(read(t.journal)[0]!.type).toBe("queue-operation"); // unrecognised => invariant 6 handles it
  // Depth-1 discovery must be unaffected by any of the above.
  expect(t.depth1).toBe(join(root, "-Users-me-repo", "sess-1.jsonl"));
});

// ── Windows path fixtures (§5, R6) ────────────────────────────────────────────────────────────────
test("T1.4: Windows fixtures carry backslash separators verbatim", () => {
  const [l] = read(windowsToolUseSession({ dir: tmp(), sessionId: "s-win", ts: base.ts }));
  const p = l.message.content[0].input.file_path;
  expect(p).toBe(WINDOWS_PATHS.absFile);
  expect(p).toContain("\\");                     // NOT pre-normalised — the reader must do that work
  expect(WINDOWS_PATHS.absFile.startsWith(WINDOWS_PATHS.repo)).toBe(true);
});
