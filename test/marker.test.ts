// test/marker.test.ts
import { test, expect } from "bun:test";
import { localDateStr, alreadyRanToday, stampToday, supportDir, logPath, rotateLogIfLarge, archivedBriefingPath } from "../src/marker";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("localDateStr formats the machine-local date as YYYY-MM-DD", () => {
  const s = localDateStr(new Date(2026, 6, 7, 23, 59));
  expect(s).toBe("2026-07-07");
});

test("once-per-day guard: stampToday makes alreadyRanToday true (DoD §10 item 4)", async () => {
  process.env.DAILY_BRIEFING_STATE_DIR = mkdtempSync(join(tmpdir(), "dba-marker-"));
  expect(await alreadyRanToday()).toBe(false);
  await stampToday();
  expect(await alreadyRanToday()).toBe(true); // a second same-day invocation would short-circuit in main.ts
  delete process.env.DAILY_BRIEFING_STATE_DIR;
});

test("stampToday(dateStr) stamps the RUN-START date, not now — a midnight-straddling retry run must not consume tomorrow", async () => {
  process.env.DAILY_BRIEFING_STATE_DIR = mkdtempSync(join(tmpdir(), "dba-marker-"));
  try {
    const { markerPath } = await import("../src/marker");
    // Simulate: run started 'yesterday' (before midnight), finishes 'today' — it stamps yesterday.
    const y = new Date(Date.now() - 864e5);
    const yStr = localDateStr(y);
    await stampToday(yStr);
    expect((await Bun.file(markerPath()).text()).trim()).toBe(yStr);
    expect(await alreadyRanToday()).toBe(false); // today is still free to run
  } finally {
    delete process.env.DAILY_BRIEFING_STATE_DIR;
  }
});

import { stateDirFor } from "../src/marker";

test("stateDirFor: cross-platform state dir (macOS ~/Library, Windows LOCALAPPDATA, else XDG state) [Tier-3 #10]", () => {
  const home = "/home/u";
  // DAILY_BRIEFING_STATE_DIR overrides everything (tests / power users)
  expect(stateDirFor("linux", { DAILY_BRIEFING_STATE_DIR: "/tmp/x" } as any, home)).toBe("/tmp/x");
  expect(stateDirFor("darwin", {} as any, home)).toBe("/home/u/Library/Application Support/daily-briefing");
  expect(stateDirFor("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" } as any, home)).toContain("daily-briefing");
  expect(stateDirFor("win32", {} as any, home)).toBe("/home/u/AppData/Local/daily-briefing"); // LOCALAPPDATA fallback
  expect(stateDirFor("linux", {} as any, home)).toBe("/home/u/.local/state/daily-briefing"); // XDG default
  expect(stateDirFor("linux", { XDG_STATE_HOME: "/xdg/state" } as any, home)).toBe("/xdg/state/daily-briefing");
});

// ---- Tier-5 batch 7: state-dir reuse + log rotation ----
test("logPath / supportDir honor DAILY_BRIEFING_STATE_DIR (shared with scripts/audit) [Tier-5]", () => {
  const prev = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.DAILY_BRIEFING_STATE_DIR = "/tmp/dba-state-x";
  try {
    expect(supportDir()).toBe("/tmp/dba-state-x");
    expect(logPath()).toBe("/tmp/dba-state-x/briefing.log");
  } finally {
    if (prev === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prev;
  }
});

test("rotateLogIfLarge: truncates an over-cap log in place, keeps one .1 generation; no-op when small/absent [Tier-5]", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dba-logrot-"));
  const log = join(dir, "briefing.log");
  writeFileSync(log, "x".repeat(100));
  await rotateLogIfLarge(log, 50); // 100 > 50 → rotate
  expect(Bun.file(log).size).toBe(0);                              // truncated in place (safe with launchd's O_APPEND fd)
  expect(await Bun.file(log + ".1").text()).toBe("x".repeat(100)); // prior generation preserved
  // under the cap → untouched
  writeFileSync(log, "small");
  await rotateLogIfLarge(log, 50);
  expect(await Bun.file(log).text()).toBe("small");
  // exactly AT the cap → untouched (only strictly-greater rotates)
  writeFileSync(log, "y".repeat(50));
  await rotateLogIfLarge(log, 50);
  expect(await Bun.file(log).text()).toBe("y".repeat(50));
  // absent → no throw
  await rotateLogIfLarge(join(dir, "nope.log"), 50);
});

test("archivedBriefingPath: shape-guards its one interpolated component [Tier-5]", () => {
  process.env.DAILY_BRIEFING_STATE_DIR = mkdtempSync(join(tmpdir(), "dba-arch-"));
  expect(archivedBriefingPath("2026-08-14")).toEndWith(join("briefings", "2026-08-14.md"));
  // Measured in review: without the guard this escaped the state dir entirely. No production caller
  // can reach it — `runDate` is machine-generated — but the calibration harness this feeds will take
  // a date from a CLI arg or a filename, and that is the caller this protects.
  expect(() => archivedBriefingPath("../../etc/passwd")).toThrow(/YYYY-MM-DD/);
  expect(() => archivedBriefingPath("")).toThrow(/YYYY-MM-DD/);
  expect(() => archivedBriefingPath("2026-8-4")).toThrow(/YYYY-MM-DD/);
  delete process.env.DAILY_BRIEFING_STATE_DIR;
});
