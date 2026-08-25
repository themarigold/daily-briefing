// test/ceilings.test.ts — the spawn/timeout CEILINGS, pinned in one place.
//
// WHY THIS FILE EXISTS. F1 converged four hand-rolled flush races onto one shared `raceFlush`, and in
// doing so gave the flush *tiers* a shared pin. The *ceilings* — how long we let a child run at all —
// never got the same treatment, and a harden pass found them entirely unpinned: each of the four
// constants below could be changed to an absurd value with the WHOLE SUITE GREEN and `tsc` clean.
//
// Measured on a scratch copy at the merge commit (934 pass / 0 fail baseline):
//   GIT_TIMEOUT_MS   30s -> 300ms   0 red
//   PROBE_MS         10s -> 300ms   0 red
//   PROBE_FLUSH_MS    1s -> 30s     0 red
//   TIMEOUT_MS      120s -> 3s      0 red
// (`proc.ts`'s DEFAULT_TIMEOUT_MS was measured 1 red — already pinned, so it is not repeated here.)
//
// Only ONE of those is silent, and it is the reason this file is worth its weight: shrinking
// GIT_TIMEOUT_MS SIGKILLs every git call on a slow, NFS-mounted or very large repo. Downstream that
// reads as "repo unreadable", and the morning briefing comes out EMPTY with nothing in it explaining
// why. The other three are loud — a killed provider raises ProviderError, a probe timeout raises an
// anomaly that surfaces in the posture line, and a stretched probe flush costs latency, not truth.
//
// SHAPE: range asserts plus the relationships between constants, following the precedent already set
// for DEFAULT_FLUSH_MS in test/proc.incomplete-read.test.ts — which pins a floor, a cap, AND a
// behavioural check, on the same reasoning (every other test injects an explicit value, so nothing
// exercises the default). The bounds below are deliberately WIDE: they are not tuning, they are a
// guard against a value that could only be a mistake. A deliberate re-tune moves them and says why.
import { test, expect } from "bun:test";
import { GIT_TIMEOUT_MS } from "../src/git";
import { PROBE_MS, PROBE_FLUSH_MS } from "../src/probe";
import { TIMEOUT_MS, flushWindowMs } from "../src/provider";
import { DEFAULT_FLUSH_MS, DEFAULT_TIMEOUT_MS } from "../src/proc";

test("GIT_TIMEOUT_MS bounds a slow repo without killing a healthy one", () => {
  // FLOOR: `runGit` is called ~10-12x per repo per tick. On a network mount or a very large repo a
  // single `git log` can legitimately take seconds — killing it turns a healthy repo into an
  // unreadable one, and an unreadable repo into an empty briefing with no error. This is the one
  // ceiling whose failure is SILENT, which is why the floor is generous.
  expect(GIT_TIMEOUT_MS).toBeGreaterThan(5_000);
  // CAP: the launchd agent ticks every 10 minutes. A ceiling anywhere near that lets one wedged repo
  // consume the whole window and starve the rest.
  expect(GIT_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  // RELATIONSHIP: the post-exit flush window must be far shorter than the ceiling that bounds the
  // child itself, or the flush stops being a "catch bytes still in flight" tier and becomes a second
  // timeout. `git.ts` uses its own 500ms flush; proc's default mirrors it for the same reason.
  expect(DEFAULT_FLUSH_MS).toBeLessThan(GIT_TIMEOUT_MS / 10);
});

test("PROBE_MS and PROBE_FLUSH_MS keep the capability probe bounded but not hair-trigger", () => {
  // FLOOR: a cold CLI printing --help on a busy machine needs real time. Too short and the probe
  // times out, which is an ANOMALY — so hardening is silently not applied, every morning. Loud
  // (it surfaces in the posture line) but still wrong.
  expect(PROBE_MS).toBeGreaterThan(2_000);
  // CAP: the probe runs before the briefing. A large ceiling here delays delivery directly.
  expect(PROBE_MS).toBeLessThanOrEqual(30_000);
  // The flush window is for bytes in flight AFTER the probe exits — it must be a fraction of the
  // ceiling, never comparable to it. Measured: stretching it to 30s left the suite green while adding
  // up to 30s to every held-pipe run.
  expect(PROBE_FLUSH_MS).toBeGreaterThan(100);
  expect(PROBE_FLUSH_MS).toBeLessThan(5_000);
  expect(PROBE_FLUSH_MS).toBeLessThan(PROBE_MS);
});

test("provider TIMEOUT_MS leaves room for a real generation and fits inside the launchd tick", () => {
  // FLOOR: a real briefing generation against a live CLI takes tens of seconds. Measured on this
  // machine's own runs, well over 3s — the mutant value that left the suite green.
  expect(TIMEOUT_MS).toBeGreaterThan(30_000);
  // CAP: the agent ticks every 10 minutes; a ceiling at or beyond that can overlap the next tick.
  expect(TIMEOUT_MS).toBeLessThanOrEqual(300_000);
  // RELATIONSHIP: the post-exit flush window must not approach the child ceiling, or a hung provider
  // is waited on twice. (The stricter SECURITY invariant — flushWindowMs(false,{}) > failFastMs —
  // is pinned separately in provider.incomplete-read.test.ts and is deliberately not duplicated.)
  expect(flushWindowMs(false, {})).toBeLessThan(TIMEOUT_MS / 2);
});

test("proc's DEFAULT_TIMEOUT_MS mirrors git's, since it runs the same binary over the same repos", () => {
  // Already pinned elsewhere (measured 1 red), so this asserts only the RELATIONSHIP the comment in
  // proc.ts claims — that the two ceilings track each other. If one is re-tuned and the other is not,
  // the audit and the app disagree about how long a repo is allowed to take.
  expect(DEFAULT_TIMEOUT_MS).toBe(GIT_TIMEOUT_MS);
});
