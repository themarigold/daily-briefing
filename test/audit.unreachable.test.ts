// test/audit.unreachable.test.ts — "resolvable but unreachable" as its own state.
//
// WHY THIS EXISTS (day-16 finding, closed 2026-08-04, user-directed eval-integrity change).
// `cat-file --batch-check` resolves any object in the database, including commits on deleted or
// abandoned branches. A briefing is read hours after it is written, so the deterministic layer could
// print `SHA-grounding: PASS` for a citation the reader cannot find on any branch.
//
// ⚠ MEASURED in this workspace on 2026-08-04 (`rev-list --all` vs `cat-file`): dozens in
// `personal_code`, 0 in the vault, a double-digit share inside the 14-day window. The COUNT is
// gc-volatile — two readings differed (35, then 98) through branch churn alone — so the method is
// recorded and the number deliberately is not.
//
// ⚠ AND WHY THE NAIVE FIX IS WRONG: swapping cat-file for rev-list would reclassify all 35 as
// missing — i.e. FABRICATED — a false accusation on real commits, the error class PR #140 removed.
import { test, expect } from "bun:test";
import { unreachableFromRevList } from "../src/audit";

const FULL_A = "aaaaaaa1111111111111111111111111111111111";
const FULL_B = "bbbbbbb2222222222222222222222222222222222";

test("a cited SHA on no ref is UNREACHABLE", () => {
  expect(unreachableFromRevList(["bbbbbbb"], [], [[FULL_A]])).toEqual(["bbbbbbb"]);
});

test("a cited SHA reachable from a ref is NOT flagged", () => {
  expect(unreachableFromRevList(["aaaaaaa"], [], [[FULL_A]])).toEqual([]);
});

test("⚠ an UNRESOLVED (fabricated) SHA is never ALSO reported as unreachable", () => {
  // THE discriminating case. Dropping the `fabricated` filter double-counts one citation as two
  // defects — reported as both hallucinated and orphaned, which are contradictory diagnoses.
  expect(unreachableFromRevList(["ccccccc"], ["ccccccc"], [[FULL_A]])).toEqual([]);
});

test("abbreviations match by PREFIX, the way cat-file resolves them", () => {
  // A briefing cites 7-char abbreviations; rev-list emits full 40-char hashes. Exact-matching would
  // report EVERY cited SHA as unreachable — a catastrophic false positive on every run.
  expect(unreachableFromRevList(["aaaaaaa"], [], [[FULL_A]])).toEqual([]);
  expect(unreachableFromRevList([FULL_A], [], [[FULL_A]])).toEqual([]);
});

test("reachability is a UNION across repos — present in any repo clears it", () => {
  expect(unreachableFromRevList(["bbbbbbb"], [], [[FULL_A], [FULL_B]])).toEqual([]);
});

test("⚠ no readable repo ⇒ NOTHING flagged (fail-safe, never a false orphan claim)", () => {
  // If rev-list failed everywhere we know nothing about reachability. Reporting every SHA as
  // orphaned would turn a read failure into an evidence-quality accusation.
  expect(unreachableFromRevList(["aaaaaaa"], [], [])).toEqual([]);
  expect(unreachableFromRevList([], [], [[FULL_A]])).toEqual([]);
});

test("case-insensitive — the fixture MIXES case, or it proves nothing", () => {
  // The first version uppercased BOTH sides, so it was case-HOMOGENEOUS and passed with both
  // .toLowerCase() calls deleted. Cited SHAs are lowercased upstream by `extractCitedShas`, so this
  // normalisation is belt-and-braces — but a test named for it must actually discriminate.
  expect(unreachableFromRevList(["AAAAAAA"], [], [["", FULL_A, "  "]])).toEqual([]);
  expect(unreachableFromRevList(["aaaaaaa"], [], [[FULL_A.toUpperCase()]])).toEqual([]);
});
