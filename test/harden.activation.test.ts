// test/harden.activation.test.ts
//
// C1/B1+B2+B3+B4+B9 — the activation. These ship as ONE commit for a reason that is easy to miss: B1
// alone is a security REGRESSION. Today the provider inherits whatever cwd the launchd job had (`/`,
// where nothing is discovered). B1 moves it to a directory under `$HOME`, which makes `~/CLAUDE.md` an
// ANCESTOR of the provider's cwd and therefore steering input the model reads. Only B4's
// `--setting-sources user` + `--strict-mcp-config` make the narrower cwd a net win. Split them and the
// intermediate commit is worse than doing nothing.
import { test, expect } from "bun:test";
import { mkdtemp, writeFile, mkdir, symlink, chmod, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenedProvider } from "../src/harden";
import { claudeShaped, resolveCliPath, providerCwd } from "../src/harden";
import { BYOCliProvider } from "../src/provider";
import { ProviderError } from "../src/types";

const fast = { probeMs: 3_000, flushMs: 150 };

/** A fake `claude`: prints the flags it was given, and lists them in --help so the probe finds them. */
async function fakeClaude(dir: string, opts: { help?: string; name?: string } = {}): Promise<string> {
  const help = opts.help ?? "--tools --setting-sources --strict-mcp-config --no-session-persistence";
  const p = join(dir, opts.name ?? "claude");
  await writeFile(p, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '${help}'; exit 0; fi
echo "ARGV:[$*]"
echo "SKIP:[$CLAUDE_CODE_SKIP_PROMPT_HISTORY]"
echo "CWD:[$(pwd)]"
`, { mode: 0o755 });
  return p;
}

// ── B4: the flags ───────────────────────────────────────────────────────────────────────────────────

test("B4: injects --tools= as a SINGLE token, and the prompt stays LAST in arg-mode", async () => {
  // `--tools` is variadic, so `--tools ""` as two tokens would swallow the positional prompt — the CLI
  // would receive the briefing prompt as a tool name and the prompt itself would vanish. The single
  // `--tools=` token is a correctness requirement, not a style choice.
  const dir = await mkdtemp(join(tmpdir(), "dba-b4-"));
  const cli = await fakeClaude(dir);
  const hp = hardenedProvider({ cli, argv: [], promptVia: "arg" }, fast);
  const out = await hp.generate("THE-PROMPT");
  const argv = /ARGV:\[(.*)\]/.exec(out)?.[1] ?? "";
  expect(argv).toContain("--tools=");
  expect(argv).not.toContain("--tools ");            // never split into two tokens
  expect(argv.trim().endsWith("THE-PROMPT")).toBe(true);
});

test("B4: injects --setting-sources user and --strict-mcp-config when the probe finds them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dba-b4b-"));
  const cli = await fakeClaude(dir);
  const out = await hardenedProvider({ cli, argv: [], promptVia: "stdin" }, fast).generate("x");
  expect(out).toContain("--setting-sources user");
  expect(out).toContain("--strict-mcp-config");
});

test("B4: sets CLAUDE_CODE_SKIP_PROMPT_HISTORY=1 in the environment", async () => {
  // Preferred over `--no-session-persistence` because an unknown ENV VAR is ignored while an unknown
  // FLAG is fatal — the env var is safe on any CLI version, the flag is not.
  const dir = await mkdtemp(join(tmpdir(), "dba-b4c-"));
  const cli = await fakeClaude(dir);
  const out = await hardenedProvider({ cli, argv: [], promptVia: "stdin" }, fast).generate("x");
  expect(out).toContain("SKIP:[1]");
});

test("B4: injects NOTHING the probe did not find", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dba-b4d-"));
  const cli = await fakeClaude(dir, { help: "--tools" });   // only --tools listed
  const out = await hardenedProvider({ cli, argv: [], promptVia: "stdin" }, fast).generate("x");
  expect(out).toContain("--tools=");
  expect(out).not.toContain("--setting-sources");
  expect(out).not.toContain("--strict-mcp-config");
});

test("B4: injects nothing for a NON-claude-shaped cli, even if --help lists the flags", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dba-b4e-"));
  const cli = await fakeClaude(dir, { name: "codex" });
  const out = await hardenedProvider({ cli, argv: [], promptVia: "stdin" }, fast).generate("x");
  expect(out).toContain("ARGV:[]");
  expect(out).not.toContain("--tools");
  expect(out).not.toContain("SKIP:[1]");
});

test("B4: claude-shaped detection strips Windows extensions and is case-insensitive", () => {
  for (const n of ["claude", "Claude", "CLAUDE.EXE", "claude.cmd", "claude.bat", "claude.ps1", "/opt/x/claude"]) {
    expect(claudeShaped(n)).toBe(true);
  }
  for (const n of ["codex", "claude-wrapper", "myclaude", "claudia", "sh"]) {
    expect(claudeShaped(n)).toBe(false);
  }
});

// ── B1/B3: the working directory ────────────────────────────────────────────────────────────────────

test("B1: the provider runs in a narrow cwd that is CREATED if missing, not reported as missing-binary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dba-b1-"));
  const cli = await fakeClaude(dir);
  const state = join(dir, "state");                          // does not exist yet
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: state });
  const out = await hp.generate("x");
  // The EXACT preferred path, not `toContain("provider-cwd")` — that substring also matches the tmp
  // fallback `daily-briefing-provider-cwd-<uid>`, so a mutant that broke the preferred rung entirely
  // still passed. And no warning, which is what proves we did not silently fall back.
  // realpath both sides: macOS resolves /var to /private/var, so a raw string compare fails for a
  // reason that has nothing to do with the property under test.
  const cwdUsed = /CWD:\[(.*)\]/.exec(out)?.[1];
  expect(await realpath(cwdUsed!)).toBe(await realpath(join(state, "provider-cwd")));
  expect(hp.runtimeWarnings).toEqual([]);
});

test("B1: the cwd path is STABLE across calls — a per-call mkdtemp would scatter transcript slugs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dba-b1b-"));
  const cli = await fakeClaude(dir);
  const state = join(dir, "state");
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: state });
  const a = /CWD:\[(.*)\]/.exec(await hp.generate("x"))?.[1];
  const b = /CWD:\[(.*)\]/.exec(await hp.generate("y"))?.[1];
  expect(a).toBe(b);
});

test("B1: an EXPLICIT opts.cwd wins over the computed narrow cwd", async () => {
  // Precedence pinned deliberately, not left to whichever spread came last. Without it, the `cwd` field
  // added for B1 would be dead for every caller, and `harden: false` would honour it while
  // `harden: true` ignored it.
  const dir = await mkdtemp(join(tmpdir(), "dba-b1c-"));
  const cli = await fakeClaude(dir);
  const explicit = await mkdtemp(join(tmpdir(), "dba-explicit-"));
  const out = await hardenedProvider({ cli, argv: [], promptVia: "stdin" },
    { ...fast, stateDir: join(dir, "state"), cwd: explicit }).generate("x");
  expect(out).toContain(explicit.split("/").pop()!);
  expect(out).not.toContain("provider-cwd");
});

test("B3: an unusable stateDir FALLS BACK and warns — it must never be fatal", async () => {
  // A briefing is worth more than a narrow cwd. Every rung of the ladder degrades and warns.
  const dir = await mkdtemp(join(tmpdir(), "dba-b3-"));
  const cli = await fakeClaude(dir);
  const blocker = join(dir, "blocked");
  await writeFile(blocker, "not a directory");               // mkdir under a FILE cannot succeed
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(blocker, "nope") });
  const out = await hp.generate("x");
  expect(out).toContain("ARGV:");                            // still produced a briefing
  expect(hp.runtimeWarnings.join(" ")).toMatch(/cwd|working directory/i);
});

test("B3: a SYMLINKED fallback is REJECTED — lstat does not follow it (squat resistance)", async () => {
  // The tmp rung uses a PREDICTABLE name, and `mkdir(recursive)` succeeds silently on an existing
  // directory — so an attacker who pre-creates it would choose the provider's cwd. Reject anything that
  // is a symlink, not 0700, or not ours.
  const dir = await mkdtemp(join(tmpdir(), "dba-b3b-"));
  const target = join(dir, "elsewhere");
  await mkdir(target);
  // 0700 and owned by us DELIBERATELY: with a 0755 target the mode check rejected it and the test
  // passed for the wrong reason — `lstat`→`stat` survived the whole suite. At 0700 the target passes
  // every other check, so the ONLY thing refusing it is that lstat does not follow the link.
  await chmod(target, 0o700);
  const squat = join(dir, "squatted");
  await symlink(target, squat);
  // Refused via lstat's not-a-directory result rather than the explicit isSymbolicLink clause — the two
  // are equivalent while lstat is used, which is why mutating away the symlink clause alone survives.
  // The property that matters, and what this pins, is that the link is not followed.
  const { ok } = await providerCwd({ preferred: squat, tmpFallback: squat });
  expect(ok).toBe(false);
});

test("B3: a WORLD-WRITABLE directory is REJECTED even though we could chmod it", async () => {
  // The one case repair must NOT paper over: anyone could already have planted a CLAUDE.md or .mcp.json
  // inside, and the provider's cwd is precisely where those are read from. Tightening the mode afterwards
  // does not un-plant a file, so the directory is untrustworthy regardless.
  const dir = await mkdtemp(join(tmpdir(), "dba-b3c-"));
  const loose = join(dir, "loose");
  await mkdir(loose, { mode: 0o777 });
  await chmod(loose, 0o777);
  const { ok } = await providerCwd({ preferred: loose, tmpFallback: loose });
  expect(ok).toBe(false);
});

// ── B2: absolute cli resolution ─────────────────────────────────────────────────────────────────────

test("B3: a GROUP-readable (0750) directory we own is REPAIRED, not refused", async () => {
  // The other side of the repair/reject line: group-READABLE is a confidentiality slip in a directory we
  // own, so tighten it and carry on. Anything WRITABLE by group or other is refused outright instead,
  // because that one may already contain planted files and a chmod cannot undo that.
  const dir = await mkdtemp(join(tmpdir(), "dba-group-"));
  const g = join(dir, "grouped");
  await mkdir(g); await chmod(g, 0o750);
  const r = await providerCwd({ preferred: g, tmpFallback: join(dir, "fb") });
  expect(r.cwd).toBe(g);
  expect((await lstat(g)).mode & 0o777).toBe(0o700);
});

test("B2: generate() actually USES resolveCliPath — a relative cli survives the narrow cwd", async () => {
  // The three B2 tests exercised the helper in isolation with literal strings; nothing pinned that the
  // call site uses it, so `cli: cfg.cli` survived the suite. This is the integration the commit message
  // calls load-bearing ("the morning dies with no retry on a wrapper that exists").
  const dir = await mkdtemp(join(tmpdir(), "dba-relcli-"));
  await fakeClaude(dir);
  const prevCwd = process.cwd();
  process.chdir(dir);                                        // so "./claude" is relative to somewhere real
  try {
    const hp = hardenedProvider({ cli: "./claude", argv: [], promptVia: "stdin" },
      { ...fast, stateDir: join(dir, "state") });
    const out = await hp.generate("x");
    expect(out).toContain("ARGV:");                          // it ran at all, from a DIFFERENT cwd
    expect(out).toContain("provider-cwd");                   // ...and the narrow cwd really was in effect
  } finally { process.chdir(prevCwd); }
});

test("B2: a RELATIVE cli path is resolved absolutely — otherwise the narrow cwd breaks it", async () => {
  // `Bun.spawn(["./wrapper.sh"], { cwd: elsewhere })` throws ENOENT, which classifies as
  // missing-binary — which withRetry treats as PERMANENT. The morning dies with no retry, on a wrapper
  // that exists. B2 must ship with B1 for exactly this reason.
  expect(resolveCliPath("./wrapper.sh", "/base", "/home/u")).toBe("/base/wrapper.sh");
  expect(resolveCliPath("sub/dir/cli", "/base", "/home/u")).toBe("/base/sub/dir/cli");
});

test("B2: a BARE name stays bare — PATH lookup is cwd-independent and must not be broken", () => {
  expect(resolveCliPath("claude", "/base", "/home/u")).toBe("claude");
  expect(resolveCliPath("sh", "/base", "/home/u")).toBe("sh");
});

test("B2: an absolute path is unchanged, and ~ is expanded", () => {
  expect(resolveCliPath("/usr/local/bin/claude", "/base", "/home/u")).toBe("/usr/local/bin/claude");
  expect(resolveCliPath("~/.local/bin/claude", "/base", "/home/u")).toBe("/home/u/.local/bin/claude");
});

// ── B9: the escape hatch ────────────────────────────────────────────────────────────────────────────

test("B9: harden:false injects nothing, skips the probe entirely, and enumerates what was surrendered", async () => {
  // All-or-nothing on purpose: a user opting back into tools via `--tools default` would otherwise
  // silently lose ALL MCP servers (measured 2 → 0) with no way to decline.
  const dir = await mkdtemp(join(tmpdir(), "dba-b9-"));
  const cli = await fakeClaude(dir);
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin", harden: false }, fast);
  const out = await hp.generate("x");
  expect(out).toContain("ARGV:[]");
  expect(out).not.toContain("SKIP:[1]");
  const w = hp.runtimeWarnings.join(" ");
  expect(w).toMatch(/harden/i);
  expect(w).toMatch(/tools|settings|MCP/i);        // names what was given up, not just "disabled"
});

test("B9: harden:false does not spawn a probe at all — counted, not inferred", async () => {
  // The old assertion matched /probe/i against the warnings, which could only ever match the memo's
  // catch text — and that never fires, because probeCapabilities is non-rejecting by construction. So a
  // mutant that fired `void caps()` inside the !harden branch passed. Count the spawns instead.
  const dir = await mkdtemp(join(tmpdir(), "dba-noprobe-"));
  const cli = join(dir, "claude");
  const log = join(dir, "spawns.log");
  await writeFile(cli, `#!/bin/sh\necho "CALL:$*" >> ${log}\necho ok\n`, { mode: 0o755 });
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin", harden: false }, { ...fast, stateDir: join(dir, "state") });
  expect((await hp.generate("x")).trim()).toBe("ok");
  const calls = (await Bun.file(log).text()).trim().split("\n").filter(Boolean);
  expect(calls).toHaveLength(1);                             // exactly the generate call
  expect(calls.some((c) => c.includes("--help"))).toBe(false);
});

