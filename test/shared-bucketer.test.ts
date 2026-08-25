import { describe, expect, test } from "bun:test";
import { repoForAbsolutePath, unitKeyForAbsolutePath, unitKey } from "../src/subprojects";

const REPOS = ["/u/work/personal_code", "/u/work/personal_code/vendor/nested", "/u/work/Notes Vault"];
const ROOTS = new Map<string, string[]>([
  ["/u/work/personal_code", ["quant_stocks", "daily_briefing_application"]],
  ["/u/work/personal_code/vendor/nested", []],
  ["/u/work/Notes Vault", []],
]);

describe("repoForAbsolutePath — §3.2 step 3", () => {
  test("deepest match wins, so a nested clone is not attributed to its parent", () => {
    expect(repoForAbsolutePath("/u/work/personal_code/vendor/nested/src/a.ts", REPOS))
      .toBe("/u/work/personal_code/vendor/nested");
  });

  test("matches only on a separator boundary", () => {
    // /u/work/personal_code_OLD must not match /u/work/personal_code
    expect(repoForAbsolutePath("/u/work/personal_code_OLD/a.ts", REPOS)).toBeNull();
  });

  test("a path under no configured repo is dropped", () => {
    expect(repoForAbsolutePath("/somewhere/else/a.ts", REPOS)).toBeNull();
  });

  test("an EXCLUDED nested repo drops the path — it does NOT fall back to the surviving parent", () => {
    // `resolveRepos` has already removed the excluded repo from `repos`; without step 3 knowing
    // about the exclusion, this path would mis-attribute to /u/work/personal_code.
    const kept = ["/u/work/personal_code"];
    expect(repoForAbsolutePath("/u/work/personal_code/vendor/nested/src/a.ts", kept,
      ["/u/work/personal_code/vendor/nested"])).toBeNull();
  });

  test("a BASENAME-form exclusion cannot protect a nested repo — the contract requires absolute paths", () => {
    // cfg.excludeRepos accepts "nested", but a basename is not a path prefix, so the excluded repo
    // never becomes the deepest match. Documented as the caller's responsibility to resolve.
    const kept = ["/u/work/personal_code"];
    expect(repoForAbsolutePath("/u/work/personal_code/vendor/nested/x.ts", kept, ["nested"]))
      .toBe("/u/work/personal_code");
    // ...whereas the resolved absolute form protects it correctly:
    expect(repoForAbsolutePath("/u/work/personal_code/vendor/nested/x.ts", kept,
      ["/u/work/personal_code/vendor/nested"])).toBeNull();
  });

  test("repo paths with spaces are handled", () => {
    expect(repoForAbsolutePath("/u/work/Notes Vault/0 - Daily Notes/x.md", REPOS))
      .toBe("/u/work/Notes Vault");
  });
});

describe("unitKeyForAbsolutePath — §3.2 steps 3-5", () => {
  test("a path under a sub-root buckets to that root's unit", () => {
    expect(unitKeyForAbsolutePath("/u/work/personal_code/quant_stocks/core/x.py", REPOS, ROOTS))
      .toBe(unitKey("/u/work/personal_code", "quant_stocks"));
  });

  test("deepest sub-root wins", () => {
    const roots = new Map([["/u/work/personal_code", ["a", "a/b"]]]);
    expect(unitKeyForAbsolutePath("/u/work/personal_code/a/b/x.ts", ["/u/work/personal_code"], roots))
      .toBe(unitKey("/u/work/personal_code", "a/b"));
  });

  test("a path under NO sub-root buckets to the repo CATCH-ALL, it is not dropped", () => {
    // The only unit a repo without a workspace manifest ever has.
    expect(unitKeyForAbsolutePath("/u/work/Notes Vault/0 - Daily Notes/x.md", REPOS, ROOTS))
      .toBe(unitKey("/u/work/Notes Vault", null));
  });

  test("backslash-separated paths bucket correctly (R6 — behaviour, not observed shape)", () => {
    expect(unitKeyForAbsolutePath("\\u\\work\\personal_code\\quant_stocks\\x.py", REPOS, ROOTS))
      .toBe(unitKey("/u/work/personal_code", "quant_stocks"));
  });

  test("a repo with no roots entry still yields its catch-all", () => {
    expect(unitKeyForAbsolutePath("/u/work/personal_code/x.ts", ["/u/work/personal_code"], new Map()))
      .toBe(unitKey("/u/work/personal_code", null));
  });

  test("an unmatched path yields null", () => {
    expect(unitKeyForAbsolutePath("/nope/x.ts", REPOS, ROOTS)).toBeNull();
  });
});
