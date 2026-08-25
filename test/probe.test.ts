// test/probe.test.ts
//
// C1/B5 — the bounded, fail-open capability probe. We ask the configured CLI `--help` and inject only
// the flags it actually lists, because an UNKNOWN FLAG IS FATAL to most CLIs: guessing wrong doesn't
// degrade the briefing, it destroys it, every morning, silently.
//
// `--help` is not a complete oracle (~45 hidden flags on claude 2.1.220), but the error is
// ONE-DIRECTIONAL — listed ⟹ accepted — so a hidden flag is a false negative and the probe fails
// OPEN, to today's unhardened behaviour. That asymmetry is the whole reason this is safe.
//
// BE CLEAR ABOUT WHAT IS PROVEN HERE: "listed ⟹ accepted" is a property of the real `claude` binary and
// NOTHING in this file tests it. Every fake CLI below accepts whatever it is given, so the fixtures model
// the converse at best (see pickyClaude in harden.ladder.test.ts, which models listed-but-rejected — the
// honest and useful half, and the reason the B6 ladder exists). The premise was verified OUT of band, by
// a real-provider ship-smoke against claude 2.1.220: all four flags listed, all four accepted, and
// `--tools=` observed actually gating the built-in tools in 0-of-3 hardened runs. Treat it as a stated,
// separately-measured assumption — not something this suite establishes.
//
// Real subprocesses throughout (`sh`), matching the house style: the properties under test are about
// what a child process actually does to our pipes, which a spawn spy cannot model.
import { test, expect } from "bun:test";
import { probeCapabilities } from "../src/probe";

/** Fast timings so the suite doesn't pay the production 10s/1s windows. */
const fast = { probeMs: 3_000, flushMs: 150 };
const WANTED = ["--tools", "--setting-sources", "--strict-mcp-config"];

const probeSh = (script: string, wanted = WANTED, opts = {}) =>
  probeCapabilities("sh", wanted, { argv: ["-c", script], ...fast, ...opts });

test("finds the wanted flags listed on STDOUT", async () => {
  const r = await probeSh("echo '  --tools <names>   --setting-sources <s>'");
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") return;
  expect(r.supported.has("--tools")).toBe(true);
  expect(r.supported.has("--setting-sources")).toBe(true);
  expect(r.supported.has("--strict-mcp-config")).toBe(false);   // genuinely absent
});

test("finds the wanted flags listed on STDERR — help goes there for some CLIs", async () => {
  const r = await probeSh("echo '--tools --strict-mcp-config' >&2");
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") return;
  expect(r.supported.has("--tools")).toBe(true);
  expect(r.supported.has("--strict-mcp-config")).toBe(true);
});

test("help on STDERR while a grandchild HOLDS STDOUT is an anomaly — but stderr WAS read independently", async () => {
  // Two properties in one, and a genuine tension in the spec worth recording here.
  //
  // B5 measured this exact pathology recovering "16,034 B, 4/4 flags" under a parallel drain versus
  // "0 B, 0/4" under a combined read — which reads like an argument for USING the recovered flags. But
  // B5 also states, explicitly and with reasoning, that an incomplete read is an ANOMALY and not an
  // inject-anyway: a flag missing from a partially-read help text is indistinguishable from a flag the
  // CLI does not support. The anomaly rule wins, because it is the conservative direction and the one
  // the spec decided deliberately. So: anomaly, inject nothing.
  //
  // The measurement still describes something real, and this test pins it: the reason must name STDOUT
  // specifically and NOT stderr. That is only knowable because the two streams are accumulated
  // INDEPENDENTLY — a single combined promise would have neither value and could not tell which stream
  // failed, so it could not even diagnose the machine. `sleep & exit 0`: the backgrounded child
  // inherits stdout and holds it open after sh itself exits.
  // ⚠ `2>/dev/null` on the backgrounded child is LOAD-BEARING and was missing. Without it `sleep 5 &`
  // inherits BOTH pipes, so stderr never EOFs either — measured: `stderr: complete=false,
  // canceled=true`. The assertions below then pinned only the ORDER the two gates are written in, not
  // which stream is which, and swapping the drains at probe.ts's `drain(proc.stdout…)` call was
  // tsc-clean and left the suite green — shipping an anomaly message that names the wrong stream, on
  // the unattended path this module exists to diagnose. With stderr redirected, the grandchild holds
  // stdout ALONE and the correspondence is real.
  const r = await probeSh("echo '--tools --setting-sources' >&2; sleep 5 2>/dev/null & exit 0");
  expect(r.kind).toBe("anomaly");
  if (r.kind !== "anomaly") return;
  expect(r.reason).toContain("stdout");
  expect(r.reason).not.toContain("stderr");   // stderr completed fine — the independence property
});

