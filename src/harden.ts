// src/harden.ts — C1/B1–B4, B9, B10: the hardening seam and what it injects.
//
// WHY A SEPARATE MODULE: imports `types`, `provider`, `probe`, `config`, `marker` only. It must never import
// `core`, which constructs the provider — that would close a cycle. Its own file makes the constraint
// mechanical rather than remembered.
//
// WHY ONE COMMIT FOR B1+B2+B3+B4: B1 alone is a security REGRESSION. Today the provider inherits the
// launchd job's cwd (`/`, where nothing is discovered). B1 moves it under `$HOME`, putting `$HOME` into
// the provider's ANCESTOR chain. Only B4's `--setting-sources user` — which drops project/local
// settings and therefore project HOOKS, the highest-severity injection-to-execution path — plus
// `--strict-mcp-config` make the narrower cwd a net win. The cwd move is therefore GATED on that flag
// actually being injected, not merely on the directory being creatable.
//
// CORRECTION (measured against claude 2.1.220's own --help): `--setting-sources` takes "a
// comma-separated list of setting sources to load (user, project, local)" — settings ONLY. It does NOT
// disable `CLAUDE.md` auto-discovery; that is `--safe-mode`/`--bare`. So `~/CLAUDE.md` is NOT
// neutralised here, and an earlier version of this comment claiming it was is simply wrong. The
// residual is bounded — a user-owned file an attacker cannot write without already having code
// execution — but a false justification in a security comment propagates, so it is corrected rather
// than repeated. `--safe-mode` is deliberately NOT adopted: it also disables the user-scoped
// settings/skills/plugins that this feature's invariant explicitly preserves. Note it would NOT be
// costing us user MCP servers on top of that — `--strict-mcp-config` is scope-BLIND ("ignoring all
// other MCP configurations") and already drops those, so an earlier version of this comment was wrong
// to list MCP among what hardening preserves. And B2 must
// come along because `Bun.spawn(["./wrapper.sh"], { cwd: elsewhere })` throws ENOENT → classified
// missing-binary → which withRetry treats as PERMANENT, so the morning dies with no retry on a wrapper
// that exists.
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdir, lstat, stat, chmod, access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { ProviderError, type Config, type Provider } from "./types";
import { BYOCliProvider, type ProviderOpts } from "./provider";
import { expandTilde } from "./config";
import { supportDir } from "./marker";
import { probeCapabilities, type Capabilities } from "./probe";
import { FLAG_REJECTION_RE, failFastMs, TIMEOUT_MS } from "./provider";

export type HardenedProvider = Provider & {
  /** Accumulated during `generate()`; read by core AFTER the call and merged into the briefing.
   *  Core must never rely on the array IDENTITY surviving a hand-off — `generator.ts` reassigns
   *  `struct.warnings` on a dropped SHA and would detach an alias. */
  runtimeWarnings: string[];
  /** True while flags are still being injected. The B6 ladder asks before drawing any conclusion from a
   *  failure: if nothing was injected, our flags cannot be the cause and backing off would be nonsense. */
  hardeningActive(): boolean;
  /** Latch hardening OFF for the rest of this process, with a reason for the briefing. Idempotent. */
  disableHardening(reason: string): void;
  /** Run `fn` with flag injection suppressed but WITHOUT latching. The B6 ladder must be able to test
   *  "would this have worked bare?" before committing to a conclusion — latching first and reverting on
   *  failure would let one transient error permanently downgrade the security posture. */
  probeWithoutHardening<T>(fn: () => Promise<T>): Promise<T>;
};

/** ⚠ `envDelete` is Omitted alongside `onWarning` for the same reason: both are set by this wrapper
 *  AFTER spreading `opts`, so a caller-supplied value was silently discarded. Leaving it settable
 *  meant a typed option that no-ops — and one that, if it HAD won, would let a caller defeat the
 *  credential mode by passing `[]`. Measured: moving either assignment before the spread survived
 *  the entire suite, so the type is the enforcement, not a test. */
export type HardenOpts = Omit<ProviderOpts, "onWarning" | "envDelete"> & {
  /** Where to root the narrow provider cwd. Injected by tests; production passes the real state dir. */
  stateDir?: string;
  /** Home directory used for `~` expansion of `provider.cli`. Injected by tests so a tilde-configured
   *  cli can be exercised end to end without writing into the real `$HOME`; production uses `homedir()`. */
  home?: string;
  probeMs?: number;
  flushMs?: number;
};

