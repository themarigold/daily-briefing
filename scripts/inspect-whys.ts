// Slice 1.5 M6 — the A3 inspection tool: a RETROSPECTIVE REPLAY of the why-join over history.
//
//   run: bun run scripts/inspect-whys.ts [--days=N] [--limit=N]
//
// It answers R3's VALUE question — "does a quoted turn add information the commit subjects lack?" —
// without waiting for telemetry to accumulate, by replaying the join over transcripts that already
// exist. It is `scripts/`-only and STDOUT-ONLY: it writes nothing, anywhere, ever.
//
// ⚠ Writing nothing is a CONTRACT, not an aspiration (§3.4 sink 7): this tool's stdout is the only
// persistence surface that exists in 1.5a, so it must not create a second one. T6.1's receipt
// snapshots cwd, TMPDIR and supportDir() around a real CLI invocation rather than spying in-process
// — a spy records zero calls whatever the child does, and a `Bun.write`/`fs` blacklist misses
// `Bun.file().writer()`, `Bun.$` and grandchildren.
import { loadConfig, resolveRepos, resolveTranscripts, compileExcludePatterns, DEFAULT_EXCLUDE_COMMIT_PATTERNS } from "../src/config";
import { listCommits } from "../src/git";
import { TRANSCRIPT_READ_MARGIN_MS } from "../src/core";
import { resolveAuthor } from "../src/git";
import { resolveUnits, unitKey as composeUnitKey, unitForCommit, rootsForRepo } from "../src/subprojects";
import { discoverDepth1, discoverSubagents, isSelfPrompt } from "../src/transcripts/discover";
import { readJsonl, emptyTally } from "../src/transcripts/reader";
import { transformLines } from "../src/transcripts/transform";
import type { Line } from "../src/transcripts/discriminate";
import { selectTurn } from "../src/transcripts/select";
import { buildSegments, makeBucketer } from "../src/transcripts/segments";
import { joinEvidence, whySourcesAdopted } from "../src/transcripts/join";
import { textSha } from "../src/transcripts/anchor";
import { isQuestionShaped } from "../src/transcripts/health";
import type { Activity, Config } from "../src/types";

export type InspectOptions = { days: number; limit: number; root: string; onAmbiguity: "drop" | "keep-earliest" };