test("matches on WORD BOUNDARIES — `--toolsy` must not satisfy `--tools`", async () => {
  // We inject `--tools=` but help lists `--tools`, so the match is on the bare token. A substring
  // match would read `--toolsy` as support for `--tools` and inject a flag the CLI rejects — fatal.
  const r = await probeSh("echo '--toolsy --setting-sources-extra'");
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") return;
  expect(r.supported.has("--tools")).toBe(false);
  expect(r.supported.has("--setting-sources")).toBe(false);
});

test("`--tools=value` in help DOES satisfy `--tools` (the `=` form is a boundary)", async () => {
  const r = await probeSh("echo '--tools=<list>'");
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") return;
  expect(r.supported.has("--tools")).toBe(true);
});

test("a NONZERO exit is an anomaly — inject nothing", async () => {
  const r = await probeSh("echo '--tools'; exit 2");
  expect(r.kind).toBe("anomaly");
});

test("EMPTY output is an anomaly — a CLI that printed nothing tells us nothing", async () => {
  const r = await probeSh("exit 0");
  expect(r.kind).toBe("anomaly");
});

test("a SPAWN error is an anomaly, never a throw", async () => {
  // The probe must never reject: it runs inside a memo whose rejection would kill the process.
  const r = await probeCapabilities("definitely-not-a-real-cli-xyz", WANTED, fast);
  expect(r.kind).toBe("anomaly");
});

test("a TIMEOUT is an anomaly and is BOUNDED — a hanging --help cannot wedge the morning", async () => {
  const t0 = Date.now();
  const r = await probeCapabilities("sh", WANTED, { argv: ["-c", "sleep 30"], probeMs: 400, flushMs: 100 });
  expect(r.kind).toBe("anomaly");
  expect(Date.now() - t0).toBeLessThan(5_000);
});

test("an INCOMPLETE read is an anomaly, NOT 'the flag is unsupported'", async () => {
  // The conservative reading is the only safe one: a flag missing from a partially-read help text is
  // indistinguishable from a flag the CLI does not support. Treating it as absent would be a silent
  // false negative; treating it as an anomaly means we inject nothing and say so.
  // Here the help never arrives, and a grandchild holds stdout open past the flush window.
  const r = await probeSh("sleep 5 & exit 0");
  expect(r.kind).toBe("anomaly");
});

test("the anomaly reason is human-readable and names the cause", async () => {
  const r = await probeSh("echo boom >&2; exit 3");
  expect(r.kind).toBe("anomaly");
  if (r.kind !== "anomaly") return;
  expect(r.reason.length).toBeGreaterThan(10);
  expect(r.reason).toMatch(/exit|status|3/i);
});

test("a wanted list of ZERO flags short-circuits without spawning anything", async () => {
  // Commit 2 ships the machinery with an empty flag table, so this is the path that runs until B4
  // lands. It must cost nothing — no subprocess per run for a result nobody uses yet.
  const t0 = Date.now();
  const r = await probeCapabilities("definitely-not-a-real-cli-xyz", [], fast);
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") return;
  expect(r.supported.size).toBe(0);
  expect(Date.now() - t0).toBeLessThan(200);   // never spawned: a bad cli would otherwise anomaly
});

