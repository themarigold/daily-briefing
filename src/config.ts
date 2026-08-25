// src/config.ts
import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import type { Config, TokenBudget } from "./types";
import { classify, type PathIssue, type GuardOpts } from "./protectedPath";

// Short per-repo label for display: the basename, unless another configured repo shares it
// (e.g. /a/api and /b/api) — then qualify with the parent dir so the briefing never merges two
// distinct projects under one `[api]` tag (review: basename collision).
//
// NOT injective, and an earlier revision of this comment claiming "UNIQUE per-repo" overstated it: it
// qualifies with exactly ONE parent segment, so `/u/a/x/api` and `/u/b/x/api` both render `x/api`.
// Callers must therefore never FILTER or DEDUPE on this value — the audit did, and a collision deleted
// one repo's diagnosis entirely. Compare on full paths; use this only to render.
export function repoLabel(path: string, allPaths: string[]): string {
  const b = basename(path);
  return allPaths.some((p) => p !== path && basename(p) === b) ? join(basename(dirname(path)), b) : b;
}

export const DEFAULT_LOOKBACK_CAP_DAYS = 4;
// Commit subjects matching these (regex) are dropped as bot/auto-commit noise — the vault
// auto-commits every ~10 min as the same author, so an author filter alone can't catch them (#3).
export const DEFAULT_EXCLUDE_COMMIT_PATTERNS = ["^vault backup:"];

// Compile the (user-configurable) exclude patterns ONCE, tolerating a bad regex: a typo'd pattern
// is collected in `invalid` (so the caller can warn) instead of throwing and silently degrading the
// whole briefing to a misleading "partial failure reading repo" (#4).
export function compileExcludePatterns(patterns: string[]): { regexes: RegExp[]; invalid: string[] } {
  const regexes: RegExp[] = [];
  const invalid: string[] = [];
  for (const p of patterns) {
    try { regexes.push(new RegExp(p)); } catch { invalid.push(p); }
  }
  return { regexes, invalid };
}
// Slice 1 input is git-only (commit messages + diffstat) and naturally bounded — unlike
// Slice 1.5, which will add transcripts and needs tighter budgeting. Keep this high so stage 2
// of reduce() (which drops activities/evidence, see src/reduce.ts) stays a rare safety net for
// pathological monorepos rather than tripping on a normal busy day.
export const DEFAULT_BUDGET: TokenBudget = { maxChars: 200000 };

export const DEFAULT_NETWORK_PROBE_HOSTS = [{ host: "1.1.1.1", port: 443 }, { host: "8.8.8.8", port: 443 }];

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "daily-briefing", "config.json");
}

// Expand a leading ~ (the natural way people write config paths) against home; other paths untouched.
export function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p;
}

