// Slice 1.5 T2.5 + T2.6 — discriminators (§2.3) and the substantive-turn pipeline (§3.2).
import { test, expect } from "bun:test";
import {
  selectTurn, selectAll, SELECT_DROP_REASONS, MIN_TURN_CHARS, MAX_TURN_CHARS, CONTROL_BYTE_CLASS,
} from "../src/transcripts/select";
import { isHumanTurn, isHarnessTurn, isSubagentLine, isExcludedMeta, humanTurnText } from "../src/transcripts/discriminate";
import { emptyDrops } from "../src/transcripts/scan";
import { humanTurn, harnessTurn, textBlockTurn, documentTurn } from "./fixtures/session";

const B = { sessionId: "s", uuid: "u", ts: "2026-07-30T10:00:00.000Z" };
const prose = (n: number) => "a".repeat(n);

// ── T2.5: all four §2.3 shapes ───────────────────────────────────────────────────────────────────
test("T2.5: the four measured line shapes classify correctly", () => {
  const human = humanTurn({ ...B, text: "why I did the thing" });
  const harness = harnessTurn({ ...B });
  const textBlk = textBlockTurn({ ...B, text: "hi" });
  const doc = documentTurn({ ...B });

  expect(isHumanTurn(human)).toBe(true);       // string content, no toolUseResult (20.7%)
  expect(isHumanTurn(harness)).toBe(false);    // toolUseResult present (77.6%)
  expect(isHarnessTurn(harness)).toBe(true);
  // Neither harness nor human: not plumbing, but not human prose either, so never a why-source.
  expect(isHumanTurn(textBlk)).toBe(false);    // 1.6%
  expect(isHarnessTurn(textBlk)).toBe(false);
  expect(isHumanTurn(doc)).toBe(false);        // 0.1%
  expect(humanTurnText(human)).toBe("why I did the thing");
  expect(humanTurnText(harness)).toBeNull();
});

// ⚠ The failure this test exists for: `isSidechain` is PRESENT on 100% of user lines, so a presence
// read (`"isSidechain" in line`) is ALWAYS true and classifies every depth-1 line as a subagent
// line. Only the VALUE discriminates (false on 22 725/22 725 depth-1, true on 47 674/47 674 subagent).
test("T2.5: isSidechain is read as a VALUE — a presence read would fail this", () => {
  const main = humanTurn({ ...B, text: "x" });
  const sub = humanTurn({ ...B, text: "x", isSidechain: true });
  expect("isSidechain" in main).toBe(true);    // present on BOTH — presence carries no signal
  expect("isSidechain" in sub).toBe(true);
  expect(isSubagentLine(main)).toBe(false);    // …but the value does
  expect(isSubagentLine(sub)).toBe(true);
});

test("T2.5: isCompactSummary is an ADDITIONAL exclusion, not the filter", () => {
  const compact = humanTurn({ ...B, text: prose(80), isCompactSummary: true });
  expect(isHumanTurn(compact)).toBe(true);     // it IS shaped like a human turn — that is the trap
  expect(isExcludedMeta(compact)).toBe(true);  // …so the exclusion has to be separate
  expect(isExcludedMeta(humanTurn({ ...B, text: "x" }))).toBe(false);
});

// ── T2.6: the six stages, in normative order ─────────────────────────────────────────────────────
test("T2.6: each stage rejects with its own DropReason", () => {
  expect(selectTurn("<task-notification>a long wrapper that would pass every other test</task-notification>"))
    .toEqual({ ok: false, reason: "harness-wrapped" });
  expect(selectTurn("continue")).toEqual({ ok: false, reason: "continuation-word" });
  expect(selectTurn("/compact")).toEqual({ ok: false, reason: "slash-command" });
  expect(selectTurn("too short")).toEqual({ ok: false, reason: "turn-too-short" });
  expect(selectTurn(prose(MAX_TURN_CHARS + 1))).toEqual({ ok: false, reason: "over-cap-turn" });
  expect(selectTurn(prose(50) + "\n" + prose(50))).toEqual({ ok: false, reason: "control-byte" });
  expect(selectTurn(prose(100))).toEqual({ ok: true });
});

// ⚠ ORDER IS NORMATIVE and load-bearing for TELEMETRY. Both regressions the spec had to correct are
// pinned here, because each yields the same qualifying SET while producing different counters — so
// only an order-sensitive assertion can catch them.
test("T2.6: order — a continuation word is NOT counted as too-short", () => {
  // Every continuation word is under 40 chars. With the length floor second, `continuation-word` and
  // `slash-command` would be structurally zero and 1.5b would read them as "never happens".
  expect("continue".length).toBeLessThan(MIN_TURN_CHARS);
  expect(selectTurn("continue").ok === false && selectTurn("continue")).toMatchObject({ reason: "continuation-word" });
  expect("/clear".length).toBeLessThan(MIN_TURN_CHARS);
  expect(selectTurn("/clear")).toEqual({ ok: false, reason: "slash-command" });
});

test("T2.6: order — an over-cap MULTI-LINE turn is counted as over-cap, not control-byte", () => {
  // The control-byte rule placed BEFORE the cap steals 28.7% of the cap's denominator (long human
  // turns are overwhelmingly multi-line pastes), collapsing over-cap from 532 to 54. Running it last
  // is what keeps `over-cap-turn` the meaningful bucket.
  const bigMultiline = prose(400) + "\n" + prose(400);
  expect(bigMultiline.length).toBeGreaterThan(MAX_TURN_CHARS);
  expect(CONTROL_BYTE_CLASS.test(bigMultiline)).toBe(true);   // it WOULD match the control rule…
  expect(selectTurn(bigMultiline)).toEqual({ ok: false, reason: "over-cap-turn" }); // …but the cap runs first
});

