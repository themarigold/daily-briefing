// Checkpoint 2 — detection. Every negative here pins a specific way the feature could bench a healthy
// account or fail to fire; the positives are built from the CAPTURED bytes, never hand-typed, because
// the real message carries a U+00B7 separator that a retyped fixture loses.
import { describe, expect, test } from "bun:test";
import { limitMatch, USAGE_LIMIT_RE, withRetry, withHardeningLadder, failFastMs } from "../src/provider";
import { ProviderError } from "../src/types";

// Byte-for-byte the live CLI's output (od -c verified: "\302\267" separator, ASCII apostrophe).
const REAL = "You've hit your weekly limit · resets Aug 26 at 10pm (America/Los_Angeles)";

describe("limitMatch — the shape gate", () => {
  test("the real captured message matches, and the returned line is the whole sentence", () => {
    expect(limitMatch(REAL, "")).toBe(REAL);
  });

  test("matches on stderr too, not just stdout", () => {
    expect(limitMatch("", REAL)).toBe(REAL);
  });

  test("session wording matches — the session wall is the more frequent one", () => {
    const s = "You've hit your session limit · resets at 3pm";
    expect(limitMatch(s, "")).toBe(s);
  });

  // The false-positive class: the briefing is generated FROM logs containing this sentence (59
  // occurrences measured in briefing.log), and the audit judge quotes it back. Matching the phrase
  // without the shape gate would bench a healthy account for days on any unrelated nonzero exit.
  test("a 4KB briefing body QUOTING the sentence does NOT match", () => {
    const body = "RESUME\n" + "x".repeat(4000) + "\n" + REAL;
    expect(limitMatch(body, "")).toBeUndefined();
  });

  test("a short stream with the match at its START does NOT match", () => {
    // Caught only by the tail rule — the length rule alone passes this one.
    expect(limitMatch(REAL + "\n" + "other output\n".repeat(20), "")).toBeUndefined();
  });

  test("near-miss wordings do NOT match", () => {
    expect(limitMatch("Error: rate limit exceeded, try again", "")).toBeUndefined();
    expect(limitMatch("context token limit reached", "")).toBeUndefined();
    expect(limitMatch("your limit is not the issue here", "")).toBeUndefined();
  });

  test("empty streams do not match", () => {
    expect(limitMatch("", "")).toBeUndefined();
  });

  test("the regex itself is insensitive to the separator and apostrophe forms", () => {
    expect(USAGE_LIMIT_RE.test("You've hit your weekly limit - resets later")).toBe(true);
    expect(USAGE_LIMIT_RE.test("You’ve hit your weekly limit · resets later")).toBe(true);
  });
});

describe("retry suppression — BOTH gates, not just withRetry", () => {
  const limitErr = () => { const e = new ProviderError("usage-limit", "limited"); e.durationMs = 4500; return e; };

  test("withRetry treats usage-limit as permanent: zero retries", async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw limitErr(); }, [1, 1], async () => {})).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("…while nonzero-exit still runs the ladder (the contrast that makes the test meaningful)", async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new ProviderError("nonzero-exit", "x"); }, [1, 1], async () => {}))
      .rejects.toThrow();
    expect(calls).toBe(3);
  });

  // The gate that matters most: the ladder wraps withRetry, and a limit returns FAST (~4.5s measured,
  // under the 5000ms failFastMs), so the duration gate does not catch it. Without this, one limit costs
  // three spawns per tick instead of one — and a rung-2 success would latch hardening off.
  test("withHardeningLadder rethrows usage-limit without running either rung", async () => {
    let once = 0, bare = 0;
    const hp = {
      runtimeWarnings: [] as string[],
      hardeningActive: () => true,
      disableHardening: () => { throw new Error("must not latch hardening off on a usage limit"); },
      probeWithoutHardening: async <T>(fn: () => Promise<T>) => { bare++; return fn(); },
    };
    await expect(withHardeningLadder(hp, async () => { throw limitErr(); }, async () => { once++; return "x"; }, 300_000))
      .rejects.toThrow();
    expect(once).toBe(0);
    expect(bare).toBe(0);
  });

  test("a fast nonzero-exit still engages the ladder — proving the gate is code-specific", async () => {
    let once = 0;
    const e = new ProviderError("nonzero-exit", "x"); e.durationMs = 10;
    const hp = {
      runtimeWarnings: [] as string[],
      hardeningActive: () => true,
      disableHardening: () => {},
      probeWithoutHardening: async <T>(fn: () => Promise<T>) => fn(),
    };
    const out = await withHardeningLadder(hp, async () => { throw e; }, async () => { once++; return "recovered"; }, 300_000);
    expect(once).toBe(1);
    expect(out).toBe("recovered");
  });

  test("the measured limit latency really is under the gate", () => {
    expect(4500).toBeLessThan(failFastMs(300_000));   // 4.4-4.5s measured vs min(5000, timeoutMs/10)
  });
});
