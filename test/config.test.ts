// test/config.test.ts
import { test, expect } from "bun:test";
import { resolveRepos, discoverRepos, initConfig, compileExcludePatterns, repoLabel, isExcludedRepo, isDir } from "../src/config";
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../src/git";

test("resolveRepos returns explicit repos verbatim when present", async () => {
  const cfg = { repos: ["/a", "/b"], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  expect(await resolveRepos(cfg)).toEqual(["/a", "/b"]);
});

test("resolveRepos discovers .git dirs under discoverRoots when repos absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "dba-"));
  mkdirSync(join(root, "proj1", ".git"), { recursive: true });
  mkdirSync(join(root, "proj2", ".git"), { recursive: true });
  const cfg = { discoverRoots: [root], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  const repos = (await resolveRepos(cfg)).sort();
  expect(repos).toEqual([join(root, "proj1"), join(root, "proj2")]);
});

test("resolveRepos discovers grandchildren (2 levels deep) under discoverRoots", async () => {
  const root = mkdtempSync(join(tmpdir(), "dba-"));
  mkdirSync(join(root, "group", "proj1", ".git"), { recursive: true });
  const cfg = { discoverRoots: [root], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  const repos = await resolveRepos(cfg);
  expect(repos).toEqual([join(root, "group", "proj1")]);
});

test("resolveRepos prefers explicit repos over discoverRoots when both are set (no union, no discovery)", async () => {
  const root = mkdtempSync(join(tmpdir(), "dba-"));
  mkdirSync(join(root, "proj1", ".git"), { recursive: true });
  const cfg = {
    repos: ["/explicit/only"],
    discoverRoots: [root],
    provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const },
  };
  expect(await resolveRepos(cfg)).toEqual(["/explicit/only"]);
});

test("discoverRepos returns explicit repos verbatim with no issues", async () => {
  const cfg = { repos: ["/a", "/b"], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  const { repos, issues } = await discoverRepos(cfg);
  expect(repos).toEqual(["/a", "/b"]);
  expect(issues).toEqual([]);
});

test("discoverRepos: excludeRepos drops a matching repo from an EXPLICIT list (absolute path)", async () => {
  const cfg = {
    repos: ["/a", "/b/chef-repo"],
    excludeRepos: ["/b/chef-repo"],
    provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const },
  };
  const { repos } = await discoverRepos(cfg);
  expect(repos).toEqual(["/a"]);
});

test("discoverRepos: excludeRepos matches by basename AND filters DISCOVERED repos, not just explicit ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "dba-"));
  mkdirSync(join(root, "keep", ".git"), { recursive: true });
  mkdirSync(join(root, "chef-repo", ".git"), { recursive: true });
  const cfg = {
    discoverRoots: [root],
    excludeRepos: ["chef-repo"], // basename form excludes the discovered /…/chef-repo
    provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const },
  };
  expect(await resolveRepos(cfg)).toEqual([join(root, "keep")]);
});

test("isExcludedRepo: matches absolute path or basename; empty/undefined list excludes nothing", () => {
  expect(isExcludedRepo("/x/dev/chef-repo", ["chef-repo"])).toBe(true);        // basename
  expect(isExcludedRepo("/x/dev/chef-repo", ["/x/dev/chef-repo"])).toBe(true);  // absolute path
  expect(isExcludedRepo("/x/dev/chef-repo", ["/x/dev/chef-repo/"])).toBe(true); // trailing slash tolerated
  expect(isExcludedRepo("/x/dev/chef-repo", ["/other/chef-repo-2"])).toBe(false);
  expect(isExcludedRepo("/x/dev/keep", ["chef-repo"])).toBe(false);
  expect(isExcludedRepo("/x/dev/chef-repo", [])).toBe(false);
  expect(isExcludedRepo("/x/dev/chef-repo", undefined)).toBe(false);
});