// Light validation of the hand-edited config (spec §6: a typo must fail fast with a clear message,
// not blind-cast into a TypeError deep in the pipeline or silent wrong math — e.g. lookbackCapDays:"4"
// made `cap + 1` the STRING "41", a 41-day scan). Also normalizes path arrays (~-expansion). Throws
// `Error("config error: …")` which run()'s catch surfaces as "Config error: …" (exit 2), NOT "no-config".
export function validateConfig(raw: unknown, home: string): Config {
  if (!raw || typeof raw !== "object") throw new Error("config error: the config is not a JSON object");
  const c = raw as Record<string, unknown>;
  // provider is required + wholly consumed unguarded downstream (argv is spread, promptVia is switched
  // on), so validate the whole shape — not just cli — or a missing argv/promptVia still TypeErrors deep
  // in BYOCliProvider.generate (the exact failure mode this validation exists to prevent).
  const p = c.provider as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object" || typeof p.cli !== "string" ||
      !Array.isArray(p.argv) || (p.argv as unknown[]).some((x) => typeof x !== "string") ||
      (p.promptVia !== "stdin" && p.promptVia !== "arg")) {
    throw new Error('config error: "provider" must be { cli: string, argv: string[], promptVia: "stdin"|"arg" } (run `daily-briefing init`)');
  }
  if (p.timeoutMs !== undefined && (typeof p.timeoutMs !== "number" || !Number.isFinite(p.timeoutMs) || p.timeoutMs <= 0)) throw new Error('config error: "provider.timeoutMs" must be a positive number (milliseconds)');
  if (p.harden !== undefined && typeof p.harden !== "boolean") throw new Error('config error: "provider.harden" must be a boolean (default true — set false only to opt out of provider hardening entirely)');
  if (p.credential !== undefined && p.credential !== "subscription" && p.credential !== "env-api-key") throw new Error('config error: "provider.credential" must be "subscription" (default — withhold ANTHROPIC_API_KEY so the CLI uses its logged-in subscription) or "env-api-key" (pass the key through and bill API credits)');
  // `provider.accounts` is validated at its USE SITE (resolveAccounts, below), not here — the same
  // shape `transcripts` uses. Validating here could only throw or strip: a throw lands at main.ts's
  // `Config error:` + `return 2` on EVERY 600s tick, and stripping destroys the very information a
  // warning would carry. Neither belongs in a function whose only outputs are "a Config" or "an
  // exception". resolveAccounts returns warnings alongside the parsed list, and core.ts pushes them
  // into the briefing's warnings the way it already does for transcripts.
  for (const k of ["repos", "discoverRoots", "excludeRepos", "excludeCommitPatterns"]) {
    const v = c[k];
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string"))) throw new Error(`config error: "${k}" must be an array of strings`);
  }
  if (c.lookbackCapDays !== undefined && (typeof c.lookbackCapDays !== "number" || !Number.isFinite(c.lookbackCapDays))) throw new Error(`config error: "lookbackCapDays" must be a number, not ${JSON.stringify(c.lookbackCapDays)}`);
  const aj = (c as Record<string, unknown>).auditJudgeArgv;
  if (aj !== undefined && (!Array.isArray(aj) || aj.some((x) => typeof x !== "string"))) {
    throw new Error('config error: "auditJudgeArgv" must be an array of strings (e.g. ["--model", "opus"])');
  }
  const tb = c.tokenBudget; // an OBJECT { maxChars: number }, not a bare number
  if (tb !== undefined && (typeof tb !== "object" || tb === null || typeof (tb as Record<string, unknown>).maxChars !== "number")) throw new Error('config error: "tokenBudget" must be { maxChars: number }');
  // author: MUST be an object of string-ARRAYS. The dangerous shape is a STRING-VALUED names/emails
  // (e.g. {emails:"me@x.com"}): it spreads per-character into --author filters (git.ts authorArgs) → git
  // ORs "--author=m --author=e …" → matches ~every commit, silently crediting other people's work.
  // (A bare-string / singular-key-typo author is instead silently IGNORED → safe git-config-identity
  // fallback; rejected here anyway so a value-shape typo surfaces loudly rather than being ignored.
  // `null` is treated as unset — preserving the pre-diff no-op.)
  const au = c.author;
  if (au != null) {
    if (typeof au !== "object" || Array.isArray(au)) throw new Error('config error: "author" must be { names?: string[], emails?: string[] }');
    for (const k of ["names", "emails"] as const) {
      const v = (au as Record<string, unknown>)[k];
      if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string"))) throw new Error(`config error: "author.${k}" must be an array of strings`);
    }
  }
  // subprojects: MUST be an array of { repo: string, roots: string[] }. A non-array or a roots-less entry
  // otherwise TypeErrors deep in resolveProjectRoots on EVERY launchd tick (fail-fast per the §6 contract).
  // `null` is treated as unset (preserving the pre-diff no-op).
  const sp = c.subprojects;
  if (sp != null) {
    if (!Array.isArray(sp)) throw new Error('config error: "subprojects" must be an array of { repo: string, roots: string[] }');
    for (const entry of sp) {
      const e = entry as Record<string, unknown> | null;
      if (!e || typeof e !== "object" || typeof e.repo !== "string" || !Array.isArray(e.roots) || (e.roots as unknown[]).some((x) => typeof x !== "string")) {
        throw new Error('config error: each "subprojects" entry must be { repo: string, roots: string[] }');
      }
    }
  }
  // morningTime is intentionally NOT hard-validated: parseFloor (schedule.ts) already degrades a bad
  // value gracefully (default 07:20 + a warning) so the briefing still runs — don't regress that.
  const expand = (v: unknown) => Array.isArray(v) ? (v as string[]).map((x) => expandTilde(x, home)) : v;
  return { ...(c as Config), repos: expand(c.repos) as Config["repos"], discoverRoots: expand(c.discoverRoots) as Config["discoverRoots"], excludeRepos: expand(c.excludeRepos) as Config["excludeRepos"] };
}