export function parseInspectOptions(argv: string[], root: string): InspectOptions {
  const num = (flag: string, dflt: number) => {
    const a = argv.find((x) => x.startsWith(`--${flag}=`));
    const n = a ? Number(a.slice(flag.length + 3)) : NaN;
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  const oa = argv.includes("--on-ambiguity=keep-earliest") ? "keep-earliest" as const : "drop" as const;
  return { days: num("days", 49), limit: num("limit", 0), root, onAmbiguity: oa };
}

export type Candidate = {
  unitKey: string;
  label: string;
  localDay: string;
  quotation: string;
  textSha: string;
  sessionId: string;
  segmentPaths: string[];
  commitSubjects: string[];
  fileCount: number;
  questionShaped: boolean;
};

/** T6.2 — the replay harness. Commit→unit via `unitForCommit`; path→unit via the SHARED bucketer;
 *  roots from `resolveProjectRoots` (through `makeBucketer`'s fallback). Using the same two functions
 *  the live path uses is the whole point: a harness with its own bucketing would answer R3 about a
 *  pipeline that does not exist. */
// ⚠ RE-EXPORTED, NOT REDECLARED. This was a second `24 * 3_600_000` beside core.ts's
// TRANSCRIPT_READ_MARGIN_MS. The constant decides transcript-window MEMBERSHIP, and this script's
// whole purpose is to replay "the same functions the live path uses" — so a silent drift here would
// make the replay answer about a pipeline that does not exist, which is the one failure mode a
// diagnostic must not have. Extract-at-two applies: it is decision-feeding, not incidental.
export const READ_WINDOW_MARGIN_MS = TRANSCRIPT_READ_MARGIN_MS;

/** T6.2 — the replay harness. Commit→unit via `unitForCommit`; path→unit via the SHARED bucketer;
 *  roots from `resolveProjectRoots` (through `makeBucketer`'s fallback). Using the same functions the
 *  live path uses is the whole point: a harness with its own bucketing would answer R3 about a
 *  pipeline that does not exist.
 *
 *  ⚠ IT REPLAYS DAY BY DAY, and that is load-bearing rather than cosmetic. The live run's window is
 *  roughly ONE DAY, so a unit is claimed by a handful of sessions and drop-on-ambiguity rarely fires.
 *  Replaying the 49-day span as a SINGLE window instead gives each unit 4-49 distinct claiming
 *  sessions, so every unit drops as `ambiguous` — measured: 9 eligible units, 9 ambiguous drops,
 *  ZERO candidates. That is a faithful result for a 49-day window and a completely wrong answer to
 *  R3's question, and it would have been handed to the gate as "the feature produces nothing". The
 *  transcript corpus is read ONCE and sliced per day in memory; re-reading per day would be 49x the
 *  I/O for identical data. */

/** Pure set-diff for A9 overlap reporting. Exported for unit tests. */
export function summarizeOverlap(cons: Set<string>, strict: Set<string>): {
  both: number; curve1Only: number; curve2Only: number; curve1: number; curve2: number;
} {
  let both = 0, curve1Only = 0, curve2Only = 0;
  for (const k of cons) (strict.has(k) ? both++ : curve1Only++);
  for (const k of strict) if (!cons.has(k)) curve2Only++;
  return { both, curve1Only, curve2Only, curve1: cons.size, curve2: strict.size };
}

export async function replay(cfg: Config, repos: string[], opts: InspectOptions): Promise<{
  candidates: Candidate[]; unitsEligible: number; days: number; daysReplayed: number;
}> {
  const end = new Date();
  const start = new Date(end.getTime() - opts.days * 864e5);
  const { regexes: excludeRe } = compileExcludePatterns(cfg.excludeCommitPatterns ?? DEFAULT_EXCLUDE_COMMIT_PATTERNS);

  // ── Git side: every commit in the span, once.
  const allActivities: Activity[] = [];
  for (const r of repos) {
    const author = await resolveAuthor(r, cfg.author).catch(() => cfg.author ?? {});
    allActivities.push(...await listCommits(r, start, end, author, excludeRe).catch(() => []));
  }

  // ── Transcript side: read the corpus ONCE, keep everything with a timestamp.
  const files = [
    ...(await discoverDepth1(opts.root, start.getTime())).map((path) => ({ path, tier: "depth1" as const })),
    ...(await discoverSubagents(opts.root, start.getTime())).map((path) => ({ path, tier: "subagent" as const })),
  ];
  const allPaths: { sessionId: string; tsUtc: string; path: string }[] = [];
  const allTurns: { sessionId: string; uuid: string; tsUtc: string; text: string; order: number }[] = [];
  let order = 0;
  const tally = emptyTally();
  for (const f of files) {
    const lines: Line[] = [];
    for await (const o of readJsonl(f.path, tally)) lines.push(o);
    const out = transformLines(lines, f.path, f.tier);
    allPaths.push(...out.paths);
    for (const t of out.turns) {
      if (isSelfPrompt(t.text)) continue;                  // never ingest our own prompts
      if (!selectTurn(t.text).ok) continue;                // the six-stage pipeline
      allTurns.push({ ...t, order: order++ });
    }
  }

  // ── Replay each day as that morning's run would have seen it.
  const rows: Candidate[] = [];
  const DROPS: Record<string,number> = {};
  let STRICT = 0;
  // ── A9 overlap. The two curves are NOT nested — conservative picks on a single claiming session,
  // strict-majority on >0.5 file coverage — so a unit can be won by either alone. Counts therefore
  // cannot tell you what strict-majority BUYS; only the set difference can. Keyed by day+unit because
  // the same unit recurs across days and must count once per unit-DAY, matching `unitsEligible`.
  const CONS = new Set<string>(), STRICTK = new Set<string>();
  // ⚠ A9 UNION VIABILITY. Set membership answers "how many does each curve win", but NOT the question
  // a union rests on: where BOTH curves fire, do they pick the SAME session? If they ever diverge,
  // "either rule resolves it" is not free coverage — it is a silent coin-flip between two sessions,
  // and the losing side means the briefing quotes the user's words from a session they were not in.
  const CONS_SESS = new Map<string, string>(), STRICT_SESS = new Map<string, string>();
  const LABELS = new Map<string, string>();
  let unitsEligible = 0, daysReplayed = 0;
  for (let d = 0; d < opts.days; d++) {
    const dayEnd = new Date(end.getTime() - d * 864e5);
    const dayStart = new Date(dayEnd.getTime() - 864e5);
    const acts = allActivities.filter((a) => inWindow(a.timestamp ?? "", dayStart, dayEnd));
    if (acts.length === 0) continue;                       // a quiet day briefs nothing
    daysReplayed++;

    const { units, rootsByRepo } = await resolveUnits(acts, [], repos, cfg);
    const bucket = await makeBucketer(repos, rootsByRepo, cfg, cfg.excludeRepos);
    const readStart = new Date(dayStart.getTime() - READ_WINDOW_MARGIN_MS);   // §3.1's margin
    const { segments, firstEdit } = buildSegments(allPaths.filter((p) => inWindow(p.tsUtc, readStart, dayEnd)), bucket);
    const candidates = allTurns.filter((t) => inWindow(t.tsUtc, readStart, dayEnd));

    const joined = joinEvidence({ segments, firstEdit, candidates, units, activities: acts, bucket, onAmbiguity: opts.onAmbiguity });
    STRICT += joined.sourcesStrictMajority.size;
    const dayKey = dayEnd.toISOString().slice(0, 10);
    const label = (k: string) => units.find((u) => composeUnitKey(u.repo, u.root) === k)?.label ?? k;
    for (const [k, src] of joined.sources) {
      CONS.add(`${dayKey}\x00${k}`); LABELS.set(`${dayKey}\x00${k}`, label(k));
      CONS_SESS.set(`${dayKey}\x00${k}`, src.anchor.sessionId);
    }
    for (const [k, src] of joined.sourcesStrictMajority) {
      STRICTK.add(`${dayKey}\x00${k}`); LABELS.set(`${dayKey}\x00${k}`, label(k));
      STRICT_SESS.set(`${dayKey}\x00${k}`, src.anchor.sessionId);
    }
    unitsEligible += joined.unitsEligible;
    for (const [k,v] of Object.entries(joined.drops)) DROPS[k]=(DROPS[k]??0)+(v??0);

    // ⚠ ADOPTED CURVE rows (union, conservative-wins), not conservative alone. A9 is decided;
    // listing only `joined.sources` omitted every strict-majority-only why the live briefing
    // would render — the same class of blind spot #181/#182 fixed on the delivery path.
    // Overlap accounting above (CONS vs STRICTK) still compares the two curves separately.
    for (const [key, src] of whySourcesAdopted(joined)) {
      const unit = units.find((u) => composeUnitKey(u.repo, u.root) === key);
      const seg = segments.find((s) => s.unitKey === key && s.sessionId === src.anchor.sessionId);
      const subjects: string[] = [];
      let fileCount = 0;
      for (const a of acts) {
        if (a.kind !== "commit" || a.meta?.excluded || !a.repo) continue;
        const root = unitForCommit(a, rootsByRepo.get(a.repo) ?? rootsForRepo(units, a.repo));
        if (composeUnitKey(a.repo, root) !== key) continue;
        subjects.push(a.text ?? "");
        fileCount += a.meta?.diffstat?.length ?? 0;
      }
      rows.push({
        unitKey: key, label: unit?.label ?? key, localDay: seg?.localDay ?? dayEnd.toISOString().slice(0, 10),
        quotation: src.text, textSha: src.anchor.textSha, sessionId: src.anchor.sessionId,
        segmentPaths: seg?.paths.slice(0, 6) ?? [], commitSubjects: subjects, fileCount,
        questionShaped: isQuestionShaped(src.text),
      });
    }
  }
  rows.sort((a, b) => (a.localDay + a.label).localeCompare(b.localDay + b.label));
  if (process.env.A3_DROPS) {
    // Self-check vs full `rows` (not limit-truncated `candidates:`). Keying collapse or a
    // STRICT/STRICTK drift prints KEYING_DRIFT; under normal 24h UTC steps both equalities hold.
    const o = summarizeOverlap(CONS, STRICTK);
    // rows = |union| (= both + curve1Only + curve2Only), not curve1 alone — see whySourcesAdopted.
    const unionRows = o.both + o.curve1Only + o.curve2Only;
    if (unionRows !== rows.length || STRICT !== o.curve2) {
      console.error("KEYING_DRIFT:", JSON.stringify({
        union_set: unionRows, rows: rows.length, strictSum: STRICT, strictSet: o.curve2,
        curve1_set: o.curve1,
      }));
    }
    // Labels are set-membership only. Accept filters (credential / outcome-verb / isTaskShaped) are
    // now shared across curves; curve2-only is still not pure "coverage rule adds" because majority
    // vs sole-claimant paths differ — see join.ts.
    const show = (ks: string[]) => ks.sort().map((k) => `${k.split("\x00")[0]} ${LABELS.get(k) ?? "?"}`);
    const consOnly = [...CONS].filter((k) => !STRICTK.has(k));
    const strictOnly = [...STRICTK].filter((k) => !CONS.has(k));
    // ⚠ THE UNION-VIABILITY MEASUREMENT. On every unit-day BOTH curves win, compare the SESSION each
    // one chose. Agreement on all of them is what makes "either rule resolves it" free coverage
    // rather than an arbitrary pick between two sessions.
    const bothKeys = [...CONS].filter((k) => STRICTK.has(k));
    const disagreed = bothKeys.filter((k) => CONS_SESS.get(k) !== STRICT_SESS.get(k));
    console.error("sessionAgreement:", JSON.stringify({
      bothFire: bothKeys.length,
      agree: bothKeys.length - disagreed.length,
      disagree: disagreed.length,
      unionSize: new Set([...CONS, ...STRICTK]).size,
    }));
    if (disagreed.length) {
      console.error("  ⚠ DISAGREEING unit-days (conservative session vs strict session):");
      for (const k of disagreed.sort()) {
        console.error(`    ${k.split("\x00")[0]} ${LABELS.get(k) ?? "?"}: ${CONS_SESS.get(k)} vs ${STRICT_SESS.get(k)}`);
      }
    }
    console.error("drops:", JSON.stringify(DROPS), "strictMajority:", o.curve2);
    console.error("overlap:", JSON.stringify({
      curve1_conservative_or_keepEarliest: o.curve1, curve2_strictMajority: o.curve2,
      both: o.both, curve1Only: o.curve1Only, curve2Only: o.curve2Only, rows: rows.length,
    }));
    console.error("  curve2-only (in strict map, not conservative):", JSON.stringify(show(strictOnly)));
    console.error("  curve1-only (in conservative, not strict):   ", JSON.stringify(show(consOnly)));
  }
  return { candidates: opts.limit ? rows.slice(0, opts.limit) : rows, unitsEligible, days: opts.days, daysReplayed };
}

const inWindow = (iso: string, start: Date, end: Date) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= start.getTime() && t <= end.getTime();
};

