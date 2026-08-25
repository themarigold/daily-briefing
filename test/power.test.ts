// test/power.test.ts — darkwake detection, and its deliberate fail-open direction.
//
// WHY. On 2026-08-08 the 07:20 run fired during a maintenance darkwake, burned all three provider
// attempts on timeouts, and wrote a failure block that was misdiagnosed twice. The network gate was
// built to prevent exactly this and cannot: `pmset` keeps TCPKeepAlive active through clamshell
// sleep, so the anycast TCP probe succeeds in ~0s while the provider call cannot complete.
//
// The discriminator is MEASURED: 410 wake events separate perfectly on the graphics capability
// (DarkWake `[CDN]`, FullWake `[CDNVA]`), and an overnight probe confirmed the live command agrees —
// `CPU Network` during real darkwake vs `CPU Graphics Audio Network` awake.
import { test, expect } from "bun:test";
import { isFullyAwake } from "../src/power";

const ok = (out: string) => async () => ({ code: 0, out });
const AWAKE = "Current System Capabilities are: CPU Graphics Audio Network \nCurrent Power State: 4";
const DARK  = "Current System Capabilities are: CPU Network \nCurrent Power State: 1";

test("Graphics present ⇒ awake; absent ⇒ darkwake", async () => {
  expect(await isFullyAwake("darwin", ok(AWAKE))).toBe(true);
  expect(await isFullyAwake("darwin", ok(DARK))).toBe(false);
});

test("the real strings measured on this machine are classified correctly", async () => {
  // Verbatim from the overnight probe log — not hand-written approximations.
  expect(await isFullyAwake("darwin", ok("Current System Capabilities are: CPU Network "))).toBe(false);
  expect(await isFullyAwake("darwin", ok("Current System Capabilities are: CPU Graphics Audio Network "))).toBe(true);
});

test("⚠ FAIL-OPEN on every uncertainty — the asymmetry is the whole design", async () => {
  // A false "awake" costs one wasted run, which is today's status quo. A false "darkwake" SKIPS a
  // morning the user is waiting for. So anything ambiguous must answer TRUE.
  expect(await isFullyAwake("darwin", async () => ({ code: 1, out: "" }))).toBe(true);          // pmset failed
  // ⚠ DISCRIMINATING FORM. The line above is an EQUIVALENT-MUTANT trap: with empty output the
  // `!caps` guard already returns true, so deleting the exit-code check changes nothing and the
  // mutation survives (MEASURED). A nonzero exit that STILL prints a darkwake line is the only input
  // that separates them — and the exit code must win, because output from a failed command is not
  // evidence.
  expect(await isFullyAwake("darwin", async () => ({ code: 1, out: DARK }))).toBe(true);
  expect(await isFullyAwake("darwin", ok("garbage with no capabilities line"))).toBe(true);     // shape changed
  expect(await isFullyAwake("darwin", ok("Current System Capabilities are:"))).toBe(true);      // empty list
  expect(await isFullyAwake("darwin", async () => { throw new Error("spawn failed"); })).toBe(true);
});

test("non-macOS is never gated — only macOS exposes this", async () => {
  let called = false;
  const spy = async () => { called = true; return { code: 0, out: DARK }; };
  expect(await isFullyAwake("linux", spy)).toBe(true);
  expect(await isFullyAwake("win32", spy)).toBe(true);
  expect(called).toBe(false);            // and it does not even spawn
});

test("matching is case-insensitive and word-bounded", async () => {
  expect(await isFullyAwake("darwin", ok("Current System Capabilities are: CPU GRAPHICS Network"))).toBe(true);
  // A capability merely CONTAINING the letters must not count as the Graphics capability.
  expect(await isFullyAwake("darwin", ok("Current System Capabilities are: CPU Graphicsy Network"))).toBe(false);
});
