import { join, basename, normalize } from "node:path";
import { hasGitEntry, isDir, repoLabel, isExcludedRepo } from "./config";
import type { Config, Activity } from "./types";

// Infra paths (Claude Code's own agent-scratch dirs) are NOT the user's work. Filtered at the unit
// SOURCE here so a unit's dirtyFiles / hasResumptionState / resumptionNote are all infra-free — which
// keeps them out of the prompt AND the deterministic RESUME backfill (generator.orderResumeByRank).
// generator.ts imports this + still applies a post-parse SUGGESTIONS filter (defense in depth).
export const INFRA_DENYLIST = [".claude/worktrees/"];

export type Unit = {
  repo: string;
  root: string | null;              // repo-relative project root, or null = catch-all
  label: string;
  hasResumptionState: boolean;      // dirty files, OR (catch-all) actionable branch/stash → Tier-1 + RESUME-eligible
  hasWindowContent: boolean;        // had ≥1 in-window commit or uncommitted file → RECAP-eligible (false = same-day-only OR a branch/stash-only catch-all; RECAP skips it, RESUME/backfill key off hasResumptionState instead)
  resumptionNote: string;
  dirtyFiles: string[];
  latestCommitTime: string | null;
};

/** Deepest root that contains `path` on a segment boundary (repo-relative, forward-slash). */
export function rootOf(path: string, roots: string[]): string | null {
  let best: string | null = null;
  for (const r of roots) {
    if (path === r || path.startsWith(r + "/")) {
      if (best === null || r.length > best.length) best = r;
    }
  }
  return best;
}


// ─── The shared bucketer (design §3.2 steps 3–5) ────────────────────────────────────────────────
// The transcript side must compute the SAME `unitKey` the git side does for a given file, or ATTRIB
// fails silently. The git side already has (repo, repo-relative path) and uses `rootOf` + `unitKey`
// directly; the transcript side starts from an ABSOLUTE path and needs step 3 (repo selection)
// first. Both therefore end in the same two calls — that is the whole point of extracting this.

/** Normalise to forward slashes and drop any trailing separator. */
const normAbs = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** True when `abs` is `dir` itself or lies beneath it ON A SEPARATOR BOUNDARY (never a bare
 *  `startsWith`, which would match `/a/foobar` against `/a/foo`). */
const underDir = (abs: string, dir: string) => abs === dir || abs.startsWith(dir + "/");

/**
 * §3.2 step 3 — absolute path → the repo that owns it, or `null`.
 *
 * DEEPEST match wins: nested clones are supported (config.ts walks children even when the parent is
 * itself a repo), and a shallow match would attribute a nested repo's edits to its parent.
 *
 * ⚠ `excludedRepoPaths` must be RESOLVED ABSOLUTE PATHS, not raw `cfg.excludeRepos` entries.
 * `cfg.excludeRepos` also accepts a bare basename (`"nested"`), which cannot be matched as a path
 * prefix — so a basename-excluded NESTED repo would never become the deepest match and the path would
 * fall back to its surviving parent, which is exactly the mis-attribution Q2 forbids. `resolveRepos`
 * knows both forms at discovery time; resolving them is the CALLER's job.
 * (Verified by test: passing `["nested"]` here returns the parent — the bug this contract prevents.)
 */
export function repoForAbsolutePath(
  absPath: string, repos: string[], excludedRepoPaths?: string[],
): string | null {
  const abs = normAbs(absPath);
  const excludeRepos = excludedRepoPaths;
  const candidates = [...repos, ...(excludedRepoPaths ?? [])].map(normAbs);
  let best: string | null = null;
  for (const c of candidates) {
    if (!c || !underDir(abs, c)) continue;
    if (best === null || c.length > best.length) best = c;
  }
  if (best === null) return null;
  if (isExcludedRepo(best, excludeRepos)) return null;   // excluded winner ⇒ drop, never fall back
  return repos.map(normAbs).includes(best) ? best : null;
}

