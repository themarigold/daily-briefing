// Slice 1.5 T3.1 — segments and turn→segment membership (§3.2).
//
// ATOM: a segment `(sessionId, unitKey, localDay)`, existing iff that session edited >=1 file under
// that unit that day. Segments are constituted by EDIT events; turns carry no unit, so membership
// has to be defined POSITIONALLY.
import { resolveProjectRoots, unitKeyForAbsolutePath, INFRA_DENYLIST } from "../subprojects";
import type { Config } from "../types";
import type { TranscriptSegment, DropReason } from "./scan";
import type { PathRecord, TurnRecord } from "./transform";

/** Local YYYY-MM-DD for an ISO instant — segments bucket by LOCAL day, matching the rest of the app. */
export function localDayOf(iso: string, now = new Date(iso)): string {
  const d = Number.isNaN(now.getTime()) ? new Date(iso) : now;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export type Bucketer = (absPath: string) => string | null;

/** §3.2 step 4's `rootsByRepo` FALLBACK.
 *
 *  `unitKeyForAbsolutePath` does `rootsByRepo.get(repo) ?? []` — correct at function level, since it
 *  is sync and takes no `cfg` — so the fallback belongs to this CALLER. The map is populated per repo
 *  present in `byRepo`, and `resumptionSignals` emits a `branch` activity for every readable repo
 *  with a resolvable branch, so a quiet clean repo DOES have an entry; the gap is only a repo that
 *  produced ZERO activities (unreadable, or unborn HEAD with no symbolic-ref).
 *
 *  ⚠ Without the fallback such a repo's edits bucket to the catch-all — silently losing the "I
 *  worked here but committed nothing" case, which is exactly what RESUME exists to surface. Dropping
 *  would be safe but equally silent.
 *
 *  Returns a bucketer plus the roots it resolved, so the caller can reuse them. */
export async function makeBucketer(
  repos: string[], rootsByRepo: Map<string, string[]>, cfg: Config, excludedRepoPaths?: string[],
): Promise<Bucketer> {
  const filled = new Map(rootsByRepo);
  for (const repo of repos) {
    if (filled.has(repo)) continue;
    const { roots } = await resolveProjectRoots(repo, cfg);   // the fallback §3.2 step 4 requires
    filled.set(repo, roots);
  }
  return (absPath: string) => unitKeyForAbsolutePath(absPath, repos, filled, excludedRepoPaths);
}

/** Build segments from allowlisted edit-path records. A path under no configured repo is dropped —
 *  THAT PATH ONLY, never the segment. A path under a known repo but under no sub-root is NOT
 *  dropped: it buckets to the repo's catch-all unit, which is a real unit and the only unit a repo
 *  without a workspace manifest ever has. Dropping it would give every single-project repo 0%
 *  coverage.
 *
 *  ⚠ INFRA PATHS ARE DROPPED HERE TOO, and this was a real attribution defect, not a tidy-up.
 *  `INFRA_DENYLIST` (agent-scratch dirs) was applied at five sites — `subprojects.resolveUnits`'s
 *  dirtyFiles, `generator`'s dirtyFiles + post-parse SUGGESTIONS filter, `core`'s resolved-files, and
 *  `audit` — but at NONE on the transcript side, so segments still formed from them. Measured over a
 *  30-day window: 2324 of 7673 edit-path records (30.3%) sit under `.claude/worktrees/`.
 *
 *  Two consequences, both observed in the A3 replay:
 *   1. WRONG UNIT. A worktree path is repo-relative `.claude/worktrees/<wt>/<subproject>/…`, which
 *      matches no sub-root, so REAL work done in a worktree bucketed to the umbrella repo's CATCH-ALL
 *      unit. Sessions building `daily_briefing_application` were credited to `personal_code`.
 *   2. PHANTOM CLAIMANTS. Those spurious catch-all segments inflate the claiming-session count, which
 *      is precisely what makes a unit `ambiguous` — so the noise was suppressing whys under the
 *      conservative rule as well, not merely mis-picking under `keep-earliest`.
 *
 *  DROPPED rather than re-mapped to the subproject the worktree mirrors. Re-mapping is a new
 *  mechanism with one case, and dropping is what the other five sites already do — an infra path is
 *  not the user's work wherever it appears.
 *
 *  Counted under `path-unresolvable`, whose contract already reads "under no configured repo (or
 *  excluded)" — `excludeRepos` reaches this same branch through the bucketer. `DropReason` is a
 *  closed set with a coverage table and a §5 accounting identity behind it; a dedicated code buys no
 *  analysis in 1.5a and would have to be threaded through both. Split it later if the two ever need
 *  telling apart. */
/** `drops` is threaded for the same reason `transformLines` takes it: `path-unresolvable` is an
 *  enumerated code, and counting it only as a local number leaves it with no writer. */
export function buildSegments(
  paths: PathRecord[], bucket: Bucketer, drops?: Partial<Record<DropReason, number>>,
): { segments: TranscriptSegment[]; firstEdit: Map<string, string>; pathsUnresolvable: number } {
  // key = sessionId \x00 unitKey \x00 localDay
  const acc = new Map<string, { seg: TranscriptSegment; firstEditTs: string }>();
  let pathsUnresolvable = 0;

  for (const p of paths) {
    // Before bucketing: an infra path would otherwise resolve to a REAL unit (the catch-all) and
    // constitute a segment there. `includes`, matching the bare form the other five sites use.
    if (INFRA_DENYLIST.some((d) => p.path.includes(d))) {
      pathsUnresolvable++;
      if (drops) drops["path-unresolvable"] = (drops["path-unresolvable"] ?? 0) + 1;
      continue;
    }
    const unitKey = bucket(p.path);
    if (unitKey === null) {
      pathsUnresolvable++;
      if (drops) drops["path-unresolvable"] = (drops["path-unresolvable"] ?? 0) + 1;
      continue;                                                // under no configured repo (or excluded)
    }
    const localDay = localDayOf(p.tsUtc);
    const key = `${p.sessionId}\x00${unitKey}\x00${localDay}`;
    const hit = acc.get(key);
    if (!hit) {
      acc.set(key, { seg: { sessionId: p.sessionId, unitKey, localDay, paths: [p.path] }, firstEditTs: p.tsUtc });
      continue;
    }
    if (!hit.seg.paths.includes(p.path)) hit.seg.paths.push(p.path);  // deduped (§3.2)
    if (p.tsUtc < hit.firstEditTs) hit.firstEditTs = p.tsUtc;
  }

  const segments: TranscriptSegment[] = [];
  const firstEdit = new Map<string, string>();
  for (const [key, v] of acc) { segments.push(v.seg); firstEdit.set(key, v.firstEditTs); }
  return { segments, firstEdit, pathsUnresolvable };
}

export const segmentKey = (s: { sessionId: string; unitKey: string; localDay: string }): string =>
  `${s.sessionId}\x00${s.unitKey}\x00${s.localDay}`;

/** ⚠ THE MEMBERSHIP RULE. A turn belongs to segment S iff it is in S's session and local day, and it
 *  is the NEAREST QUALIFYING HUMAN TURN AT OR BEFORE S's first edit event under that unitKey.
 *
 *  Positional by necessity: turns carry no unit. Without this rule two segments of the same session
 *  on the same day resolve to the SAME turn, and a why is grounded in another unit's material while
 *  passing every downstream guard — and §2.1's evidence makes that the common case, not an edge
 *  ("one session spans 07-14 -> 07-26 across 14 cwds").
 *
 *  If no qualifying turn PRECEDES that edit, the segment has no why-source. FAIL-CLOSED — never
 *  "borrow the next one", which would quote a turn the user wrote about later work.
 *
 *  Ordering is by TIMESTAMP, not file position; `uuid` ordering is unusable (12.80% of lines
 *  collide). Ties break by file order, then `uuid` lexicographically — deterministic by
 *  construction. `candidates` must already be filtered to qualifying (substantive) turns. */
export function turnForSegment(
  seg: { sessionId: string; unitKey: string; localDay: string },
  firstEditTs: string,
  candidates: (TurnRecord & { order: number })[],
): TurnRecord | null {
  let best: (TurnRecord & { order: number }) | null = null;
  for (const c of candidates) {
    if (c.sessionId !== seg.sessionId) continue;
    if (localDayOf(c.tsUtc) !== seg.localDay) continue;
    if (c.tsUtc > firstEditTs) continue;                       // strictly at or before the first edit
    if (best === null || isNearer(c, best)) best = c;
  }
  return best ? { sessionId: best.sessionId, uuid: best.uuid, tsUtc: best.tsUtc, text: best.text } : null;
}

/** "Nearer to the edit" = later timestamp; ties by file order, then uuid lexicographically. */
function isNearer(a: TurnRecord & { order: number }, b: TurnRecord & { order: number }): boolean {
  if (a.tsUtc !== b.tsUtc) return a.tsUtc > b.tsUtc;
  if (a.order !== b.order) return a.order > b.order;
  return a.uuid > b.uuid;
}