test("output is capped, so a pathological --help cannot exhaust memory", async () => {
  // Soft by design: the cap is checked AFTER appending a chunk, so it overshoots by up to one read
  // chunk (measured ~150 KB over a 256 KB cap). `cancel()` is best-effort, not a kill — the real
  // bound on a SIGPIPE-ignoring child is the spawn timeout.
  const r = await probeCapabilities("sh", WANTED, {
    argv: ["-c", "yes 0123456789abcdef | head -c 400000; echo '--tools'"],
    probeMs: 5_000, flushMs: 150, maxBytes: 4_096,
  });
  // Assert the FAIL-OPEN invariant, not a tautology. The previous version asserted
  // `r.kind === "ok" || r.kind === "anomaly"` — which is every possible value of the union, so it could
  // not fail — and guarded its only real assertion behind `if (r.kind === "ok")`, exactly the branch a
  // mutant avoids. Measured: making truncation fall into the incomplete-read branch (so an over-cap help
  // injects NOTHING and warns daily instead of degrading to a false negative) survived the whole suite.
  expect(r.kind).toBe("ok");                       // truncation is NOT an anomaly — that is the invariant
  if (r.kind !== "ok") return;
  expect(r.supported.has("--tools")).toBe(false);  // ...and the past-the-cap flag is simply not found
});

// ── F1 M2: probe converged onto src/stream.ts's `drain` + `raceFlush` ────────────────────────────
//
// ⚠ DELIBERATE DEPARTURE FROM THIS FILE'S HOUSE STYLE. Everything above drives a real `sh -c` child,
// on the stated grounds that "the properties under test are about what a child process actually does
// to our pipes, which a spawn spy cannot model". That holds for those properties. It cannot hold for
// these: a real child cannot be made to error a pipe MID-STREAM on demand, and asserting that a held
// reader was RELEASED requires observing the stream's own `cancel()` hook, which a real pipe does not
// expose. Both need a fake. The sibling suites reached the same conclusion —
// test/git.incomplete-read.test.ts:34 and test/proc.incomplete-read.test.ts:268 use exactly these two
// shapes — so this is the repo's existing answer to the problem, not a new one.
//
// WHY THESE EXIST AT ALL: before F1, `probe.ts` had ZERO abandonment coverage (the only `cancel` in
// this file was a comment), and it was one of the two sites where weakening `||` to `&&` in the
// abandon guard would have passed the entire suite silently.
import { spyOn } from "bun:test";
import { MAX_HELP_BYTES } from "../src/probe";

function fakeSpawn(opts: { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exitCode?: number }) {
  return {
    stdout: opts.stdout, stderr: opts.stderr,
    exited: Promise.resolve(opts.exitCode ?? 0),
    exitCode: opts.exitCode ?? 0,
    signalCode: null,
    kill() {},
  } as unknown as ReturnType<typeof Bun.spawn>;
}

function closedStream(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); c.close(); } });
}

/** Never EOFs, and reports whether its reader was really cancelled. Copied (not imported) from
 *  proc.incomplete-read.test.ts:268 — module-local there, and importing one test file into another
 *  re-registers its tests. */
function heldWithCancelFlag(): { stream: ReadableStream<Uint8Array>; wasCancelled: () => boolean } {
  let cancelled = false;
  const enc = new TextEncoder();
  return {
    stream: new ReadableStream<Uint8Array>({
      async pull(c) { await Bun.sleep(5); c.enqueue(enc.encode("noise\n")); },
      cancel() { cancelled = true; },
    }),
    wasCancelled: () => cancelled,
  };
}

test("T2.6a — a held STDOUT reader is RELEASED, not left attached (stderr complete)", async () => {
  // The one-sided shape is required: with both streams held, `||` and `&&` are indistinguishable.
  // Unreleased, a grandchild that keeps writing grows the sink for the life of the process.
  const held = heldWithCancelFlag();
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: held.stream, stderr: closedStream("--tools\n") }));
  try {
    const r = await probeCapabilities("anything", WANTED, fast);
    expect(r.kind).toBe("anomaly");          // stdout never reached EOF
    expect(held.wasCancelled()).toBe(true);  // ...and its reader was released
  } finally { spy.mockRestore(); }
});

test("T2.6b — a held STDERR reader is RELEASED even though stdout completed (the mirror)", async () => {
  // Not redundant with T2.6a: this is the only direction that catches a call site passing the same
  // drain handle twice — `raceFlush(o, o, ms)` is tsc-clean and plausible under copy-paste.
  const held = heldWithCancelFlag();
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: closedStream("--tools\n"), stderr: held.stream }));
  try {
    const r = await probeCapabilities("anything", WANTED, fast);
    expect(r.kind).toBe("anomaly");          // stderr never reached EOF
    expect(held.wasCancelled()).toBe(true);
  } finally { spy.mockRestore(); }
});