test("T2.6: a harness wrapper is dropped FIRST, even though it passes every other test", () => {
  const wrapper = "<task-notification>" + prose(100) + "</task-notification>";
  expect(wrapper.length).toBeGreaterThanOrEqual(MIN_TURN_CHARS);
  expect(wrapper.length).toBeLessThanOrEqual(MAX_TURN_CHARS);
  expect(CONTROL_BYTE_CLASS.test(wrapper)).toBe(false);
  expect(selectTurn(wrapper)).toEqual({ ok: false, reason: "harness-wrapped" });
  // PREFIX-based, not tag-name-based: an unknown tag CC adds tomorrow is still caught.
  expect(selectTurn("<some-tag-invented-next-week>" + prose(60))).toEqual({ ok: false, reason: "harness-wrapped" });
});

// ⚠ `\x7f` (DEL) is neither C0 nor C1. Describing the class as "C0/C1" omits it, and a turn
// containing U+007F would clear selection, be mutated by stripControl at render, and persist NOT
// byte-equal to its anchor — the precise failure stage 6 exists to prevent.
test("T2.6: a \\x7f-bearing turn is rejected at stage 6", () => {
  expect(selectTurn(prose(50) + "\x7f" + prose(50))).toEqual({ ok: false, reason: "control-byte" });
  expect(selectTurn(prose(50) + "\x9f" + prose(50))).toEqual({ ok: false, reason: "control-byte" });
  expect(selectTurn(prose(50) + "\x00" + prose(50))).toEqual({ ok: false, reason: "control-byte" });
});

test("T2.6: stage 6 tests the VERBATIM value, not the trimmed one", () => {
  // A trailing newline survives `.trim()`. Testing the trimmed value would pass this turn, and it
  // would then persist stripped — i.e. not byte-equal to the bytes textSha covers.
  const withTrailingNewline = prose(100) + "\n";
  expect(withTrailingNewline.trim().length).toBe(100);
  expect(selectTurn(withTrailingNewline)).toEqual({ ok: false, reason: "control-byte" });
});

// ⚠ FOUND AT C2. A bare `\s+` argument separator matched a NEWLINE, so a multi-line turn beginning
// with a slash command was attributed to `slash-command`. Both paths end in a drop, so the
// qualifying set is unchanged — but the stage attribution IS the telemetry, and the order is
// normative precisely because 1.5b reads these buckets.
test("T2.6: a MULTI-LINE turn starting with a slash command is not attributed to slash-command [C2 regression]", () => {
  const multi = "/loop\nplease keep iterating on the retention eval until the numbers stabilise";
  expect(selectTurn(multi)).toEqual({ ok: false, reason: "control-byte" });
  // Single-line invocations, with or without arguments, still attribute to slash-command.
  expect(selectTurn("/compact")).toEqual({ ok: false, reason: "slash-command" });
  expect(selectTurn("/code-review ultra 42")).toEqual({ ok: false, reason: "slash-command" });
});

test("T2.6: the cap is a SELECTION filter, never a truncation", () => {
  const at = prose(MAX_TURN_CHARS), over = prose(MAX_TURN_CHARS + 1);
  expect(selectTurn(at)).toEqual({ ok: true });
  expect(selectTurn(over)).toEqual({ ok: false, reason: "over-cap-turn" });
  // Measured on the VERBATIM length: capping on the trimmed value would admit a 601-byte emittable
  // turn, which is what "capped is never truncated" forbids.
  expect(selectTurn(" ".repeat(10) + prose(595))).toEqual({ ok: false, reason: "over-cap-turn" });
});

test("T2.6: a slash command MENTIONED in prose survives — only an exclusive invocation drops", () => {
  const mention = "I ran /compact because the context was getting long and I wanted to keep going";
  expect(mention.length).toBeGreaterThanOrEqual(MIN_TURN_CHARS);
  expect(selectTurn(mention)).toEqual({ ok: true });
  expect(selectTurn("/compact")).toEqual({ ok: false, reason: "slash-command" });
  expect(selectTurn("/code-review ultra 42")).toEqual({ ok: false, reason: "slash-command" });
});

// ── The §5 accounting assertion, over a fixture with >=1 turn in EVERY bucket ────────────────────
test("T2.6: sum(six drop buckets) + qualifiers === examined", () => {
  const texts = [
    "<task-notification>" + prose(80) + "</task-notification>",  // harness-wrapped
    "yes",                                                        // continuation-word
    "/clear",                                                     // slash-command
    "short one",                                                  // turn-too-short
    prose(MAX_TURN_CHARS + 50),                                   // over-cap-turn
    prose(60) + "\n" + prose(60),                                 // control-byte
    prose(120), prose(200),                                       // qualifiers
  ];
  const drops = emptyDrops();
  const t = selectAll(texts, drops);

  const sixSum = SELECT_DROP_REASONS.reduce((n, r) => n + drops[r], 0);
  expect(sixSum + t.qualified).toBe(t.examined);
  expect(t.examined).toBe(8);
  expect(t.qualified).toBe(2);
  // Every bucket populated — otherwise the identity above holds vacuously for the empty ones.
  for (const r of SELECT_DROP_REASONS) expect(drops[r]).toBe(1);
  // The other ten codes belong to later stages and must NOT be touched here.
  const others = Object.keys(drops).filter((k) => !SELECT_DROP_REASONS.includes(k as never));
  expect(others.every((k) => drops[k as never] === 0)).toBe(true);
});
