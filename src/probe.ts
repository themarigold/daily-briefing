// src/probe.ts — C1/B5, the bounded fail-open capability probe.
//
// WHY PROBE AT ALL: an unknown flag is FATAL to most CLIs. Guessing wrong doesn't degrade the
// briefing, it destroys it — every morning, silently, on an unattended launchd run. So we ask the
// configured CLI what it supports and inject only that.
//
// WHY IT'S SAFE TO TRUST: `--help` is not a complete oracle (claude 2.1.220 hides ~45 flags), but the
// error is ONE-DIRECTIONAL — listed ⟹ accepted. A hidden flag is therefore a false NEGATIVE, and the
// probe degrades to today's unhardened behaviour rather than to a broken one. Every failure mode below
// resolves the same way: inject nothing, say why.
import { ProviderError } from "./types";
import { drain, raceFlush, sinkText } from "./stream";
import { withoutKeys } from "./provider";

export const PROBE_MS = 10_000;
export const PROBE_FLUSH_MS = 1_000;
export const MAX_HELP_BYTES = 256 * 1024;

export type Capabilities =
  | { kind: "ok"; supported: ReadonlySet<string> }
  | { kind: "anomaly"; reason: string };

export type ProbeOptions = {
  argv?: string[];          // defaults to ["--help"]; tests drive `sh -c …` through here
  probeMs?: number;
  flushMs?: number;
  maxBytes?: number;
  /** Variable names withheld from the probe's child, mirroring the generate call. The probe runs the
   *  user's configured binary, so a claim that the tool withholds a credential from "the CLI it
   *  spawns" is only true if this spawn honours it too. */
  envDelete?: readonly string[];
  /** Extra variables merged over `process.env` for the probe's child, mirroring the generate call.
   *  ⚠ EXISTS FOR TESTABILITY, and that is a sufficient reason here: without it a test cannot plant a
   *  sentinel key in the probe's environment, so the only way to exercise `envDelete` above is against
   *  whatever the developer's machine happens to export. That test passes vacuously wherever no key is
   *  set — i.e. on CI — and on a machine that does have one it puts the REAL credential into the
   *  fixture's output. Both were true of the first version of this. */
  env?: Record<string, string>;
};

/** Word-boundaried, so `--toolsy` does not read as support for `--tools`. `=` and `,` count as
 *  boundaries because help text writes `--tools=<list>`; we inject `--tools=` but help lists `--tools`. */