test("B10: an opts.env entry passed through hardenedProvider reaches the child", async () => {
  // Latent today (no production caller passes env), but the passthrough was unpinned: dropping
  // `...opts.env` from the merge survived the suite.
  const dir = await mkdtemp(join(tmpdir(), "dba-envpass-"));
  const cli = join(dir, "claude");
  await writeFile(cli, "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then echo '--tools'; exit 0; fi\necho \"V:[$DBA_PASS]\"\n", { mode: 0o755 });
  const out = await hardenedProvider({ cli, argv: [], promptVia: "stdin" },
    { ...fast, stateDir: join(dir, "state"), env: { DBA_PASS: "through" } }).generate("x");
  expect(out).toContain("V:[through]");
});

// ── Security-review fixes (activation round) ────────────────────────────────────────────────────────

test("B3: a NON-SEARCHABLE (0600) directory we own is REPAIRED to 0700, so it is actually usable", async () => {
  // Measured: a 0600 dir passed the original check and `Bun.spawn` then failed with EACCES naming the
  // BINARY — `chdir(2)` needs the search bit. Refusing it would have been a worse fix than repairing it:
  // the directory is ours, so making it right is both safe and what the user wants.
  const dir = await mkdtemp(join(tmpdir(), "dba-nosearch-"));
  const bad = join(dir, "nosearch");
  await mkdir(bad); await chmod(bad, 0o600);
  const r = await providerCwd({ preferred: bad, tmpFallback: join(dir, "fb") });
  expect(r.cwd).toBe(bad);
  expect((await lstat(bad)).mode & 0o777).toBe(0o700);
});