/** The flags we inject, each gated on the probe finding it in `--help`. `--tools=` is deliberately ONE
 *  token: `--tools` is variadic, so `--tools ""` as two tokens swallows the positional prompt in
 *  arg-mode — the CLI would read the briefing prompt as a tool name and the prompt itself would vanish.
 *  Say so here, because it looks like a typo and someone will try to "clean it up". */
const FLAG_INJECTIONS: readonly { probe: string; argv: readonly string[] }[] = [
  { probe: "--tools", argv: ["--tools="] },
  { probe: "--setting-sources", argv: ["--setting-sources", "user"] },
  { probe: "--strict-mcp-config", argv: ["--strict-mcp-config"] },
  { probe: "--no-session-persistence", argv: ["--no-session-persistence"] },
];
const WANTED_FLAGS: readonly string[] = FLAG_INJECTIONS.map((f) => f.probe);

/** Flags that WIDEN the provider's authority but were measured NOT to defeat an injected flag. Hardening
 *  still holds with these present, so they only warrant a warning — but the user should know they are in
 *  play, because they are the reason the invariant is conditional. */
const ADJACENT_FLAGS: readonly string[] = [
  "--settings", "--mcp-config", "--plugin-dir", "--plugin-url", "--agents",
  "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
  "--permission-mode", "--dangerously-skip-permissions", "--add-dir",
];

/** Flags that make `init` exit non-zero — and ONLY init. A `--settings` SessionStart hook was measured
 *  EXECUTING under full hardening, i.e. arbitrary shell execution, so it is worth refusing to PROCEED
 *  while the user is present to fix it. (Not refusing to WRITE — see assertInitSafeArgv; initConfig only
 *  ever writes the default argv.) Never worth killing a morning over: a tick warns and delivers. */
const INIT_REFUSED: readonly string[] = ["--tools", "--settings"];

/** Index of `flag` in `m` as a whole token, or -1. `--tools` must not match inside `--toolset`. */
function flagIndex(m: string, flag: string): number {
  return m.search(new RegExp(`${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`));
}

/** How close an injected flag must sit to the rejection phrase to count as evidence rather than
 *  coincidence. Real CLIs print them adjacent: `error: unknown option '--strict-mcp-config'`. */
const REJECTION_PROXIMITY = 120;

/** Which flag a token names, ignoring its value: `--tools=Bash` → `--tools`, `Bash` → undefined. */
function flagName(tok: string): string | undefined {
  if (!tok.startsWith("--")) return undefined;
  const eq = tok.indexOf("=");
  return eq === -1 ? tok : tok.slice(0, eq);
}

/** Classify conflicts in the CONFIG argv. Never called on the final argv: in arg-mode that contains the
 *  prompt, which is built from commit subjects — attacker-influenceable text. Letting a branch name
 *  called `--settings` steer a security decision would be its own vulnerability. */
export function argvConflicts(argv: readonly string[]): { ours: string[]; adjacent: string[] } {
  const names = new Set(argv.map(flagName).filter((f): f is string => f !== undefined));
  return {
    ours: WANTED_FLAGS.filter((f) => names.has(f)),
    adjacent: ADJACENT_FLAGS.filter((f) => names.has(f)),
  };
}

/** Throw for a provider argv that defeats hardening outright. Called ONLY from init(), which turns this
 *  into a non-zero exit — it does not prevent a config from being WRITTEN (initConfig only ever writes the
 *  default argv, and leaves an existing config alone), it refuses to PROCEED while the user is present.
 *  An earlier doc here claimed the former, which was never true. */
export function assertInitSafeArgv(argv: readonly string[]): void {
  const names = new Set(argv.map(flagName).filter((f): f is string => f !== undefined));
  const bad = INIT_REFUSED.filter((f) => names.has(f));
  if (bad.length) {
    throw new Error(`config error: "provider.argv" must not contain ${bad.join(", ")} — ${bad.includes("--settings") ? "a --settings file can register a SessionStart hook, which was measured executing arbitrary shell even under full hardening; " : ""}remove it, or set "provider.harden": false to opt out of hardening deliberately`);
  }
}

/** The environment variables withheld from the spawned CLI when `provider.credential` is not
 *  "env-api-key". A named constant like its siblings, so the policy is greppable and has one
 *  referent — and so that adding `ANTHROPIC_AUTH_TOKEN` later is a one-line change here rather than
 *  a hunt through `generate()`. Deliberately ONE entry today; README states the residual honestly. */
const WITHHELD_ENV = ["ANTHROPIC_API_KEY"] as const;

/** What `harden: false` gives up — enumerated, because "hardening disabled" alone tells the user
 *  nothing about their exposure. */