function lists(help: string, flag: string): boolean {
  const esc = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${esc}(?![\\w-])`).test(help);
}

/**
 * Ask `cli` what flags it supports. NEVER throws and never rejects: every failure becomes
 * `{kind:"anomaly"}`. That is a hard requirement, not defensiveness — the caller memoises this
 * promise, and a rejected memo with no awaiter terminates the Bun process (exit 1), which would turn
 * one bug here into permanent silent non-delivery.
 */
export async function probeCapabilities(
  cli: string, wanted: readonly string[], opts: ProbeOptions = {},
): Promise<Capabilities> {
  // Nothing to ask about ⇒ don't spawn. Keeps the probe free while the flag table is empty, and means
  // a caller that has disabled every flag pays nothing.
  if (wanted.length === 0) return { kind: "ok", supported: new Set() };

  const probeMs = opts.probeMs ?? PROBE_MS;
  const flushMs = opts.flushMs ?? PROBE_FLUSH_MS;
  const maxBytes = opts.maxBytes ?? MAX_HELP_BYTES;

  try {
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      // `stdin: "ignore"` so a CLI that reads stdin on --help can't block waiting for input.
      proc = Bun.spawn([cli, ...(opts.argv ?? ["--help"])], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: probeMs, killSignal: "SIGKILL",
        // MERGE-then-remove, never a bare object: `provider.ts` records that handing `Bun.spawn` a
        // replacement env "was measured leaving HOME=UNSET, which kills the provider's auth".
        ...(opts.env !== undefined || opts.envDelete?.length
          ? { env: withoutKeys({ ...process.env, ...opts.env }, opts.envDelete) }
          : {}),
      });
    } catch (e: unknown) {
      return { kind: "anomaly", reason: `could not run \`${cli} --help\` (${(e as { code?: string })?.code ?? "spawn error"})` };
    }

    // PARALLEL drain with INDEPENDENT per-stream accumulation — not one combined promise. Measured on
    // the real pathology (help on stderr, a grandchild holding stdout): parallel recovered 16,034 B and
    // 4/4 flags; sequential/combined recovered 0 B and 0/4, silently concluding the CLI supports
    // nothing. Same ordering rule as the provider: start the reads, await exit, THEN race a flush
    // window — an un-raced read on a held pipe never sees EOF.
    // ⚠ `maxBytes` MUST go to BOTH streams. It used to be a required positional, which forced it; as
    // an options bag, omitting it on one side is tsc-clean and silent. Each side is now pinned
    // SEPARATELY — stdout by the "output is capped" test, stderr by T2.7 — and T2.7 exists precisely
    // because that asymmetry was unguarded. (An earlier revision of this comment claimed a one-sided
    // omission was NOT caught; T2.7 falsified it in the same commit. Corrected rather than left.)
    // Help routinely arrives on stderr, so an uncapped stderr is a real memory hole, not a nicety.
    const o = drain(proc.stdout, { maxBytes }), e = drain(proc.stderr, { maxBytes });
    await proc.exited;
    await raceFlush(o, e, flushMs);

    if (proc.exitCode === null) {
      return { kind: "anomaly", reason: `\`${cli} --help\` did not finish within ${probeMs}ms (killed)` };
    }
    if (proc.exitCode !== 0) {
      return { kind: "anomaly", reason: `\`${cli} --help\` exited ${proc.exitCode}` };
    }
    // An incomplete read is an ANOMALY, not "the flag is unsupported". A flag missing from a
    // partially-read help text is indistinguishable from a flag the CLI doesn't have, so the
    // conservative reading is the only safe one. Truncation at the cap is deliberately NOT an
    // anomaly — see stream.ts's soft-cap note; it degrades to a false negative, which fails open.
    //
    // ⚠ WHAT CHANGED IN F1, and it is NOT the guard: the guard's logic is untouched, but the point at
    // which probe OBSERVES it moved across a microtask boundary (`await raceFlush` above). A previous
    // revision of this note argued the `!truncated` clause was equivalent to the `complete` one and
    // that "no test can kill it". Both halves are now wrong:
    //   - `truncated` and `complete` are no longer redundant here. `stream.ts` sets `complete` only
    //     when NEITHER canceled nor truncated, so a truncated read is `complete: false,
    //     truncated: true` and this guard must test both to let it through as `ok`.
    //   - a test does kill it: deleting the `!o.sink.truncated` term turns the "output is capped"
    //     test below red, because a truncated help would then be reported as a held pipe.
    // The reason the observation point is safe is `stream.ts`'s freeze: `canceled` gates BOTH
    // `complete` and `truncated`, so no late chunk can flip either field between raceFlush's abandon
    // and these two reads.
    if (!o.sink.complete && !o.sink.truncated) {
      return { kind: "anomaly", reason: `\`${cli} --help\` stdout never reached EOF (a child process is holding the pipe)` };
    }
    if (!e.sink.complete && !e.sink.truncated) {
      return { kind: "anomaly", reason: `\`${cli} --help\` stderr never reached EOF (a child process is holding the pipe)` };
    }

    // Search BOTH streams: some CLIs print help to stderr, and we cannot know which in advance.
    // `sinkText` decodes once over the concatenated bytes; the old incremental `{stream:true}` decode
    // was equivalent on the EOF and truncation paths. On the ERROR path they differ slightly — the old
    // code skipped its trailing `decode()` flush and dropped a dangling multi-byte tail, where this
    // emits U+FFFD — which is unobservable, because an errored read leaves `complete` false and the
    // guard above has already returned an anomaly without reading any text.
    const help = `${sinkText(o.sink)}\n${sinkText(e.sink)}`;
    if (!help.trim()) return { kind: "anomaly", reason: `\`${cli} --help\` produced no output` };

    const supported = new Set<string>();
    for (const f of wanted) if (lists(help, f)) supported.add(f);
    return { kind: "ok", supported };
  } catch (e: unknown) {
    // Catch-all: this function's contract is "never rejects". Anything unforeseen becomes an anomaly.
    if (e instanceof ProviderError) return { kind: "anomaly", reason: e.message };
    return { kind: "anomaly", reason: `probing \`${cli} --help\` failed unexpectedly: ${e instanceof Error ? e.message : String(e)}` };
  }
}
