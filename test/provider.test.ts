// test/provider.test.ts
import { test, expect } from "bun:test";
import { BYOCliProvider } from "../src/provider";
import { ProviderError } from "../src/types";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("BYOCliProvider pipes prompt via stdin and returns stdout", async () => {
  const p = new BYOCliProvider({ cli: "cat", argv: [], promptVia: "stdin" });
  expect(await p.generate("hello world")).toBe("hello world");
});

test("throws missing-binary for a nonexistent CLI", async () => {
  const p = new BYOCliProvider({ cli: "definitely-not-a-real-cli-xyz", argv: [], promptVia: "stdin" });
  await expect(p.generate("x")).rejects.toMatchObject({ code: "missing-binary" });
});

test("throws nonzero-exit when the CLI fails", async () => {
  const p = new BYOCliProvider({ cli: "sh", argv: ["-c", "exit 3"], promptVia: "stdin" });
  await expect(p.generate("x")).rejects.toBeInstanceOf(ProviderError);
});

test("nonzero-exit surfaces the CLI's STDOUT when stderr is empty (claude prints its error to stdout — audit 2026-07-11)", async () => {
  // The launchd exit-1 rendered as a blank 'claude exited 1:' because the message was built from
  // stderr only, and claude writes its diagnostic to stdout. A diagnostic-visibility regression test.
  const p = new BYOCliProvider({ cli: "sh", argv: ["-c", "echo 'Usage limit reached — resets 3am'; exit 1"], promptVia: "stdin" });
  const err = await p.generate("x").catch((e) => e);
  expect(err).toBeInstanceOf(ProviderError);
  expect(err.code).toBe("nonzero-exit");
  expect(err.message).toContain("Usage limit reached"); // the reason is no longer thrown away
});

test("nonzero-exit still prefers stderr when the CLI writes there", async () => {
  const p = new BYOCliProvider({ cli: "sh", argv: ["-c", "echo 'boom on stderr' 1>&2; exit 2"], promptVia: "stdin" });
  const err = await p.generate("x").catch((e) => e);
  expect(err.code).toBe("nonzero-exit");
  expect(err.message).toContain("boom on stderr");
});

test("throws empty-output when the CLI returns nothing", async () => {
  const p = new BYOCliProvider({ cli: "true", argv: [], promptVia: "stdin" });
  await expect(p.generate("x")).rejects.toMatchObject({ code: "empty-output" });
});

test("promptVia: arg appends the prompt as an argv entry", async () => {
  const p = new BYOCliProvider({ cli: "echo", argv: [], promptVia: "arg" });
  expect(await p.generate("hello arg mode")).toBe("hello arg mode\n");
});

test("a non-ENOENT spawn failure (EACCES: cli points at a non-executable file) is NOT mislabeled missing-binary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dba-noexec-"));
  const notExecutable = join(dir, "not-a-cli");
  writeFileSync(notExecutable, "#!/bin/sh\necho hi\n");
  chmodSync(notExecutable, 0o644); // readable but NOT executable → spawn throws EACCES, not ENOENT
  const p = new BYOCliProvider({ cli: notExecutable, argv: [], promptVia: "stdin" });
  await expect(p.generate("x")).rejects.toBeInstanceOf(ProviderError);
  const err = await p.generate("x").catch((e) => e);
  expect(err.code).not.toBe("missing-binary");
});

test("timeout escalates to SIGKILL when the child ignores SIGTERM — a TERM-trapping child cannot hang the run", async () => {
  const p = new BYOCliProvider(
    { cli: "sh", argv: ["-c", 'trap "" TERM; echo started; sleep 30'], promptVia: "stdin" },
    { timeoutMs: 300, killGraceMs: 200, flushMs: 200 },
  );
  const t0 = Date.now();
  await expect(p.generate("x")).rejects.toThrow(/timed out/);
  expect(Date.now() - t0).toBeLessThan(4000); // bounded, not a 30s (or forever) hang
});

test("withRetry: retries transient ProviderErrors on the schedule, then succeeds", async () => {
  const { withRetry } = await import("../src/provider");
  const slept: number[] = [];
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new ProviderError("nonzero-exit", "flaky");
    return "ok";
  }, [5, 7], async (ms) => { slept.push(ms); });
  expect(result).toBe("ok");
  expect(calls).toBe(3);
  expect(slept).toEqual([5, 7]);
});

test("withRetry: missing-binary and non-ProviderError throw immediately (no retry)", async () => {
  const { withRetry } = await import("../src/provider");
  let calls = 0;
  await expect(withRetry(async () => { calls++; throw new ProviderError("missing-binary", "gone"); }, [5], async () => {}))
    .rejects.toThrow("gone");
  expect(calls).toBe(1);
  calls = 0;
  await expect(withRetry(async () => { calls++; throw new Error("plain bug"); }, [5], async () => {}))
    .rejects.toThrow("plain bug");
  expect(calls).toBe(1);
});

test("returns stdout even when a grandchild holds stderr open past the flush (no false empty-output) [Tier-3 #6]", async () => {
  // sh writes BRIEFING to stdout then exits; a backgrounded `sleep` (its stdout → /dev/null) inherits
  // ONLY stderr, holding that pipe open after sh exits. Old code assigned out/err together after
  // Promise.all([stdout,stderr]) → stderr never EOFs → out stayed "" → false empty-output even though
  // stdout was fully read. Originally fixed by assigning each stream independently; since C1 the same property comes from the sinks being readable mid-flight.
  const p = new BYOCliProvider(
    { cli: "sh", argv: ["-c", "echo BRIEFING; sleep 1 1>/dev/null &"], promptVia: "stdin" },
    { flushMs: 150 },
  );
  expect((await p.generate("x")).trim()).toBe("BRIEFING");
});

test("a signal-killed provider (not our timeout) is labeled killed/nonzero-exit, not 'timeout' [Tier-5]", async () => {
  // sh kills ITSELF with SIGKILL → exitCode null, signalCode SIGKILL, but we never fired our timeout.
  const p = new BYOCliProvider({ cli: "sh", argv: ["-c", "kill -KILL $$"], promptVia: "stdin" }, { timeoutMs: 5000, flushMs: 100 });
  await expect(p.generate("x")).rejects.toMatchObject({ code: "nonzero-exit" }); // NOT "timeout"
  await expect(p.generate("x")).rejects.toThrow(/killed|signal/i);
});
