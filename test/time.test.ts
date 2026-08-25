import { test, expect } from "bun:test";
import { localMidnight, windowStart } from "../src/time";

test("localMidnight zeroes the local time-of-day", () => {
  const m = localMidnight(new Date(2026, 6, 7, 15, 30)); // Jul 7 15:30 local
  expect(m.getHours()).toBe(0);
  expect(m.getDate()).toBe(7);
});

test("windowStart stops at the most recent prior day with a commit", () => {
  const now = new Date(2026, 6, 7, 9, 0); // Tue
  // commit only on Monday Jul 6 (i.e. yesterday)
  const mon = localMidnight(new Date(2026, 6, 6)).getTime();
  const start = windowStart(now, (d) => d.getTime() === mon, 4);
  expect(start.getTime()).toBe(mon);
});

test("windowStart widens across a weekend to Friday", () => {
  const now = new Date(2026, 6, 6, 9, 0); // Mon Jul 6
  const fri = localMidnight(new Date(2026, 6, 3)).getTime(); // Fri Jul 3
  const start = windowStart(now, (d) => d.getTime() === fri, 4);
  expect(start.getTime()).toBe(fri);
});

test("windowStart hard-caps at capDays when no commits found", () => {
  const now = new Date(2026, 6, 7, 9, 0);
  const start = windowStart(now, () => false, 4);
  const expected = localMidnight(new Date(2026, 6, 3)).getTime(); // 4 days back
  expect(start.getTime()).toBe(expected);
});

test("windowStart is correct across a DST boundary (US spring-forward 2026-03-08)", () => {
  const now = new Date(2026, 2, 9, 9, 0); // Mon Mar 9, day after spring-forward
  const sun = localMidnight(new Date(2026, 2, 8)).getTime(); // the 23-hour DST day
  // stops at Sunday when it had a commit — absolute-instant compare must still match local midnight
  expect(windowStart(now, (d) => d.getTime() === sun, 4).getTime()).toBe(sun);
  // and widens correctly across the DST day to the 4-day cap (Thu Mar 5) when no commits
  expect(windowStart(now, () => false, 4).getTime()).toBe(localMidnight(new Date(2026, 2, 5)).getTime());
});
