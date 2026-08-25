import { test, expect } from "bun:test";
import { classifyReadError, defaultProtectedRoots, matchProtectedRoot } from "../src/protectedPath";

// Injected roots + platform keep these deterministic regardless of the test machine.
const ROOTS = [
  "/Users/me/Desktop",
  "/Users/me/Documents",
  "/Users/me/Downloads",
  "/Users/me/Library/Mobile Documents",
];

test("EPERM under a protected root on darwin is tcc-denied with the matched root", () => {
  const r = classifyReadError({ path: "/Users/me/Desktop/proj", err: { code: "EPERM" }, platform: "darwin", protectedRoots: ROOTS });
  expect(r.kind).toBe("tcc-denied");
  expect(r.protectedRoot).toBe("/Users/me/Desktop");
});

test("a nested path under a protected root still classifies tcc-denied", () => {
  const r = classifyReadError({ path: "/Users/me/Desktop/a/b/c", err: { code: "EPERM" }, platform: "darwin", protectedRoots: ROOTS });
  expect(r.kind).toBe("tcc-denied");
  expect(r.protectedRoot).toBe("/Users/me/Desktop");
});

test("EACCES under a protected root is unreadable, not tcc-denied", () => {
  const r = classifyReadError({ path: "/Users/me/Desktop/proj", err: { code: "EACCES" }, platform: "darwin", protectedRoots: ROOTS });
  expect(r.kind).toBe("unreadable");
});

test("EPERM outside any protected root is unreadable", () => {
  const r = classifyReadError({ path: "/tmp/proj", err: { code: "EPERM" }, platform: "darwin", protectedRoots: ROOTS });
  expect(r.kind).toBe("unreadable");
});

test("EPERM under a protected root on non-darwin is unreadable (no TCC off macOS)", () => {
  const r = classifyReadError({ path: "/Users/me/Desktop/proj", err: { code: "EPERM" }, platform: "linux", protectedRoots: ROOTS });
  expect(r.kind).toBe("unreadable");
});

test("a git subprocess 'Operation not permitted' error maps to tcc-denied on darwin", () => {
  const err = new Error("git rev-parse failed in /Users/me/Desktop/proj: fatal: Operation not permitted");
  const r = classifyReadError({ path: "/Users/me/Desktop/proj", err, platform: "darwin", protectedRoots: ROOTS });
  expect(r.kind).toBe("tcc-denied");
});

test("no errno (missing .git signal) is not-a-repo", () => {
  const r = classifyReadError({ path: "/Users/me/dev/proj", err: undefined, platform: "darwin", protectedRoots: ROOTS });
  expect(r.kind).toBe("not-a-repo");
});

test("a sibling whose name merely prefixes a root does not match", () => {
  const r = classifyReadError({ path: "/Users/me/Desktopfoo/proj", err: { code: "EPERM" }, platform: "darwin", protectedRoots: ROOTS });
  expect(r.kind).toBe("unreadable");
});

test("defaultProtectedRoots derives the four home-relative roots", () => {
  const roots = defaultProtectedRoots("/Users/me");
  expect(roots).toContain("/Users/me/Desktop");
  expect(roots).toContain("/Users/me/Documents");
  expect(roots).toContain("/Users/me/Downloads");
  expect(roots).toContain("/Users/me/Library/Mobile Documents");
});

test("matchProtectedRoot returns the matched root or undefined", () => {
  expect(matchProtectedRoot("/Users/me/Documents/x", ROOTS)).toBe("/Users/me/Documents");
  expect(matchProtectedRoot("/tmp/x", ROOTS)).toBeUndefined();
});

// ---- Tier-5 batch 6: ENOENT distinct kind + case-insensitive root match ----
import { classify, warnFor, isInaccessible } from "../src/protectedPath";

test("classifyReadError: ENOENT (a nonexistent/typo'd path) is 'not-found', not 'not-a-repo' [Tier-5]", () => {
  const r = classifyReadError({ path: "/nope/typo", err: { code: "ENOENT" }, platform: "darwin", protectedRoots: [] });
  expect(r.kind).toBe("not-found");
  expect(warnFor(r)).toMatch(/path not found/i);
  expect(isInaccessible(r)).toBe(false); // an absent path doesn't block stamping (like not-a-repo)
});

test("classifyReadError: EPERM under a differently-cased protected root is still tcc-denied on darwin (APFS) [Tier-5]", () => {
  const roots = ["/Users/me/Desktop"];
  const r = classifyReadError({ path: "/Users/me/desktop/proj", err: { code: "EPERM" }, platform: "darwin", protectedRoots: roots });
  expect(r.kind).toBe("tcc-denied");
  expect(r.protectedRoot).toBe("/Users/me/Desktop");
  // linux is case-sensitive: lowercase 'desktop' must NOT match → unreadable
  const rl = classifyReadError({ path: "/Users/me/desktop/proj", err: { code: "EPERM" }, platform: "linux", protectedRoots: roots });
  expect(rl.kind).toBe("unreadable");
});

test("matchProtectedRoot: case-insensitive flag + separator-awareness [Tier-5]", () => {
  const roots = ["/Users/me/Desktop"];
  expect(matchProtectedRoot("/Users/me/desktop/p", roots, true)).toBe("/Users/me/Desktop");  // case-insensitive
  expect(matchProtectedRoot("/Users/me/desktop/p", roots, false)).toBeUndefined();            // case-sensitive: no match
  expect(matchProtectedRoot("/Users/me/Desktopfoo/p", roots, true)).toBeUndefined();          // sibling prefix ≠ match
  expect(matchProtectedRoot("/Users/me/Desktop", roots, false)).toBe("/Users/me/Desktop");    // exact
});

test("classifyReadError: win32 matches a protected root case-insensitively (→ unreadable, no tcc off darwin) [Tier-5]", () => {
  const roots = ["C:\\Users\\Me\\Desktop"];
  const r = classify("c:\\users\\me\\desktop\\proj", { code: "EACCES" }, { platform: "win32", protectedRoots: roots });
  expect(r.kind).toBe("unreadable"); // win32 never tcc-denied, but the case-insensitive match still classifies EACCES
});