// ── Slice 1.5 §3.6: transcripts config + root resolution (T1.1/T1.2) ──────────────────────────────
// B1 style, like resolveProbeHosts (net.ts): a malformed block WARNS and disables the feature, it
// never throws out of loadConfig. A transcript-config typo must not take the morning briefing down —
// the feature is optional and off by default, while the briefing is the product.
export const DEFAULT_TRANSCRIPTS_DIRNAME = "projects";

export type ResolvedTranscripts = { enabled: boolean; root: string; warning?: string };

/** Resolution order (§3.6): `transcripts.root` → `CLAUDE_CONFIG_DIR` → default `~/.claude/projects`.
 *  `env`/`home` are injected so the three branches are testable without mutating process state. */
export function resolveTranscripts(
  raw: unknown, home: string, env: Record<string, string | undefined> = process.env,
): ResolvedTranscripts {
  // The default root is computed even when the feature is off, so `enabled: true` added later to an
  // existing config needs no other edit — the case config.ts's early-returning initConfig creates.
  const claudeDir = env.CLAUDE_CONFIG_DIR;
  const fallback = claudeDir
    ? join(expandTilde(claudeDir, home), DEFAULT_TRANSCRIPTS_DIRNAME)
    : join(home, ".claude", DEFAULT_TRANSCRIPTS_DIRNAME);

  if (raw === undefined || raw === null) return { enabled: false, root: fallback }; // unset is not a typo — no warning
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { enabled: false, root: fallback, warning: 'config: "transcripts" must be { enabled?: boolean, root?: string } — transcript evidence disabled' };
  }
  const t = raw as Record<string, unknown>;
  if (t.enabled !== undefined && typeof t.enabled !== "boolean") {
    return { enabled: false, root: fallback, warning: 'config: "transcripts.enabled" must be a boolean — transcript evidence disabled' };
  }
  // A non-string root is a typo; an EMPTY string is too, and is the more dangerous one — `join("", x)`
  // silently yields a relative path, so the scan would read from the process CWD instead of failing.
  if (t.root !== undefined && (typeof t.root !== "string" || t.root.trim() === "")) {
    return { enabled: false, root: fallback, warning: 'config: "transcripts.root" must be a non-empty string — transcript evidence disabled' };
  }
  const root = t.root !== undefined ? expandTilde(t.root as string, home) : fallback;
  return { enabled: t.enabled === true, root };
}

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(configPath());
  if (!(await file.exists())) throw new Error("no-config");
  return validateConfig(await file.json(), homedir());
}

