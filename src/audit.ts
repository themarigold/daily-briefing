// src/audit.ts — deterministic checks + adversarial-prompt builder for the daily briefing self-audit.
// Pure functions only (testable); the CLI orchestration lives in scripts/audit.ts.
//
// DELIBERATELY SEPARATE from src/eval/checks.ts — do NOT "DRY up" the two into a shared primitive. This
// is the LENIENT, text-based MONITOR of the REAL daily briefing: it mines the RENDERED briefing text,
// resolves cited SHAs via `git cat-file` (4-char floor, to catch short garbles), and treats a commit as
// covered if its prefix appears anywhere — tuned to avoid false alarms on live, day-to-day-drifting data
// a human reads each morning. src/eval/checks.ts is the STRICT, struct-based GATE (parsed struct, unique
// 7-char prefix, exactly-once coverage) for a deterministic pass/fail on synthetic fixtures. The two
// share vocabulary, not semantics — a shared primitive would force one to adopt the other's and regress it.
import type { Activity } from "./types";
import { repoLabelFor, INFRA_DENYLIST, type Unit } from "./subprojects";
// The SAME shape test the generator's grounding guard uses (src/sha.ts) — so a hex-ish prose word the
// generator legitimately KEEPS in evidence ("added"/"cafe") isn't re-mined here and re-flagged as a
// `fabricated SHA` in the deterministic report + the EVAL row (final-review Tier-D).
import { isShaShaped } from "./sha";
import { localDateStr } from "./marker";

// Parse the briefing's "state as of HH:MM" stamp (core.ts stateAsOf = local HH:MM, rendered by
// render.ts) into the generation INSTANT on bDate (local epoch-ms), or null if absent/unparseable.
// Used to exclude commits made AFTER the briefing was generated from the same-day-miss count — an
// afternoon or retrospective audit otherwise flags commits the briefing could not have known about.
export function generationInstant(briefingText: string, bDate: string): number | null {
  const m = briefingText.match(/state as of\s+(\d{1,2}):(\d{2})/i);
  if (!m) return null;
  const [y, mo, d] = bDate.split("-").map(Number);
  if (!y || !mo || !d) return null;
  const dt = new Date(y, mo - 1, d, Number(m[1]), Number(m[2]));
  return isNaN(dt.getTime()) ? null : dt.getTime();
}

// Parse `git log --pretty=%h%x1f%cI%x1f%P%x1f%s` output into the briefing's-own-day commits, applying
// the SAME filters as the app's listCommits so the same-day-blindness count can't over-report:
//  - exact committer-LOCAL-day match (== bDate),
//  - SPLIT OUT merges (2+ parents) — the app's listCommits (git.ts) drops them from the recap/Today-so-far
//    commit stream, so a dropped merge commit must not be counted as "missed" here. (A same-day PR landing
//    is surfaced via the separate mergedToday channel as "🔀 Merged #N (branch) (sha)", not as a recap
//    commit, so it's out of this blindness count either way.)
//  - DROP bot/auto commits (excludeRe), mirroring the app's filter.
// When `generatedBeforeMs` is given, commits at/after that instant are split out as `postGeneration`
// (they landed after the briefing ran — not blindness) rather than counted as missed.
//
// ⚠ FREEZE-BLOCK DEFECT A, fixed 2026-08-14 after the days 27–29 window closed (EVAL.md). Merges used
// to be `continue`d into the void, so the judge's ground truth had NO trace of them at all — while the
// app renders each one as `🔀 Merged #N (branch) (sha)`. Absence from the evidence then read as
// invention, and the judge returned a Ground FAIL on a REAL, verified merge on days 27, 28 AND 29
// (`071461a`, `2eb9310`, `07dc91f`+`be2d501` — each confirmed with `git cat-file` / `gh pr view`).
// They are returned separately rather than folded into `lines`/`shas`, because the blindness count
// must keep excluding them exactly as before: this is a COVERAGE fix, not a counting change.
// Post-generation merges go to `postGeneration` tagged `(merge)`, so nothing is silently dropped.
//
// ⚠ `prMerges` vs `otherMerges` — added after review, and the split is the whole point. The app's
// `listPrMerges` (git.ts) renders ONLY subjects matching PR_MERGE_SUBJECT; a `Merge branch 'x'` or a
// `git pull` merge is surfaced by NEITHER channel. A first draft returned every 2+-parent commit
// under a heading claiming the app surfaces them, which would have invited the mirror-image false
// finding — the judge seeing a merge the ground truth says is rendered, not finding it in the
// briefing, and reporting an omission the app structurally cannot make.
export const PR_MERGE_SUBJECT = /^Merge pull request #(\d+) from (\S+)/;   // == listPrMerges (git.ts)

export function sameDayCommits(
  logOut: string, bDate: string, excludeRe: RegExp[], generatedBeforeMs?: number,
): { shas: string[]; lines: string[]; postGeneration: string[]; prMerges: string[]; otherMerges: string[] } {
  const shas: string[] = [], lines: string[] = [], postGeneration: string[] = [];
  const prMerges: string[] = [], otherMerges: string[] = [];
  for (const row of logOut.split("\n").filter(Boolean)) {
    const [h, cISO, parents, subj] = row.split("\x1f");
    if (!h || !cISO || localDateStr(new Date(cISO)) !== bDate) continue;
    const isMerge = (parents ?? "").trim().split(/\s+/).filter(Boolean).length > 1;
    if (excludeRe.some((re) => re.test(subj ?? ""))) continue;                     // bot/auto commit
    const label = `${h} ${subj ?? ""}`;
    if (generatedBeforeMs !== undefined && new Date(cISO).getTime() >= generatedBeforeMs) {
      postGeneration.push(isMerge ? `${label} (merge)` : label); // after generation — not the briefing's fault
      continue;
    }
    if (isMerge) {                                                                 // never a recap commit
      (PR_MERGE_SUBJECT.test(subj ?? "") ? prMerges : otherMerges).push(label);
      continue;
    }
    shas.push(h); lines.push(label);
  }
  return { shas, lines, postGeneration, prMerges, otherMerges };
}

// ⚠ A FIRST ATTEMPT AT THIS USED `git reflog`, AND IT WAS WRONG IN BOTH DIRECTIONS. Recorded because
// the failure is instructive, not to pad the file. The reflog answers "did HEAD move"; the judge needs
// "did `isBranchNotable`'s inputs change". Neither implies the other:
//   • `git fetch` moves `@{u}` — which `isBranchNotable` reads via ahead/behind (git.ts) — and writes
//     NO HEAD reflog entry. So "HEAD did not move" was emitted as "the branch state IS comparable"
//     while ahead/behind had silently changed underneath it. A confident, wrong endorsement.
//   • HEAD's reflog records ordinary `commit:` entries, so on any day the author commits after the
//     briefing runs, the guard fired "moved" and told the judge to drop EVERY branch finding.
//     Blanket suppression would have been the normal case, not the edge case.
// Both were caught in review before shipping. The lesson generalises: an instrument that infers a
// fact from a proxy signal must be judged on the proxy's failure modes, not on its happy path.
//
// What replaces it, per the freeze block's first sanctioned option (EVAL.md — "compare against state
// at generation"): the DELIVERED BRIEFING already carries the answer. `branchStateLines` (core.ts)
// emits a line IFF `isBranchNotable` is true, and `render.ts` renders it as `• [label] <text>`. So the
// briefing states the app's own branch verdict AT GENERATION, and its ABSENCE is equally informative.
//
// ⚠ CIRCULARITY, stated because it is real and cannot be designed away: this derives the
// generation-time fact from the artifact under review. It establishes what the app BELIEVED at
// generation — not, independently, that the belief was correct. A briefing that omitted a branch line
// through a BUG reads here as "not notable". `branchAxisText` says so in the block preamble rather
// than letting the judge assume otherwise.
export type BranchAtGeneration =
  | { kind: "stated"; text: string }        // the briefing rendered a branch line for this repo
  | { kind: "not-notable" }                 // briefing parsed, no line for this repo → predicate was false
  | { kind: "unguarded"; why: string };     // no generation-time fact available at all