test("B3: an existing directory with a LOOSE mode is repaired to 0700, not silently accepted", async () => {
  // `mkdir(recursive, mode)` does NOT re-apply the mode to an existing directory (measured: 0755
  // survived). Without an explicit repair, a provider-cwd created once under a bad umask stays
  // world-readable forever and every later run re-accepts it.
  const dir = await mkdtemp(join(tmpdir(), "dba-repair-"));
  const loose = join(dir, "loose");
  await mkdir(loose); await chmod(loose, 0o755);
  const r = await providerCwd({ preferred: loose, tmpFallback: join(dir, "fb") });
  expect(r.cwd).toBe(loose);
  expect((await lstat(loose)).mode & 0o777).toBe(0o700);
});

test("B3: an UNREACHABLE cwd is retryable and names the cwd — never missing-binary", async () => {
  // `Bun.spawn` reports an unreachable cwd as ENOENT naming the BINARY, so the old classification
  // called it missing-binary — which withRetry treats as PERMANENT. The morning died with zero
  // retries and the message "CLI not found", about a CLI that is installed and working.
  const dir = await mkdtemp(join(tmpdir(), "dba-badcwd-"));
  const p = new BYOCliProvider({ cli: "/bin/echo", argv: [], promptVia: "stdin" }, { cwd: join(dir, "vanished") });
  const e: unknown = await p.generate("x").then(() => { throw new Error("expected a rejection"); }, (err: unknown) => err);
  expect((e as ProviderError).code).toBe("nonzero-exit");        // retryable, not permanent
  expect((e as Error).message).toContain("vanished");            // names the cwd, not the binary
});