/** T6.3 — the output format. Quotation, producing segment, AND the unit-day's commit subjects plus
 *  file counts, because R3's question is comparative: the human is judging whether the quotation adds
 *  information the SUBJECTS lack, and cannot do that without both side by side.
 *
 *  ⚠ Invariant 5 on path 2: every printed quotation is byte-equal to its anchored turn. Asserted here
 *  rather than only in a test, so a replay that would print a mutated quotation fails loudly instead
 *  of feeding a corrupted sample into the gate. */
export function formatReport(r: { candidates: Candidate[]; unitsEligible: number; days: number; daysReplayed?: number }): string {
  const L: string[] = [];
  L.push(`A3 retrospective replay — ${r.days} days`);
  L.push(`days with git activity replayed: ${r.daysReplayed ?? "-"}   eligible unit-days: ${r.unitsEligible}   candidates: ${r.candidates.length}`);
  L.push("");
  r.candidates.forEach((c, i) => {
    if (textSha(c.quotation) !== c.textSha) {
      throw new Error(`invariant 5 violated at path 2: candidate ${i} quotation is not byte-equal to its anchor`);
    }
    L.push(`── [${i + 1}] ${c.label}  ${c.localDay}${c.questionShaped ? "  (question-shaped)" : ""}`);
    L.push(`   you wrote: ${JSON.stringify(c.quotation)}`);
    L.push(`   commit subjects (${c.commitSubjects.length}, ${c.fileCount} files):`);
    for (const s of c.commitSubjects.slice(0, 8)) L.push(`     · ${s}`);
    if (c.commitSubjects.length > 8) L.push(`     …+${c.commitSubjects.length - 8} more`);
    L.push(`   segment: session ${c.sessionId.slice(0, 8)} · ${c.segmentPaths.join(", ") || "(no paths)"}`);
    L.push("");
  });
  return L.join("\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cfg = await loadConfig();
  const repos = await resolveRepos(cfg);
  const t = resolveTranscripts(cfg.transcripts, process.env.HOME ?? "");
  const opts = parseInspectOptions(argv, t.root);
  if (t.warning) console.error(t.warning);
  const result = await replay(cfg, repos, opts);
  // STDOUT ONLY. No file is written by this tool, by design (§3.4 sink 7).
  console.log(formatReport(result));
}

if (import.meta.main) main().catch((e) => { console.error(`inspect-whys failed: ${e}`); process.exit(1); });
