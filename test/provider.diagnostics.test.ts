// test/provider.diagnostics.test.ts
//
// C1/A2 + C1/A3 — two live bugs in how a failing provider is classified and reported.
//
// A2 (provider.ts): `if (/not found|ENOENT/i.test(err)) throw missing-binary`. `withRetry` treats
//     missing-binary as PERMANENT — no retry, ever. So any wrapper CLI whose usage text happens to
//     contain "not found" gets zero retries and a misleading "CLI not found" on a binary that
//     exists. Gate it on exit 127 (the shell's real command-not-found code); a genuine missing
//     binary already throws ENOENT at spawn time, before this line is reachable.
//
// A3 (provider.ts): the diag prefers stderr and only falls back to stdout when stderr is EMPTY.
//     `claude` prints a benign advisory to stderr on otherwise-successful runs when an auth env
//     var is set, which makes `err.trim()` truthy — so the stdout fallback added to diagnose the
//     2026-07-11 launchd failure never fires, and the real message is thrown away again.
import { test, expect } from "bun:test";
import { BYOCliProvider } from "../src/provider";

const sh = (script: string) => new BYOCliProvider({ cli: "sh", argv: ["-c", script], promptVia: "stdin" });

test("A2: a wrapper whose usage text says 'not found' but exits != 127 is RETRYABLE, not missing-binary", async () => {
  // Real shape: a shim that rejects an unknown flag. Classifying this permanent means the morning
  // dies with no retry on a CLI that is installed and working.
  const p = sh("echo \"error: option '--tools' not found\" >&2; exit 1");
  await expect(p.generate("x")).rejects.toMatchObject({ code: "nonzero-exit" });
});

test("A2: exit 127 with 'not found' is STILL missing-binary (permanent) — the narrowing must not over-correct", async () => {
  const p = sh("echo 'sh: nosuchbinary: command not found' >&2; exit 127");
  await expect(p.generate("x")).rejects.toMatchObject({ code: "missing-binary" });
});

test("A2: exit 127 with NO output is RETRYABLE — the gate needs its text conjunct, not just the code", async () => {
  // The suite's only other 127 case also prints "command not found", so the two conjuncts were never
  // exercised apart and `exitCode === 127` alone survived all 456 tests. That matters: a wrapper which
  // propagates an inner 127 — ITS child missing, not the wrapper itself — would be classified
  // missing-binary, which withRetry treats as PERMANENT. Zero retries, morning lost, on a CLI that is
  // installed. A genuinely absent binary still ENOENTs at spawn time, so retryable is the safe call.
  await expect(sh("exit 127").generate("x")).rejects.toMatchObject({ code: "nonzero-exit" });
});

test("A2: a genuinely absent binary is still missing-binary (throws at spawn, before the heuristic)", async () => {
  const p = new BYOCliProvider({ cli: "definitely-not-a-real-cli-xyz", argv: [], promptVia: "stdin" });
  await expect(p.generate("x")).rejects.toMatchObject({ code: "missing-binary" });
});

test("A3: a nonzero exit surfaces STDOUT even when stderr carries a benign advisory", async () => {
  // The 2026-07-11 shape, reproduced: advisory on stderr, the actual cause on stdout.
  const p = sh("echo 'warning: connectors are disabled because an auth source is set' >&2; echo 'Usage limit reached — resets at 3pm'; exit 1");
  await expect(p.generate("x")).rejects.toThrow(/Usage limit reached/);
});

test("A3: stderr is still surfaced when it is the only output (no regression)", async () => {
  const p = sh("echo 'the real stderr failure' >&2; exit 2");
  await expect(p.generate("x")).rejects.toThrow(/the real stderr failure/);
});

test("A3: both streams appear when both are non-empty, so neither cause is lost", async () => {
  const p = sh("echo 'STDERR-SIDE' >&2; echo 'STDOUT-SIDE'; exit 1");
  const err: Error = await p.generate("x").then(
    () => { throw new Error("expected the provider call to reject"); },
    (e: Error) => e,
  );
  expect(err.message).toContain("STDERR-SIDE");
  expect(err.message).toContain("STDOUT-SIDE");
});

test("A3: '(no output)' is still used when the CLI says nothing at all", async () => {
  await expect(sh("exit 4").generate("x")).rejects.toThrow(/\(no output\)/);
});
