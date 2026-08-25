// src/reduce.ts
import type { Activity, ActivityMeta, ReducedContext, TokenBudget } from "./types";

export const STAGE1_TEXT_CAP = 200;   // long prose bodies (AI-session prompts/responses) → first 200 chars
export const STAGE1_LIST_CAP = 100;   // pathological diffstat/working-tree lists → first N files (evidence kept)

export function summarize(commits: Activity[], dirty: boolean): string {
  const files = commits.flatMap((a) => a.meta?.diffstat?.map((d) => d.file) ?? []);
  return `${commits.length} commit(s), ${new Set(files).size} file(s) touched${dirty ? ", uncommitted work present" : ""}`;
}

// Stage-1 gentle trim: shrink the fields that actually hold bulk while keeping evidence.
// `text` covers long AI-session prose; the `meta` list caps cover the git case — a huge diffstat or
// working-tree list is where a git-only activity's size lives, so trimming only `text` would leave it
// over budget and force the evidence-destroying stage 2. First-N files keep the SHA + leading evidence
// generator.ts cites; the stage note discloses the trim.
function trimActivity(a: Activity): Activity {
  // Preserve an absent `text` as undefined (do NOT coerce to ""): generator.ts renders each activity
  // as `a.text ?? a.target ?? ""`, so a coerced "" would shadow the `target` fallback of a text-less
  // signal (e.g. a future branch/stash activity). Unreachable today (git producers always set text),
  // but pinned by a regression test so it stays correct once AI-session producers land.
  const text = a.text !== undefined ? a.text.slice(0, STAGE1_TEXT_CAP) : undefined;
  if (!a.meta) return { ...a, text };
  const meta: ActivityMeta = { ...a.meta };
  if (meta.diffstat && meta.diffstat.length > STAGE1_LIST_CAP) meta.diffstat = meta.diffstat.slice(0, STAGE1_LIST_CAP);
  if (meta.uncommittedFiles && meta.uncommittedFiles.length > STAGE1_LIST_CAP) meta.uncommittedFiles = meta.uncommittedFiles.slice(0, STAGE1_LIST_CAP);
  return { ...a, text, meta };
}

export function reduce(activities: Activity[], budget: TokenBudget): ReducedContext {
  const byRepo = new Map<string, Activity[]>();
  for (const a of activities) {
    const key = a.repo ?? "(unknown)";
    let arr = byRepo.get(key);
    if (!arr) byRepo.set(key, (arr = []));
    arr.push(a);
  }
  const repos = [...byRepo.entries()].map(([repo, acts]) => {
    const commitActs = acts.filter((a) => a.kind === "commit");
    const dirty = acts.some((a) => a.kind === "uncommitted");
    const summary = summarize(commitActs, dirty);
    return { repo, summary, activities: acts };
  });

  let ctx: ReducedContext = { repos };
  if (JSON.stringify(ctx).length > budget.maxChars) {
    // stage 1: trim the fields that hold bulk (long prose + pathological meta lists), keeping evidence
    ctx = {
      repos: repos.map((r) => ({ ...r, activities: r.activities.map(trimActivity) })),
      note: `context trimmed to fit ${budget.maxChars} chars (heavy map-reduce is Slice 1.5)`,
    };
    // stage 2: still over → keep per-repo summaries only, drop activity detail (bounded by repo count).
    // NOTE: dropping activities here also drops per-commit SHA/file evidence that generator.ts's
    // buildPrompt cites for grounding — that's why the Slice-1 DEFAULT_BUDGET (src/config.ts) is
    // set high, so normal days never reach this stage. A future Slice-1.5 improvement is to
    // preserve compact evidence (SHA + files) here while dropping prose, instead of dropping
    // activities wholesale.
    if (JSON.stringify(ctx).length > budget.maxChars) {
      ctx = {
        repos: repos.map((r) => ({ repo: r.repo, summary: r.summary, activities: [] })),
        note: `context reduced to per-repo summaries to fit ${budget.maxChars} chars`,
      };
    }
    // stage 3: final safety net. A pathological repo count or very long repo paths can still
    // leave stage 2 over budget — drop repo entries from the tail until the whole context fits,
    // so reduce() never returns an over-budget ReducedContext.
    if (JSON.stringify(ctx).length > budget.maxChars) {
      const kept = ctx.repos;
      // Serialize each repo ONCE and keep prefix sums, so finding how many to keep is O(n), not the
      // O(n²) of re-serializing the whole remaining array on every pop.
      const prefix = [0];
      for (const r of kept) prefix.push(prefix[prefix.length - 1]! + JSON.stringify(r).length);
      // Stage 3 can be entered because stage 2's (longer) note overflowed, yet all repos still fit
      // once the shorter note replaces it — so guard against a misleading "dropped 0 repo(s)". The
      // SAME function drives both lenFor() and the attached note, keeping the length arithmetic exact.
      const note = (dropped: number) => dropped === 0
        ? `context reduced to fit ${budget.maxChars} chars`
        : `context truncated: dropped ${dropped} repo(s) to fit ${budget.maxChars} chars`;
      // Exact serialized length of {"repos":[r0..r(k-1)],"note":"<note>"} WITHOUT rebuilding the object —
      // and crucially INCLUDING the note (measuring {repos} alone let a context that only fits without
      // the note slip through, then the attached note pushed it back over budget).
      const lenFor = (k: number) => {
        const arr = k === 0 ? 2 : 2 + prefix[k]! + (k - 1); // [ … ] : brackets + entries + commas
        return 9 /* {"repos": */ + arr + 8 /* ,"note": */ + JSON.stringify(note(kept.length - k)).length + 1 /* } */;
      };
      // NOTE: the dropped===0 note is ~20 chars shorter than the dropped>=1 note, so lenFor() has a
      // tiny non-monotonic step at the 0→1 boundary. Harmless: a repo entry dwarfs 20 chars, and the
      // exact-stringify guard below backstops any residual edge — this loop is an O(n) fast path, not
      // the correctness authority.
      let keep = kept.length;
      while (keep > 0 && lenFor(keep) > budget.maxChars) keep--;
      ctx = { repos: kept.slice(0, keep), note: note(kept.length - keep) };
      // Ultimate fallback: even zero repos + the drop-note don't fit (maxChars below that skeleton).
      // Try the shortest note, then no note at all — {"repos":[]} (12 chars) is the smallest legal
      // shape; a maxChars below that cannot be honored by any non-throwing return.
      if (JSON.stringify(ctx).length > budget.maxChars) {
        ctx = { repos: [], note: "context truncated to fit budget" };
        if (JSON.stringify(ctx).length > budget.maxChars) ctx = { repos: [] };
      }
    }
  }
  return ctx;
}