/**
 * §3.2 steps 3–5 — absolute path → `unitKey`, or `null` when the path lies under no configured repo
 * (or under an excluded one).
 *
 * ⚠ A path under a known repo but under no sub-root is NOT dropped: it buckets to that repo's
 * CATCH-ALL unit, `unitKey(repo, null)` — the only unit a repo without a workspace manifest ever has.
 * Dropping it would give every single-project repo zero coverage.
 */
export function unitKeyForAbsolutePath(
  absPath: string, repos: string[], rootsByRepo: Map<string, string[]>, excludedRepoPaths?: string[],
): string | null {
  const repo = repoForAbsolutePath(absPath, repos, excludedRepoPaths);
  if (repo === null) return null;
  const rel = normAbs(absPath).slice(repo.length + 1);   // "" when the path IS the repo root
  const root = rootOf(rel, rootsByRepo.get(repo) ?? []); // null ⇒ the repo catch-all unit
  return unitKey(repo, root);
}

const strip = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** Expand root globs (repo-relative) to concrete directories with hygiene + `!`-negation. */
export async function expandRoots(repo: string, globs: string[]): Promise<string[]> {
  const positives = globs.filter((g) => !g.startsWith("!")).map(strip);
  const negatives = globs.filter((g) => g.startsWith("!")).map((g) => strip(g.slice(1)));
  const negGlobs = negatives.map((n) => new Bun.Glob(n));
  const out = new Set<string>();
  for (const g of positives) {
    for await (const m of new Bun.Glob(g).scan({ cwd: repo, onlyFiles: false })) {
      const rel = strip(m);
      // segment-wise skip: a recursive glob (packages/**) can surface node_modules/dotdirs at ANY depth
      if (rel.split("/").some((s) => s === "node_modules" || s.startsWith("."))) continue;
      if (!(await isDir(join(repo, rel)))) continue;
      if (await hasGitEntry(join(repo, rel))) continue;        // submodule/nested repo → its own repo
      if (negGlobs.some((ng) => ng.match(rel))) continue;      // `!`-negation postfilter
      out.add(rel);
    }
  }
  return [...out];
}

export type WorkspaceDetector = (repo: string) => Promise<string[] | null>;

async function readText(repo: string, name: string): Promise<string | null> {
  const f = Bun.file(join(repo, name));
  return (await f.exists()) ? f.text() : null;
}

export const detectJs: WorkspaceDetector = async (repo) => {
  const pkg = await readText(repo, "package.json");
  if (pkg) {
    const w = (JSON.parse(pkg) as any).workspaces;
    const globs = Array.isArray(w) ? w : w?.packages ?? null;
    if (Array.isArray(globs)) return globs.map(strip);
  }
  const pnpm = await readText(repo, "pnpm-workspace.yaml");
  if (pnpm) {
    const y = Bun.YAML.parse(pnpm) as any;
    if (Array.isArray(y?.packages)) return y.packages.map(strip);
  }
  const lerna = await readText(repo, "lerna.json");
  if (lerna) {
    const l = JSON.parse(lerna) as any;
    return (Array.isArray(l?.packages) ? l.packages : ["packages/*"]).map(strip);
  }
  return null;
};

export const detectRust: WorkspaceDetector = async (repo) => {
  const cargo = await readText(repo, "Cargo.toml");
  if (!cargo) return null;
  const ws = (Bun.TOML.parse(cargo) as any)?.workspace;
  if (!ws) return null;
  const members: string[] = Array.isArray(ws.members) ? ws.members.map(strip) : [];
  const exclude: string[] = Array.isArray(ws.exclude) ? ws.exclude.map((e: string) => "!" + strip(e)) : [];
  return [...members, ...exclude];
};

