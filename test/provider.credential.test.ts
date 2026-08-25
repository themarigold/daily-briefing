// test/provider.credential.test.ts — which credential the spawned CLI is allowed to use.
//
// WHY THIS EXISTS. The app spawns the user's `claude` CLI, which bills either its logged-in
// SUBSCRIPTION or API CREDITS depending on whether `ANTHROPIC_API_KEY` is in its environment — the
// key wins when present. The app used to hand its whole environment to the child (`provider.ts`'s
// spawn merges `...process.env`, and where no env option is passed at all `Bun.spawn` inherits
// everything), so a machine-wide key silently re-billed a subscription to API credits FOR WEEKS.
// Nothing in any output stated which credential a run used, so a wrong belief had nothing to
// collide with.
//
// REAL SUBPROCESSES, not a spawn spy — the same house-style argument test/provider.opts.test.ts:10-13
// makes for the env merge: "a spy would assert what we passed, not what the child actually received,
// and it is the child's view that matters." That is doubly true here, where the mechanism is a
// delete-after-merge on a copied object and the only proof is what the child can read.
//
// ⚠ THE SENTINEL IS INJECTED, NEVER AMBIENT. A developer machine may well have a real
// `ANTHROPIC_API_KEY` exported (this one does); CI will not. A test written against ambient state
// would pass here and go vacuous — or invert — on CI. Every case below plants its own value through
// `opts.env` so the assertions mean the same thing everywhere. And no fixture ever ECHOES the key —
// they classify it (MATCH/EMPTY/OTHER, see `classify` below), so a REGRESSION cannot print a real
// credential into a failure message. Both halves are needed: planting keeps the green path honest,
// classifying keeps the red path safe.
import { test, expect, spyOn } from "bun:test";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BYOCliProvider, withoutKeys } from "../src/provider";
import { hardenedProvider } from "../src/harden";

const SENTINEL = "sk-test-not-a-real-key";
/** CLASSIFY the child's view of the key — never echo it. MATCH / EMPTY / OTHER.
 *
 *  ⚠ THE CLASSIFICATION IS THE POINT, and it is about the RED path, not the green one. Echoing
 *  `[$ANTHROPIC_API_KEY]` is harmless while the code is correct — the child only ever sees the
 *  sentinel. But the exact regression these tests exist to catch (the strip stops applying, or
 *  `opts.env` stops being threaded) makes the child inherit the AMBIENT environment, so on a machine
 *  with a real key exported the fixture writes the REAL key and the failing `toContain` prints it.
 *  That is precisely when a human is reading the output. A leak on the failure path is worse than one
 *  on the success path, and this session already leaked this machine's key once through output shaped
 *  exactly like that.
 *
 *  `OTHER` is deliberately a distinct third state rather than folding into a plain inequality: it
 *  distinguishes "withheld" (EMPTY) from "something else got through" (OTHER), which is the shape an
 *  ambient-inheritance regression actually takes.
 *
 *  Also reports HOME, so one run proves the strip AND the merge. */
const classify = (extra = "") =>
  `k=OTHER; [ -z "$ANTHROPIC_API_KEY" ] && k=EMPTY; ` +
  `[ "$ANTHROPIC_API_KEY" = "${SENTINEL}" ] && k=MATCH; echo "KEY=$k${extra}"`;
/** ⚠ `HOME_EMPTY` reads AMBIENT `HOME` on purpose, and it is the one thing in this file that does.
 *  Planting `HOME` through `opts.env` would DEFEAT it: a bare replacement env would then still carry
 *  the planted value and the merge-don't-replace mutation would survive. The dependency is also
 *  fail-safe — a `HOME`-less container makes this fail, never pass vacuously. */
const REPORT = classify(' HOME_EMPTY=[${HOME:+no}]');

const sh = (opts = {}) =>
  new BYOCliProvider({ cli: "sh", argv: ["-c", REPORT], promptVia: "stdin" }, opts);

