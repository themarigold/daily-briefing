// Slice 1.5 T1.1/T1.2 — the transcripts config surface and root resolution (§3.6).
// B1 style: a malformed block WARNS and disables the feature; it never throws out of loadConfig.
import { test, expect } from "bun:test";
import { resolveTranscripts, validateConfig } from "../src/config";
import { join } from "node:path";

const HOME = "/home/u";

// ── Root resolution, the three branches of §3.6's order ───────────────────────────────────────────
test("T1.2: transcripts.root wins over CLAUDE_CONFIG_DIR and the default", () => {
  const r = resolveTranscripts({ enabled: true, root: "/explicit/root" }, HOME, { CLAUDE_CONFIG_DIR: "/env/claude" });
  expect(r.root).toBe("/explicit/root");
  expect(r.enabled).toBe(true);
  expect(r.warning).toBeUndefined();
});

test("T1.2: CLAUDE_CONFIG_DIR is used when transcripts.root is absent", () => {
  const r = resolveTranscripts({ enabled: true }, HOME, { CLAUDE_CONFIG_DIR: "/env/claude" });
  expect(r.root).toBe(join("/env/claude", "projects"));
});

test("T1.2: default is ~/.claude/projects when neither is set", () => {
  const r = resolveTranscripts({ enabled: true }, HOME, {});
  expect(r.root).toBe(join(HOME, ".claude", "projects"));
});

// ⚠ The case §3.6 calls out as REQUIRED, not a convenience: `initConfig` returns early when a config
// file already exists, so EVERY existing installation — including the live 7:20 agent — has no
// `transcripts` key at all. Without a default those installs would have no root, and the feature
// would be inert with no diagnostic. Resolution must therefore work on a config that predates it.
test("T1.2: an existing config with NO transcripts key still resolves the default root", () => {
  const r = resolveTranscripts(undefined, HOME, {});
  expect(r.root).toBe(join(HOME, ".claude", "projects"));
  expect(r.enabled).toBe(false); // dark launch: off unless explicitly enabled
  expect(r.warning).toBeUndefined(); // unset is not a typo
});

test("T1.2: ~ in transcripts.root and in CLAUDE_CONFIG_DIR is expanded against home", () => {
  expect(resolveTranscripts({ root: "~/tx" }, HOME, {}).root).toBe(join(HOME, "tx"));
  expect(resolveTranscripts({}, HOME, { CLAUDE_CONFIG_DIR: "~/cc" }).root).toBe(join(HOME, "cc", "projects"));
});

// ── Malformed shapes: warn + disable, never throw ─────────────────────────────────────────────────
test("T1.1: a malformed transcripts block warns and disables — it does not throw", () => {
  for (const bad of [42, "yes", [], { enabled: "true" }, { root: 5 }]) {
    const r = resolveTranscripts(bad, HOME, {});
    expect(r.enabled).toBe(false);
    expect(r.warning).toBeTruthy();
    expect(r.root).toBe(join(HOME, ".claude", "projects")); // still resolvable, so a later fix needs no other edit
  }
});

// An EMPTY-STRING root is the dangerous typo, not merely an invalid one: `join("", x)` yields a
// RELATIVE path, so the scan would silently read from the process CWD instead of failing.
test("T1.1: an empty-string transcripts.root is rejected, not joined into a relative path", () => {
  const r = resolveTranscripts({ enabled: true, root: "   " }, HOME, {});
  expect(r.enabled).toBe(false);
  expect(r.warning).toContain("non-empty");
  expect(r.root.startsWith("/")).toBe(true);
});

// ── The load path must stay non-throwing (B1) ─────────────────────────────────────────────────────
test("T1.1: validateConfig does NOT throw on a malformed transcripts block", () => {
  const base = { provider: { cli: "c", argv: [], promptVia: "stdin" } };
  // Contrast: `repos` is hard-validated and DOES throw. transcripts must not — a transcript-config
  // typo cannot be allowed to take the morning briefing down, since the feature is optional and off.
  expect(() => validateConfig({ ...base, repos: 5 }, HOME)).toThrow();
  expect(() => validateConfig({ ...base, transcripts: 5 }, HOME)).not.toThrow();
  expect(() => validateConfig({ ...base, transcripts: { enabled: "yes" } }, HOME)).not.toThrow();
});
