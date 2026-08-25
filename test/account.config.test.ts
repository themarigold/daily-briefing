// Checkpoint 4 — config resolution and the §4a runtime rule.
// Validation lives at the USE site (resolveAccounts), matching resolveTranscripts, so that a malformed
// optional block degrades to "off, with a warning" instead of throwing — a throw from config loading
// costs the briefing on every 600s tick.
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAccounts } from "../src/config";
import { recordAuthProbe, loadAccountState, DEFAULT_LABEL } from "../src/account";

const HOME = "/home/u";
const noEnv = {} as Record<string, string | undefined>;
const allExist = () => true;
const NOW = new Date("2026-08-24T12:00:00-07:00");

describe("resolveAccounts", () => {
  test("absent ⇒ no accounts, no warning (unset is not a typo)", () => {
    expect(resolveAccounts(undefined, HOME, noEnv, allExist)).toEqual({ warnings: [] });
  });

  test("a valid pair resolves, and ~ is expanded in the nested configDir", () => {
    const r = resolveAccounts([{ label: "primary" }, { label: "fallback", configDir: "~/.claude-briefing" }], HOME, noEnv, allExist);
    expect(r.accounts).toEqual([{ label: "primary" }, { label: "fallback", configDir: "/home/u/.claude-briefing" }]);
    expect(r.warnings).toEqual([]);
  });

  // Each malformed shape DISABLES failover and says so — it must never throw, and must never leave a
  // value that resolveAccount could TypeError on.
  for (const [name, raw] of [
    ["not an array", "primary,fallback"],
    ["entry not an object", ["primary"]],
    ["entry missing label", [{ configDir: "/x" }]],
    ["empty label", [{ label: "" }]],
    ["configDir not a string", [{ label: "a", configDir: 5 }]],
    ["null entry", [null]],
  ] as [string, unknown][]) {
    test(`malformed: ${name} ⇒ disabled with a warning, never a throw`, () => {
      let r!: ReturnType<typeof resolveAccounts>;
      expect(() => { r = resolveAccounts(raw, HOME, noEnv, allExist); }).not.toThrow();
      expect(r.accounts).toBeUndefined();
      expect(r.warnings.some((w) => w.includes("account failover disabled"))).toBe(true);
    });
  }

  test("duplicate labels ⇒ disabled (marks are keyed by label, so they would share one)", () => {
    const r = resolveAccounts([{ label: "a" }, { label: "a", configDir: "/x" }], HOME, noEnv, allExist);
    expect(r.accounts).toBeUndefined();
    expect(r.warnings.some((w) => w.includes("duplicate labels"))).toBe(true);
  });

  // The spelling a string comparison misses: an ABSENT configDir means the CLI's default login, which
  // IS ~/.claude — so this pair is two labels on one account, i.e. failover that cannot fail over.
  test("absent configDir vs an explicit ~/.claude ⇒ disabled (same login under two labels)", () => {
    const r = resolveAccounts([{ label: "a" }, { label: "b", configDir: "~/.claude" }], HOME, noEnv, allExist);
    expect(r.accounts).toBeUndefined();
    expect(r.warnings.some((w) => w.includes("same login directory"))).toBe(true);
  });

  test("two entries both omitting configDir ⇒ disabled, same reason", () => {
    const r = resolveAccounts([{ label: "a" }, { label: "b" }], HOME, noEnv, allExist);
    expect(r.accounts).toBeUndefined();
  });

  test("a configDir with no .claude.json warns but KEEPS the account", async () => {
    const d = await mkdtemp(join(tmpdir(), "acct-cfg-"));
    const loggedIn = join(d, "in"), never = join(d, "out");
    await mkdir(loggedIn, { recursive: true });
    await mkdir(never, { recursive: true });
    await writeFile(join(loggedIn, ".claude.json"), "{}");
    const r = resolveAccounts([{ label: "a", configDir: loggedIn }, { label: "b", configDir: never }], HOME, noEnv);
    expect(r.accounts?.length).toBe(2);                       // kept — it may be logged in later
    expect(r.warnings.some((w) => w.includes("never been logged in"))).toBe(true);
    expect(r.warnings.some((w) => w.includes(loggedIn))).toBe(false);
    await rm(d, { recursive: true, force: true });
  });

  // CLAUDE_CONFIG_DIR is a SUPPORTED way to set the transcript root, so warning unconditionally would
  // fire every tick on a legitimate setup.
  test("an ambient CLAUDE_CONFIG_DIR warns about the transcript-root collision", () => {
    const r = resolveAccounts(undefined, HOME, { CLAUDE_CONFIG_DIR: "/somewhere" }, allExist);
    expect(r.warnings.some((w) => w.includes("transcript scan root"))).toBe(true);
  });
});

describe("§4a — a non-limit failure on a fallback", () => {
  const two = [{ label: "primary" }, { label: "fallback", configDir: "/x" }];

  test("marks the FALLBACK for an hour, with no lastLimit", async () => {
    const d = await mkdtemp(join(tmpdir(), "acct-4a-"));
    expect(await recordAuthProbe("fallback", two, NOW, d)).toBe(true);
    const st = await loadAccountState(d);
    expect(st.accounts.fallback?.isProbe).toBe(true);
    expect(st.lastLimit).toBeUndefined();      // an auth failure is not a usage wall
    await rm(d, { recursive: true, force: true });
  });

  // The rule is scoped by POSITION. A label-based reading ("non-default") would mark the primary on an
  // ordinary wake-before-wifi nonzero-exit — the most common transient failure this codebase has.
  test("does NOT mark the first entry", async () => {
    const d = await mkdtemp(join(tmpdir(), "acct-4a-"));
    expect(await recordAuthProbe("primary", two, NOW, d)).toBe(false);
    expect((await loadAccountState(d)).accounts.primary).toBeUndefined();
    await rm(d, { recursive: true, force: true });
  });

  test("does NOT mark the synthesised default on a single-account machine", async () => {
    const d = await mkdtemp(join(tmpdir(), "acct-4a-"));
    expect(await recordAuthProbe(DEFAULT_LABEL, undefined, NOW, d)).toBe(false);
    await rm(d, { recursive: true, force: true });
  });
});