/** A claude-SHAPED fake, so the `shaped` branch in harden.ts is the one under test. `claudeShaped`
 *  keys on the binary's basename, so naming the script `claude` is what makes it shaped. */
async function claudeShaped(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dba-cred-"));
  const cli = join(dir, "claude");
  // Prints the key it received; `--help` must list the flags so the capability probe stays happy.
  await writeFile(cli, `#!/bin/sh
case "$1" in --help) echo "--tools --setting-sources --strict-mcp-config --print" ;; *) ${REPORT} ;; esac
`, "utf-8");
  await chmod(cli, 0o755);
  return cli;
}

const fast = { probeMs: 3_000, flushMs: 150, timeoutMs: 10_000 };

// ── the primitive ────────────────────────────────────────────────────────────────────────────────

test("withoutKeys removes named keys and keeps everything else", () => {
  const env = { HOME: "/h", PATH: "/p", ANTHROPIC_API_KEY: SENTINEL };
  expect(withoutKeys(env, ["ANTHROPIC_API_KEY"])).toEqual({ HOME: "/h", PATH: "/p" });
  expect(withoutKeys(env, [])).toBe(env);          // no copy when there is nothing to do
  expect(withoutKeys(env, undefined)).toBe(env);
});

test("withoutKeys keeps a variable literally named __proto__", () => {
  // `out[k] = v` in a loop is a [[Set]], so `__proto__` hits Object.prototype's setter: assigning a
  // string is a silent no-op and no own property is created, so the variable is DROPPED. Measured
  // end-to-end before the fix: `env | grep -c '^__proto__='` gave 1 without a strip and 0 with one.
  // No pollution risk and dropping is the safe direction, but it contradicts the contract of keeping
  // every other variable intact. `Object.fromEntries` creates own properties and preserves it.
  const out = withoutKeys({ ["__proto__"]: "keepme", HOME: "/h" } as Record<string, string>, ["ANTHROPIC_API_KEY"]);
  expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(out)).toBe(Object.prototype);   // and no prototype was polluted
});

test("withoutKeys is CASE-INSENSITIVE — Windows env names are, and a JS object is not", () => {
  // The one platform where a user could not have known it mattered. An exact-key `delete` would
  // leave this in place and bill them anyway.
  expect(withoutKeys({ Anthropic_Api_Key: SENTINEL, HOME: "/h" }, ["ANTHROPIC_API_KEY"]))
    .toEqual({ HOME: "/h" });
});

// ── the child's view, through BYOCliProvider ─────────────────────────────────────────────────────

test("envDelete withholds the key from the child — and does NOT evict the environment", async () => {
  // Both halves in one assertion set, because the second is the scar this mechanism was built
  // around: `provider.ts` records that handing Bun.spawn a bare env object "was measured leaving
  // HOME=UNSET — which kills the provider's auth".
  const out = await sh({ env: { ANTHROPIC_API_KEY: SENTINEL }, envDelete: ["ANTHROPIC_API_KEY"] }).generate("");
  expect(out).toContain("KEY=EMPTY");
  expect(out).toContain("HOME_EMPTY=[no]");
});

test("without envDelete the key reaches the child (the guard is not over-broad)", async () => {
  const out = await sh({ env: { ANTHROPIC_API_KEY: SENTINEL } }).generate("");
  expect(out).toContain("KEY=MATCH");
});

// ── the resolution, through hardenedProvider ─────────────────────────────────────────────────────

test("an OMITTED credential withholds — the default is the entire fix", async () => {
  // THE discriminating case. Every config that exists today omits this field, so a resolution
  // written as `=== "subscription"` would match none of them and strip nothing, while still
  // reading as if it worked. The `!== "env-api-key"` form is what makes the default real.
  const cli = await claudeShaped();
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" },
    { ...fast, env: { ANTHROPIC_API_KEY: SENTINEL } });
  const out = await hp.generate("x");
  expect(out).toContain("KEY=EMPTY");
  // ⚠ And it must withhold ONLY that. MEASURED: widening the withheld list to
  // ["ANTHROPIC_API_KEY", "HOME"] survived the ENTIRE suite — HOME being the variable
  // `provider.ts` calls the measured auth-killer. The does-not-evict property was pinned only on a
  // raw BYOCliProvider with a hand-passed envDelete, never on the resolution production uses.
  expect(out).toContain("HOME_EMPTY=[no]");
});