test("T2.5 — a mid-stream READ ERROR is an anomaly (kind only; the message is deliberately NOT pinned)", async () => {
  // Converging on `drain` gives probe `sink.errored` for free, but probe deliberately does not consume
  // it: the gate is `complete`, and an errored read leaves `complete` false, so it routes to the same
  // anomaly. Behaviour is identical to the pre-F1 bare `catch {}`.
  //
  // ⚠ Only `kind` is asserted, ON PURPOSE. The message says "a child process is holding the pipe",
  // which is the WRONG CAUSE for a broken read — git.ts:37-56 exists precisely to reject that
  // conflation. Pinning the text here would cement the wrong diagnosis and make the deferred fix
  // harder to land. Fail-closed is the property that matters, so fail-closed is what is pinned.
  const enc = new TextEncoder();
  // ⚠ TWO fixture corrections, both found by checkpoint review after the first version SHIPPED VACUOUS.
  //  (a) stderr must carry HELP, not "". With both streams empty the probe returns an anomaly via
  //      `!help.trim()` ("produced no output") no matter what the errored read does — measured: a
  //      mutant making an errored read set `complete = true` (fail-OPEN) left the whole probe suite
  //      green. With help on stderr, the errored-stdout gate is the ONLY route to an anomaly.
  //  (b) error from `pull()`, not `start()`. Enqueue-then-error inside `start()` resets the queue per
  //      the Streams spec, so no bytes are ever delivered — measured `chunks: 0` — which means the
  //      partial-bytes-then-error case this test is named for was never exercised.
  const erroring = new ReadableStream<Uint8Array>({
    async pull(c) { c.enqueue(enc.encode("--to")); await Bun.sleep(1); c.error(new Error("EIO")); },
  });
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: erroring, stderr: closedStream("--tools --setting-sources\n") }));
  try {
    const r = await probeCapabilities("anything", WANTED, fast);
    expect(r.kind).toBe("anomaly");
  } finally { spy.mockRestore(); }
});

test("T2.7 — the byte cap is applied to STDERR too, not only stdout", async () => {
  // MUTATION this kills: `drain(proc.stderr)` with the `{ maxBytes }` argument dropped. That is
  // tsc-clean and silent, and it is quiet in the worst possible way — dropping the cap on BOTH streams
  // is caught by "output is capped" above, so a smoke test would report that the cap works.
  // Help routinely arrives on stderr (see the stderr tests above), so an uncapped stderr is the real
  // memory-exhaustion hole this cap exists to close.
  // ⚠ MULTI-CHUNK, and that is load-bearing. The cap is SOFT — checked after appending — so a
  // single-chunk fixture delivers the whole payload before the cap can trip, `--tools` lands inside
  // it, and the test fails for a reason that has nothing to do with stderr. (Measured: the
  // single-chunk version of this test failed exactly that way.) The real `sh -c` cap test above
  // avoids this by piping `yes | head -c`, which arrives in many OS-sized chunks.
  const enc = new TextEncoder();
  const chunked = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 600; i++) c.enqueue(enc.encode("0123456789"));   // 6,000 B past a 4,096 B cap
      c.enqueue(enc.encode("\n--tools\n"));                                 // arrives only if uncapped
      c.close();
    },
  });
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: closedStream(""), stderr: chunked }));
  try {
    const r = await probeCapabilities("anything", WANTED, { ...fast, maxBytes: 4_096 });
    expect(r.kind).toBe("ok");                       // truncation is not an anomaly
    if (r.kind !== "ok") return;
    expect(r.supported.has("--tools")).toBe(false);  // ...and the past-the-cap flag is not found
  } finally { spy.mockRestore(); }
});