export async function isDir(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

// True if `dir/.git` exists at all, whether a normal repo's DIRECTORY or a worktree's/submodule's
// FILE (a "gitdir: <path>" pointer). A plain isDir() check misses the file form, silently dropping
// worktrees/submodules from discovery. Deliberately NOT `gitDirExists` (git.ts) — that spawns
// `git rev-parse --git-dir`, which searches PARENT directories too; run here on every walked dir,
// that would misclassify a repo-less subdirectory as a repo whenever an ancestor outside the walk
// (e.g. a dotfiles-managed $HOME) happens to be a git repo itself.
export async function hasGitEntry(dir: string): Promise<boolean> {
  try { await stat(join(dir, ".git")); return true; } catch { return false; }
}

// Walk up to `depth` levels under `dir`, collecting repos (dirs containing a `.git`). Skips
// hidden dirs (name starts with ".") and `node_modules`, and stops descending once a `.git` is
// found (don't recurse into a repo's own working tree) — keeps the scan cheap even under $HOME.
// A dir we can't enumerate is CLASSIFIED and surfaced (§5.11) — never a silent skip — so a
// TCC-blocked ~/Desktop shows up as an issue instead of its repos just vanishing.
async function discoverUnder(
  dir: string, depth: number, found: string[], issues: PathIssue[], opts?: GuardOpts,
): Promise<void> {
  if (await hasGitEntry(dir)) { found.push(dir); return; }
  if (depth <= 0) return;
  let entries: Dirent[] = [];
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (e) {
    issues.push(classify(dir, e, opts));
    return;
  }
  for (const dirent of entries) {
    const name = dirent.name;
    if (name.startsWith(".") || name === "node_modules") continue;
    const child = join(dir, name);
    // Use the dirent's type from readdir instead of a stat per child (skips a stat for the common
    // dir/regular-file cases). Fall back to stat for anything that ISN'T a plain file — symlinks
    // (stat follows them, preserving the prior descend-into-symlinked-dir behavior) AND dirents whose
    // type is unresolved (DT_UNKNOWN on some NFS/SMB/FUSE mounts, where isDirectory() is false for a
    // real directory). Only a known regular file is skipped stat-free. Matches the old stat-everything
    // semantics for every non-file entry, so no repo is lost on exotic filesystems.
    if (dirent.isDirectory() || (!dirent.isFile() && await isDir(child))) {
      await discoverUnder(child, depth - 1, found, issues, opts);
    }
  }
}

// True if `repoPath` is in the exclude list — matched by exact absolute path OR by basename
// (the ergonomic form: `"chef-repo"` drops /Users/x/dev/chef-repo without pinning the full path).
// A trailing slash on an entry is tolerated. Case-sensitive; paths compared verbatim (no realpath)
// to match how repos are stored in config. NB basename matching drops *every* repo with that
// basename — intended for a deliberate personal exclude, not surgical path targeting.
export function isExcludedRepo(repoPath: string, exclude?: string[]): boolean {
  if (!exclude || exclude.length === 0) return false;
  const b = basename(repoPath);
  return exclude.some((e) => {
    const norm = e.endsWith("/") ? e.slice(0, -1) : e;
    return norm === repoPath || norm === b;
  });
}

// Discover repos AND surface any protected-path/read issues hit while walking (§5.11).
// Explicit `repos` short-circuits discovery entirely (and yields no issues). `excludeRepos` is
// applied LAST to both paths, so a stale/work checkout is dropped whether it was listed or found.
export async function discoverRepos(cfg: Config, opts?: GuardOpts): Promise<{ repos: string[]; issues: PathIssue[] }> {
  const keep = (paths: string[]) => paths.filter((p) => !isExcludedRepo(p, cfg.excludeRepos));
  if (cfg.repos && cfg.repos.length) return { repos: keep(cfg.repos), issues: [] };
  const found: string[] = [];
  const issues: PathIssue[] = [];
  for (const root of cfg.discoverRoots ?? []) {
    // The root ITSELF may be a repo (running `init` from inside your own project, a common first move) —
    // record it. But STILL walk its children: a repo can contain independent nested clones — e.g. dotfiles
    // tracked directly in $HOME (which initConfig always adds as a discoverRoot) with project repos beneath
    // it — and short-circuiting here would collapse discovery to just [$HOME] and drop every one of them
    // (final-review Tier-D / MED-2). discoverUnder stops at each child's own .git, so a normal monorepo's
    // non-repo subdirs add nothing (only genuine nested repos are picked up); overlaps are deduped below.
    if (await hasGitEntry(root)) found.push(root);
    let entries: Dirent[] = [];
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (e) {
      issues.push(classify(root, e, opts));
      continue;
    }
    for (const dirent of entries) {
      const name = dirent.name;
      if (name.startsWith(".") || name === "node_modules") continue;
      const dir = join(root, name);
      // Only descend into DIRECTORY children (same DT_UNKNOWN-safe dirent guard as discoverUnder): a
      // root's loose top-level FILES (README.md, package.json — common under a repo root) must not be
      // handed to discoverUnder, whose readdir would ENOTDIR and log a spurious `not-a-repo` issue per
      // file (final-review Tier-D). A known regular file is skipped stat-free; symlinks / DT_UNKNOWN
      // fall back to stat so no real directory is missed on exotic filesystems.
      if (!(dirent.isDirectory() || (!dirent.isFile() && await isDir(dir)))) continue;
      // 2 levels deep under each root: immediate children AND grandchildren.
      await discoverUnder(dir, 1, found, issues, opts);
    }
  }
  return { repos: keep([...new Set(found)]), issues }; // dedupe: overlapping roots (e.g. init's [cwd, home]) can find the same repo twice
}

export async function resolveRepos(cfg: Config): Promise<string[]> {
  return (await discoverRepos(cfg)).repos;
}

// Resolve the absolute path of a CLI on PATH via `which` (POSIX) / `where` (Windows); returns
// undefined if not found. launchd agents get a minimal PATH, so a bare name won't resolve at
// wake-time — the config must store an absolute path (spec §5.1 / final-review FIX 3).
async function resolveCliPath(cli: string): Promise<string | undefined> {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const p = Bun.spawn([finder, cli], { stdout: "pipe", stderr: "pipe" });
    // Drain stdout+stderr concurrently: a sequential read of stdout-then-stderr can hang forever
    // if the child fills the stderr pipe buffer first. NOTE: runGit no longer shares this shape —
    // it races the reads against a flush window so a grandchild holding the pipe cannot hang it
    // (C1/A1). `which`/`where` spawns no grandchildren, so the simpler form is fine here; C1 rev
    // 3.4 explicitly scopes this site out rather than claiming every child is bounded.
    const [out] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    await p.exited;
    if (p.exitCode === 0) {
      // `where` can print multiple matches (one per line); take the first.
      const resolved = out.split(/\r?\n/)[0]?.trim();
      if (resolved) return resolved;
    }
    return undefined;
  } catch { return undefined; }
}