test('credential: "subscription" withholds', async () => {
  const cli = await claudeShaped();
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin", credential: "subscription" },
    { ...fast, env: { ANTHROPIC_API_KEY: SENTINEL } });
  expect(await hp.generate("x")).toContain("KEY=EMPTY");
});

test('credential: "env-api-key" passes the key through', async () => {
  const cli = await claudeShaped();
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin", credential: "env-api-key" },
    { ...fast, env: { ANTHROPIC_API_KEY: SENTINEL } });
  expect(await hp.generate("x")).toContain("KEY=MATCH");
});

test("harden: false STILL withholds — opting out of hardening is not opting into spending", async () => {
  // A genuinely separate BYOCliProvider construction that returns before `build()` exists. Applying
  // the strip only at the `build()` site — the natural reading, since that is where `env` lives —
  // leaves this path leaking, on a config the tool itself writes as discoverable.
  const cli = await claudeShaped();
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin", harden: false },
    { ...fast, env: { ANTHROPIC_API_KEY: SENTINEL } });
  expect(await hp.generate("x")).toContain("KEY=EMPTY");
});

test("a NON-CLAUDE CLI withholds too — the `shaped` gate must not decide this", async () => {
  // `harden.ts` only attaches an `env` option when the CLI is claude-shaped, which is exactly how a
  // non-claude CLI would keep inheriting the ambient key. Withholding is about whose money is spent,
  // not about which binary is running.
  const hp = hardenedProvider({ cli: "sh", argv: ["-c", REPORT], promptVia: "stdin" },
    { ...fast, env: { ANTHROPIC_API_KEY: SENTINEL } });
  expect(await hp.generate("x")).toContain("KEY=EMPTY");
});