const SURRENDERED = "tool gating (--tools=), project and local settings including project hooks (--setting-sources user), all filesystem-configured MCP servers (--strict-mcp-config — which drops user-scope servers too, not only project ones), prompt-history suppression (both the CLAUDE_CODE_SKIP_PROMPT_HISTORY env var and --no-session-persistence when the probe finds it), absolute cli-path resolution, and the private working directory (the provider keeps this process's cwd)";

/** True for the `claude` CLI under any plausible spelling. Basename-only, lowercased, Windows launcher
 *  extensions stripped. Deliberately EXACT rather than substring: `claude-wrapper` is somebody's shim
 *  with unknown flag handling, and injecting into it is how you break a working setup. */
export function claudeShaped(cli: string): boolean {
  const b = basename(cli).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
  return b === "claude";
}

/** Resolve `cli` to something a spawn with a DIFFERENT cwd will still find.
 *  - `~` expanded.
 *  - contains a separator ⇒ relative to the ORIGINAL cwd, so resolve it absolutely now.
 *  - bare name ⇒ leave alone. PATH lookup is cwd-independent, and rewriting it would break it. */
export function resolveCliPath(cli: string, base: string, home: string): string {
  const expanded = expandTilde(cli, home);
  if (isAbsolute(expanded)) return expanded;
  return expanded.includes(sep) || expanded.includes("/") ? resolve(base, expanded) : expanded;
}

/** Is `dir` safe to use as the provider's cwd? The tmp rung uses a PREDICTABLE name and
 *  `mkdir(recursive)` succeeds silently on an existing directory, so an attacker who pre-creates it
 *  would choose where the provider runs. Refuse anything symlinked, group/world-WRITABLE, or not ours;
 *  merely group/world-READABLE is ours to tighten, so it is repaired instead. */
async function safeOwnDir(dir: string, uid: number = process.getuid?.() ?? -1): Promise<boolean> {
  try {
    // `lstat`, not `stat`, and this is THE protection: `stat` follows the link and would report the
    // TARGET's mode, owner and type, so a symlink planted at our predictable path and pointing at any
    // victim-owned 0700 directory would pass every check below.
    //
    // The `isSymbolicLink()` clause is DEAD CODE and an earlier comment here was wrong about why it was
    // kept: it claimed the clause would become load-bearing under a `stat` refactor, but `stat` never
    // reports `isSymbolicLink() === true` either, so it protects nothing in either direction. It is
    // retained only as a signpost. Do not "simplify" this to `stat`; a test pins the not-followed
    // property with a 0700 target so that refactor fails loudly.
    const st = await lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;

    // POSIX ownership/permission tests are meaningless on Windows: `process.getuid` is undefined there
    // and directories report mode 0o40777, so both tests below would fail forever — no cwd hardening at
    // all, plus a daily warning whose stated diagnosis ("not owned by this user") is false. Accept a
    // directory we just created under the per-user app-data root instead.
    if (process.platform === "win32") return true;

    // Not ours ⇒ refuse, and never touch it. This is the check an attacker cannot get past: they cannot
    // create a directory owned by us, and chmod'ing theirs is not ours to do.
    // `uid` is a parameter purely so this — the strongest claim in the file, and the one an attacker
    // genuinely cannot get past — is testable at all. It cannot be exercised in-process otherwise, since
    // the suite has only one uid, and three separate comments used to assert it with nothing pinning it.
    if (st.uid !== uid) return false;

    // GROUP- OR WORLD-WRITABLE is rejected rather than repaired, and the distinction is the point: anyone
    // with write access could already have planted a `CLAUDE.md` or `.mcp.json` INSIDE it, and the
    // provider's cwd is exactly where those get read from. Fixing the mode does not un-plant a file, so a
    // directory that was ever writable by anyone else is not trustworthy no matter what we do to it now.
    // GROUP is included deliberately: on macOS every local user is in `staff`, so group-write is the same
    // threat as world-write, and repairing it would apply an argument to one that we reject for the other.
    if ((st.mode & 0o022) !== 0) return false;

    // The parent is checked BEFORE the repair below, so we never chmod a path we are about to declare
    // untrustworthy — the one situation where a rename window is actually live. And `stat`, not `lstat`:
    // here we WANT to follow, because a parent that is itself a symlink would otherwise be judged on the
    // LINK's own mode (0120755 on macOS — never world-writable), so a link to a 0777 non-sticky directory
    // passed. That is precisely the configuration this check exists to reject. (`lstat` remains correct
    // for the LEAF, where not-following is the whole protection.)
    const parent = await stat(dirname(dir));
    if ((parent.mode & 0o002) !== 0 && (parent.mode & 0o1000) === 0) return false;

    // Anything else that is merely too open (0755 from a permissive umask) or not searchable (0600 —
    // which `chdir(2)` cannot enter, and which the first version of this accepted and then let
    // `Bun.spawn` fail with EACCES naming the BINARY) is OURS and repairable. Repair rather than reject:
    // `mkdir(recursive, mode)` does NOT re-apply the mode to an existing directory (measured — a 0755
    // survived), so without this a provider-cwd created once under a bad umask stays wrong forever and
    // every later run silently re-accepts it.
    if ((st.mode & 0o777) !== 0o700) {
      try { await chmod(dir, 0o700); } catch { return false; }
      if (((await lstat(dir)).mode & 0o777) !== 0o700) return false;
    }

    return true;
  } catch { return false; }
}