export async function initConfig(
  resolveCli: (cli: string) => Promise<string | undefined> = resolveCliPath, // injectable for tests
): Promise<{ path: string; wrote: boolean; cliFound: boolean }> {
  const path = configPath();
  if (await Bun.file(path).exists()) return { path, wrote: false, cliFound: true };
  // detect an installed provider CLI (spec §5.1); default to claude
  const claudePath = await resolveCli("claude");
  const codexPath = claudePath ? undefined : await resolveCli("codex");
  const cliFound = !!(claudePath || codexPath); // neither on PATH → we default to "claude" but must warn (#13)
  const cli = claudePath ?? codexPath ?? "claude";
  const argv = codexPath && cli === codexPath ? ["exec"] : ["-p"];
  // Actually discover repos so a first-time user gets a working config, not a placeholder path.
  const discoverRoots = [process.cwd(), homedir()];
  const discovered = await resolveRepos({
    discoverRoots,
    provider: { cli, argv, promptVia: "stdin" },
  });
  const template: Config = {
    ...(discovered.length ? { repos: discovered } : {}),
    // Keep discoverRoots as a fallback even when repos were found (e.g. for a future re-scan).
    discoverRoots,
    // `harden` is written explicitly at its DEFAULT so the opt-out is discoverable: a user who needs
    // their project MCP servers or hooks during a briefing should not have to read the source to find it.
    // `credential` is written at its default for the same reason `harden` is: so the alternative is
    // DISCOVERABLE. A user who wants to spend API credits will never guess at a field that only
    // exists in the type — and the whole point of this setting is that the billing choice should be
    // something you made on purpose rather than something your shell made for you.
    provider: { cli, argv, promptVia: "stdin", harden: true, credential: "subscription" },
    tokenBudget: DEFAULT_BUDGET,
    lookbackCapDays: DEFAULT_LOOKBACK_CAP_DAYS,
    // #9: write the connectivity-probe targets explicitly so they're discoverable/editable — a
    // local/offline provider (a local-model CLI) can set this to [] to skip the daily network wait.
    networkProbeHosts: DEFAULT_NETWORK_PROBE_HOSTS,
  };
  await Bun.write(path, JSON.stringify(template, null, 2));
  return { path, wrote: true, cliFound };
}

