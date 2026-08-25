// test/git.swallow-audit.test.ts
//
// C1/A1 — throwing IncompleteReadError is only half the fix. Every frame that catches must let it
// through, or the fix is a NO-OP for its two motivating protections. The SEVENTH review round caught
// this, after six rounds had all audited git.ts and stopped at its boundary. (Not "the final" review —
// several more followed, and the sibling header was corrected for the same reason.)
//
//  - git.ts `gitDirExists`'s swallow-to-false  → an incomplete read would read as "not a git repo"
//  - git.ts `resolveAuthor`'s two swallows-to-"" → would degrade to NO AUTHOR FILTER, crediting
//    coworkers' commits — the exact failure the error class exists to prevent
//
// Cited by SYMBOL, not by line: these sites moved at every commit on this branch, and a stale line
// number in a comment this codebase treats as documentation sends the next reader to unrelated code.
//
// Everything that is NOT an IncompleteReadError must keep being swallowed exactly as before: these
// catches exist because an unborn HEAD, a missing git config, or a detached HEAD are all normal.
import { test, expect, spyOn } from "bun:test";
import { runGit, gitDirExists, resolveAuthor, IncompleteReadError } from "../src/git";
import { buildRepo } from "./fixtures/build-repo";

function stream(chunks: string[], eof: boolean): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); if (eof) c.close(); } });
}
/** A git that exits 0 but leaves stdout held open — the grandchild case. */
function heldSpawn() {
  return {
    stdout: stream(["partial"], false), stderr: stream([], true),
    exited: Promise.resolve(0), exitCode: 0, signalCode: null, kill() {},
  } as unknown as ReturnType<typeof Bun.spawn>;
}
/** A git that fails normally — the case these catches legitimately swallow. */
function failSpawn() {
  return {
    stdout: stream([], true), stderr: stream(["fatal: not a git repository\n"], true),
    exited: Promise.resolve(128), exitCode: 128, signalCode: null, kill() {},
  } as unknown as ReturnType<typeof Bun.spawn>;
}

test("gitDirExists PROPAGATES IncompleteReadError instead of reporting 'not a git repo'", async () => {
  const spy = spyOn(Bun, "spawn").mockImplementation(heldSpawn);
  try {
    await expect(gitDirExists("/tmp")).rejects.toBeInstanceOf(IncompleteReadError);
  } finally { spy.mockRestore(); }
});

test("gitDirExists still returns false for a genuine non-repo (normal failure stays swallowed)", async () => {
  const spy = spyOn(Bun, "spawn").mockImplementation(failSpawn);
  try {
    expect(await gitDirExists("/tmp")).toBe(false);
  } finally { spy.mockRestore(); }
});

test("resolveAuthor PROPAGATES IncompleteReadError instead of degrading to no author filter", async () => {
  const spy = spyOn(Bun, "spawn").mockImplementation(heldSpawn);
  try {
    // Degrading here returns {} → authorArgs produces no --author → every commit matches →
    // coworkers' commits get credited to the user. Must fail closed instead.
    await expect(resolveAuthor("/tmp", undefined)).rejects.toBeInstanceOf(IncompleteReadError);
  } finally { spy.mockRestore(); }
});

test("resolveAuthor still falls back quietly when git config is simply unset (normal failure stays swallowed)", async () => {
  const spy = spyOn(Bun, "spawn").mockImplementation(failSpawn);
  try {
    const a = await resolveAuthor("/tmp", undefined);
    expect(a).toEqual({});   // no identity discoverable — the pre-existing quiet fallback
  } finally { spy.mockRestore(); }
});

test("resolveAuthor short-circuits on an explicit config author without touching git at all", async () => {
  const spy = spyOn(Bun, "spawn").mockImplementation(heldSpawn);  // would throw if git were called
  try {
    expect(await resolveAuthor("/tmp", { emails: ["me@example.com"] })).toEqual({ emails: ["me@example.com"] });
  } finally { spy.mockRestore(); }
});

test("a real repo still resolves its git identity (no regression on the happy path)", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date().toISOString() }]);
  const a = await resolveAuthor(repo, undefined);
  expect((a.emails?.length ?? 0) + (a.names?.length ?? 0)).toBeGreaterThan(0);
  expect(await gitDirExists(repo)).toBe(true);
  expect(await runGit(["rev-parse", "--git-dir"], repo)).toBeTruthy();
});
