// Slice 1.5 T4.7 — maintenance with transcript dependencies.
// ⚠ The plan notes NO harness existed for uninstall. This writes one: it CREATES every artifact
// first, then asserts removal — a harness that only checks "the dir is gone" would pass against an
// uninstall that never knew those files existed.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { archivedBriefingPath } from "../src/marker";
import { join, dirname, basename } from "node:path";
import { auditFilesToPrune, AUDIT_RETENTION, lastBriefing, LAST_BRIEFING_SCAN_BYTES } from "../src/audit";

test("T4.7: uninstall removes briefing.log.1, audit-*.md and transcript-health.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dba-uninst-"));
  const plist = join(dir, "fake.plist");
  const artifacts = [
    "daily-briefing", "wake-schedule.json", "briefing.log", "briefing-latest.md",
    "briefing.log.1", "transcript-health.json", "audit-2026-07-30.md", "audit-2026-07-31.md",
  ];
  for (const f of artifacts) writeFileSync(join(dir, f), "x");
  // The dated archive is a DIRECTORY — a glob `rm -f` would leave the user's whole briefing history
  // behind, which is exactly the "removal was never added" defect uninstall.sh records for
  // briefing.log.1. Asserted separately below because `artifacts` is a flat file list.
  // Derived from the implementation, NOT the literal "briefings": if the archive directory is ever
  // renamed, this test must follow it rather than silently creating-and-removing a directory the app
  // no longer writes to, which would pass while nothing cleaned the real one.
  const archiveDir = basename(dirname(archivedBriefingPath("2026-08-14")));
  mkdirSync(join(dir, archiveDir), { recursive: true });
  writeFileSync(join(dir, archiveDir, "2026-08-14.md"), "x");
  writeFileSync(plist, "<plist/>");
  for (const f of artifacts) expect(existsSync(join(dir, f))).toBe(true);   // created, so removal is meaningful

  const proc = Bun.spawn(["bash", "scripts/uninstall.sh"], {
    cwd: process.cwd(),
    env: { ...process.env, DBA_TEST_DIR: dir, DBA_TEST_PLIST: plist },
    stdout: "pipe", stderr: "pipe",
  });
  await proc.exited;
  const left = readdirSync(dir);
  for (const f of artifacts) expect(left).not.toContain(f);
  expect(left).not.toContain(archiveDir);
});

// ⚠ The plan's exact receipt: 61 audit files ⇒ 60 remain.
test("T4.7: audit retention keeps the newest 60 and prunes the rest", () => {
  const names: string[] = [];
  for (let i = 1; i <= 61; i++) names.push(`audit-2026-${String(Math.floor((i - 1) / 31) + 6).padStart(2, "0")}-${String(((i - 1) % 31) + 1).padStart(2, "0")}.md`);
  const pruned = auditFilesToPrune(names);
  expect(names.length).toBe(61);
  expect(pruned.length).toBe(1);
  expect(names.length - pruned.length).toBe(AUDIT_RETENTION);
  // The OLDEST goes: `audit-YYYY-MM-DD.md` sorts lexicographically == chronologically.
  expect(pruned[0]).toBe([...names].sort()[0]);

  expect(auditFilesToPrune(names.slice(0, 60))).toEqual([]);   // exactly at the limit: nothing pruned
  // Non-audit files are never touched, whatever else lives in the support dir.
  expect(auditFilesToPrune(["briefing.log", "daily-briefing", "transcript-health.json"])).toEqual([]);
});

test("T4.7: lastBriefing scans a bounded tail, and still returns a WHOLE briefing", () => {
  const header = (d: string) => `☀️  Morning briefing — ${d}  (this machine: t)\n`;
  const one = (d: string) => header(d) + "body ".repeat(50) + "\n";

  // Normal case: the last of several blocks.
  expect(lastBriefing(one("2026-07-29") + one("2026-07-30")).startsWith(header("2026-07-30"))).toBe(true);

  // A log far larger than the bound: only the tail is scanned, and the result is a complete block.
  const huge = "noise\n".repeat(LAST_BRIEFING_SCAN_BYTES / 3) + one("2026-07-31");
  expect(huge.length).toBeGreaterThan(LAST_BRIEFING_SCAN_BYTES);
  const got = lastBriefing(huge);
  expect(got.startsWith(header("2026-07-31"))).toBe(true);

  // ⚠ The fallback that keeps the bound safe. The discriminating shape needs TWO headers, both
  // OUTSIDE the scanned tail: without the fallback the tail contains no header at all and the
  // function returns a raw fragment — handing the audit a briefing missing its head, which is worse
  // than doing no bounding. (A one-header fixture does NOT discriminate: it returns the whole text
  // either way. Measured — removing the fallback left that version green.)
  const twoFarBack = one("2026-07-01") + one("2026-07-02") + "z".repeat(LAST_BRIEFING_SCAN_BYTES + 10);
  const fell = lastBriefing(twoFarBack);
  expect(fell.startsWith(header("2026-07-02"))).toBe(true);   // the LAST briefing, whole
  expect(fell.startsWith("z")).toBe(false);                   // never a headerless fragment
});