test("B1+B4: the narrow cwd is NOT applied when the isolation flag was not injected", async () => {
  // The commit's own thesis is that B1 without B4 is a REGRESSION: a cwd under $HOME makes
  // ~/CLAUDE.md an ancestor. So the cwd move must be gated on --setting-sources actually going in,
  // not merely on the directory being creatable. Measured before the fix: three reachable paths moved
  // the cwd with zero or partial flags, two of them silently.
  const dir = await mkdtemp(join(tmpdir(), "dba-gate-"));
  const cli = await fakeClaude(dir, { help: "--tools" });        // --setting-sources NOT listed
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "state") });
  const out = await hp.generate("x");
  expect(out).toContain("--tools=");                             // what was probed still goes in
  expect(out).not.toContain("provider-cwd");                     // ...but the cwd does NOT move
  expect(hp.runtimeWarnings.join(" ")).toMatch(/working directory|cwd/i);
});

test("B4: a NON-claude-shaped cli says so, rather than silently doing nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dba-shape-"));
  const cli = await fakeClaude(dir, { name: "codex" });
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "state") });
  await hp.generate("x");
  expect(hp.runtimeWarnings.join(" ")).toMatch(/not recognised|not recognized/i);
  expect(hp.runtimeWarnings.join(" ")).toContain("codex");
});

