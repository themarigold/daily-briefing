// test/posture.test.ts
//
// C2 — the release gate must be able to state the security posture it measured.
//
// After C1, the provider can silently end up with MORE authority than the default: a capability probe
// anomaly, a `--help` that hides `--tools` (claude 2.1.220 hides ~45 flags), a user's own conflicting
// argv, `provider.harden: false`, or the B6 ladder latching hardening off mid-run. Every one of those
// raises a `runtimeWarnings` entry — and `scripts/eval.ts` and `scripts/audit.ts` currently drop all of
// them on the floor.
//
// The point is NOT that a partially-unhardened run produces different briefing text; on synthetic gold
// cases it very likely produces identical text. The point is provenance: **a gate that cannot state the
// posture it measured is not a gate.** An `EVAL.md` row recorded under unknown hardening cannot be
// compared against a later one.
//
// The judge providers are the sharper half: `eval.ts` and `audit.ts` each build a SECOND
// `hardenedProvider` that never passes through `runCore`, so unlike the main path — where `core.ts`
// folds warnings into `struct.warnings` — their warnings are genuinely lost rather than merely unprinted.
import { test, expect } from "bun:test";
import { postureLine, posturePhrase, mergeWarnings, isPostureWarning, TRUNCATION_SENTINEL } from "../src/eval/posture";

const HARD_OFF = "provider hardening is DISABLED by config (provider.harden: false) — surrendering tool gating (--tools=)";
const PARTIAL = "provider hardening is PARTIAL: --tools is not listed in `claude --help`, so it was not injected — note --tools is what disables the CLI's built-in tools";
const ANOMALY = "provider hardening flags not applied — `claude --help` exited 3";

test("a run with no warnings reports posture: full", () => {
  expect(posturePhrase([])).toBe("full");
});

test("an explicit opt-out is named as such, not lumped in with a failure", () => {
  // `harden: false` is a deliberate user choice; a probe anomaly is a malfunction. Reporting both as
  // "degraded" would make a considered configuration look like a broken machine.
  expect(posturePhrase([HARD_OFF])).toBe("off (by config)");
});

test("a partial or failed injection reports posture: degraded", () => {
  expect(posturePhrase([PARTIAL])).toBe("degraded");
  expect(posturePhrase([ANOMALY])).toBe("degraded");
});

test("an unrelated warning does NOT downgrade the posture", () => {
  // Only hardening-relevant warnings speak to posture. A repo-read warning is a different subject, and
  // treating every warning as a posture signal would make "degraded" meaningless.
  expect(posturePhrase(["skipped /tmp/repo: git's output could not be read to completion"])).toBe("full");
});

test("the posture line is compact and names WHAT was lost, not just that something was", () => {
  // It rides in EVAL.md's Notes column, which is prose and already carries the rule flags — so it must be
  // short, but "degraded" alone would leave the reader unable to compare two rows.
  const line = postureLine([PARTIAL]);
  expect(line).toContain("posture: degraded");
  expect(line).toContain("--tools");
  expect(line.length).toBeLessThan(200);
});

test("posture: full renders as a bare phrase — no noise on the overwhelmingly common path", () => {
  expect(postureLine([])).toBe("posture: full");
});

test("duplicate warnings across attempts collapse", () => {
  // withRetry can raise the same anomaly on all three attempts, and the eval runs 3 concurrent cases on
  // separate provider instances, so the same string arrives many times.
  const line = postureLine([ANOMALY, ANOMALY, ANOMALY]);
  expect(line.match(/exited 3/g) ?? []).toHaveLength(1);
});

test("mergeWarnings collects from a struct, a ProviderError, and a hardened provider — deduped", () => {
  // The three places a warning can hide, and the reason this helper exists: the main path stashes them in
  // `struct.warnings` (core.ts folds them), the failure path attaches them to the thrown ProviderError,
  // and a judge provider keeps them only on its own `runtimeWarnings`.
  const err = Object.assign(new Error("boom"), { warnings: [ANOMALY] });
  const merged = mergeWarnings(
    { warnings: [PARTIAL] },
    err,
    { runtimeWarnings: [PARTIAL, HARD_OFF] },
  );
  expect(merged).toContain(PARTIAL);
  expect(merged).toContain(ANOMALY);
  expect(merged).toContain(HARD_OFF);
  expect(merged.filter((w) => w === PARTIAL)).toHaveLength(1);
});

