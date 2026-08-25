// src/protectedPath.ts — macOS TCC / protected-path guard (design §5.11).
//
// A pure classifier that decides why a repo read failed: a macOS TCC denial
// (needs a Files-&-Folders / Full Disk Access grant), an ordinary permission
// problem, or simply not a git repo. Platform + protected-root list are
// injectable so this is unit-testable without touching real TCC state.
import { homedir } from "node:os";
import { join, sep } from "node:path";

export type PathIssueKind = "tcc-denied" | "unreadable" | "not-a-repo" | "not-found";
export type PathIssue = { path: string; kind: PathIssueKind; protectedRoot?: string };

// Injection surface for the classifier: overridable platform + protected-root list. Threaded
// from run()/init only for tests; production leaves both undefined (classifyReadError defaults).
export type GuardOpts = { platform?: NodeJS.Platform; protectedRoots?: string[] };

// An issue represents a repo we could not read (as opposed to one that is simply absent).
// A blocked repo (TCC or ordinary perms) must not let an empty run "consume" the day.
export function isInaccessible(issue: PathIssue): boolean {
  return issue.kind === "tcc-denied" || issue.kind === "unreadable";
}

// The macOS TCC-gated, home-relative folders Slice 1 targets. Removable/network
// volumes are a separate TCC category, deferred (design §5.11).
export function defaultProtectedRoots(home: string = homedir()): string[] {
  return [
    join(home, "Desktop"),
    join(home, "Documents"),
    join(home, "Downloads"),
    join(home, "Library", "Mobile Documents"), // iCloud Drive container root
  ];
}

// Is `path` at or under `root`? Separator-aware, so "/a/Desktopfoo" does NOT match "/a/Desktop".
// `caseInsensitive` for case-insensitive filesystems (default APFS, Windows): a config path spelled
// `~/desktop/proj` (or reached via a differently-cased symlink) still matches `~/Desktop`, so an EPERM
// there is correctly classified tcc-denied (with the System-Settings fix) instead of a plain unreadable.
export function matchProtectedRoot(path: string, roots: string[], caseInsensitive = false): string | undefined {
  const norm = caseInsensitive ? (s: string) => s.toLowerCase() : (s: string) => s;
  const p = norm(path);
  return roots.find((r) => p === norm(r) || p.startsWith(norm(r) + sep));
}

// A TCC denial surfaces as EPERM ("Operation not permitted"); ordinary perms as
// EACCES ("Permission denied"). fs errors carry an errno `.code`; git subprocess
// failures are thrown Errors whose (locale-dependent, English C-locale) message
// embeds the strerror text — a complement, not the sole detector.
export function readErrCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  const msg = err instanceof Error ? err.message : "";
  if (/operation not permitted/i.test(msg)) return "EPERM";
  if (/permission denied/i.test(msg)) return "EACCES";
  return undefined;
}

// Classify a repo-read failure. `err` is the fs/subprocess error, or undefined when
// the caller's signal is "no .git here" (not an errno). Only EPERM under a protected
// root on darwin is a TCC denial; EACCES (or EPERM off macOS / outside a root) is an
// ordinary perms problem; anything else is not-a-repo.
export function classifyReadError(args: {
  path: string;
  err?: unknown;
  platform?: NodeJS.Platform;
  protectedRoots?: string[];
}): PathIssue {
  const { path } = args;
  const platform = args.platform ?? process.platform;
  const roots = args.protectedRoots ?? defaultProtectedRoots();
  const code = readErrCode(args.err);

  if (code === "EPERM" || code === "EACCES") {
    // darwin/win32 are case-insensitive filesystems by default → match roots case-insensitively there.
    const root = matchProtectedRoot(path, roots, platform === "darwin" || platform === "win32");
    if (platform === "darwin" && code === "EPERM" && root) {
      return { path, kind: "tcc-denied", protectedRoot: root };
    }
    return { path, kind: "unreadable" };
  }
  // ENOENT = the path doesn't exist (the classic config typo, or an un-expanded `~`/relative path) —
  // distinct from a real directory that isn't a git repo. Labeled separately so the warning points the
  // user at the right problem instead of "not a git repo".
  if (code === "ENOENT") return { path, kind: "not-found" };
  return { path, kind: "not-a-repo" };
}

// The single place a read failure is turned into a PathIssue. Every probe/discovery/preflight
// site funnels through this, so a change to classification (or a new GuardOpts knob) lands once.
export function classify(path: string, err: unknown, opts?: GuardOpts): PathIssue {
  return classifyReadError({ path, err, platform: opts?.platform, protectedRoots: opts?.protectedRoots });
}

// Human-facing warning line for a classified path issue. A tcc-denied issue names the
// concrete fix (grant the binary in System Settings); the rest are plain skips.
export function warnFor(issue: PathIssue): string {
  switch (issue.kind) {
    case "tcc-denied":
      return `TCC-blocked: can't read ${issue.path} (macOS-protected folder ${issue.protectedRoot}). ` +
        `Grant the daily-briefing binary access in System Settings → Privacy & Security → ` +
        `Files & Folders (or Full Disk Access), or move the repo out of Desktop/Documents/Downloads. See the README.`;
    case "unreadable":
      return `skipped repo (unreadable): ${issue.path}`;
    case "not-found":
      return `skipped: path not found — ${issue.path} (check for a typo; relative paths resolve against the launchd job's cwd, so configure an absolute path)`;
    default:
      return `skipped repo (not a git repo): ${issue.path}`;
  }
}