test("probe anomaly: the warning must not claim the cwd change didn't happen when it did", async () => {
  // The old wording was "provider hardening not applied", which is false on the anomaly path if the
  // cwd still moved — telling the user nothing happened when the riskier half did.
  const dir = await mkdtemp(join(tmpdir(), "dba-anom-"));
  const cli = join(dir, "claude");
  await writeFile(cli, "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then exit 3; fi\necho ok\n", { mode: 0o755 });
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "state") });
  const out = await hp.generate("x");
  expect(out).toContain("ok");
  const w = hp.runtimeWarnings.join(" ");
  expect(w).toMatch(/flags/i);                                   // says the FLAGS were not applied
  expect(out).not.toContain("provider-cwd");                     // and the cwd correctly did not move
});

test("B2+B5: a TILDE-configured cli is resolved for the PROBE too, not only for the spawn", async () => {
  // The probe used to receive the RAW `cfg.cli` while the spawn got the resolved one. For a
  // `~/.local/bin/claude` config — the exact shape B2 exists to support, and the shape of this machine's
  // real config — `Bun.spawn(["~/…","--help"])` is ENOENT, so the probe anomalied and ZERO flags were
  // ever injected, with a daily warning blaming a CLI that works perfectly.
  const home = await mkdtemp(join(tmpdir(), "dba-home-"));
  await fakeClaude(home);                                    // lives at <fakeHome>/claude
  const hp = hardenedProvider({ cli: "~/claude", argv: [], promptVia: "stdin" },
    { ...fast, stateDir: join(home, "state"), home });
  const out = await hp.generate("x");
  expect(out).toContain("--setting-sources user");           // the probe SAW the flags
  expect(hp.runtimeWarnings.join(" ")).not.toMatch(/not applied|could not run/i);
});