/** Parse go.work `use` directives. Returns repo-relative roots and any `../`-escaping paths. */
export function parseGoWork(text: string): { roots: string[]; escaped: string[] } {
  const roots: string[] = [], escaped: string[] = [];
  let inBlock = false;
  const add = (raw: string) => {
    let p = raw.trim().replace(/^["']|["']$/g, "");
    if (!p) return;
    p = strip(p);
    // repo-escape check on the RESOLVED path, not a naive startsWith("../")
    const np = normalize(p);
    if (np.startsWith("..")) { escaped.push(p); return; }
    roots.push(np); // push the NORMALIZED path (git-relative paths never contain ".." segments, so a raw "a/../b" would never match downstream)
  };
  for (let line of text.split("\n")) {
    line = line.replace(/\/\/.*$/, "").trim();               // strip line comments
    if (!line) continue;
    if (inBlock) { if (line === ")") { inBlock = false; continue; } add(line); continue; }
    if (line === "use (" || line === "use(") { inBlock = true; continue; }
    const m = line.match(/^use\s+(.+)$/);                     // only `use` (not replace/require)
    if (m) add(m[1]!);
  }
  return { roots, escaped };
}

// go.work is NOT a FAMILIES detector: resolveProjectRoots reads+parses it once inline (below) to
// derive both its roots and its escape warnings from a single parse. parseGoWork holds the logic.
const FAMILIES: WorkspaceDetector[][] = [[detectJs], [detectRust]];

export function repoLabelFor(repo: string, repos: string[]): string {
  return repoLabel(repo, repos);
}

export const unitKey = (repo: string, root: string | null) => `${repo}\x00${root ?? ""}`;

/** Two-pass global labeling with the 3-tier collision rule. */
export function labelUnits(pending: { repo: string; root: string | null }[], repos: string[]): Map<string, string> {
  // tier 1: base label (catch-all = bare repo label; sub-project = basename(root))
  const base = new Map<string, string>();
  for (const u of pending) {
    base.set(unitKey(u.repo, u.root), u.root === null ? repoLabelFor(u.repo, repos) : basename(u.root));
  }
  const count = new Map<string, number>();
  for (const l of base.values()) count.set(l, (count.get(l) ?? 0) + 1);
  // tier 2: qualify colliding SUB-PROJECT labels with the owning repo label (catch-all stays bare)
  const t2 = new Map<string, string>();
  for (const u of pending) {
    const k = unitKey(u.repo, u.root), l = base.get(k)!;
    t2.set(k, (u.root !== null && count.get(l)! > 1) ? `${repoLabelFor(u.repo, repos)}/${basename(u.root)}` : l);
  }
  const c2 = new Map<string, number>();
  for (const l of t2.values()) c2.set(l, (c2.get(l) ?? 0) + 1);
  // tier 3: still-colliding sub-projects → full repo-relative root path (unique within a repo)
  const final = new Map<string, string>();
  for (const u of pending) {
    const k = unitKey(u.repo, u.root), l = t2.get(k)!;
    final.set(k, (u.root !== null && c2.get(l)! > 1) ? `${repoLabelFor(u.repo, repos)}/${u.root}` : l);
  }
  return final;
}

export function unitForCommit(commit: Activity, roots: string[]): string | null {
  return unitForFiles(commit.meta?.diffstat?.map((d) => d.file) ?? [], roots);
}

/** The plurality-with-tie-guard vote, extracted verbatim from `unitForCommit` (T1.3): PR-merge
 *  labelling (core.ts mergeLabel) is a second consumer of the SAME decision-feeding attribution
 *  rule, and a silently divergent copy is exactly the day-8 class of misattribution. */
export function unitForFiles(files: string[], roots: string[]): string | null {
  const votes = new Map<string, number>();
  for (const f of files) { const r = rootOf(f, roots); if (r) votes.set(r, (votes.get(r) ?? 0) + 1); }
  if (votes.size === 0) return null;
  // Cross-cutting guard: attribute to the UNIQUE plurality root. If ≥2 roots tie for the top
  // vote, the files split evenly across sub-projects (e.g. a repo-wide/infra change like an
  // autolog STATE.md sync) — there is no clear owner, so it belongs to the repo catch-all (null), NOT an
  // arbitrary lexicographic pick (which caused the day-8 `accountant_ai` misattribution of `8b4e2b9`).
  const maxN = Math.max(...votes.values());
  const winners = [...votes].filter(([, n]) => n === maxN).map(([r]) => r);
  return winners.length === 1 ? winners[0]! : null;
}

export function composeResumptionNote(i: { files: string[]; ahead: number; behind: number; stashes: number; detached: boolean }): string {
  const ab = [i.ahead > 0 ? `ahead ${i.ahead}` : "", i.behind > 0 ? `behind ${i.behind}` : ""].filter(Boolean).join(", ");
  return [
    i.files.length ? `uncommitted: ${i.files.join(", ")}` : "",
    ab,
    i.stashes > 0 ? `${i.stashes} stash(es)` : "",
    i.detached ? "detached HEAD" : "",
  ].filter(Boolean).join("; ");
}

export async function resolveUnits(
  activities: Activity[], today: Activity[], repos: string[], cfg: Config,
): Promise<{ units: Unit[]; warnings: string[]; rootsByRepo: Map<string, string[]> }> {
  const all = [...activities, ...today];
  const warnings: string[] = [];
  const byRepo = new Map<string, Activity[]>();
  for (const a of all) if (a.repo) (byRepo.get(a.repo) ?? byRepo.set(a.repo, []).get(a.repo)!).push(a);
  // The FULL candidate root set resolveProjectRoots produced per repo (before survivor filtering) —
  // threaded out so buildPrompt/main.ts bucket against the SAME roots resolveUnits used, not the
  // survivor subset (rootsForRepo), which can diverge for nested project roots.
  const rootsByRepo = new Map<string, string[]>();

  type Acc = {
    root: string | null; commits: Activity[]; dirtyFiles: string[];
    ahead: number; behind: number; stashes: number; detached: boolean;
    sawWindowContent: boolean; // commit/uncommitted in `activities` (not today-only)
  };
  const windowSet = new Set(activities);
  const pending: { repo: string; root: string | null }[] = [];
  const accs = new Map<string, Acc>(); // key = unitKey

  const acc = (repo: string, root: string | null): Acc => {
    const k = unitKey(repo, root);
    let a = accs.get(k);
    if (!a) { a = { root, commits: [], dirtyFiles: [], ahead: 0, behind: 0, stashes: 0, detached: false, sawWindowContent: false }; accs.set(k, a); pending.push({ repo, root }); }
    return a;
  };

  for (const [repo, acts] of byRepo) {
    const { roots, warnings: w } = await resolveProjectRoots(repo, cfg);
    warnings.push(...w);
    rootsByRepo.set(repo, roots);
    for (const a of acts) {
      if (a.kind === "commit") {
        const root = unitForCommit(a, roots);
        const u = acc(repo, root);
        // An `excluded` commit VOTES for the root and counts as window content, but never joins
        // `commits` — that array feeds `latestCommitTime` (the sole recency key in `rankUnits`) and
        // `isActive`. Keeping it out means an excluded-only unit is not active, so it never reaches
        // `survivors`/`labelUnits` either, and existing users' labels and RESUME order are untouched.
        if (!a.meta?.excluded) u.commits.push(a);
        if (windowSet.has(a)) u.sawWindowContent = true;
      } else if (a.kind === "uncommitted") {
        const files = a.meta?.uncommittedFiles ?? [];
        const byRoot = new Map<string | null, string[]>();
        for (const f of files) { const r = rootOf(f, roots); (byRoot.get(r) ?? byRoot.set(r, []).get(r)!).push(f); }
        for (const [r, fs] of byRoot) {
          const kept = fs.filter((f) => !INFRA_DENYLIST.some((d) => f.includes(d))); // drop agent-scratch paths (#14)
          if (!kept.length) continue; // an infra-only uncommitted set is not real work → no unit/window-content
          const u = acc(repo, r); u.dirtyFiles.push(...kept); u.sawWindowContent = true;
        }
      } else if (a.kind === "branch") {
        const u = acc(repo, null);
        u.ahead = a.meta?.aheadBehind?.ahead ?? 0; u.behind = a.meta?.aheadBehind?.behind ?? 0;
        if (a.target === "HEAD") u.detached = true;
      } else if (a.kind === "stash") {
        acc(repo, null).stashes++;
      }
    }
  }

  // Unknown-repo warning (spec §4.1): a subprojects entry naming a repo not in the resolved set.
  for (const s of cfg.subprojects ?? []) if (!repos.includes(s.repo)) warnings.push(`[${s.repo}] subprojects entry names a repo not in the resolved repo set — ignored`);

  // FILTER FIRST, then label — labelUnits must see ONLY the units that will actually be rendered,
  // else a dropped idle/would-be sibling inflates the collision count and over-qualifies a survivor.
  // We do NOT drop same-day-only-clean units here: they are rendered in "Today so far" and need a
  // label. They are excluded from RECAP/RESUME at render time via `hasWindowContent` (below).
  const isoMs = (t: string) => new Date(t).getTime();
  const survivors = pending.map(({ repo, root }) => {
    const a = accs.get(unitKey(repo, root))!;
    const hasResumptionState = a.dirtyFiles.length > 0 || (root === null && (a.ahead > 0 || a.behind > 0 || a.stashes > 0 || a.detached));
    return { repo, root, a, hasResumptionState, isActive: a.commits.length > 0 || hasResumptionState };
  }).filter((s) => s.isActive);                                // idle branch-only (ahead 0/behind 0, clean) → dropped

  const labels = labelUnits(survivors.map(({ repo, root }) => ({ repo, root })), repos);
  const units: Unit[] = survivors.map(({ repo, root, a, hasResumptionState }) => {
    const times = a.commits.map((c) => c.timestamp).filter((t): t is string => !!t);
    return {
      repo, root, label: labels.get(unitKey(repo, root))!,
      hasResumptionState,
      hasWindowContent: a.sawWindowContent,                    // recap/resume-eligible only if it had in-window content
      resumptionNote: composeResumptionNote({ files: a.dirtyFiles, ahead: a.ahead, behind: a.behind, stashes: a.stashes, detached: a.detached }),
      dirtyFiles: a.dirtyFiles,
      // compare by epoch ms, NOT lexicographically — %cI keeps the LOCAL offset, so string order ≠ chronological order
      latestCommitTime: times.length ? times.reduce((m, t) => isoMs(t) > isoMs(m) ? t : m) : null,
    };
  });
  return { units, warnings, rootsByRepo };
}

export function rankUnits(units: Unit[]): Unit[] {
  const ms = (t: string | null) => t ? new Date(t).getTime() : -Infinity;
  return [...units].sort((x, y) => {
    if (x.hasResumptionState !== y.hasResumptionState) return x.hasResumptionState ? -1 : 1;
    if (ms(x.latestCommitTime) !== ms(y.latestCommitTime)) return ms(y.latestCommitTime) - ms(x.latestCommitTime); // newer first
    return x.label < y.label ? -1 : x.label > y.label ? 1 : 0; // lexicographic label tie-break (valid 3-way comparator)
  });
}

/** Shared helper (imported by generator.ts and main.ts): the repo's project roots that survived into `units`. */
export const rootsForRepo = (units: Unit[], repo: string): string[] =>
  units.filter((u) => u.repo === repo && u.root !== null).map((u) => u.root!);

export async function resolveProjectRoots(repo: string, cfg: Config): Promise<{ roots: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const entry = cfg.subprojects?.find((s) => s.repo === repo);
  // Explicit-config branch gets its OWN try/catch — a failure here is the user's config, not "detection".
  if (entry) {
    if (entry.roots.length === 0) return { roots: [], warnings }; // intentional single-unit
    try {
      const roots = await expandRoots(repo, entry.roots);
      if (roots.length === 0) warnings.push(`[${repo}] subprojects roots ${JSON.stringify(entry.roots)} resolved to zero directories`);
      // ⚠ A PARTIALLY dead list used to be silent forever, because the all-or-nothing check above is
      // the only one there was. Found in review 2026-08-14: this repo's 8 configured roots expand to
      // 7 — `quant_options` is a planned sub-project with no folder yet — and nothing said so. A typo
      // ("acountant_ai") is INDISTINGUISHABLE from that, and its whole sub-project silently keeps
      // rendering under the catch-all label, which is the exact defect the config exists to fix.
      // Only LITERAL roots are checked: a glob legitimately matching nothing today is not a mistake,
      // and re-scanning per glob to find out would cost a filesystem walk each.
      const isLiteral = (g: string) => !/[*?[\]]/.test(g) && !g.startsWith("!");
      for (const g of entry.roots.filter(isLiteral)) {
        if (!roots.includes(g.replace(/\/+$/, ""))) {
          warnings.push(`[${repo}] subprojects root "${g}" matched no directory — typo, or a project not scaffolded yet? Its commits will fall to the catch-all label.`);
        }
      }
      return { roots, warnings };
    } catch (e) {
      warnings.push(`[${repo}] subprojects config failed to expand (${(e as Error).message})`);
      return { roots: [], warnings };
    }
  }
  try {
    // detection: union across families, first-non-null within a family
    const globs: string[] = [];
    for (const family of FAMILIES) {
      for (const detect of family) {
        const found = await detect(repo);
        if (found) { globs.push(...found); break; }
      }
    }
    // go.work: ONE read + ONE parse for both its roots and its escape warnings. Handled before the
    // zero-globs early return so a go.work whose ONLY `use` dirs escape the repo yields zero net
    // globs but still warns.
    const goworkText = await readText(repo, "go.work");
    if (goworkText) {
      const { roots: goRoots, escaped } = parseGoWork(goworkText);
      globs.push(...goRoots);
      for (const esc of escaped) warnings.push(`[${repo}] go.work 'use ${esc}' resolves outside the repo — skipped`);
    }
    if (globs.length === 0) return { roots: [], warnings };
    const roots = await expandRoots(repo, globs);
    if (roots.length === 0) warnings.push(`[${repo}] detected a workspace manifest but its roots resolved to zero directories`);
    return { roots, warnings };
  } catch (e) {
    warnings.push(`[${repo}] workspace detection failed (${(e as Error).message}) — treated as single project`);
    return { roots: [], warnings };
  }
}

// LABEL IDENTITY — the single definition. Strip markdown emphasis/code decoration (`**app**`,
// `*app*`, `` `app` ``) BEFORE trimming trailing punctuation, so a model bullet labeled `**app**`
// still matches the ranked unit `app` — otherwise it is both tail-preserved AND backfilled, yielding
// duplicate, contradictory resume lines. (Underscores are left alone — they're common in real
// repo/dir names, and both sides normalize identically.)
//
// ⚠ IT LIVES HERE, not in generator.ts, because a FOURTH consumer proved the old home unreachable.
// `orderResumeByRank`, the eval judge's `g1Attribution`, `render.ts` and `core.ts` all import it from
// `generator` — but `generator` imports `postcheck`, so `postcheck` could not import back without a
// cycle. It therefore grew its OWN weaker copy (`toLowerCase().trim()`, no decoration strip), and
// `checkResumeFreshness` silently returned ZERO findings for any decorated label — a false negative
// in the one check whose job is catching silent failures. MEASURED 2026-08-10: `[accountant_ai]` → 1
// finding, `[**accountant_ai**]` → 0. `subprojects` imports only `config`/`types`, so every consumer
// including `postcheck` can reach it. `generator` re-exports it so existing importers are unchanged.
export const norm = (s: string) => s.toLowerCase().replace(/[*`]/g, "").trim().replace(/[.,;:!?]+$/, "");