// Anchored to the EXACT shapes git.ts emits for a branch activity — `On branch <b> (ahead N, behind M)`,
// `On branch <b> (no upstream)`, `Detached HEAD at <sha7>`. Deliberately strict: resume bullets share
// the `• [label] …` shape and are free model prose, so a loose pattern would mine one as branch state.
const BRANCH_LINE =
  /^\s*•\s*\[([^\]]+)\]\s*((?:On branch \S+ \((?:ahead \d+, behind \d+|no upstream)\))|(?:Detached HEAD at [0-9a-f]{7,40}))\s*$/;

/** Branch lines the DELIVERED briefing rendered, keyed by the label `render.ts` emitted. */
export function branchLinesFromBriefing(briefing: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of briefing.split("\n")) {
    const m = BRANCH_LINE.exec(line);
    if (m) out.set(m[1]!.trim(), m[2]!.trim());
  }
  return out;
}

/** `branchLines === null` ⇒ the briefing itself could not be read, so absence proves nothing. */
export function branchAtGeneration(branchLines: Map<string, string> | null, label: string): BranchAtGeneration {
  if (branchLines === null) return { kind: "unguarded", why: "the delivered briefing could not be read" };
  const text = branchLines.get(label);
  return text ? { kind: "stated", text } : { kind: "not-notable" };
}

/** One line per repo for the judge's ground truth. Keyed by BOTH the rendered label and the full repo
 *  path: `repoLabel` is non-injective by construction (config.ts), and this file already records that
 *  filtering on a non-injective key deleted a repo's diagnosis twice. */
export function branchAxisLine(label: string, repoPath: string, s: BranchAtGeneration): string {
  const id = `${repoPath} [${label}]`;
  switch (s.kind) {
    case "stated":
      return `  ${id}: AT GENERATION the briefing stated "${s.text}". Compare THAT against this repo's branch facts, not the audit-time reading.`;
    case "not-notable":
      return `  ${id}: AT GENERATION the briefing rendered NO branch line, and it renders one iff the branch is notable — so the branch was NOT notable then. A branch difference in the facts is post-generation; do not score it as an omission.`;
    case "unguarded":
      return `  ⚠ ${id}: UNGUARDED — ${s.why}, so there is no generation-time branch fact for this repo. Its branch facts reflect AUDIT time only.`;
  }
}

const HEX = "[0-9a-f]{4,40}";
// A "clean citation" part: a lone SHA (>=4 — catches 6-char garbles), optionally with a "(file)" note.
const CLEAN_CITATION = new RegExp(`^\\s*${HEX}\\s*(\\(.+\\))?\\s*$`, "i");
// A SHA TOKEN: hex bounded by whitespace/comma/paren — NOT embedded in a filename (0001_init.sql, feed.json).
const STANDALONE_HEX = new RegExp(`(?<=^|[\\s,(])${HEX}(?=$|[\\s,)])`, "gi");

// Cited SHAs = standalone hex tokens found in SHA-CITATION groups: parenthesized / "evidence:" content
// that is *majority comma-separated SHAs* (so prose like "(2024 planning, faced a decade)" and file
// evidence like "(0001_init.sql)" are NOT mined). Matches generator.ts's anchored intent while still
// catching a garbled short SHA (e.g. "2ee140"). Skips the app's own grounding-guard disclosure line.
// Top-level (balanced) parenthesized groups of a line, each as a separate string; nested parens stay
// inside their enclosing group. Unbalanced trailing "(" is ignored (only closed groups are returned).
function topLevelParenGroups(line: string): string[] {
  const groups: string[] = [];
  let depth = 0, start = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "(") { if (depth === 0) start = i + 1; depth++; }
    else if (line[i] === ")" && depth > 0 && --depth === 0) groups.push(line.slice(start, i));
  }
  return groups;
}