test("discoverRepos surfaces a blocked (unreadable) discoverRoot as an issue and still finds repos under a readable root", async () => {
  const good = mkdtempSync(join(tmpdir(), "dba-good-"));
  mkdirSync(join(good, "proj1", ".git"), { recursive: true });
  const blocked = mkdtempSync(join(tmpdir(), "dba-blocked-"));
  chmodSync(blocked, 0o000);
  const cfg = { discoverRoots: [good, blocked], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  try {
    const { repos, issues } = await discoverRepos(cfg);
    expect(repos).toContain(join(good, "proj1"));
    expect(issues.some((i) => i.path === blocked && i.kind === "unreadable")).toBe(true);
  } finally {
    chmodSync(blocked, 0o755); // restore so the tmpdir is cleanable
  }
});

test("discoverRepos surfaces a blocked root as an 'unreadable' issue (real EACCES, darwin) — classification not swallowed", async () => {
  // A real readdir on a chmod-000 dir yields EACCES → 'unreadable' (a real EPERM/tcc-denied can't
  // be produced in a tmpdir; that path is covered by the injected-probe tests in main/extractor).
  const blocked = mkdtempSync(join(tmpdir(), "dba-prot-"));
  chmodSync(blocked, 0o000);
  const cfg = { discoverRoots: [blocked], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  try {
    const { issues } = await discoverRepos(cfg, { platform: "darwin", protectedRoots: [blocked] });
    const issue = issues.find((i) => i.path === blocked);
    expect(issue).toBeDefined();
    expect(issue!.kind).toBe("unreadable");
  } finally {
    chmodSync(blocked, 0o755);
  }
});

test("resolveRepos discovers a repo whose .git is a FILE (a real git worktree), not just a directory", async () => {
  // `.git` is a directory for a normal repo but a "gitdir: <path>" FILE for a worktree (and for
  // submodules). A naive isDir(join(dir, ".git")) check misses the file form, so a worktree's
  // activity would silently vanish from discovery.
  const root = mkdtempSync(join(tmpdir(), "dba-wt-"));
  const mainRepo = join(root, "main");
  mkdirSync(mainRepo, { recursive: true });
  await runGit(["init", "-q", "-b", "main"], mainRepo);
  await runGit(["config", "user.email", "test@example.com"], mainRepo);
  await runGit(["config", "user.name", "Test"], mainRepo);
  writeFileSync(join(mainRepo, "a.txt"), "a");
  await runGit(["add", "."], mainRepo);
  await runGit(["commit", "-q", "-m", "init"], mainRepo);
  const worktreeDir = join(root, "wt");
  await runGit(["worktree", "add", "-q", "-b", "feature", worktreeDir], mainRepo);
  const cfg = { discoverRoots: [root], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" as const } };
  const repos = (await resolveRepos(cfg)).sort();
  expect(repos).toContain(worktreeDir);
  expect(repos).toContain(mainRepo);
});

test("initConfig is a no-op when a config already exists: returns wrote:false and does not overwrite it", async () => {
  const cfgHome = mkdtempSync(join(tmpdir(), "dba-cfg-"));
  mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
  const cfgFile = join(cfgHome, "daily-briefing", "config.json");
  const original = JSON.stringify({ marker: "do-not-touch" });
  writeFileSync(cfgFile, original);
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfgHome;
  try {
    const result = await initConfig();
    expect(result.wrote).toBe(false);
    expect(result.cliFound).toBe(true); // config-exists early return suppresses the no-CLI notice
    expect(result.path).toBe(cfgFile);
    expect(readFileSync(cfgFile, "utf8")).toBe(original);
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

test("compileExcludePatterns keeps valid regexes and collects invalid ones without throwing", () => {
  const { regexes, invalid } = compileExcludePatterns(["^vault backup:", "(unbalanced"]);
  expect(regexes.length).toBe(1);
  expect(regexes[0]!.test("vault backup: 2026")).toBe(true);
  expect(invalid).toEqual(["(unbalanced"]);
});

test("repoLabel: bare basename when unique, parent-qualified when two configured repos collide", () => {
  const all = ["/clients/acme/api", "/clients/globex/api", "/work/personal_code"];
  // unique basename → bare
  expect(repoLabel("/work/personal_code", all)).toBe("personal_code");
  // colliding basename → disambiguated by parent dir so two distinct projects never merge under [api]
  expect(repoLabel("/clients/acme/api", all)).toBe("acme/api");
  expect(repoLabel("/clients/globex/api", all)).toBe("globex/api");
});

test("hasGitEntry is exported and detects a .git entry", async () => {
  const { hasGitEntry } = await import("../src/config");
  const root = mkdtempSync(join(tmpdir(), "dba-hge-"));
  mkdirSync(join(root, "sub", ".git"), { recursive: true });
  expect(await hasGitEntry(join(root, "sub"))).toBe(true);
  expect(await hasGitEntry(root)).toBe(false);
});

import { validateConfig } from "../src/config";
test("validateConfig: rejects bad provider / non-number lookbackCapDays ('4'→'41') / non-object tokenBudget / bad repos [Tier-3 #13]", () => {
  const P = { cli: "claude", argv: [], promptVia: "stdin" as const }; // a complete, valid provider
  expect(() => validateConfig({}, "/home/u")).toThrow(/provider/i);                                           // missing provider
  expect(() => validateConfig({ provider: { cli: "claude" } }, "/home/u")).toThrow(/provider/i);              // missing argv/promptVia → would TypeError deep in generate
  expect(() => validateConfig({ provider: { cli: 5, argv: [], promptVia: "stdin" } }, "/home/u")).toThrow(/provider/i);
  expect(() => validateConfig({ provider: P, lookbackCapDays: "4" }, "/home/u")).toThrow(/lookbackCapDays.*number/i);
  expect(() => validateConfig({ provider: P, tokenBudget: 5000 }, "/home/u")).toThrow(/tokenBudget/i);        // object, not a bare number
  expect(() => validateConfig({ provider: P, repos: "nope" }, "/home/u")).toThrow(/repos.*array/i);
  // valid tokenBudget object passes; a non-string morningTime does NOT hard-fail (parseFloor degrades it)
  const ok = validateConfig({ provider: P, tokenBudget: { maxChars: 5000 }, morningTime: 720 } as any, "/home/u");
  expect(ok.tokenBudget).toEqual({ maxChars: 5000 });
});
test("validateConfig: rejects malformed author / subprojects shape [pre-spec B1]", () => {
  const P = { cli: "claude", argv: [], promptVia: "stdin" as const };
  // author: a STRING (or a string-valued emails/names) would spread into per-CHARACTER --author filters
  // (git.ts authorArgs) → matches ~every commit → silently credits other people's commits.
  expect(() => validateConfig({ provider: P, author: "me@x.com" } as any, "/home/u")).toThrow(/author/i);
  expect(() => validateConfig({ provider: P, author: { emails: "me@x.com" } } as any, "/home/u")).toThrow(/author\.emails/i);
  expect(() => validateConfig({ provider: P, author: { names: [5] } } as any, "/home/u")).toThrow(/author\.names/i);
  // subprojects: a non-array (or an entry missing roots) currently TypeErrors deep in resolveProjectRoots
  // on EVERY 10-min launchd tick — must fail fast with a clear message per the §6 config contract.
  expect(() => validateConfig({ provider: P, subprojects: { repo: "/a", roots: ["x"] } } as any, "/home/u")).toThrow(/subprojects.*array/i);
  expect(() => validateConfig({ provider: P, subprojects: [{ repo: "/a" }] } as any, "/home/u")).toThrow(/subprojects/i);
  expect(() => validateConfig({ provider: P, subprojects: [{ repo: "/a", roots: "x" }] } as any, "/home/u")).toThrow(/subprojects/i);
  // a [null] entry is rejected (not left to crash downstream in resolveProjectRoots)
  expect(() => validateConfig({ provider: P, subprojects: [null] } as any, "/home/u")).toThrow(/subprojects/i);
  // valid shapes pass through unchanged
  const ok = validateConfig({ provider: P, author: { names: ["Me"], emails: ["me@x.com"] }, subprojects: [{ repo: "/a", roots: ["pkg/*"] }] } as any, "/home/u");
  expect(ok.author?.emails).toEqual(["me@x.com"]);
  expect(ok.subprojects?.[0]?.roots).toEqual(["pkg/*"]);
  // empty-but-valid shapes MUST pass (don't over-reject); `null` == unset (preserve the pre-diff no-op)
  expect(() => validateConfig({ provider: P, author: {}, subprojects: [] } as any, "/home/u")).not.toThrow();
  expect(() => validateConfig({ provider: P, author: { names: [] }, subprojects: [{ repo: "/a", roots: [] }] } as any, "/home/u")).not.toThrow();
  expect(() => validateConfig({ provider: P, author: null, subprojects: null } as any, "/home/u")).not.toThrow();
});
test("validateConfig: expands a leading ~ in repos/discoverRoots/excludeRepos; valid config passes [Tier-3 #13]", () => {
  const c = validateConfig({ provider: { cli: "claude", argv: [], promptVia: "stdin" }, repos: ["~/dev/x", "/abs/y"], discoverRoots: ["~"], excludeRepos: ["~/z"], lookbackCapDays: 4 }, "/home/u");
  expect(c.repos).toEqual(["/home/u/dev/x", "/abs/y"]);
  expect(c.discoverRoots).toEqual(["/home/u"]);
  expect(c.excludeRepos).toEqual(["/home/u/z"]);
  expect(c.lookbackCapDays).toBe(4);
});

test("validateConfig: provider.timeoutMs must be a number if present; a valid one is kept [Tier-3 #8]", () => {
  const P = { cli: "claude", argv: [], promptVia: "stdin" as const };
  expect(() => validateConfig({ provider: { ...P, timeoutMs: "slow" } }, "/home/u")).toThrow(/timeoutMs.*number/i);
  expect(() => validateConfig({ provider: { ...P, timeoutMs: 0 } }, "/home/u")).toThrow(/timeoutMs.*positive/i); // #8 review: reject <= 0
  expect(validateConfig({ provider: { ...P, timeoutMs: 300000 } }, "/home/u").provider.timeoutMs).toBe(300000);
});

test("initConfig writes networkProbeHosts (discoverable escape hatch for local/offline providers) [Tier-3 #9]", async () => {
  const cfgHome = mkdtempSync(join(tmpdir(), "dba-init9-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfgHome;
  try {
    const result = await initConfig();
    expect(result.wrote).toBe(true);
    const written = JSON.parse(readFileSync(result.path, "utf8"));
    expect(Array.isArray(written.networkProbeHosts)).toBe(true);
    expect(written.networkProbeHosts.length).toBeGreaterThan(0); // a user can set [] to disable the probe
    // ...and `provider.credential`, written at its default for the SAME discoverability reason.
    // MEASURED: deleting it from the template survived the entire suite — so the one field whose
    // whole purpose is "be visible so the alternative can be found" was the field nothing checked
    // was actually in the template.
    expect(written.provider.credential).toBe("subscription");
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

test.skipIf(process.platform === "win32")("discoverRepos descends a symlinked directory (stat-follows-symlink preserved after withFileTypes) [Tier-5]", async () => {
  // (Windows symlinkSync needs elevation/Developer Mode; skip there — CI runs on ubuntu.)
  const base = mkdtempSync(join(tmpdir(), "dba-symlink-"));
  const root = join(base, "root");
  const container = join(root, "container");
  mkdirSync(container, { recursive: true });
  // a real repo (worktree-pointer `.git` FILE form) OUTSIDE the walk, reached only via a symlink
  const realRepo = join(base, "realrepo");
  mkdirSync(realRepo);
  writeFileSync(join(realRepo, ".git"), "gitdir: /elsewhere");
  symlinkSync(realRepo, join(container, "linked"));
  const { repos } = await discoverRepos({
    discoverRoots: [root],
    provider: { cli: "c", argv: [], promptVia: "stdin" as const },
  });
  // the dirent for `linked` is a symlink (not a directory), so it hits the `!isFile() && isDir()`
  // stat-fallback branch — the SAME branch that rescues DT_UNKNOWN dirents on NFS/SMB/FUSE mounts.
  expect(repos).toContain(join(container, "linked"));
});

test("isDir: true for a directory, false for a file and a missing path (dedup target for subprojects) [Tier-5]", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dba-isdir-"));
  const file = join(dir, "f.txt");
  writeFileSync(file, "x");
  expect(await isDir(dir)).toBe(true);
  expect(await isDir(file)).toBe(false);
  expect(await isDir(join(dir, "nope"))).toBe(false); // ENOENT → false, not a throw
});

test("discoverRepos: a discoverRoot that is ITSELF a repo is found (init from inside your own repo) [Tier-B]", async () => {
  const repo = mkdtempSync(join(tmpdir(), "dba-selfrepo-"));
  mkdirSync(join(repo, ".git")); // the root itself is a repo
  const { repos } = await discoverRepos({ discoverRoots: [repo], provider: { cli: "c", argv: [], promptVia: "stdin" as const } });
  expect(repos).toContain(repo); // the root itself, not just its children
});

test("discoverRepos: a discoverRoot that is a repo AND contains nested repos yields BOTH (dotfiles-in-$HOME) [Tier-D]", async () => {
  // MED-2 regression guard: initConfig always adds homedir() as a discoverRoot. If $HOME itself has a
  // real .git (dotfiles tracked directly in $HOME — a genuine pattern), the earlier short-circuit
  // `continue` collapsed discovery to [$HOME] and DROPPED every project repo under ~. The root-is-a-repo
  // case must record the root AND still walk children for independent nested repos.
  const root = mkdtempSync(join(tmpdir(), "dba-rootrepo-"));
  mkdirSync(join(root, ".git"));                                  // the root itself is a repo ($HOME dotfiles)
  mkdirSync(join(root, "proj1", ".git"), { recursive: true });   // an independent nested repo under it
  mkdirSync(join(root, "proj2", ".git"), { recursive: true });
  mkdirSync(join(root, "src"));                                   // an ORDINARY non-repo child dir (no .git)
  writeFileSync(join(root, "README.md"), "# dotfiles");           // a loose top-level FILE
  const { repos, issues } = await discoverRepos({ discoverRoots: [root], provider: { cli: "c", argv: [], promptVia: "stdin" as const } });
  expect(repos).toContain(root);                 // the root repo itself
  expect(repos).toContain(join(root, "proj1"));  // …and the nested projects are NOT lost
  expect(repos).toContain(join(root, "proj2"));
  expect(repos.length).toBe(3);                  // …and ONLY those — the ordinary `src/` dir isn't a repo
  // A loose top-level file must NOT be handed to discoverUnder and logged as a spurious `not-a-repo` issue.
  expect(issues.filter((i) => i.kind === "not-a-repo")).toEqual([]);
});

test("initConfig: cliFound reflects the injected CLI finder (drives the init no-CLI notice) [Tier-B]", async () => {
  const prevXdg = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "dba-nocli-"));
    const noCli = await initConfig(async () => undefined);       // neither claude nor codex on PATH
    expect(noCli.wrote).toBe(true);
    expect(noCli.cliFound).toBe(false);                          // → init() prints the "install a CLI" notice
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "dba-yescli-"));
    const found = await initConfig(async (c) => c === "claude" ? "/usr/bin/claude" : undefined);
    expect(found.cliFound).toBe(true);
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
  }
});

test('validateConfig rejects an unknown provider.credential and accepts the two valid values', () => {
  // The one thing telling a user their `"env_api_key"` typo is inert. MEASURED: deleting the
  // validation branch left the whole suite green, so nothing pinned it. Consequence is bounded —
  // an unrecognised value fails SAFE via `!== "env-api-key"`, i.e. withholds — but then the user
  // silently gets the opposite of what they typed.
  const base = { provider: { cli: "claude", argv: [], promptVia: "stdin" as const } };
  expect(() => validateConfig({ ...base, provider: { ...base.provider, credential: "env_api_key" } }, "/h"))
    .toThrow(/credential/i);
  for (const v of ["subscription", "env-api-key", undefined]) {
    expect(() => validateConfig({ ...base, provider: { ...base.provider, credential: v } }, "/h")).not.toThrow();
  }
});

test("auditJudgeArgv must be an array of strings", () => {
  const base = { provider: { cli: "c", argv: [], promptVia: "stdin" } };
  expect(() => validateConfig({ ...base, auditJudgeArgv: ["--model", "opus"] }, "/home/u")).not.toThrow();
  expect(() => validateConfig({ ...base, auditJudgeArgv: undefined }, "/home/u")).not.toThrow();
  expect(() => validateConfig({ ...base, auditJudgeArgv: "--model opus" }, "/home/u")).toThrow(/auditJudgeArgv/);
  expect(() => validateConfig({ ...base, auditJudgeArgv: ["--model", 5] }, "/home/u")).toThrow(/auditJudgeArgv/);
});