/** Is `dir` actually usable as a working directory right now? `chdir` needs execute/search. */
async function cwdUsable(dir: string): Promise<boolean> {
  try { await access(dir, FS.X_OK); return true; } catch { return false; }
}

/** Pick the provider's working directory, degrading rather than failing. A briefing is worth more than
 *  a narrow cwd, so every rung warns and continues; only the last gives up on narrowing at all. */
export async function providerCwd(opts: { preferred: string; tmpFallback: string; uid?: number }): Promise<{ ok: boolean; cwd?: string; warning?: string }> {
  try {
    await mkdir(opts.preferred, { recursive: true, mode: 0o700 });
    if (await safeOwnDir(opts.preferred, opts.uid)) return { ok: true, cwd: opts.preferred };
  } catch { /* fall through to the tmp rung */ }
  try {
    await mkdir(opts.tmpFallback, { recursive: true, mode: 0o700 });
    if (await safeOwnDir(opts.tmpFallback, opts.uid)) {
      return { ok: true, cwd: opts.tmpFallback, warning: `could not use the preferred provider working directory; fell back to ${opts.tmpFallback}` };
    }
    return { ok: false, warning: `refused the fallback provider working directory ${opts.tmpFallback} (not a private directory owned by this user) — the provider will inherit this process's working directory` };
  } catch {
    return { ok: false, warning: `could not create a private provider working directory — the provider will inherit this process's working directory` };
  }
}