export function extractCitedShas(text: string): string[] {
  const shas = new Set<string>();
  for (const line of text.split("\n")) {
    if (/didn't resolve to a real commit/i.test(line)) continue; // the generator's own warning line
    // Each TOP-LEVEL parenthesized group SEPARATELY (a balanced walk, not one greedy first-'(' to
    // last-')' span): a greedy match merges a prose paren and a later citation paren into one blob that
    // fails the SHA-citation test below, shielding a fabricated SHA in e.g. `… (see plan) … (2ee140)`.
    // A nested paren stays inside its top-level group, so a legit `(a1b2c3, (2ee140), …)` list still mines.
    const groups: string[] = topLevelParenGroups(line);
    const ev = line.match(/evidence:\s*(.*)$/i);
    if (ev) groups.push(ev[1]!);
    for (const g of groups) {
      const parts = g.split(",");
      const clean = parts.filter((p) => CLEAN_CITATION.test(p)).length;
      if (!parts.length || clean / parts.length < 0.5) continue; // not a SHA-citation list → skip
      // Mine only SHA-SHAPED tokens: even inside a citation group, a parenthetical note can carry a
      // hex-ish prose word ("added"/"cafe") the generator kept verbatim — isShaShaped drops it so it
      // isn't reported as `fabricated added`, while a real/garbled abbrev (digit+letter) is still mined.
      for (const tok of g.match(STANDALONE_HEX) ?? []) if (isShaShaped(tok)) shas.add(tok.toLowerCase());
    }
  }
  return [...shas];
}

// A briefing.log accumulates multiple briefings (launchd appends to StandardOutPath). Return the
// LAST (most recent) briefing block, split on the header marker, so the audit reads today's — not the
// oldest — when the log has piled up.
/** ⚠ SLICE BOUND (T4.7). `briefing.log` is append-only and launchd never truncates it, so it grows
 *  without limit — and with no bound this read is O(whole file) on every audit, forever. The tail is
 *  the only part that can contain the last briefing, so only the tail is scanned.
 *  The bound is generous enough that a single briefing can never straddle it. */
export const LAST_BRIEFING_SCAN_BYTES = 256 * 1024;

/** Matches BOTH briefing headers, and must keep doing so permanently.
 *
 *  The header was `☀️  Morning briefing — <date>` until 2026-08-17, when the scope decision (the
 *  deliverable is a FIRST-WAKE briefing, not an 07:20 one) dropped "Morning" — see render.ts:29.
 *  ⚠ **Narrowing this to the new spelling would break the audit SILENTLY, not loudly**: `briefing.log`
 *  and all 31 archived briefings under `<state>/briefings/` carry the OLD text, `lastBriefing` falls
 *  back to returning the WHOLE text when it finds no header, and the audit would then grade a
 *  concatenation of every briefing ever written while reporting nothing wrong. Accept both forever.
 *
 *  ⚠ Returned fresh per call rather than shared: `matchAll` clones the regex so a shared literal is
 *  safe TODAY, but a future `.test()`/`.exec()` caller on a `g`-flagged shared object would inherit
 *  `lastIndex` and skip matches intermittently — the kind of defect that passes every test once. */
const BRIEFING_HEADER_RE = () => /^☀️.*[Bb]riefing —/gm;

export function lastBriefing(text: string): string {
  const scanned = text.length > LAST_BRIEFING_SCAN_BYTES ? text.slice(-LAST_BRIEFING_SCAN_BYTES) : text;
  const idxs = [...scanned.matchAll(BRIEFING_HEADER_RE())].map((m) => m.index!);
  if (idxs.length > 0) return scanned.slice(idxs[idxs.length - 1]!);
  // No header in the tail — fall back to the whole text rather than returning a truncated fragment,
  // which would silently hand the audit a briefing missing its head.
  const all = [...text.matchAll(BRIEFING_HEADER_RE())].map((m) => m.index!);
  return all.length > 1 ? text.slice(all[all.length - 1]!) : text;
}

/** Audit retention (T4.7): keep the newest N `audit-*.md` and delete the rest. Without it the
 *  support dir accretes one report per day forever. Returns the paths removed. */
export const AUDIT_RETENTION = 60;

export function auditFilesToPrune(names: string[], keep = AUDIT_RETENTION): string[] {
  // `audit-YYYY-MM-DD.md` sorts lexicographically == chronologically, so name order IS date order.
  const audits = names.filter((n) => /^audit-\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort();
  return audits.length <= keep ? [] : audits.slice(0, audits.length - keep);
}

// Of the given day's (author-filtered) commit SHAs, which does the briefing NOT reflect (by bounded
// 7-char prefix — not a coincidental mid-hash substring)?
export function missingSameDay(dayShas: string[], briefingText: string): string[] {
  const hay = briefingText.toLowerCase();
  return dayShas.filter((sha) => !new RegExp(`(?<![0-9a-f])${sha.slice(0, 7).toLowerCase()}`, "i").test(hay));
}

// Repos with working-tree/stash state the briefing never names (word-bounded, verbatim label match —
// NO basename() — so a parent-qualified label like "A/api" only clears if "A/api" itself appears, not
// a bare "api"). A repo is covered iff at least one of its labels (repo label + any unit labels) is
// found; this lets a dirty sub-project be covered by its unit label even when the bare repo label
// never appears in the text.
export function coverageGaps(
  reposWithState: { repo: string; labels: string[] }[],
  briefingText: string,
): { repo: string; labels: string[] }[] {
  const hay = briefingText.toLowerCase();
  return reposWithState.filter(({ labels }) =>
    !labels.some((l) => {
      const esc = l.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${esc}\\b`).test(hay);
    }),
  );
}

// Which cited SHAs are "missing" in EVERY repo. `repoOutputs[i]` is repo i's cat-file --batch-check
// output split into lines, index-aligned to `cited`. A non-"missing" line (resolved/ambiguous) clears it.
export function unresolvedFromBatch(cited: string[], repoOutputs: string[][]): string[] {
  if (!cited.length) return [];
  const missing = new Set(cited.map((s) => s.toLowerCase()));
  for (const lines of repoOutputs) cited.forEach((sha, i) => { if (!/\bmissing\b/.test(lines[i] ?? "")) missing.delete(sha.toLowerCase()); });
  return [...missing];
}

/**
 * Cited SHAs that EXIST as objects but are reachable from no ref in any repo — "resolvable but
 * unreachable". The third state between "resolves" and "fabricated" (day-16 finding, closed
 * 2026-08-04, user-directed eval-integrity change).
 *
 * WHY IT IS ITS OWN STATE AND NOT JUST A FAILURE. `cat-file --batch-check` resolves any object in
 * the database, including commits on deleted or abandoned branches. A briefing is read hours after
 * it is written, so it can cite a commit that was on a branch at generation time and on none by the
 * time anyone follows the SHA — the deterministic layer then certifies a citation the reader cannot
 * find, which is the reverse of the day-3 lesson.
 *
 * ⚠ MEASURED 2026-08-04 in this workspace, by `git rev-list --all` against `cat-file`: DOZENS of
 * such commits in `personal_code` (0 in the vault), a double-digit share of them inside the 14-day
 * briefing window. Live, not hypothetical. The COUNT is deliberately not quoted: it is gc-volatile
 * and two readings five days apart already differed (35, then 98) purely through branch churn and
 * pruning. Re-measure with the method, never cite the number.
 *
 * ⚠ AND THIS IS WHY THE OBVIOUS FIX IS WRONG. Swapping `cat-file` for `rev-list` outright would
 * reclassify all 35 as missing, i.e. FABRICATED — a false-fabrication verdict on real commits, the
 * exact error class PR #140 was opened to remove, firing on 14 in-window commits immediately. The
 * audit already draws this distinction elsewhere (ambiguous ≠ fabricated, the 4-char floor); this
 * keeps it. Orphaned is a WARNING about durability; fabricated is an accusation of hallucination.
 *
 * `reachablePerRepo` holds each readable repo's full `rev-list --all` output. A cited SHA may be
 * abbreviated, so membership is a prefix test against full hashes — matching how `cat-file` resolves
 * abbreviations, so the two layers agree on what "this SHA" means.
 */
export function unreachableFromRevList(
  cited: string[], unresolved: string[], reachablePerRepo: string[][],
): string[] {
  if (!cited.length || !reachablePerRepo.length) return [];
  const fabricated = new Set(unresolved.map((s) => s.toLowerCase()));
  const all = reachablePerRepo.flat().map((h) => h.trim().toLowerCase()).filter(Boolean);
  return cited
    .map((s) => s.toLowerCase())
    // Only SHAs that DID resolve can be "orphaned" — an unresolved one is already reported as
    // fabricated, and listing it in both states would double-count one citation as two defects.
    .filter((s) => !fabricated.has(s))
    .filter((s) => !all.some((full) => full.startsWith(s)));
}

// In-window ground-truth summary (the exact activities the briefing was built from) + which repos have
// working state. Pure so it's unit-testable. `units` + the FULL `repos` list let a repo's `labels`
// match exactly what the real briefing renders (repoLabelFor(repo, repos) + its unit labels) — a repo
// whose only state is a dirty sub-project has no catch-all unit to read a bare label from, so deriving
// a proxy `repos` from `activities` alone would reintroduce the day-to-day label-flip.
export function factsFromActivities(
  activities: Activity[], units: Unit[], repos: string[], cap = 30,
): { text: string; reposWithState: { repo: string; labels: string[] }[] } {
  const byRepo = new Map<string, Activity[]>();
  for (const a of activities) {
    const k = a.repo ?? "(unknown)";
    let arr = byRepo.get(k);
    if (!arr) byRepo.set(k, (arr = []));
    arr.push(a);
  }
  const reposWithState: { repo: string; labels: string[] }[] = [];
  const blocks: string[] = [];
  for (const [repo, acts] of byRepo) {
    // `meta.excluded` (bot/auto-commit noise) is dropped HERE, not by the caller (slice 1.5 T0.4).
    // Until T0.2 the git layer dropped these outright, so this function could never see one; T0.2
    // inverted that into a tag so an excluded commit can still vote for a sub-project root, and this
    // was the one consumer left unguarded — bot commits entered the judge's ground truth as work
    // "the briefing SHOULD recap", so the judge penalised the briefing for ignoring them. On the
    // author's own machine that is every day (an Obsidian vault repo auto-commits; the DEFAULT pattern is
    // `^vault backup:`), which would have understated quality in every EVAL.md row.
    //
    // Filtered here rather than at the single call site so the next caller inherits the guard, and
    // deliberately NOT before `resolveUnits` in scripts/audit.ts: the APP gives resolveUnits the full
    // list so excluded commits still vote, and the audit's units must match the app's units or its
    // "did the briefing name this unit?" checks judge a unit set the app never produced. This keeps
    // the audit mirroring the app — which is why it reuses gitActivity at all — and keeps the
    // generator/judge pairing in test/audit.test.ts true, since the generator side is already fed
    // from the filtered `ctx`.
    const commits = acts.filter((a) => a.kind === "commit" && !a.meta?.excluded);
    const state = acts.filter((a) => a.kind === "uncommitted" || a.kind === "branch" || a.kind === "stash");
    // A repo has "state the briefing should name" only for a stash OR an uncommitted change with a
    // NON-infra file — the briefing itself filters `.claude/worktrees/` agent-scratch dirt (generator),
    // so an infra-only-dirty repo must NOT be flagged "UNCOMMITTED NOT SURFACED". (A structured file
    // list absent → treat as real state, for back-compat with activities that carry only `text`.)
    const hasRealState = acts.some((a) => {
      if (a.kind === "stash") return true;
      if (a.kind !== "uncommitted") return false;
      const files = a.meta?.uncommittedFiles;
      return files === undefined || files.some((f) => !INFRA_DENYLIST.some((d) => f.includes(d)));
    });
    if (hasRealState) {
      const unitLabels = units.filter((u) => u.repo === repo).map((u) => u.label);
      const labels = [...new Set([repoLabelFor(repo, repos), ...unitLabels])];
      reposWithState.push({ repo, labels });
    }
    // Include each commit's file list (from --numstat) — the generator's prompt shows the model
    // these files, so the judge must see them too or it flags correct file claims as "fabricated"
    // (2026-07-10 false positive: dualread_live_b.json was real, grounded evidence). Capped for size.
    const lines = commits.slice(0, cap).map((a) => {
      // Rename rows show both sides (defect C) — keeps the judge's evidence byte-parallel with
      // generator.ts's activityLine, which renders the same "old → new" form.
      const files = a.meta?.diffstat?.map((d) => (d.renamedFrom ? `${d.renamedFrom} → ${d.file}` : d.file)) ?? [];
      const filesPart = files.length
        ? ` — files: ${files.slice(0, 8).join(", ")}${files.length > 8 ? ` (+${files.length - 8} more)` : ""}`
        : "";
      // Same date as the generator's activityLine (generator.ts), by the same rule: a raw slice of
      // git's %cI, i.e. the committer's local date, never a UTC re-render. Reason is the sentence
      // above — the prompt now shows the model these dates, so the judge must see them too or a
      // briefing that cites them is flagged unsupported (the same 2026-07-10 false-positive class).
      const datePart = a.timestamp ? ` — ${a.timestamp.slice(0, 10)}` : "";
      return `  ${(a.event_id ?? "").slice(0, 7)} ${a.text ?? ""}${filesPart}${datePart}`;
    });
    blocks.push(
      `### ${repo}`,
      `in-window commits (${commits.length}) the briefing SHOULD recap:`,
      lines.join("\n") || "  (none)",
      commits.length > cap ? `  …+${commits.length - cap} more` : "",
      `current resumption state:`,
      state.map((a) => `  (${a.kind}) ${a.text ?? a.target ?? ""}`).join("\n") || "  (none)",
      "",
    );
  }
  return { text: blocks.join("\n"), reposWithState };
}

// Assemble the adversarial LLM-judge prompt.
export function buildAuditPrompt(parts: {
  briefing: string;
  gitFacts: string;
  popup: string | null;
  deterministic: string[];
  popupConfigured?: boolean; // opt-in: omit the popup comparison entirely unless a popup source was set
  /** T8.7 — ground truth for any QUOTATION the briefing rendered: each quoted turn paired with the
   *  corpus turn whose bytes equal it (T8.1a's content search). Absent or empty ⇒ the section is
   *  omitted entirely, so a git-only briefing's prompt is unchanged. */
  whyGroundTruth?: { quotation: string; sessionId: string; tsUtc: string }[];
}): string {
  // Three cases: (a) popup NOT configured (the default for public users — the daily_briefing popup is
  // the author's personal tool) → omit the block AND the VS POPUP heading, so no phantom "limitation"
  // noise; (b) configured but unavailable/stale → note it; (c) configured + present → show it.
  const popupBlock = !parts.popupConfigured
    ? ""
    : parts.popup
      ? `THIS MORNING'S POPUP (the separate daily_briefing tool — vault/calendar/AI-news):\n${parts.popup}`
      : `THIS MORNING'S POPUP: unavailable (didn't run today, or its files are stale/missing — note this as a comparison limitation; don't invent its contents).`;
  const det = parts.deterministic.length
    ? parts.deterministic.map((d) => `- ${d}`).join("\n")
    : "- (no issues found by the deterministic code checks)";
  // ── T8.7: the fidelity / outcome-leakage section. Present ONLY when the briefing actually
  // rendered a quotation whose source turn was located — so a git-only run's prompt is byte-unchanged.
  //
  // ⚠ Its receipt is that this section is PRESENT IN THE PROMPT, never that the judge's reply
  // discusses it. The reply is live model output: whether it echoes the turn is the model's choice,
  // and asserting on it would indict the model rather than the code.
  const whyBlock = (parts.whyGroundTruth?.length ?? 0) === 0 ? "" : `
QUOTED TURNS (the briefing quoted the developer's OWN words above a unit's bullets; each is
reproduced here BYTE-FOR-BYTE between its --- markers, unescaped and unquoted, because invariant 5
requires byte-equality on every path and this prompt is one of them — a JSON-escaped copy would
break it for any turn containing a quote or backslash):
${parts.whyGroundTruth!.map((w) => `--- session ${w.sessionId.slice(0, 8)} @ ${w.tsUtc}\n${w.quotation}\n--- end`).join("\n")}

Judge these on TWO dimensions and report under FIDELITY below:
 (a) FIDELITY — is the quotation reproduced exactly, and does it plausibly explain the unit's commits?
     A quotation that is accurate but describes DIFFERENT work is a mis-attribution, not a style issue.
 (b) OUTCOME LEAKAGE — does the quotation report a COMPLETED outcome ("fixed it", "done") rather than
     intent? A leaked outcome makes a resumption briefing read as if the work is finished.
`;

  return `You are an ADVERSARIAL evaluator of a developer's git-based "daily briefing". Attack it from
multiple angles — do NOT be charitable. Find what it got wrong, missed, or could do better, grounded
ONLY in the evidence below. Never invent facts not present here.

THE APP BRIEFING UNDER REVIEW:
${parts.briefing}

GIT GROUND TRUTH — the author-filtered in-window activity the briefing was built from (independently
recomputed; the recap must be consistent with this and must not claim anything absent from it).
Per-commit file lists come from \`git log --numstat\`; MERGE commits list no files, so an absent file
list does NOT prove a commit changed nothing. Working-tree facts here reflect NOW, and repos change
between the briefing's generation and this audit (the vault auto-commits every ~10 min) — prefer the
briefing's own "state as of HH:MM" stamp and drift warnings over calling a mismatch fabrication:
${parts.gitFacts}

DETERMINISTIC CHECKS already run in code (treat as verified fact; build on them, don't re-derive):
${det}

${popupBlock}
${whyBlock}
Report concisely under these headings:
1. GROUNDING & ERRORS — claims unsupported by the git ground truth; fabricated/misattributed evidence.
2. COMPLETENESS / MISSES — real work (especially same-day commits) or resumption state it omitted. Also flag OVER-SUPPRESSION: SUGGESTIONS that collapse to verification-only / vacuous "confirm X holds" items with no genuinely-next step. A SHORTER list is NOT itself a defect: judge the items present, not the count.${parts.popupConfigured ? "\n3. VS POPUP — what the popup surfaced that the app didn't (and vice-versa); which is more trustworthy where." : ""}
${(parts.whyGroundTruth?.length ?? 0) > 0 ? `${parts.popupConfigured ? 4 : 3}. FIDELITY — the two dimensions above, for each quoted turn.\n` : ""}${(parts.popupConfigured ? 4 : 3) + ((parts.whyGroundTruth?.length ?? 0) > 0 ? 1 : 0)}. IMPROVEMENT OPPORTUNITIES — concrete, ranked.
Finish with one line: VERDICT — Ground: PASS/FAIL (did every cited SHA/file resolve?) · Actionable: YES/NO.
Cite specific SHAs/paths. Where the briefing is solid on a dimension, say so briefly and move on.`;
}

/** The operator-facing message when today's briefing could not be obtained by regenerating it (F2).
 *
 * Takes the whole `RunResult`-shaped outcome rather than a flag or two, because THREE different events
 * arrive here wearing similar numbers and each calls for different action:
 *   - `!spawned` — `Bun.spawn` threw; no process ran, no pipe existed. "Re-run the audit" is wrong
 *     advice (it will fail identically); the operator needs to know the binary/PATH is the problem.
 *   - `!complete` — a pipe existed and never reached EOF. The generation may well have SUCCEEDED and
 *     we simply could not read all of it, so re-running IS the right move. `run()` forces `code` to -1
 *     here, so without this clause the operator stares at an exit code no process returned.
 *   - `signal` — the child was killed. It EOFs its pipes on death, so `complete` is true and the
 *     truncation clause is correctly suppressed, leaving a bare `exit=1` that looks like an ordinary
 *     failure. An OOM-killed generator is a different problem from one that ran and failed.
 *
 * `detail` is expected to arrive already sanitized: it carries the generator's stderr, which embeds
 * model output and therefore commit-subject-influenceable text, and this string rides a thrown Error
 * to `main().catch` — which console.errors it WITHOUT the report-side sanitization.
 */
export function regenFailureMessage(
  r: { code: number; complete: boolean; spawned: boolean; signal?: string | null; timedOut?: boolean },
  detail: string,
): string {
  const head = r.spawned
    ? `could not obtain today's briefing (generation exit=${r.code})`
    : `could not obtain today's briefing (the generator could not be started)`;
  // Ordered most-specific first, as a statement chain rather than a nested ternary — the order IS the
  // logic and a reader has to be able to check it.
  const cause = ((): string => {
    if (!r.spawned) return "";
    // Ahead of `!complete`: our own timeout kill produces `{code: -1, complete: false,
    // signal: "SIGKILL"}`, which without this clause matched the truncation branch and advised
    // "re-run the audit" — i.e. run the same 20-minute job again to be killed at the same ceiling.
    // It is also the branch most likely to fire on the regen path, whose child spawns children of its
    // own that inherit the pipe.
    if (r.timedOut) return " — the generator exceeded the audit's own time limit and was killed; re-running will hit the same ceiling, so raise it or investigate why generation is slow";
    if (!r.complete) return " — the generator's output pipe never reached EOF, so its output may be truncated (hence exit=-1); re-run the audit";
    // "we did not detect our own limit", not "it definitely was not us": `timedOut` is inferred, and
    // its false-NEGATIVE direction is real — `Date.now()` is wall-clock, so a backward clock step can
    // make our own kill look external. Phrase it as what we observed, not as a fact about causation.
    if (r.signal) return ` — the generator was killed by ${r.signal} (not by the audit's own time limit, as far as it can tell), so its output is likely incomplete`;
    // A clean exit reaching a FAILURE message can only mean the output carried no briefing dated
    // today — a stale generator, or a midnight rollover between the check and the generation.
    if (r.code === 0) return " — the generator exited cleanly but produced no briefing dated today";
    return "";
  })();
  const why = detail.trim() ? ` — ${detail.trim()}` : "";
  return `${head}${cause}${why}; refusing to overwrite the log`;
}

/** The deterministic line that must appear whenever a git read DEGRADED (F2 review).
 *
 * Making the spawn helper fail closed stopped the audit hanging, but the consumers still spoke
 * confidently about repos they never read: a held pipe on one repo's `git log` made the report print
 * "clean: all cited SHAs resolve, no same-day miss" and a ✅ EVAL row — i.e. a degraded audit produced
 * a BETTER-looking result than a healthy one. The failure note existed, but only inside the judge
 * prompt, which `--no-judge` never builds. It has to be in the deterministic section, which is the one
 * labelled "code — reliable" and the one that decides whether the "clean:" line is printed at all.
 */
export function degradedReadLine(repos: string[]): string | null {
  if (!repos.length) return null;
  return `READ DEGRADED (truncated read): ${repos.join(", ")} — this audit is INCOMPLETE: counts derived from those repos are a lower bound. Transient; re-run before recording a row.`;
}

/** How a failed git invocation should be reported (F2 round 4).
 *
 * The first version of this classifier was `code === -1 ? transient : definite`, and its comment
 * asserted "any other nonzero is git giving a definite answer". BOTH were wrong, in the two cases most
 * likely to occur in production:
 *   - A TIMEOUT kill returns `{code: 1, complete: true, signal: "SIGKILL", timedOut: true}` — SIGKILL
 *     EOFs the pipes, so the `-1` forcing never fires and `exitCode ?? 1` yields a plain 1. A slow
 *     network mount therefore got "fix or remove the config entry", i.e. advice to delete a perfectly
 *     healthy repo over a transient slowdown.
 *   - A SPAWN failure (git not on PATH) returns `code: -1`, so it got "transient; re-run" — permanent,
 *     un-clearable advice. That is exactly the conflation `RunResult.spawned` was added to prevent,
 *     reintroduced on the git consumers while the regeneration consumer honoured it.
 *
 * The facts were already on `RunResult`; the call sites simply destructured `{out, code}` and threw
 * the rest away. Classify from the whole outcome instead.
 */
export type ReadFailure = "transient" | "repo" | "toolchain";
export function classifyReadFailure(r: {
  code: number; complete: boolean; spawned: boolean; signal?: string | null; timedOut?: boolean;
}): ReadFailure {
  if (!r.spawned) return "toolchain";                    // no process ran — re-running changes nothing
  if (r.timedOut || r.signal) return "transient";        // killed, by us or otherwise: try again
  if (!r.complete || r.code === -1) return "transient";  // truncated read — the F2 case
  return "repo";                                         // git ran and gave a definite answer
}

/** Sort the extractor's own PathIssues into the audit's advice buckets (F2 round 5).
 *
 * Round 4 fixed this axis for `run()` outcomes and left the PathIssue mapping alone, on a comment
 * claiming "the kinds already encode the distinction this report needs". They do not: the kinds encode
 * BLIND-vs-DEFINITE, not TRANSIENT-vs-PERSISTENT, and those are different questions.
 *   - `tcc-denied` is never transient. The remedy is a System Settings grant, which `warnFor` already
 *     spells out — and this matters concretely here, because these repos live under `~/Desktop`, a
 *     TCC-protected root, so an unentitled binary would print "transient, re-run" for every repo every
 *     day. That is the operator-training failure the whole split exists to prevent.
 *   - `unreadable` is genuinely ambiguous: the extractor emits it BOTH for an IncompleteReadError
 *     (transient) and, via `classify`, for EPERM/EACCES (persistent). The kind alone cannot separate
 *     them — but the WARNINGS can, because only the incomplete-read path emits "partial read of X".
 */
export function bucketPathIssues(
  issues: { path: string; kind: string }[],
  warnings: string[],
): { transient: string[]; access: string[]; repo: string[]; toolchain: string[] } {
  const out = { transient: [] as string[], access: [] as string[], repo: [] as string[], toolchain: [] as string[] };
  // Matches every incomplete-read template THAT NAMES A REPO — i.e. two of the three below. (An
  // earlier revision of this line said "EVERY", which overstates it: the systemic probe's "git ran
  // but …" carries no repo path and is handled by the `path === "git"` branch instead, never reaching
  // this regex.) The first version keyed on "partial read of" alone, which
  // is only the PHASE-2 wording; phase 1 says "skipped X: …" and the systemic probe says "git ran
  // but …" (extractor.ts). A phase-1 held pipe — transient by definition — therefore fell through to
  // `access` and was reported as a permanent permissions problem telling the operator to grant Full
  // Disk Access: the exact inverse of the truth, and the mirror image of the mis-advice this function
  // was added to fix. An earlier revision of this comment claimed "only the incomplete-read path emits
  // 'partial read of X'", which was false — there are three emitters and only one uses that template.
  // Key on the SHARED clause instead of any one wording, and pin it against the extractor's source.
  const partialRead = new Set(
    warnings
      .map((w) => w.match(/^(?:partial read of|skipped) (.+?): git's output could not be read to completion/)?.[1])
      .filter((x): x is string => !!x),
  );
  for (const i of issues) {
    // The extractor's git-probe sentinel is `{path: "git"}` — not a repo at all. Left in the access
    // bucket it printed "ACCESS DENIED: could not read git … grant Full Disk Access" directly above the
    // correct GIT UNAVAILABLE line (contradictory advice, one half telling you to fix a MISSING BINARY
    // with a TCC grant), and rendered "git" among the repo names in the grounding verdict.
    if (i.path === "git") out.toolchain.push(i.path);
    else if (i.kind === "tcc-denied") out.access.push(i.path);
    else if (i.kind === "unreadable") (partialRead.has(i.path) ? out.transient : out.access).push(i.path);
    else out.repo.push(i.path);          // not-found / not-a-repo → a config answer
  }
  return out;
}

/** Repos we could not read for ACCESS reasons that will not clear on their own. Separate from both the
 *  transient line (re-running cannot grant a permission) and the config line (the entry is correct;
 *  the process just cannot read it). */
export function accessDeniedLine(repos: string[]): string | null {
  if (!repos.length) return null;
  return `ACCESS DENIED: could not read ${repos.join(", ")} — a permissions problem, not a transient one, so re-running will not clear it. On macOS grant the binary Full Disk Access (System Settings → Privacy & Security); otherwise check filesystem permissions. Until then this audit cannot verify anything in those repos.`;
}

/** Bucket the audit's OWN git-invocation failures. Pure, so the routing is testable.
 *
 * The call sites previously inlined `(kind === "transient" ? a : kind === "repo" ? b : c).push(...)`,
 * and a measured mutation swapping two of those arms left the whole suite green — silently restoring
 * "delete your healthy repo" advice for a timeout. The branching moves here; the call sites now only
 * record `{repo, kind}`. */
export function bucketFailures(
  failures: { repo: string; kind: ReadFailure }[],
): { transient: string[]; repo: string[]; toolchain: string[] } {
  const out = { transient: [] as string[], repo: [] as string[], toolchain: [] as string[] };
  for (const f of failures) out[f.kind === "repo" ? "repo" : f.kind].push(f.repo);
  return out;
}

/** Every degradation line, in report order — the ONLY producer of them.
 *
 * Extracted because three review rounds in a row found defects in this assembly while it lived inline
 * in `scripts/audit.ts`, which cannot be imported (bare `main().catch`) and so was pinned only by
 * source scan. Those scans then proved not load-bearing: deleting a `deterministic.push(...)` left all
 * 664 tests green, silently restoring the round-2 HIGH. Behaviour, not source text, is what needs
 * pinning — so the behaviour lives somewhere it can be called.
 *
 * Any non-empty return suppresses the report's "clean:" fallback; that suppression IS the fix, so a
 * line computed but not returned would be the same defect wearing a helper function. */
/** Assemble the degradation inputs from every source, so the report's INPUTS are as testable as its
 *  output. Pure; `main()` should do nothing but call it and hand the result on.
 *
 *  Extracted after a review measured that this wiring was the last unpinned surface — and then proved
 *  the cost empirically: `truncated: allTruncated` -> `truncated: []` survived the full suite AND was
 *  accidentally committed, restoring the round-2 HIGH (a truncation-only run printing the confident
 *  "clean:" line). Deleting the phase-2 warnings loop survived too. Every earlier round moved a piece
 *  of the report's OUTPUT into pure code; this is the same move for its INPUT. */
export function collectDegradation(i: {
  extractorIssues: { path: string; kind: string }[];
  extractorWarnings: string[];
  day: { transient: string[]; repo: string[]; toolchainDetail: string[] };
  sha: { transient: string[]; repo: string[]; toolchain: string[]; toolchainDetail: string[] };
}): { truncated: string[]; access: string[]; unreadable: string[]; unknown: string[]; toolchainDetail: string[]; shaBlind: string[] } {
  // Buckets carry FULL PATHS end to end; display labels are applied only when a line is rendered.
  // (`bn` below is the identity, kept as a seam rather than deleted inline at each use. It is NOT
  // basename — an earlier revision made it one, which is exactly the bug this comment describes.)
  //
  // Round 9 labelled here instead, and that was still wrong — one directory deeper. `repoLabel`
  // qualifies with exactly ONE parent segment, so it is NOT injective: `/home/u/a/x/api` and
  // `/home/u/b/x/api` both label `x/api`. Because the cross-bucket priority filter then compared
  // LABELS, a truncated repo and a definitively-broken one collapsed again and the truncated-wins rule
  // deleted the permanent failure's diagnosis — byte-for-byte the bug round 9 set out to fix. The
  // repo's own test fixtures already contain such a pair (`/x/A/dupe`, `/y/A/dupe`).
  const bn = (x: string) => x;
  const b = bucketPathIssues(i.extractorIssues, i.extractorWarnings);
  // The extractor emits a PathIssue for an IncompleteReadError but returns `issues: []` with a bare
  // "partial failure reading repo: X" WARNING for any OTHER phase-2 git failure. Without this the
  // repo's working state goes unread, `coverageGaps` is vacuous for it, and "all working-state repos
  // named" can still print. Pinned against the extractor's own source in test/audit.test.ts.
  // NOT `truncated`: this warning is raised by a plain nonzero git exit, which is typically
  // persistent. Asserting truncation and transience about it was wrong on both counts.
  const fromWarnings = i.extractorWarnings
    .map((w) => w.match(/^partial failure reading repo: (.+)$/)?.[1])
    .filter((x): x is string => !!x)
    .map(bn);
  return {
    truncated: [...new Set([...b.transient.map(bn), ...i.day.transient.map(bn), ...i.sha.transient.map(bn)])],
    access: [...new Set(b.access.map(bn))],
    unreadable: [...new Set([...b.repo.map(bn), ...i.day.repo.map(bn), ...i.sha.repo.map(bn)])],
    unknown: [...new Set(fromWarnings)],
    // The probe sentinel carries the extractor's own diagnosis in `warnings`; reuse it rather than
    // inventing a second wording for the same event.
    toolchainDetail: [...new Set([
      ...(b.toolchain.length ? i.extractorWarnings.filter((w) => w.startsWith("git ")) : []),
      ...i.day.toolchainDetail, ...i.sha.toolchainDetail,
    ])],
    // ONLY the cat-file reads gate the grounding verdict — see the shaBlind note at the call site.
    shaBlind: [...new Set([...i.sha.transient, ...i.sha.repo, ...i.sha.toolchain])],
  };
}

export function degradationBuckets(i: { truncated: string[]; access: string[]; unreadable: string[]; unknown?: string[] }): {
  truncated: string[]; access: string[]; unreadable: string[]; unknown: string[];
} {
  const uniq = (xs: string[]) => [...new Set(xs)];
  const truncated = uniq(i.truncated);
  // Filtered against `truncated` AND `access`, not just the first: a TCC-denied repo reaches the
  // extractor as `tcc-denied` AND makes the audit's own `git -C repo …` exit 128, which classifies as
  // a config answer — so the same repo drew BOTH "grant Full Disk Access" and "fix or remove the
  // config entry". Measured, in this deployment's own flagship scenario (repos under ~/Desktop).
  const access = uniq(i.access).filter((r) => !truncated.includes(r));
  const unreadable = uniq(i.unreadable).filter((r) => !truncated.includes(r) && !access.includes(r));
  // Least specific, so it yields to every diagnosis we can actually name.
  const unknown = uniq(i.unknown ?? []).filter((r) => !truncated.includes(r) && !access.includes(r) && !unreadable.includes(r));
  return { truncated, access, unreadable, unknown };
}

export function degradationLines(i: {
  groundTruthErr: unknown;
  groundingLine: string | null;
  /** Applied at RENDER time only. Filtering happens on full paths above, so a non-injective label can
   *  at worst make two lines read alike — it can no longer delete one of them. */
  label?: (p: string) => string;
  truncated: string[];
  access: string[];
  unreadable: string[];
  unknown?: string[];
  toolchainDetail: string[];
}): string[] {
  const lines: string[] = [];
  if (i.groundTruthErr !== null && i.groundTruthErr !== undefined) lines.push(groundTruthUnavailableLine(i.groundTruthErr));
  const { truncated, access, unreadable, unknown } = degradationBuckets(i);
  const lb = i.label ?? ((x: string) => x);
  const t = degradedReadLine(truncated.map(lb)); if (t) lines.push(t);
  const a = accessDeniedLine(access.map(lb)); if (a) lines.push(a);
  const u = unreadableReposLine(unreadable.map(lb)); if (u) lines.push(u);
  const k = unknownFailureLine(unknown.map(lb)); if (k) lines.push(k);
  const g = gitUnavailableLine([...new Set(i.toolchainDetail)].join("; ")); if (g) lines.push(g);
  // The grounding verdict's line belongs to the SAME producer, because its push was the last piece of
  // this block still living inline: deleting `deterministic.push(ground.line)` made the
  // FABRICATED/UNKNOWN line vanish and let the "clean:" fallback print again, with all 672 tests green.
  if (i.groundingLine) lines.push(i.groundingLine);
  return lines;
}

/** The "Suggested EVAL.md row" — the line actually transcribed into the measurements table, and so the
 *  single most consequential string this tool emits.
 *
 *  Pure for two measured reasons. Its emoji had NO pin: replacing `${evalGround}` with a literal ✅
 *  wrote a clean verdict for a degraded or fabricated run with the whole suite green. And it
 *  interpolated the RAW bucket sets while the report body used the filtered ones, so the record could
 *  carry two contradictory diagnoses for one repo ("access-denied: repo; unreadable: repo") even
 *  though the body correctly printed one. Both now come from the same filtered buckets. */
export function evalRow(i: {
  bDate: string;
  emoji: string;
  /** Render-time only, as in degradationLines — the buckets are filtered on full paths first. */
  label?: (p: string) => string;
  flagCount: number;
  groundTruthFailed: boolean;
  truncated: string[];
  access: string[];
  unreadable: string[];
  unknown?: string[];
  toolchainDetail?: string[];
  fabricated: string[];
  shaBlind: boolean;
  missedDay: number;
  posture: string;
  /** ⚠ Did the judge actually RUN? Absent/true = ran. The row used to print `judge posture: full`
   *  for a run where the judge produced NOTHING — `posture` describes the hardening of the ATTEMPTED
   *  call, which is a question adjacent to the one the reader is asking. On 2026-08-08 the judge died
   *  twice with "out of usage credits" and the suggested row still read `judge posture: full`; a
   *  reader scanning rows would have taken that row as judged.
   *
   *  Second defect of this exact family — the first was `flagCount = deterministic.length`, where an
   *  informational line inflated a defect count (days 18 and 20, fixed in #142). Both are reporting
   *  fields answering a question adjacent to the one their name implies. */
  judgeRan?: boolean;
}): string {
  const raw = degradationBuckets(i);
  const lb = i.label ?? ((x: string) => x);
  const b = { truncated: raw.truncated.map(lb), access: raw.access.map(lb), unreadable: raw.unreadable.map(lb), unknown: raw.unknown.map(lb) };
  const notes = [
    `auto-audit: ${i.flagCount} flag(s)`,
    i.groundTruthFailed ? "DEGRADED (ground truth unavailable)" : "",
    b.truncated.length ? `DEGRADED (truncated: ${b.truncated.join(",")})` : "",
    b.access.length ? `access-denied: ${b.access.join(",")}` : "",
    b.unreadable.length ? `unreadable: ${b.unreadable.join(",")}` : "",
    b.unknown.length ? `read-failed: ${b.unknown.join(",")}` : "",
    // The strongest degradation of all had no marker at all: a run that "verified nothing" was
    // indistinguishable in the record from a mild healthy one.
    i.toolchainDetail?.length ? "DEGRADED (git unavailable)" : "",
    // Never claim fabrication while BLIND — the SHAs may live in a repo cat-file could not read. But a
    // ground-truth throw does NOT blind cat-file, and gating on it made the row contradict both the
    // body and its own emoji: `groundingVerdict` returns ❌ FAIL on a proven fabrication, the body
    // printed the SHAs, and the row showed a bare ❌ with the list suppressed next to a DEGRADED
    // marker inviting the transcriber to discount it. The two must agree; only `shaBlind` gates this.
    !i.shaBlind && i.fabricated.length ? `fabricated ${i.fabricated.join(",")}` : "",
    i.missedDay ? `missed ${i.missedDay} same-day` : "",
    // JUDGE FAILURE OUTRANKS POSTURE. If the judge never ran, its hardening posture is not merely
    // uninteresting, it is misleading — so it is replaced, not appended to.
    i.judgeRan === false ? "JUDGE DID NOT RUN (no holistic verdict — Act is unmeasured)" : i.posture,
  ].filter(Boolean);
  return `| … | ${i.bDate} | ${i.emoji} | ? |  |  | ${notes.join("; ")} |`;
}

/** A repo whose read failed for an UNKNOWN reason — the extractor's generic phase-2 warning, raised by
 *  a plain nonzero git exit inside `listCommits`/`resumptionSignals` (a corrupt index, say).
 *
 *  Its own wording because routing it through `degradedReadLine` asserted "truncated read … Transient;
 *  re-run" — wrong on both counts for an event that is typically PERSISTENT, and un-clearable advice of
 *  exactly the kind rounds 4-5 removed everywhere else. We genuinely cannot tell which it is here, so
 *  say that rather than guess: an honest "unknown" beats a confident wrong remedy, in a section headed
 *  "code — reliable". */
export function unknownFailureLine(repos: string[]): string | null {
  if (!repos.length) return null;
  return `READ FAILED (cause unknown): ${repos.join(", ")} — git returned an error while reading these; it may be transient or persistent, so a re-run may or may not clear it. Counts derived from them are a lower bound.`;
}

/** git itself could not be started. Distinct from a repo-level failure because the remedy is neither
 *  "re-run" nor "fix that config entry" — nothing about the repo list is wrong. */
export function gitUnavailableLine(detail: string): string | null {
  if (!detail.trim()) return null;
  return `GIT UNAVAILABLE: could not start git (${detail.trim().slice(0, 160)}) — no repo could be checked. This audit verified nothing.`;
}

/** Repos git could definitively NOT read (a nonzero exit, not a truncated one): a deleted path left in
 *  config, a non-repo directory, a permissions failure.
 *
 *  Kept separate from `degradedReadLine` for the ADVICE only. An earlier revision of this comment
 *  argued the stronger claim — that such a repo need not block the fabrication verdict, "since the
 *  app reads the same repos with the same git, so the briefing could hold no citations from it." That
 *  is FALSE, and end-to-end fault injection caught it: the briefing was generated EARLIER, when the
 *  repo was readable, so its citations are real but now unverifiable. Reporting them as FABRICATED is
 *  the very accusation this machinery exists to prevent. Simultaneity was doing hidden work in that
 *  argument. BOTH kinds therefore block the verdict; only the remedy differs.
 *
 *  What the split does fix is the advice. Routing a stale config entry through `degradedReadLine`
 *  produced permanent "re-run before recording a row" guidance that could never succeed — which
 *  trains the operator to ignore DEGRADED and so masks the real transient case. "Fix or remove the
 *  config entry" is achievable, and a permanent UNKNOWN is then the honest state until it is done. */
export function unreadableReposLine(repos: string[]): string | null {
  if (!repos.length) return null;
  return `REPO UNREADABLE: git could not read ${repos.join(", ")} — a definite failure, not a transient truncation, so re-running will not help. Fix or remove the config entry; until then this audit cannot verify anything that lives in those repos.`;
}

/** Ground-truth gathering threw as a whole (the extractor rethrows genuinely unexpected errors).
 *
 *  Without this the audit's most confident possible output was reachable from its least: every derived
 *  check — same-day misses, uncommitted coverage — goes VACUOUSLY empty, so the report printed
 *  "clean: … no same-day miss, all working-state repos named" with a ✅ row and "0 flag(s)". The only
 *  trace was a stderr line that never reaches the saved `audit-<date>.md`, so on a scheduled run it was
 *  invisible. A degraded audit outscoring a healthy one is the exact defect this file keeps closing. */
export function groundTruthUnavailableLine(err: unknown): string {
  return `GROUND TRUTH UNAVAILABLE: the same-day and uncommitted-coverage checks did NOT run (${String(err).slice(0, 200)}) — this audit is INCOMPLETE and its "no same-day miss" silence means nothing. Do not record a row from it.`;
}

/** The SHA-grounding verdict, which must never be confident about repos it could not read (F2 review).
 *
 * The unsound step this exists to prevent: `unresolvedFromBatch` reports every cited SHA that resolved
 * in none of the repos it was GIVEN. If a repo was skipped because its read failed, a SHA living only
 * there comes back "unresolved" — and the audit printed it as `FABRICATED SHA(s)` with a ❌ EVAL row.
 * Reproduced with a held pipe on one repo: nine real commits accused of being hallucinated.
 *
 * The converse is equally wrong and easier to miss: finding NO unresolved SHAs across the readable
 * repos says nothing about the unreadable one, so a degraded run must not report PASS/✅ either.
 * Degradation collapses both directions to UNKNOWN — the SHAs are still surfaced, as unverified.
 */
export function groundingVerdict(i: {
  citedCount: number;
  unresolved: string[];
  verified: boolean;
  degradedRepos: string[];
}): { line: string | null; ground: "PASS" | "FAIL" | "UNKNOWN" | "n/a"; emoji: "✅" | "❌" | "?" } {
  if (!i.citedCount) return { line: null, ground: "n/a", emoji: "?" };
  if (i.degradedRepos.length) {
    const which = i.unresolved.length
      ? ` ${i.unresolved.length} cited SHA(s) resolved in no READABLE repo (${i.unresolved.join(", ")}) — NOT fabrication: they may live in the unread repo.`
      : "";
    return {
      line: `SHA grounding UNKNOWN — could not read ${i.degradedRepos.join(", ")}, so no fabrication verdict is possible.${which}`,
      ground: "UNKNOWN",
      emoji: "?",
    };
  }
  if (!i.verified) {
    return { line: `Could not verify cited SHAs (no readable repo) — grounding UNKNOWN.`, ground: "UNKNOWN", emoji: "?" };
  }
  if (i.unresolved.length) {
    return {
      line: `FABRICATED SHA(s) cited but resolving to no commit in any repo: ${i.unresolved.join(", ")}`,
      ground: "FAIL",
      emoji: "❌",
    };
  }
  return { line: null, ground: "PASS", emoji: "✅" };
}


// ── Slice 1.5 T8.1a — the audit obtains the source turn by CONTENT SEARCH, not anchor lookup.
//
// ⚠ "Re-read the anchor by composite" is CIRCULAR and was the plan's own corrected mistake: the
// composite IS `TranscriptAnchor`, which lives only inside `TranscriptEvidence`, which the audit
// does not have — it starts from a SAVED BRIEFING, possibly days old, in a separate process.
//
// The buildable route: parse the quotation out of the saved briefing with the frame's own parser,
// then search the transcript corpus for a turn BYTE-EQUAL to it. That is sound precisely because
// invariant 5 guarantees the rendered quotation is byte-equal to its source turn — the search is
// exact, never fuzzy. Starting from the delivered briefing also satisfies §6's "grade what was
// DELIVERED".
//
// ⚠ If no match (the transcript was pruned or rotated), the ground truth is OMITTED, never
// substituted. A near-miss presented as the source turn would be a fabricated citation in the very
// instrument that exists to detect fabrication.
export type TurnSearch = (needle: string) => Promise<{ found: true; sessionId: string; tsUtc: string } | { found: false }>;

/** Recover every quotation the delivered briefing actually rendered. */
export function quotationsIn(briefing: string, parse: (line: string) => string | null): string[] {
  const out: string[] = [];
  for (const line of briefing.split("\n")) {
    const q = parse(line);
    if (q !== null) out.push(q);
  }
  return out;
}

/** Ground truth for the judge: each rendered quotation paired with the corpus turn whose bytes equal
 *  it. Unmatched quotations are OMITTED from the result — the caller must not substitute. */
export async function groundTruthForQuotations(
  quotations: string[], search: TurnSearch,
): Promise<{ quotation: string; sessionId: string; tsUtc: string }[]> {
  const out: { quotation: string; sessionId: string; tsUtc: string }[] = [];
  for (const q of quotations) {
    const hit = await search(q);
    if (hit.found) out.push({ quotation: q, sessionId: hit.sessionId, tsUtc: hit.tsUtc });
    // else: omitted. Never substituted, never approximated.
  }
  return out;
}

// ── Slice 1.5 T8.2 — sink 6: the audit prompt is itself persisted as a new CC transcript.
//
// `CLAUDE_CODE_SKIP_PROMPT_HISTORY` is applied only when the provider is claude-shaped AND hardening
// is on; it is enumerated in SURRENDERED, i.e. given up when hardening is off. On that rung CC
// persists the prompt — and the audit prompt is the ONE place that carries the RAW anchored turn.
//
// ⚠ The predicate is evaluated BEFORE the prompt string is built, because only the two STATIC
// reasons are decidable in time. Stated residual, NOT handled: the ladder's runtime latch fires only
// after a call has already failed, by which point the raw turn has been sent.
/** One line stating which optional features the DEPLOYED CONFIG actually enables — twice (day 29:
 *  the recap split; day 32: the whole transcript layer) an EVAL watch was opened on a feature that
 *  was switched off in the live config, and nothing anywhere printed the fact. This line makes that
 *  failure impossible to repeat silently: it renders in the same report the watch-opener is reading.
 *  Pure and exported (the F2 pattern) so the omission of a feature from this line is a test failure,
 *  not a silent gap — when a new optional feature ships, ADD IT HERE or the pin in
 *  test/day33-batch.test.ts stays red. */
export function featuresLine(cfg: {
  transcripts?: { enabled?: boolean; root?: string };
  subprojects?: { repo: string; roots: string[] }[];
  provider: { harden?: boolean; timeoutMs?: number };
}, resolvedTranscripts: { enabled: boolean; root: string }): string {
  const tx = resolvedTranscripts.enabled ? `on (root=${resolvedTranscripts.root})` : "OFF";
  const sub = cfg.subprojects?.length
    ? cfg.subprojects.map((s) => `${s.roots.length} root(s)`).join(", ")
    : "OFF (single-unit repos)";
  const harden = cfg.provider.harden === false ? "OFF" : "on";
  const timeout = `${(cfg.provider.timeoutMs ?? 120000) / 1000}s`;
  return `features (deployed config): transcripts=${tx} · subprojects=${sub} · harden=${harden} · provider timeout=${timeout}`;
}

export function auditMayCarryRawTurn(provider: { cli: string; harden?: boolean }, claudeShapedFn: (cli: string) => boolean): boolean {
  return provider.harden !== false && claudeShapedFn(provider.cli);
}

/** The DOWNGRADE RECORD. §3.8 governs every self-disable, including this one — routing it to
 *  telemetry alone is precisely the silent degradation that tier forbids. So it returns BOTH a
 *  warning and the drop code, and the caller must emit both. Rev 4 tasked only the predicate, which
 *  left `hardening-off` with no writer at all. */
export const HARDENING_OFF_NOTICE =
  "transcript ground truth omitted from this audit: provider hardening is off or the CLI is not Claude-shaped, so the prompt would be persisted as a new transcript.";