test("mergeWarnings tolerates absent, undefined and wrongly-shaped sources", () => {
  // It is called on an unknown caught value and on providers that may be plain `Provider` stubs, so it
  // must never throw — a reporting helper that crashes the reporter is worse than no report.
  expect(mergeWarnings(undefined, undefined, undefined)).toEqual([]);
  expect(mergeWarnings({}, new Error("no warnings prop"), { generate: async () => "" })).toEqual([]);
  expect(mergeWarnings("a string", 42, null)).toEqual([]);
  expect(mergeWarnings({ warnings: "not an array" }, { warnings: [1, 2] }, undefined)).toEqual([]);
});

// ── defects found by self-review before the review agents reported ──────────────────────────────────

test("EVERY hardening warning harden.ts can emit is recognised — enforced against the SOURCE", async () => {
  // My first marker list matched only 7 of the 14 warnings the provider stack actually emits, and every miss was
  // in the DANGEROUS direction: a run whose working directory was never narrowed would have reported
  // `posture: full`. The comment defending the substring approach claimed a parallel machine-readable
  // channel would be "two things to keep in sync" — but an ad-hoc list in a different file is exactly
  // that, and it had already drifted before it shipped. So the list lives next to the strings now, and
  // this test reads the SOURCE so the next added warning fails loudly instead of silently reporting full.
  // THREE shapes across ALL of src/, because the first version of this guard scanned only
  // `runtimeWarnings.push(<literal>)` in harden.ts and therefore checked 9 of 14 strings. The misses were
  // structural, not careless (it also matched `disableHardening(` literals, which is how it reached 9 and
  // not 8): `providerCwd` RETURNS its warnings as `warning:` properties that are pushed
  // later through a variable, so no literal appears at the push site; and one `disableHardening` literal
  // lives in provider.ts. A coverage guard with a blind spot is worse than none — it reports confidence
  // it has not earned, which is the same defect class it exists to catch.
  // Two regexes with DIFFERENT reach, because the shapes differ in how specific they are.
  // `runtimeWarnings.push` / `disableHardening` are unambiguous, so they are swept across all of src/ —
  // an emitter added to a third file must not escape. A bare `warning:` is NOT specific: globbing it
  // hoovered up `morningTime`, `networkProbeHosts` and even a fragment of this feature's own comment
  // (measured), turning the guard into a source of false failures. It is scoped to harden.ts, the one
  // place a hardening warning reaches a push site as a returned `warning:` property.
  // `this\.warn\(` joined the list when the provider gained a runtime warning of its own (C1). Adding
  // the alternation ALONE is not enough and gets it exactly wrong in both directions: with the warning
  // emitted through a helper the regex matches nothing and the guard silently keeps its blind spot,
  // and with it emitted inline the guard goes RED — because the assertion below demands every emitted
  // warning be a POSTURE warning, and this one deliberately is not. Hence the split: posture warnings
  // OR a short, named list of deliberate exceptions. An unnamed newcomer still fails loudly, which is
  // the property this guard actually exists to hold.
  const PUSH_RE = /(?:runtimeWarnings\.push|disableHardening|this\.warn)\(\s*[`"]([^`"]{15,})/g;
  const RETURN_RE = /warning:\s*[`"]([^`"]{15,})/g;
  /** Emitters that are deliberately NOT posture warnings. Every entry needs a reason, and adding one
   *  should feel like a decision — that is the whole difference between this and simply widening
   *  `isPostureWarning` until the guard stops complaining. */
  const NON_POSTURE = [TRUNCATION_SENTINEL];
  const emitted: string[] = [];
  const { Glob } = await import("bun");
  for await (const f of new Glob("**/*.ts").scan({ cwd: new URL("../src", import.meta.url).pathname, absolute: true })) {
    emitted.push(...[...(await Bun.file(f).text()).matchAll(PUSH_RE)].map((m) => m[1]!));
  }
  const hardenSrc = await Bun.file(new URL("../src/harden.ts", import.meta.url)).text();
  emitted.push(...[...hardenSrc.matchAll(RETURN_RE)].map((m) => m[1]!));
  // A floor, so a regex that silently stops matching fails loudly instead of vacuously passing.
  expect(emitted.length).toBeGreaterThanOrEqual(15);
  const missed = emitted.filter((w) => !isPostureWarning(w) && !NON_POSTURE.some((k) => w.includes(k)));
  expect(missed).toEqual([]);
});

test("a warning containing a PIPE cannot break the EVAL.md table row", () => {
  // Measured: `provider.ts` builds its diagnostic by joining stderr and stdout with " | ", `harden.ts`
  // interpolates that into the rejection warning, and the resulting row had 9 pipes where a 7-column row
  // needs 8 — silently corrupting the table this feature exists to make trustworthy.
  const w = "the provider CLI rejected an injected hardening flag (claude exited 2: usage | (stdout) try --help); hardening flags are disabled";
  const line = postureLine([w]);
  expect(line).not.toContain("|");
  const row = `| … | case | ✅ | ? |  |  | live gate: 0 flag(s); ${line} |`;
  expect((row.match(/\|/g) ?? [])).toHaveLength(8);
});

test("a multi-line warning is flattened — a newline would break the row just as badly", () => {
  const line = postureLine(["provider hardening flags not applied — line one\nline two\n\tline three"]);
  expect(line).not.toMatch(/[\n\r\t]/);
});

test("a MIXED opt-out and malfunction reports degraded, not 'off (by config)'", () => {
  // `every`, not `some`: if anything malfunctioned, the run is degraded regardless of an opt-out also
  // being present. Pinning it even though the mixed state may be unreachable today (harden:false returns
  // before any other posture warning) — a pure function's contract should not depend on a caller's
  // current control flow, and `some` survived the suite.
  expect(posturePhrase([HARD_OFF, ANOMALY])).toBe("degraded");
  expect(posturePhrase([ANOMALY, HARD_OFF])).toBe("degraded");
});

test("the line is length-capped, so one enormous warning cannot swamp the Notes column", () => {
  // Unpinned before: removing the cap survived, because no test built a line past it. A CLI diagnostic is
  // 300 chars per stream by construction, so this is reachable with a single real warning.
  const huge = `provider hardening flags not applied — ${"x".repeat(500)}`;
  const line = postureLine([huge]);
  expect(line.length).toBeLessThanOrEqual(190);
  expect(line.startsWith("posture: degraded")).toBe(true);
});

test("mergeWarnings survives a hostile source — a throwing getter must not crash the reporter", () => {
  // It runs inside eval.ts's catch on an UNKNOWN caught value, in a `main()` with no outer .catch — so an
  // exotic thrown object would take down the reporter while reporting an error. Demonstrated throwing on
  // a getter bomb before this guard.
  const bomb = { get warnings(): string[] { throw new Error("getter bomb"); } };
  expect(() => mergeWarnings(bomb)).not.toThrow();
  expect(mergeWarnings(bomb)).toEqual([]);
  const proxy = new Proxy({}, { get() { throw new Error("proxy bomb"); } });
  expect(() => mergeWarnings(proxy)).not.toThrow();
  // ...and a good source alongside a hostile one still yields its warnings.
  expect(mergeWarnings(bomb, { warnings: [ANOMALY] })).toContain(ANOMALY);
});

test("posturePhrase aggregates across cases — one degraded case degrades the whole run", () => {
  // What the --json gate field needs: a run is only `full` if EVERY case was. Reporting the last case's
  // posture, or the first, would let a degraded case hide behind clean neighbours.
  expect(posturePhrase([])).toBe("full");
  expect(posturePhrase([ANOMALY])).toBe("degraded");
  expect(posturePhrase(["unrelated warning", ANOMALY, "another unrelated"])).toBe("degraded");
});

test("ANSI/control sequences are stripped — they are not whitespace and eval.ts strips nothing", () => {
  // The chain is real: a commit subject reaches the model, the model's partial output reaches
  // `provider.ts`'s diagnostic, `harden.ts` embeds that in the latch warning, and `postureLine` puts it
  // in the operator's terminal AND the row they paste into EVAL.md. `cellSafe` collapsed \s and pipes,
  // but ESC and BEL are neither — and unlike audit.ts, `scripts/eval.ts` performs no stripControl at all.
  const hostile = `provider hardening flags not applied — \x1b[31mRED\x1b[0m\x07 and \x1b]0;title\x07`;
  const line = postureLine([hostile]);
  expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  expect(line).toContain("RED");                    // the text survives; only the escapes go
});

test("a non-claude CLI is 'unhardened', not 'degraded' — it is expected, not a malfunction", () => {
  // Same carve-out reasoning as the opt-out: a codex user would otherwise read `degraded` on every row
  // forever, which dilutes the one signal the field exists to carry.
  const skipped = "provider hardening skipped: `codex` is not recognised as the claude CLI, so no isolation flags were injected";
  expect(posturePhrase([skipped])).toBe("unhardened (non-claude CLI)");
  // ...but a real malfunction alongside it still wins.
  expect(posturePhrase([skipped, ANOMALY])).toBe("degraded");
});

test("truncation never splits a surrogate pair — swept, so it cannot be vacuous", () => {
  // The first version of this used a single fixed pad of 148, which put the cut inside the run of `a`s —
  // the backoff clause was never exercised and deleting it survived the whole suite. A guard that reports
  // confidence it has not earned is the exact class this PR keeps finding. Sweeping the pad guarantees
  // some iteration lands the cut between the halves of a pair, whatever the cap happens to be.
  for (let pad = 100; pad <= 170; pad++) {
    const line = postureLine([`provider hardening flags not applied — ${"a".repeat(pad)}${"😀".repeat(20)}`]);
    expect(line.length).toBeLessThanOrEqual(190);
    // BOTH halves: a naive backoff fixes the dangling high surrogate and can still leave a dangling low.
    expect(`pad=${pad} loneHigh=${/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(line)}`).toBe(`pad=${pad} loneHigh=false`);
    expect(`pad=${pad} loneLow=${/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(line)}`).toBe(`pad=${pad} loneLow=false`);
  }
});

test("flattening a multi-line warning keeps a word boundary — it must not glue words together", () => {
  // Measured: stripping control characters BEFORE collapsing whitespace deleted the newline outright,
  // so `line one\nline two` became `line oneline two`. Collapse first, then strip.
  const line = postureLine(["provider hardening flags not applied — line one\nline two\ttabbed"]);
  expect(line).toContain("line one line two tabbed");
});

test("every hardenedProvider in the scripts has its warnings read — the wiring is otherwise untestable", async () => {
  // No test imports or executes `scripts/*.ts`, so every script-side line of this feature is
  // mutation-invisible: deleting `caseProvider` from the merge was measured surviving the whole suite.
  // A static structural guard is the only thing that can catch that — same shape as the existing
  // "every provider construction routes through the seam" guard.
  //
  // Paren-BALANCED argument extraction, not a `[^)]*` scan: the naive form stops at the first `)`, which
  // in `mergeWarnings(...attempts.map((a) => a.struct), caseProvider)` is the `)` of `(a)` — so the
  // SUCCESS-path merge was invisible to this guard and `caseProvider` was passing on the catch-path call
  // alone (measured). That both hid a real gap and would have false-failed a refactor that legitimately
  // kept only the success-path merge.
  const mergeArgs = (src: string): string[] => {
    const out: string[] = [];
    const re = /mergeWarnings\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const start = m.index + m[0].length;
      let depth = 1;
      let i = start;
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
      }
      out.push(src.slice(start, i - 1));
    }
    return out;
  };
  for (const f of ["../scripts/eval.ts", "../scripts/audit.ts"]) {
    const src = await Bun.file(new URL(f, import.meta.url)).text();
    const built = [...src.matchAll(/const\s+(\w+)\s*=\s*hardenedProvider\(/g)].map((m) => m[1]!);
    expect(built.length).toBeGreaterThan(0);
    // EVERY construction must be a named binding, not just every binding checked: the original code
    // called `hardenedProvider(...)` INLINE as an argument, which creates no binding and would sail past
    // a bindings-only scan while its warnings went unread — a partial revert to that shape must fail.
    expect(`${f} inline-constructions`).toBe(
      (src.match(/hardenedProvider\(/g) ?? []).length === built.length ? `${f} inline-constructions` : `${f} HAS AN UNBOUND hardenedProvider(...) CALL`);
    for (const v of built) {
      // Two legal routes, because audit.ts collects into an array and spreads it — so a direct-mention
      // check alone would fail a correctly-wired file, and a "mentions mergeWarnings somewhere" check
      // would pass a broken one. Express the actual property: the provider reaches a merge, directly or
      // via a collector that is itself spread into one.
      const direct = mergeArgs(src).some((a) => new RegExp(`\\b${v}\\b`).test(a));
      const collector = new RegExp(`(\\w+)\\.push\\(\\s*${v}\\s*\\)`).exec(src)?.[1];
      const viaCollector = collector !== undefined
        && new RegExp(`mergeWarnings\\(\\s*\\.\\.\\.\\s*${collector}\\b`).test(src);
      expect(`${f}:${v} reaches a merge`).toBe(direct || viaCollector ? `${f}:${v} reaches a merge` : "UNREAD");
    }
  }
});

test("two EXPECTED states together are not a malfunction", () => {
  // `harden: false` AND a non-claude CLI: both deliberate, neither a fault, so `degraded` would be the
  // exact misreport this feature's carve-outs exist to prevent. Unreachable today (harden:false returns
  // before the not-recognised warning is pushed) — pinned anyway, for the same reason the every/some case
  // was: a pure function's contract should not depend on a caller's current control flow.
  const OPT = "provider hardening is DISABLED by config (provider.harden: false) — surrendering x";
  const UNH = "provider hardening skipped: `codex` is not recognised as the claude CLI, so no isolation flags were injected";
  expect(posturePhrase([OPT, UNH])).toBe("off (by config)");   // the explicit choice dominates
  expect(posturePhrase([UNH, OPT])).toBe("off (by config)");   // order-independent
  // ...and either one alongside a real malfunction is still degraded.
  expect(posturePhrase([OPT, UNH, ANOMALY])).toBe("degraded");
});

test("T19: the coverage guard accepts a NAMED non-posture warning but still fails an unnamed one", async () => {
  // The split introduced above is only worth having if it stayed strict. Two meta-mutations:
  // (a) removing the truncation sentinel from NON_POSTURE must make the real emitter unclassifiable;
  // (b) any warning that is neither a posture warning nor named must still be rejected.
  // Both are asserted here against the SAME predicate the guard uses, so the guard cannot drift into
  // "accept anything I do not recognise" — which is how a coverage guard quietly becomes decorative.
  const classify = (w: string, allow: readonly string[]) =>
    isPostureWarning(w) || allow.some((k) => w.includes(k));
  const real = "sh exited successfully but its output stream never closed — a background process is holding it open";
  expect(classify(real, [TRUNCATION_SENTINEL])).toBe(true);
  expect(classify(real, [])).toBe(false);                       // (a) drop it from the allowlist
  expect(classify("some brand new warning nobody classified", [TRUNCATION_SENTINEL])).toBe(false); // (b)
});

test("postureLine marks a truncated run — including one whose hardening was otherwise perfect", () => {
  // The dangerous case is `full`: a truncated run whose posture is fine would otherwise render exactly
  // "posture: full" and be scored as a normal briefing. It also has to survive the `degraded` path,
  // where the detail text is truncated to 190 chars.
  // MUTATION: drop `${cut}` from the `full` branch → "posture: full" instead of "posture: full · truncated".
  const real = "sh exited successfully but its output stream never closed — a background process is holding it open";
  expect(postureLine([real])).toBe("posture: full · truncated");
  expect(postureLine(["provider hardening is DISABLED by config (provider.harden: false)"]))
    .not.toContain("truncated");
  expect(postureLine([])).toBe("posture: full");
  expect(postureLine([real, "provider hardening flags not applied — probe anomaly"])).toContain("· truncated");
  // All THREE branches, because dropping `${cut}` from the `unhardened` one alone survived the entire
  // 607-test suite (measured). That is the narrowest possible version of the hole this feature exists
  // to close, left open for exactly the users — non-claude CLIs — who never see any other signal.
  expect(postureLine([real, "provider hardening skipped: `codex` is not recognised as the claude CLI, so no isolation flags were injected"]))
    .toBe("posture: unhardened (non-claude CLI) · truncated");
});