test("B5: a NON-claude cli is never probed — counted, not inferred", async () => {
  // The existing non-claude test used a fake that answers `--help` cleanly, so probing versus not
  // probing was invisible to it. A codex/wrapper user should not pay a `--help` spawn every morning for
  // an answer that is discarded, nor risk a spurious anomaly warning about a CLI that was never a
  // candidate for injection.
  const dir = await mkdtemp(join(tmpdir(), "dba-noprobe2-"));
  const cli = join(dir, "codex");
  const log = join(dir, "spawns.log");
  await writeFile(cli, `#!/bin/sh\necho "CALL:$*" >> ${log}\necho ok\n`, { mode: 0o755 });
  const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "state") });
  expect((await hp.generate("x")).trim()).toBe("ok");
  const calls = (await Bun.file(log).text()).trim().split("\n").filter(Boolean);
  expect(calls).toHaveLength(1);                             // the generate call only
  expect(calls.some((c) => c.includes("--help"))).toBe(false);
});

test("B3: a GROUP-WRITABLE (0770) directory is REFUSED, not repaired", async () => {
  // The "a chmod cannot un-plant a file" argument applies identically to group-write, and on macOS every
  // local user is in `staff` — so repairing 0770 would apply an argument to one case that we reject for
  // the other. Group-READABLE (0750) is still repaired; only write access is disqualifying.
  const dir = await mkdtemp(join(tmpdir(), "dba-grpw-"));
  const g = join(dir, "grpw");
  await mkdir(g); await chmod(g, 0o770);
  const r = await providerCwd({ preferred: g, tmpFallback: join(dir, "fb") });
  expect(r.cwd).not.toBe(g);
});

test("B3: a SYMLINKED parent is judged on its TARGET, not on the link's own mode", async () => {
  // `lstat` on the parent reported the SYMLINK's mode (0120755 on macOS — never world-writable), so a
  // parent that was a link to a 0777 non-sticky directory passed the very check added to reject it. The
  // leaf still uses lstat, where not-following IS the protection.
  const base = await mkdtemp(join(tmpdir(), "dba-plink-"));
  const wide = join(base, "wide");
  await mkdir(wide); await chmod(wide, 0o777);      // world-writable, non-sticky
  const viaLink = join(base, "viaLink");
  await symlink(wide, viaLink);
  const leaf = join(viaLink, "provider-cwd");
  const r = await providerCwd({ preferred: leaf, tmpFallback: join(base, "fb") });
  expect(r.cwd).not.toBe(leaf);
});

test("B3: a STICKY world-writable parent is ACCEPTED — the exemption is load-bearing on Linux", async () => {
  // Deleting `&& (parent.mode & 0o1000) === 0` left the whole suite green, yet the exemption decides real
  // behaviour: on Linux `os.tmpdir()` is `/tmp` (1777, sticky) and is the DIRECT parent of the tmp-fallback
  // rung, so without it the fallback would be refused outright and the narrow cwd silently lost.
  // Shelled out to `chmod` deliberately: Bun's fs.chmod DROPS S_ISVTX on macOS (measured — 0o1777 yields
  // mode 40777), which is very likely why this case was never covered.
  const base = await mkdtemp(join(tmpdir(), "dba-sticky-"));
  const parent = join(base, "stickyparent");
  await mkdir(parent);
  await Bun.spawn(["chmod", "1777", parent]).exited;
  const mode = (await lstat(parent)).mode;
  if ((mode & 0o1000) === 0) return;                 // platform refused the sticky bit; nothing to assert
  const leaf = join(parent, "provider-cwd");
  const r = await providerCwd({ preferred: leaf, tmpFallback: join(base, "fb") });
  expect(r.cwd).toBe(leaf);
});

test("B3: a directory NOT owned by us is refused — the one check an attacker cannot get past", async () => {
  // Previously unpinned: deleting the uid check survived the entire suite at two different heads, while
  // three comments described it as the wall an attacker cannot climb. It cannot be exercised in-process
  // with the real uid — the suite has only one — so `providerCwd` takes the uid as a parameter and this
  // drives a mismatch, which is exactly the attacker's situation: a directory they own, not us.
  const dir = await mkdtemp(join(tmpdir(), "dba-notours-"));
  const theirs = join(dir, "theirs");
  await mkdir(theirs, { mode: 0o700 });
  const r = await providerCwd({ preferred: theirs, tmpFallback: theirs, uid: (process.getuid?.() ?? 0) + 12345 });
  expect(r.ok).toBe(false);
});