test("T2.7b — the PRODUCTION default cap is MAX_HELP_BYTES, driven behaviourally", async () => {
  // ⚠ The first version of this test asserted only `MAX_HELP_BYTES === 256 * 1024` while its NAME
  // and comment claimed to guard the production default per-stream. Measured: changing
  // `opts.maxBytes ?? MAX_HELP_BYTES` to `?? 4_096` shrinks the real default 64x and left the suite
  // at 18 pass / 0 fail. A constant-equality assertion cannot see which constant the code uses.
  // Driven through probeCapabilities with NO maxBytes override instead: a flag before 256 KB is
  // found, one after it is not.
  // ⚠ The DISCRIMINATOR must sit BETWEEN the two candidate caps. My first fixture put `--tools`
  // before both and `--strict-mcp-config` after both, so a shrunken 4 KB default and the real 256 KB
  // one truncate at the same OBSERVABLE point — the red-check came back GREEN and the test was
  // rewritten. `--setting-sources` now sits at ~100 KB: inside the real default, past a shrunken one.
  const enc = new TextEncoder();
  const big = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode("--tools\n"));                                   // before any cap
      for (let i = 0; i < 12; i++) c.enqueue(enc.encode("z".repeat(8_192))); // ~98 KB
      c.enqueue(enc.encode("\n--setting-sources\n"));                      // ~100 KB: THE discriminator
      for (let i = 0; i < 30; i++) c.enqueue(enc.encode("z".repeat(8_192))); // past 256 KB
      c.enqueue(enc.encode("\n--strict-mcp-config\n"));                    // past the real cap
      c.close();
    },
  });
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: big, stderr: closedStream("") }));
  try {
    const r = await probeCapabilities("anything", WANTED, { probeMs: 3_000, flushMs: 150 });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.supported.has("--tools")).toBe(true);                 // before any cap
    expect(r.supported.has("--setting-sources")).toBe(true);       // ~100 KB in -> the default is NOT small
    expect(r.supported.has("--strict-mcp-config")).toBe(false);    // past 256 KB -> the default IS ~256 KB
  } finally { spy.mockRestore(); }
  expect(MAX_HELP_BYTES).toBe(256 * 1024);
});

test("T2.7c — probe passes its FLUSH window to raceFlush, not some other timing constant", async () => {
  // Unpinned until now, and the same hazard class the provider guards with a source scan: passing
  // `probeMs` instead of `flushMs` is tsc-clean and leaves the suite green while turning the 1 s
  // post-exit flush window into the 10 s PROBE_MS — up to 10 extra seconds on every held-pipe
  // morning run. Measured: the mutation left 18 pass / 0 fail and moved suite wall-clock 1.05s -> 12.4s.
  // Pinned by ELAPSED TIME with the two constants set far apart, so the wrong one is unmistakable.
  const held = heldWithCancelFlag();
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: held.stream, stderr: closedStream("") }));
  try {
    const t0 = Date.now();
    const r = await probeCapabilities("anything", WANTED, { probeMs: 8_000, flushMs: 50 });
    const ms = Date.now() - t0;
    expect(r.kind).toBe("anomaly");
    expect(ms).toBeLessThan(2_000);   // flushMs=50 honoured; probeMs=8000 would blow this
  } finally { spy.mockRestore(); }
});

test("T2.7d — a TRUNCATED read still RELEASES its reader (the cap is memory-safe end to end)", async () => {
  // stream.ts documents the cap as memory-safe only because `truncated` suppresses `complete`, so
  // raceFlush's `||` gate abandons and the reader is released. Nothing pinned the release half:
  // measured, restricting the abandon to the timer-lost branch — which skips exactly the truncated
  // and errored cases — left the suite at 930 pass / 0 fail. Without the release a capped stream
  // whose producer keeps writing is read forever, which is the very exhaustion the cap prevents.
  const held = heldWithCancelFlag();
  const spy = spyOn(Bun, "spawn").mockImplementation(() =>
    fakeSpawn({ stdout: held.stream, stderr: closedStream("--tools\n") }));
  try {
    const r = await probeCapabilities("anything", WANTED, { probeMs: 3_000, flushMs: 100, maxBytes: 12 });
    expect(r.kind).toBe("ok");               // truncation is not an anomaly
    expect(held.wasCancelled()).toBe(true);  // ...and the capped reader was released
  } finally { spy.mockRestore(); }
});