export function hardenedProvider(cfg: Config["provider"], opts: HardenOpts = {}): HardenedProvider {
  const runtimeWarnings: string[] = [];
  /** Funnel for warnings raised inside a `BYOCliProvider`. `build()` makes a fresh instance per ladder
   *  rung, so the warning has to reach THIS array rather than the instance that raised it. */
  const pushWarning = (w: string): void => { runtimeWarnings.push(w); };
  const harden = cfg.harden !== false;                     // default ON
  // ── CREDENTIAL MODE ───────────────────────────────────────────────────────────────────────────
  // Resolved once at CONSTRUCTION, beside `harden`, because both are config-derived decisions and
  // both are needed before any spawn — including the capability probe below, which is a spawn of the
  // user's configured CLI and would otherwise inherit the key. Two load-bearing details:
  //
  //  1. `!== "env-api-key"`, not `=== "subscription"`. `validateConfig` VALIDATES without
  //     normalizing (it returns the parsed object plus path expansions), exactly as it does for
  //     `timeoutMs`/`harden` — so an omitted field stays `undefined`, and an equality test against
  //     "subscription" would match nothing on every config that exists today. The `!==` form also
  //     fails SAFE: anything unrecognised withholds rather than spends.
  //
  //  2. It applies REGARDLESS of `harden`. Opting out of hardening is not opting into spending
  //     money, so `credential` is deliberately NOT part of the SURRENDERED bargain: the
  //     `harden: false` branch is a separate `BYOCliProvider` construction that returns before
  //     `build()` exists, and missing it would leave that path leaking.
  const envDelete = cfg.credential !== "env-api-key" ? WITHHELD_ENV : undefined;

  // C1/B6 latch. A plain boolean rather than a promise-memo, deliberately: it is only ever set to true
  // and read, so concurrent callers cannot reach a wrong conclusion — the worst case is that two calls
  // already in flight each pay one rejected attempt before the latch is visible. A promise-memo would
  // not help those two (they are past the check) and would only add a await to every call.
  let flagsOff: string | undefined;
  let suppressed = 0;                                      // >0 while the ladder is testing a bare call

  // A PROMISE memo, not a value memo: the eval fires three concurrent `generate()` calls on ONE
  // instance and a value memo would probe three times. Lazy, because core builds the provider BEFORE
  // the offline-skip return — an eager probe would spend its window on a waking machine and discard it.
  // It can never reject: a rejected memo nobody awaits terminates the Bun process (exit 1), turning one
  // bug here into permanent silent non-delivery, which is strictly worse than shipping no hardening.
  // Resolved ONCE and shared. Feeding the raw `cfg.cli` to the probe while spawning the resolved one
  // meant a tilde-configured cli (`~/.local/bin/claude` — a shape B2 explicitly supports) made the probe
  // ENOENT, so zero flags were ever injected while the narrow cwd still applied: precisely the
  // "B1 without B4" state this file says must never ship, plus a daily warning blaming a working CLI.
  const resolvedCli = resolveCliPath(cfg.cli, process.cwd(), opts.home ?? homedir());

  let capsMemo: Promise<Capabilities> | undefined;
  const caps = (): Promise<Capabilities> => (capsMemo ??= probeCapabilities(resolvedCli, WANTED_FLAGS, {
    probeMs: opts.probeMs, flushMs: opts.flushMs,
    // The probe spawns the USER'S CONFIGURED BINARY — an arbitrary path that may be a wrapper doing
    // anything — so it gets the same withholding as the generate call. `--help` bills nothing today,
    // but "we withhold the key from the CLI we spawn" should be true of every spawn of it, not most.
    envDelete,
    // `opts.env` goes with it. Production never sets this, so it looks inert — but omitting it is what
    // made the probe test read the AMBIENT environment instead of an injected sentinel: vacuous on any
    // machine without a key, and echoing the real one on any machine with it.
    env: opts.env,
  }).catch((e: unknown): Capabilities => ({
    kind: "anomaly",
    reason: `capability probe failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`,
  })));

  let cwdMemo: Promise<{ ok: boolean; cwd?: string; warning?: string }> | undefined;
  const cwdOnce = () => (cwdMemo ??= (async () => {
    const base = opts.stateDir ?? supportDir();
    return providerCwd({
      preferred: join2(base, "provider-cwd"),
      // A STABLE name, not mkdtemp: the provider derives its transcript slug from the cwd, so a fresh
      // directory per call would scatter one machine's sessions across hundreds of slugs.
      tmpFallback: join2(tmpdirSafe(), `daily-briefing-provider-cwd-${process.getuid?.() ?? "nouid"}`),
    });
  })().catch((e: unknown) => ({
    // Mirrors capsMemo's guard. Unreachable today — `providerCwd` is fully wrapped — but this memo IS
    // awaited, so a rejection would surface as a non-ProviderError that withRetry rethrows immediately,
    // killing the run with no retry. The ASYMMETRY was the defect, not a live bug.
    ok: false as const,
    warning: `could not choose a private provider working directory (${e instanceof Error ? e.message : String(e)}); the provider will inherit this process's working directory`,
  })));

  const disableHardening = (reason: string): void => {
    // Idempotent — though no test can prove it, and that is worth recording rather than claiming coverage.
    // Measured: dropping this guard changes nothing observable, because latching also empties `extra`, and
    // the fast path requires `extra.length > 0` to fire again. The ladder calls this once. So it is a
    // belt against a FUTURE second caller, not a live guard.
    if (flagsOff) return;
    flagsOff = reason;
    runtimeWarnings.push(reason);
  };

  return {
    runtimeWarnings,
    hardeningActive: () => harden && !flagsOff && suppressed === 0,
    disableHardening,
    probeWithoutHardening: async <T,>(fn: () => Promise<T>): Promise<T> => {
      suppressed++;
      try { return await fn(); } finally { suppressed--; }
    },
    generate: async (prompt: string) => {
      if (!harden) {
        // All-or-nothing on purpose: partial opt-out (e.g. re-enabling tools via `--tools default`)
        // would silently drop ALL MCP servers — measured 2 → 0 — with no way for the user to decline.
        runtimeWarnings.push(`provider hardening is DISABLED by config (provider.harden: false) — surrendering ${SURRENDERED}`);
        return new BYOCliProvider(cfg, { ...opts, envDelete, onWarning: pushWarning }).generate(prompt);
      }

      // An EXPLICIT `opts.cwd` wins over the computed narrow one, and short-circuits computing it at
      // all. Without this precedence the `cwd` field added for B1 would be dead for every caller, and
      // `harden: false` would honour it while `harden: true` silently ignored it — the kind of
      // inconsistency that gets discovered by someone debugging at 7am.
      // Do not probe a CLI we would never inject into: a codex/wrapper user would otherwise pay a
      // `--help` spawn every morning AND could get a spurious "flags not applied" warning about a CLI
      // that was never a candidate.
      const shaped = claudeShaped(cfg.cli);
      const explicitCwd = opts.cwd !== undefined;
      // Skip the cwd ladder too for a non-claude CLI: `isolated` requires `shaped`, so the directory can
      // never be used, and computing it would mkdir/chmod for nothing AND emit a tmp-fallback warning
      // about a directory that is never used.
      const [c, cwd] = await Promise.all([
        shaped ? caps() : Promise.resolve<Capabilities>({ kind: "ok", supported: new Set() }),
        explicitCwd ? Promise.resolve({ ok: true as const, cwd: opts.cwd })
          : shaped ? cwdOnce() : Promise.resolve({ ok: false as const }),
      ]);
      if (c.kind === "anomaly") {
        // Fail OPEN: inject no FLAGS and say why. Deliberately says "flags", not "hardening": the
        // earlier wording claimed hardening was not applied, which was false whenever the cwd still
        // moved — it told the user nothing had happened while the half this file calls risky was
        // precisely the half that had.
        runtimeWarnings.push(`provider hardening flags not applied — ${c.reason}`);
      }
      if (!explicitCwd && "warning" in cwd && cwd.warning) runtimeWarnings.push(cwd.warning);

      const supported = c.kind === "ok" ? c.supported : new Set<string>();
      // Gate on the CLI being claude: `codex exec` has no `--tools` equivalent, and a wrapper's flag
      // handling is unknown. A non-claude CLI is left exactly as the user configured it.
      if (!shaped) {
        // Previously silent, which is the worst of the options: nothing in the briefing told the user
        // whether hardening was in effect at all. Real claude installed at a non-`claude` basename lands
        // here and gets nothing.
        runtimeWarnings.push(`provider hardening skipped: \`${cfg.cli}\` is not recognised as the claude CLI, so no isolation flags were injected`);
      }
      // B7: skip what we cannot win. Injected flags are PREPENDED, so a flag the user also passes lands
      // after ours and wins under both last-wins and accumulating-variadic parsing — injecting it anyway
      // would be pointless AND would make the briefing claim hardening it does not have.
      const conflicts = argvConflicts(cfg.argv);
      for (const f of conflicts.ours) {
        runtimeWarnings.push(`did not inject ${f}: your own provider.argv already passes it, and because injected flags are prepended, your value wins — remove it from provider.argv to let hardening apply`);
      }
      for (const f of conflicts.adjacent) {
        runtimeWarnings.push(`provider.argv passes ${f}, which widens what the provider can do; hardening still applies, but this flag is part of your exposure`);
      }
      const skip = new Set(conflicts.ours);
      const extra = shaped && !flagsOff && suppressed === 0
        ? FLAG_INJECTIONS.filter((f) => supported.has(f.probe) && !skip.has(f.probe)).flatMap((f) => [...f.argv]) : [];

      // THE GATE. A cwd under `$HOME` is a net win only when project settings and hooks are actually
      // suppressed; without that flag the move is exactly the regression this file's header describes.
      // Three reachable paths used to narrow the cwd with zero or partial flags — a probe anomaly, a
      // non-claude CLI, and a `--help` that hides `--setting-sources` (which the probe's own docs say
      // happens, ~45 flags are hidden) — and two of the three said nothing at all.
      // Transitive: if we could not impose the isolation flag — whether because the probe did not find it
      // or because the user's own copy wins — the narrow cwd is unjustified for exactly the same reason.
      // Any flag we wanted and did NOT get must be named. The activation review fixed exactly this class
      // for `--setting-sources` ("three reachable paths narrowed the cwd with zero or partial flags, two
      // of the three said nothing at all") and left it unfixed for `--tools`, the primary
      // injection-to-execution barrier: a future CLI that renames or hides it would silently remove the
      // main protection forever, while the README's table still promises it.
      if (shaped && !flagsOff && suppressed === 0 && c.kind === "ok") {
        // `--no-session-persistence` is deliberately excluded: it is a transcript-hygiene nicety, and an
        // older claude that lacks it would otherwise carry an unactionable PARTIAL line in every briefing
        // forever — the same daily-noise class this file removed for non-claude CLIs. The env var covers
        // most of what it buys anyway, and it is listed in SURRENDERED for anyone auditing.
        const SECURITY_FLAGS = ["--tools", "--setting-sources", "--strict-mcp-config"];
        const missing = SECURITY_FLAGS.filter((f) => !supported.has(f) && !skip.has(f));
        if (missing.length) {
          runtimeWarnings.push(`provider hardening is PARTIAL: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not listed in \`${cfg.cli} --help\`, so ${missing.length === 1 ? "it was" : "they were"} not injected${missing.includes("--tools") ? " — note --tools is what disables the CLI's built-in tools" : ""}`);
        }
      }
      const isolated = shaped && !flagsOff && suppressed === 0
        && supported.has("--setting-sources") && !skip.has("--setting-sources");
      const narrowCwd = explicitCwd ? opts.cwd : (isolated && cwd.ok ? cwd.cwd : undefined);
      // `shaped` guard: for a non-claude CLI the "isolation flag was not injected" diagnosis is about a
      // flag that was never a candidate — the single "not recognised" line above already says everything
      // true. `suppressed` guard: the ladder's bare probe is an internal experiment, not the run's
      // outcome, so its warnings must not ride out on the result.
      if (!explicitCwd && shaped && suppressed === 0 && cwd.ok && !isolated) {
        runtimeWarnings.push("kept this process's working directory for the provider: the setting-sources isolation flag was not injected, and narrowing the working directory without it would put $HOME in the provider's ancestor chain for no benefit");
      }

      // Injected flags are PREPENDED. Order does not affect prompt POSITION — BYOCliProvider appends the
      // prompt last either way, and `--tools=`'s `=` form is what stops it being swallowed. But order IS
      // decisive for PRECEDENCE, and an earlier version of this comment wrongly said it was not
      // load-bearing at all: a user's own `--tools Bash` in `provider.argv` lands AFTER ours and wins,
      // so config can silently defeat hardening while the briefing reports it as applied. Flipping to
      // append does not fix that either (accumulating variadics union), so the only correct answer is
      // DETECTION — which is B7, and is not in this commit.
      const build = (useCwd: string | undefined, flags: readonly string[] = extra) => new BYOCliProvider(
        { ...cfg, cli: resolvedCli, argv: [...flags, ...cfg.argv] },
        {
          ...opts,
          cwd: useCwd,
          // The env var rather than a flag wherever possible: an unknown env var is IGNORED, an unknown
          // flag is FATAL. Safe on every CLI version; the flag form is added only when probed.
          ...(shaped ? { env: { ...opts.env, CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1" } } : {}),
          // AFTER the `shaped` spread and unconditional, because the credential decision is NOT
          // claude-specific: the `shaped` gate above is why a non-claude CLI got no `env` option at
          // all, which is precisely how it would keep inheriting the ambient key. Withholding is
          // about whose money is spent, not about which CLI is running.
          envDelete,
          // AFTER the spread, unconditionally. `HardenOpts` extends `ProviderOpts`, so a caller could
          // pass their own `onWarning`; if theirs won, every warning the provider raises would vanish
          // from `runtimeWarnings` and never reach the briefing. Ordering is the whole enforcement.
          onWarning: pushWarning,
        },
      );

      try {
        return await build(narrowCwd).generate(prompt);
      } catch (e) {
        // B3's ladder has to extend PAST the mkdir check into the spawn, because a directory can pass
        // every check and still be un-`chdir`-able moments later (removed, remounted, chmod'd). Bun
        // reports that as ENOENT/EACCES naming the BINARY, so without this rung the run blames the
        // user's CLI for a directory problem. Only ever retried for a cwd WE chose: an explicit one is
        // the caller's to get right, and silently ignoring it would hide their bug.
        if (narrowCwd !== undefined && !explicitCwd && !(await cwdUsable(narrowCwd))) {
          runtimeWarnings.push(`the private provider working directory ${narrowCwd} became unusable, so the provider was re-run with this process's working directory instead`);
          return await build(undefined).generate(prompt);
        }
        // C1/B6 FAST PATH. The failure looks like a usage error on strong evidence — a rejection phrase
        // with one of OUR flags adjacent to it, on a failure fast enough to be a parse error rather than a
        // real provider call. Not "proven", which an earlier comment claimed: the searched string includes
        // `(stdout)`, i.e. model output, so the gates below are what make it evidence at all. Acting here
        // beats letting withRetry burn three attempts and 135s of sleeps on a usage error. Measured recovery 3.09s / 2 calls versus 138.4s / 5 without this.
        // Guarded on `extra.length` because a CLI complaining about the USER's own argv must not be read
        // as our flag being refused: there would be nothing to back off from.
        // Also gated on the failure being FAST, and that gate is a security control, not an optimisation.
        // The message this regex searches embeds `(stdout) …` (provider.ts), and on a mid-generation
        // failure that stdout is partial MODEL OUTPUT — prompt-derived, so commit-subject-influenceable.
        // A hostile commit subject quoting "error: unknown option '--strict-mcp-config'" could otherwise
        // talk us into disabling hardening and retrying bare WITH that same text in the prompt. A real
        // usage error returns in ~90ms and cannot contain model output; a mid-generation failure is slow.
        // This is the same rule B7 applies to argv: never let attacker text steer a security decision.
        //
        // C1 ADDENDUM — the timing argument above is NOT sufficient on its own any more, and knowing
        // why matters. It assumes partial bytes imply a lost flush race, hence >=10s, hence over the
        // 5s cap. False for an ERRORED sink: `drain` never rejects, it records the failure and
        // RESOLVES, so both reads settle in milliseconds, the race is WON, `durationMs` is small — and
        // `sinkText` still yields the bytes buffered before the error, straight into this message. So
        // gate on the property directly rather than inferring it from a duration measured in another
        // file: `partialRead` is stamped by the provider whenever a message may carry bytes from a
        // stream that never EOF'd or that errored.
        const fastEnough = (e as ProviderError)?.durationMs !== undefined
          && (e as ProviderError).durationMs! <= failFastMs(opts.timeoutMs ?? TIMEOUT_MS)
          && !(e as ProviderError).partialRead;
        // ...and the message must name one of the FLAGS we sent, ADJACENT to the phrase that matched.
        //
        // Two corrections to an earlier version of this gate, both found by review. It iterated all of
        // `extra`, which includes VALUE tokens — so the bare word `user` (from `--setting-sources user`)
        // satisfied it, and `user` appears in a large fraction of English error text; a message naming no
        // flag at all was measured latching hardening off. And a plain `includes` anywhere in the message
        // is satisfiable by a commit subject that merely mentions `--tools`. A real rejection puts the
        // flag right next to the complaint (`error: unknown option '--strict-mcp-config'`), so require
        // that proximity: it is the difference between evidence and coincidence.
        const msg = e instanceof Error ? e.message : "";
        const hit = FLAG_REJECTION_RE.exec(msg);
        const namesOurs = hit !== null && extra
          .filter((t) => t.startsWith("--"))
          .some((t) => {
            // Word-boundaried, for the same reason the probe's matcher is: measured, a CLI rejecting the
            // USER's own `--toolset` satisfied a plain `indexOf("--tools")` and latched hardening off with
            // the false diagnosis "rejected an injected hardening flag". No unhardened model call was
            // reachable that way — the bare retry still carries the user's bad flag and fails at parse —
            // but a wrong diagnosis plus a wasted attempt is exactly what this gate exists to prevent.
            const at = flagIndex(msg, t.split("=")[0]!);
            return at !== -1 && Math.abs(at - hit.index) <= REJECTION_PROXIMITY;
          });
        // `extra.length > 0` is now SUBSUMED by `namesOurs` (which is false for an empty `extra`), so it is
        // an equivalent clause and cannot be killed on its own — noted because a future edit to `namesOurs`
        // would silently un-protect the nothing-was-injected case with no failing test. Kept as the
        // explicit statement of the precondition.
        if (extra.length > 0 && e instanceof ProviderError && fastEnough && namesOurs) {
          disableHardening(`the provider CLI rejected an injected hardening flag (${firstLine(e.message)}); hardening flags are disabled for the rest of this run`);
          // Bare means BARE: no flags, and no narrow cwd either, since the gate's own reasoning says the
          // cwd move is only justified while the isolation flag is in effect.
          return await build(undefined, []).generate(prompt);
        }
        throw e;
      }
    },
  };
}

// Local helpers kept tiny so the imports above stay honest about what this module depends on.
function join2(a: string, b: string): string { return resolve(a, b); }
/** `os.tmpdir()`, not a hand-rolled TMPDIR read: it honours TEMP/TMP on Windows (where TMPDIR is
 *  unset, so the old helper fell through to "/tmp" and resolved to a directory at the drive root), and
 *  on macOS it returns the per-user private `/var/folders/…` dir, which is mode 0700 and owned by us —
 *  a strictly better fallback than shared /tmp. */
function tmpdirSafe(): string { return tmpdir(); }

/** First line only: a CLI usage error can dump its whole help text after the message. */
function firstLine(m: string): string { return m.split("\n")[0]!.slice(0, 160); }
