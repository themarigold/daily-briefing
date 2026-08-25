import { test, expect } from "bun:test";
import { parseFloor, isPastFloor } from "../src/schedule";

test("parseFloor parses HH:MM to minutes; default + warning on invalid", () => {
  expect(parseFloor("07:20").minutes).toBe(440);
  expect(parseFloor("00:00").minutes).toBe(0);
  expect(parseFloor("23:59").minutes).toBe(1439);
  expect(parseFloor(undefined).minutes).toBe(440);            // default
  const bad = parseFloor("7am");
  expect(bad.minutes).toBe(440);                              // falls back to default
  expect(bad.warning).toMatch(/morningTime/i);               // and warns
  expect(parseFloor("24:00").warning).toBeDefined();         // hour out of range
  expect(parseFloor("07:60").warning).toBeDefined();         // minute out of range
});

test("parseFloor degrades (not throws) on a non-string morningTime — malformed config, not a crash", () => {
  const num = parseFloor(720 as any);
  expect(num.minutes).toBe(440);
  expect(num.warning).toMatch(/morningTime/i);

  const nul = parseFloor(null as any);
  expect(nul.minutes).toBe(440);
  expect(nul.warning).toMatch(/morningTime/i);
});

test("isPastFloor compares local wall-clock minutes", () => {
  const floor = 440; // 07:20
  expect(isPastFloor(new Date(2026, 6, 16, 7, 19), floor)).toBe(false);
  expect(isPastFloor(new Date(2026, 6, 16, 7, 20), floor)).toBe(true);  // exactly-at counts
  expect(isPastFloor(new Date(2026, 6, 16, 9, 0), floor)).toBe(true);
});