/** Validated failover accounts plus the diagnostics that would otherwise be invisible.
 *
 *  Shaped like `resolveTranscripts` on purpose: an OPTIONAL feature validates at its use site and
 *  degrades to "off, with a warning" rather than throwing, because a throw from config loading costs
 *  the briefing on every 600s tick. Anything malformed yields `accounts: undefined`, which the caller
 *  treats as "no failover configured" — identical to today's behaviour. */
export type ResolvedAccounts = { accounts?: { label: string; configDir?: string }[]; warnings: string[] };

export function resolveAccounts(
  raw: unknown, home: string, env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = (p) => existsSync(p),
): ResolvedAccounts {
  const warnings: string[] = [];
  const off = (why: string): ResolvedAccounts => ({ warnings: [`config: "provider.accounts" ${why} — account failover disabled`] });

  // An AMBIENT CLAUDE_CONFIG_DIR is a supported way to set the transcript root (see resolveTranscripts),
  // so it is only worth warning about when no explicit `transcripts.root` overrides it — otherwise a
  // legitimate setup gets a warning on every tick. Reported whether or not failover is configured,
  // because the hazard is the variable's dual meaning, not this feature.
  if (env.CLAUDE_CONFIG_DIR) {
    warnings.push('config: CLAUDE_CONFIG_DIR is set in the environment — it also resolves the transcript scan root, so transcript evidence may come from the wrong directory; set "transcripts.root" explicitly to pin it');
  }
  if (raw === undefined || raw === null) return { warnings };      // unset is not a typo — no warning
  if (!Array.isArray(raw)) return { warnings: [...warnings, ...off("must be an array").warnings] };

  const out: { label: string; configDir?: string }[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") return { accounts: undefined, warnings: [...warnings, ...off("entries must be objects").warnings] };
    const e = a as Record<string, unknown>;
    if (typeof e.label !== "string" || e.label.trim() === "") {
      return { accounts: undefined, warnings: [...warnings, ...off('entries need a non-empty string "label"').warnings] };
    }
    if (e.configDir !== undefined && typeof e.configDir !== "string") {
      return { accounts: undefined, warnings: [...warnings, ...off('"configDir" must be a string when present').warnings] };
    }
    out.push(e.configDir !== undefined ? { label: e.label, configDir: expandTilde(e.configDir as string, home) } : { label: e.label });
  }

  // Marks are keyed by label, so two accounts sharing one would share a limit mark.
  const labels = out.map((a) => a.label);
  if (new Set(labels).size !== labels.length) {
    return { accounts: undefined, warnings: [...warnings, ...off("has duplicate labels, and limit marks are keyed by label").warnings] };
  }

  // Two labels pointing at the SAME login is failover that cannot fail over: the primary walls, the
  // "fallback" is selected, hits the same wall immediately, and both get marked — while the provenance
  // log shows two distinct labels and looks correct. Comparing RESOLVED dirs catches the spelling an
  // absent `configDir` hides, since absent means the CLI's default (~/.claude).
  const resolved = out.map((a) => a.configDir ?? join(home, ".claude"));
  if (new Set(resolved).size !== resolved.length) {
    return { accounts: undefined, warnings: [...warnings, ...off("has two accounts pointing at the same login directory, so it cannot fail over").warnings] };
  }

  // A configured directory with no `.claude.json` has never been logged into. Warn but KEEP the list:
  // an unlogged fallback is still better than none (it only costs a probe), and the check is a
  // heuristic — the user may be about to log in.
  for (const a of out) {
    if (a.configDir && !exists(join(a.configDir, ".claude.json"))) {
      warnings.push(`config: account "${a.label}" points at ${a.configDir}, which has no .claude.json — that account has never been logged in, so failing over to it will not work`);
    }
  }
  return { accounts: out, warnings };
}
