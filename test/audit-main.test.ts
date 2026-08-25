// Slice 1.5 T0.3 (F5) — `scripts/audit.ts` used to end in a bare `main().catch(...)` with all of its
// argv- and env-derived state resolved at MODULE scope, so importing it ran the whole audit against
// the real repos and nothing in it could be tested. These pins hold the extraction in place.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The import itself is the first assertion: with `import.meta.main` removed, this module would run
// the audit at import time — and with XDG_CONFIG_HOME unset to a config-less dir it would throw
// "no-config" straight into `main().catch(...)`, whose handler calls process.exit(1) and takes the
// whole test runner down with it. There is no way for that regression to look green.
const emptyCfg = mkdtempSync(join(tmpdir(), "dba-t03-cfg-"));
process.env.XDG_CONFIG_HOME = emptyCfg;
const stateA = mkdtempSync(join(tmpdir(), "dba-t03-state-"));
process.env.DAILY_BRIEFING_STATE_DIR = stateA;

const audit = await import("../scripts/audit");

test("T0.3: importing scripts/audit.ts does not run the audit", () => {
  expect(typeof audit.main).toBe("function");
  expect(typeof audit.parseAuditOptions).toBe("function");
  // An audit that ran would have written `audit-<date>.md` into the state dir (main's last step).
  expect(readdirSync(stateA).filter((f) => f.startsWith("audit-"))).toEqual([]);
});

test("T0.3: parseAuditOptions resolves state paths at CALL time, not import time", () => {
  const a = audit.parseAuditOptions([]);
  expect(a.supportApp).toBe(stateA);

  // Point the env somewhere else AFTER import — a module-scope `supportDir()` would be frozen at the
  // import-time value and this would still read stateA. This is the property that lets a test (and
  // C4's fixture-config comparison) aim the audit at a throwaway state dir at all.
  const stateB = mkdtempSync(join(tmpdir(), "dba-t03-state-b-"));
  process.env.DAILY_BRIEFING_STATE_DIR = stateB;
  const b = audit.parseAuditOptions([]);
  expect(b.supportApp).toBe(stateB);
  expect(b.bin).toBe(join(stateB, "daily-briefing"));
  expect(b.supportApp).not.toBe(a.supportApp);
  process.env.DAILY_BRIEFING_STATE_DIR = stateA;
});

test("T0.3: parseAuditOptions parses argv the way the CLI always did", () => {
  const o = audit.parseAuditOptions(["/tmp/b.md", "--no-judge", "--popup=/tmp/p"]);
  expect(o.briefingArg).toBe("/tmp/b.md");   // first non-flag positional
  expect(o.noJudge).toBe(true);
  expect(o.popupDir).toBe("/tmp/p");
  expect(o.popupConfigured).toBe(true);

  const bare = audit.parseAuditOptions([]);
  expect(bare.briefingArg).toBeUndefined();
  expect(bare.noJudge).toBe(false);
  expect(bare.popupConfigured).toBe(false); // unset => the VS POPUP section is omitted entirely
  // `--popup=` with an empty value is NOT "configured" — the `|| undefined` fallback. Pinned because
  // popupConfigured drives a report line, and an empty dir would render a phantom limitation.
  expect(audit.parseAuditOptions(["--popup="]).popupConfigured).toBe(false);
});