test("envDelete ALONE makes an env object be passed — the inherited-environment case", async () => {
  // ⚠ THE CASE MY FIXTURES MASKED, and the one production depends on. `provider.ts` attaches an env
  // object only when `env` is set OR `envDelete` is non-empty. Every test above passes `opts.env`,
  // satisfying the first half — so dropping the `|| envDelete?.length` clause left all of them GREEN
  // while breaking the path that matters: `harden.ts` sets `env` only for a claude-SHAPED CLI, so
  // for any other CLI `envDelete` is the SOLE trigger. Without the clause the child inherits the
  // whole environment and the strip silently never happens.
  //
  // ⚠ A SPY, deliberately, and it is the one exception to this file's real-subprocess rule. That
  // rule exists because "the child's view is what matters" — but here the child cannot see it.
  // MEASURED: Bun's default inherit (no `env` option) does NOT reflect a runtime mutation of
  // `process.env`, while a spread does:
  //     inherit=[]   spread=[leaked]
  // So a test that sets the variable at runtime observes an empty value under BOTH the correct code
  // and the mutant, and passes either way — which is exactly what the first version of this test did.
  // The property here is about the CALL SHAPE (is an env object passed at all), and only a spy can
  // observe that.
  const seen: Array<Record<string, unknown>> = [];
  // Cast because `Bun.spawn` is overloaded and its options arg is optional in one form, so a
  // two-parameter implementation is not assignable without help. The repo's other spawn fakes take
  // no arguments at all; this one must READ them, which is the whole point.
  const impl = ((_cmd: string[], o: Record<string, unknown>) => {
    seen.push(o);
    const enc = new TextEncoder();
    const close = (t: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(t)); c.close(); } });
    return {
      stdin: { write() {}, end() {} }, stdout: close("ok\n"), stderr: close(""),
      exited: Promise.resolve(0), exitCode: 0, signalCode: null, kill() {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
  const spy = spyOn(Bun, "spawn").mockImplementation(impl);
  try {
    await new BYOCliProvider({ cli: "sh", argv: ["-c", "true"], promptVia: "stdin" },
      { envDelete: ["ANTHROPIC_API_KEY"] }).generate("");   // note: no `env` — envDelete stands alone
    expect(seen).toHaveLength(1);
    const env = seen[0]!.env as Record<string, string> | undefined;
    expect(env).toBeDefined();                       // an env object WAS constructed...
    expect("ANTHROPIC_API_KEY" in (env ?? {})).toBe(false);   // ...with the key removed...
    expect(env?.HOME).toBeDefined();                 // ...and the rest of the environment intact
  } finally { spy.mockRestore(); }
});

test("the PROBE spawn withholds it too — every spawn of the configured CLI, not most", async () => {
  // `probeCapabilities` runs the user's configured binary with `--help` to see which hardening flags
  // it supports. `--help` bills nothing, so this is not a money leak — but `provider.cli` is an
  // arbitrary user-supplied path that may be a wrapper doing anything, and the README claims the
  // tool withholds the key from "the CLI it spawns". That is only true if BOTH spawns honour it.
  // MEASURED before this fix: `generate: KEY=[] / probe: HELPKEY=[SENTINEL]`.
  //
  // ⚠ THE SENTINEL REACHES THE PROBE VIA `ProbeOptions.env`, which exists for exactly this. The first
  // version of this test planted it on `opts.env` and never threaded it past `hardenedProvider`, so
  // the probe child read the AMBIENT environment: it asserted nothing wherever no key is exported
  // (CI), and on a developer machine it wrote the developer's REAL key into `log`, where a failing
  // assertion would print it. That is the vacuous-or-inverted trap this file's own header warns
  // about at the top — written there first, then walked into here.
  const dir = await mkdtemp(join(tmpdir(), "dba-probe-"));
  const cli = join(dir, "claude");
  const log = join(dir, "probe-saw.txt");
  // `HOME_EMPTY` here too, not only on the generate path: the probe builds its own env object, so the
  // merge-don't-replace property needs its own pin. MEASURED: swapping the probe's merge for a bare
  // `withoutKeys({...opts.env}, …)` survived the entire suite before this line existed.
  await writeFile(cli, `#!/bin/sh
case "$1" in
  --help) ${REPORT} > "${log}"; echo "--tools --setting-sources --strict-mcp-config --print" ;;
  *) ${REPORT} ;;
esac
`, "utf-8");
  await chmod(cli, 0o755);
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" },
    { ...fast, env: { ANTHROPIC_API_KEY: SENTINEL } });
  await hp.generate("x");
  const saw = await Bun.file(log).text();
  expect(saw).toContain("KEY=EMPTY");
  expect(saw).toContain("HOME_EMPTY=[no]");
});

test("the probe passes the key through under env-api-key — the strip is not unconditional", async () => {
  // The negative twin of the test above. Without it, hard-coding the probe's `envDelete` to
  // WITHHELD_ENV — ignoring `credential` entirely — passes, and an `env-api-key` user's wrapper CLI
  // would silently lose the key on the probe spawn while keeping it on the generate spawn.
  const dir = await mkdtemp(join(tmpdir(), "dba-probe-thru-"));
  const cli = join(dir, "claude");
  const log = join(dir, "probe-saw.txt");
  await writeFile(cli, `#!/bin/sh
case "$1" in
  --help) ${REPORT} > "${log}"; echo "--tools --setting-sources --strict-mcp-config --print" ;;
  *) ${REPORT} ;;
esac
`, "utf-8");
  await chmod(cli, 0o755);
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin", credential: "env-api-key" },
    { ...fast, env: { ANTHROPIC_API_KEY: SENTINEL } });
  await hp.generate("x");
  expect(await Bun.file(log).text()).toContain("KEY=MATCH");
});
