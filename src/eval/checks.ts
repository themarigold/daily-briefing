// src/eval/checks.ts — Pure checks for the eval harness.
//
// DELIBERATELY SEPARATE from src/audit.ts — do NOT "DRY up" the two into a shared primitive. This is
// the STRICT, struct-based GATE: it reads the PARSED briefing `struct`, resolves cited SHAs by UNIQUE
// 7-char prefix against a rev-list set (ambiguous → fail), and requires every in-window commit to be
// cited exactly once — because a deterministic pass/fail release gate needs precision on synthetic
// fixtures. src/audit.ts is the LENIENT, text-based MONITOR of the REAL daily briefing (mines rendered
// text, resolves via `git cat-file`, 4-char floor, "appears anywhere" coverage), tuned to avoid false
// alarms on live, day-to-day-drifting data. The two share vocabulary, not semantics — forcing a shared
// resolver/coverage primitive would make this gate looser or that monitor noisier: a regression either way.
import { section, norm } from "../generator";
import { isShaShaped } from "../sha";
import type { CheckInput, Finding, Check } from "./types";
import { unitKey } from "../subprojects";
import { textSha, matchesAnchor, resolveAnchor } from "../transcripts/anchor";
import { hasOutcomeVerb } from "../transcripts/outcomeVerb";
import { parseWhy } from "../transcripts/frame";
import { checkSuggestionRestatement, checkResumeFreshness } from "../postcheck";
import { whySourceFor } from "../transcripts/join";

/**
 * G3 Structure check: validates the raw briefing output has required headers and non-empty sections.
 * - When !emptyWindow: rawText must contain all three ## RESUME / ## RECAP / ## SUGGESTIONS headers
 * - RECAP must be non-empty when ctx has commit activities
 * - SUGGESTIONS must be non-empty when ctx is non-empty
 */
export const g3Structure: Check = (i: CheckInput): Finding[] => {
  const findings: Finding[] = [];

  // When emptyWindow is true, skip header requirements but still check content rules
  if (!i.emptyWindow) {
    // Check for presence of all three headers
    if (!i.rawText.includes("## RESUME")) {
      findings.push({
        case: i.caseName,
        check: "G3",
        rule: "structure",
        severity: "fail",
        detail: "Missing ## RESUME header in rawText",
      });
    }
    if (!i.rawText.includes("## RECAP")) {
      findings.push({
        case: i.caseName,
        check: "G3",
        rule: "structure",
        severity: "fail",
        detail: "Missing ## RECAP header in rawText",
      });
    }
    if (!i.rawText.includes("## SUGGESTIONS")) {
      findings.push({
        case: i.caseName,
        check: "G3",
        rule: "structure",
        severity: "fail",
        detail: "Missing ## SUGGESTIONS header in rawText",
      });
    }
  }

  // Check RECAP non-empty when ctx has commit activities
  const hasCommitActivity = i.ctx.repos.some((repo) =>
    repo.activities.some((activity) => activity.kind === "commit")
  );
  if (hasCommitActivity) {
    const recapLines = section(i.rawText, "RECAP");
    // Guard against a `section()` parser quirk (generator.ts): when a section is
    // fully empty and abuts the next `## ` header on the very next line, the lazy
    // capture's lookahead can't fire and it swallows the following section's
    // content instead of returning []. Treat that mis-bounded slice as empty too.
    const recapIsEmpty = recapLines.length === 0 || recapLines[0]!.startsWith("##");
    if (recapIsEmpty) {
      findings.push({
        case: i.caseName,
        check: "G3",
        rule: "structure",
        severity: "fail",
        detail: "RECAP section must be non-empty when ctx has commit activities",
      });
    }
  }

  // Check SUGGESTIONS non-empty when ctx is non-empty
  const ctxIsNonEmpty = i.ctx.repos.length > 0;
  if (ctxIsNonEmpty) {
    const suggestionsLines = section(i.rawText, "SUGGESTIONS");
    // Same section()-swallow guard as RECAP above: an empty SUGGESTIONS abutting a following
    // `## ` header (reordered sections / trailing chatter) mis-bounds into the next section — treat
    // that mis-bounded slice as empty too.
    const suggestionsIsEmpty = suggestionsLines.length === 0 || suggestionsLines[0]!.startsWith("##");
    if (suggestionsIsEmpty) {
      findings.push({
        case: i.caseName,
        check: "G3",
        rule: "structure",
        severity: "fail",
        detail: "SUGGESTIONS section must be non-empty when ctx is non-empty",
      });
    }
  }

  return findings;
};

/**
 * Resolve a hex `token` to a full commit SHA iff it is a strict 7-40-char UNIQUE
 * prefix of exactly one SHA in `gitShaSet`. Returns the full SHA, or null when the
 * token is out of range, non-hex, matches nothing, or is an ambiguous prefix.
 *
 * Top-level export: G2 (fabrication + file-claims) and G3/5c all resolve cited
 * short-prefixes against the FULL-SHA-keyed git set through this single helper.
 */
export function resolvePrefix(token: string, gitShaSet: Set<string>): string | null {
  if (token.length < 7 || token.length > 40) return null;
  if (!/^[0-9a-f]+$/.test(token)) return null;
  let match: string | null = null;
  for (const sha of gitShaSet) {
    if (sha.startsWith(token)) {
      if (match !== null) return null; // ambiguous — not a unique prefix
      match = sha;
    }
  }
  return match;
}

// --- G2 fabrication internals -------------------------------------------------

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1]!;
}

/** Candidate SHA-like tokens in an evidence field: a maximal 7-40 hex run that passes the SHARED
 *  shape test in `src/sha.ts`.
 *
 *  ⚠ THIS USED TO BE A THIRD, DIVERGENT COPY of the SHA shape test, and it produced FALSE
 *  `fail`-severity verdicts. `sha.ts` exists so the generator's grounding guard and the audit's
 *  citation miner "can NEVER disagree"; this miner never imported it, and admitted ANY 7-40 hex run
 *  with no `[a-f]` requirement at all. So an all-digit token in an evidence field — a date like
 *  `20260716`, a timestamp, a PR number — became a G2 fabrication FAIL on a HARD rule, while the
 *  generator and the audit both correctly ignored it. `proseCandidates` below already guarded
 *  against exactly this, so the two miners in THIS FILE disagreed with each other too.
 *
 *  ⚠ THE 7-CHAR FLOOR IS DELIBERATE and is NOT converged with `sha.ts`'s 4. Measured against
 *  realistic evidence-field contents, lowering it to 4 and filtering by the same predicate trades
 *  one false-FAIL class for three:
 *      migrations/0a1b_init.sql  -> "0a1b"    src/db/ade4f.sql -> "ade4f"    "e2e4 harness" -> "e2e4"
 *  each of which becomes a `fail` unless it happens to resolve. The residual cost is a real one and
 *  is stated rather than hidden: the short-garble class (`2ee0ae5` mistyped as `2ee140`) stays
 *  invisible to THIS miner. It is still caught by the other two layers, and this file's job is to
 *  avoid asserting something false — a missed garble is a gap, a fabricated-SHA verdict on a date is
 *  a wrong answer, and this project has already been burned once by the latter (F2 printed nine
 *  genuine commits as `FABRICATED SHA(s)`). */
function evidenceCandidates(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[0-9a-f]{7,40}/g)) out.push(m[0]!);
  return out;
}

/** Of those candidates, the ones a FABRICATION verdict may be based on.
 *
 *  ⚠ THE SPLIT BETWEEN THIS AND `evidenceCandidates` IS THE WHOLE POINT, and getting it wrong is
 *  caught by a gold case. Extraction and fabrication are different questions:
 *    - EXTRACTION ("which token is this bullet's evidence SHA?") must find a real SHA whatever it
 *      looks like. G1 requires exactly one, so filtering here breaks legitimate briefings.
 *    - FABRICATION ("is this token a SHA that resolves to nothing?") must not accuse a token that
 *      was never a SHA claim in the first place.
 *  Measured, by trying it the wrong way first: applying `isShaShaped` to EXTRACTION turned the
 *  `monorepo-detect` gold case red, because commit `4760499` has an all-digit 7-char abbreviation
 *  and `sha.ts` deliberately treats pure-digit tokens as non-SHAs (its documented, accepted
 *  false-negative — harmless when deciding whether to grounding-CHECK a token, wrong when deciding
 *  whether a token EXISTS). G1 then reported "cites 0 evidence SHAs" and the commit as uncited.
 *
 *  Applying it HERE is safe in both directions: a real all-digit SHA is already exempt one line
 *  below because it RESOLVES, and a date/timestamp/PR-number does not resolve and is exactly what
 *  used to become a false `fail`. */
function fabricationCandidates(tokens: Iterable<string>): string[] {
  return [...tokens].filter(isShaShaped);
}

/**
 * Candidate SHA-like tokens in recap prose. A hex run is a candidate only if it has
 * ≥1 `[a-f]` — an all-digit run of ANY length is skipped (issue #, date, timestamp,
 * count — never a SHA ref; a real SHA prefix that happened to be all-digit would still
 * resolve and pass through the resolve check anyway, so this can't hide a genuine ref).
 * `#`-prefixed and date-shaped whitespace tokens are skipped wholesale.
 */
function proseCandidates(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    if (raw.startsWith("#")) continue; // issue-number reference, not a SHA
    if (/^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(raw)) continue; // date-shaped
    // Pure EXTRACTION, symmetric with `evidenceCandidates`. The all-digit guard that used to live
    // here inline — a hand-rolled `if (!/[a-f]/.test(tok)) continue`, i.e. the same rule `sha.ts`
    // owns, written a fourth time — has moved to `fabricationCandidates`, which is the only consumer
    // of this function and the only place the question is actually asked.
    for (const m of raw.matchAll(/[0-9a-f]{7,40}/g)) out.push(m[0]!);
  }
  return out;
}

/**
 * Candidate file-claim tokens: a name ending in `.` + a LETTER + up to 5 more
 * alnum chars (letter-initial extension only). This is a shape gate, decoupled from
 * `/` and from inventory membership — bare filenames (`foo.ts`) are valid candidates
 * just like slashed paths (`src/auth/x.ts`); whether a candidate produces a finding
 * (and at what confidence) is decided downstream in `g2Fabrication` against the
 * commit's diffstat, `fileInventory`, and whether the token contains `/`.
 *
 * The letter-initial requirement excludes version tokens (`v2`), ratios (`3/4`),
 * dates (`2026/07/17`), and numeric "extensions" (`docs/v2.1`, `release/v1.0` — the
 * `.1`/`.0` isn't a letter-initial extension).
 */
function candidateFileTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[\w.\-/]*[\w.\-]\.[a-z][a-z0-9]{0,5}\b/gi)) {
    out.push(m[0]);
  }
  return out;
}

/** Basename/suffix match between a diffstat file and a claimed path token. */
function pathMatches(diffFile: string, token: string): boolean {
  if (diffFile === token) return true;
  if (basename(diffFile) === basename(token)) return true;
  if (diffFile.endsWith("/" + token) || token.endsWith("/" + diffFile)) return true;
  return false;
}

/**
 * G2 Fabrication check: independently detects fabricated evidence in the briefing
 * `struct` — it does NOT trust the product's own sanitizer. Cited SHA-like tokens
 * are resolved against the git-derived SHA set; file claims are checked against the
 * cited commit's own diffstat.
 *
 * - fail: a candidate token that does not resolve AND is not exempt. Exempt = the
 *   CITING bullet's OWN commit message contains the token (its evidence SHA resolves,
 *   and `commitMessages.get(fullSha)` substring-contains the token). A token relocated
 *   into a DIFFERENT bullet's prose is still caught — the message check is per-bullet.
 * - warn (file-claims, Option C — uniformly WARN-tier): a candidate file token (see
 *   `candidateFileTokens`'s letter-initial-extension gate — NOT gated on `/`) claimed in a
 *   bullet, checked against the cited commit's own diffstat AND the global `fileInventory`:
 *     - real file (in `fileInventory`) but not in the cited commit's diffstat -> warn,
 *       regardless of whether the token contains `/` (inventory membership alone confirms
 *       it's a real file — this covers bare filenames like `foo.ts` too).
 *     - in NEITHER the diffstat NOR `fileInventory` (wholly fabricated / hallucinated path) ->
 *       ALSO warn, but ONLY when the token contains `/` (path-shaped -> higher confidence it's
 *       a deliberate file reference; a bare nonexistent token is too ambiguous and is ignored).
 *       SHA fabrication above remains the only hard-fail fabrication tier; no file-claim ever fails.
 * - warn: `struct.warnings` contains a "didn't resolve" entry (the product itself
 *   caught + stripped a garble).
 */
export const g2Fabrication: Check = (i: CheckInput): Finding[] => {
  const findings: Finding[] = [];

  for (const bullet of i.struct.recap) {
    const evidence = bullet.evidence ?? "";
    const prose = bullet.text ?? "";

    // Resolve THIS bullet's own evidence SHA (first evidence candidate that resolves).
    let ownFullSha: string | null = null;
    for (const t of evidenceCandidates(evidence)) {
      const r = resolvePrefix(t, i.gitShaSet);
      if (r) {
        ownFullSha = r;
        break;
      }
    }
    const ownMsg = ownFullSha ? (i.commitMessages.get(ownFullSha) ?? "") : "";

    // --- fabrication: candidate ∧ !resolves ∧ !exempt ---
    const candidates = new Set(fabricationCandidates([
      ...evidenceCandidates(evidence),
      ...proseCandidates(prose),
    ]));
    for (const c of candidates) {
      if (resolvePrefix(c, i.gitShaSet)) continue; // resolves — genuine reference
      if (ownMsg.includes(c)) continue; // exempt — quoted from this bullet's own commit message
      findings.push({
        case: i.caseName,
        check: "G2",
        rule: "fabrication",
        severity: "fail",
        detail: `Fabricated SHA-like token "${c}" in recap bullet [${bullet.repo}] resolves to no commit and is not in its own commit message`,
      });
    }

    // --- file-claims: path in evidence+prose must be in THIS commit's diffstat ---
    if (ownFullSha) {
      let diffFiles: string[] = [];
      for (const repo of i.ctx.repos) {
        for (const act of repo.activities) {
          if (act.event_id === ownFullSha) {
            diffFiles = (act.meta?.diffstat ?? []).map((d) => d.file);
          }
        }
      }
      const seen = new Set<string>();
      for (const p of candidateFileTokens(evidence + " " + prose)) {
        if (seen.has(p)) continue;
        seen.add(p);
        const inDiffstat = diffFiles.some((f) => pathMatches(f, p));
        if (inDiffstat) continue; // OK — matches the cited commit's own diffstat, no finding

        const inInventory = i.fileInventory.has(p) || i.fileInventory.has(basename(p));
        if (inInventory) {
          // Real file (confirmed by inventory membership), just not in THIS commit's
          // diffstat — warn regardless of `/` (bare filenames included; this is the
          // regression guard: a bare real filename in the wrong commit must still warn).
          findings.push({
            case: i.caseName,
            check: "G2",
            rule: "fabrication",
            severity: "warn",
            detail: `Real file "${p}" claimed in recap bullet [${bullet.repo}] cited but not in commit ${ownFullSha.slice(0, 7)}'s diffstat (exists elsewhere in repo)`,
          });
        } else if (p.includes("/")) {
          // Option C: a path-shaped claim in NEITHER the cited commit's diffstat NOR the
          // repo's fileInventory (wholly fabricated / hallucinated path) — uniformly warn,
          // not silently ignored. Gated on `/` here: path-shape is what gives us confidence
          // this is a deliberate file reference rather than an ambiguous bare token (e.g. a
          // stray nonexistent `notes.md` in prose) — too ambiguous to warn on. This is
          // deliberately NOT promoted to a hard fail: a false-positive path-shape match
          // (e.g. a prose fragment that happens to look like a path) would be a much
          // costlier mistake at fail-tier than at warn-tier.
          //
          // Phase-2 promotion path (Option D, deferred): a path-shaped token whose PARENT
          // DIRECTORY exists in the repo but whose file does not is high-confidence
          // fabrication -> promote to hard fail; else keep warn. Deferred until real
          // false-positive-rate data exists.
          findings.push({
            case: i.caseName,
            check: "G2",
            rule: "fabrication",
            severity: "warn",
            detail: `File "${p}" claimed in recap bullet [${bullet.repo}] cited but no such file in the repo`,
          });
        }
        // else: bare nonexistent token (no `/`, not in inventory) — too ambiguous, ignored.
      }
    }
  }

  // --- secondary signal: the product itself flagged a garble it stripped ---
  for (const w of i.struct.warnings ?? []) {
    if (w.includes("didn't resolve")) {
      findings.push({
        case: i.caseName,
        check: "G2",
        rule: "fabrication",
        severity: "warn",
        detail: `Product warning (garble stripped): ${w}`,
      });
    }
  }

  return findings;
};

/**
 * G1 Attribution/evidence/coverage check — the Day-8 misattribution catch. Verifies that
 * every recap bullet cites exactly one real in-window commit, attributes it to the correct
 * unit, and that the in-window commit set is covered exactly once.
 *
 * Sub-checks (each tagged with its own `rule`):
 * - evidence: each bullet must cite EXACTLY ONE evidence SHA. Zero or two+ → fail — EXCEPT a
 *   bullet whose `evidence===undefined` when the product itself recorded a "didn't resolve"
 *   warning (it legitimately stripped a garble) → warn, not fail.
 * - resolution + integrity: the single cited 7-char prefix resolves (unique-prefix) to a full
 *   SHA that must be an in-window `ctx` commit. A SHA that resolves to an in-window ctx commit
 *   but is ABSENT from `shaToUnit` (ground truth) THROWS a "mis-authored case" error —
 *   bidirectional integrity, not a Finding. A non-resolving / out-of-window token is left for
 *   G2 fabrication and is not counted toward coverage.
 * - attribution: cited SHA → `shaToUnit{repo,root}` → the correct unit's label. Hard-fail ONLY
 *   when the bullet's `[label]` `norm()`-matches a DIFFERENT unit (a true misattribution). A
 *   `[label]` matching NO unit → warn (benign wording variance).
 * - coverage: every in-window ctx commit must be cited by exactly one recap bullet — cited 0
 *   times → fail; cited 2+ times → fail (Phase 1 exactly-once).
 */
export const g1Attribution: Check = (i: CheckInput): Finding[] => {
  const findings: Finding[] = [];
  const warnings = i.struct.warnings ?? [];

  // In-window ctx commit set: FULL SHAs of every `commit`-kind activity.
  const ctxCommitShas = new Set<string>();
  for (const repo of i.ctx.repos) {
    for (const act of repo.activities) {
      if (act.kind === "commit") ctxCommitShas.add(act.event_id);
    }
  }

  // How many recap bullets cite each in-window commit (for coverage).
  const citeCounts = new Map<string, number>();

  for (const bullet of i.struct.recap) {
    const evTokens = evidenceCandidates(bullet.evidence ?? "");

    // --- evidence: exactly one SHA per bullet ---
    if (evTokens.length !== 1) {
      // Exception: undefined evidence + a product "didn't resolve" warning = legitimately stripped garble.
      const warnedStripped =
        bullet.evidence === undefined && warnings.some((w) => w.includes("didn't resolve"));
      findings.push({
        case: i.caseName,
        check: "G1",
        rule: "evidence",
        severity: warnedStripped ? "warn" : "fail",
        detail: warnedStripped
          ? `Recap bullet [${bullet.repo}] has no evidence SHA but the product warned it was stripped (garble)`
          : `Recap bullet [${bullet.repo}] cites ${evTokens.length} evidence SHAs (expected exactly 1)`,
      });
      continue; // no single SHA to resolve/attribute/count
    }

    // --- resolution: unique-prefix → full SHA (FULL-SHA-keyed maps) ---
    const fullSha = resolvePrefix(evTokens[0]!, i.gitShaSet);
    if (!fullSha) continue; // non-resolving token is G2 fabrication's concern; not counted here
    if (!ctxCommitShas.has(fullSha)) continue; // resolves but not an in-window commit — not attributed/counted

    // --- integrity: an in-window cited commit MUST be in ground truth ---
    if (!i.shaToUnit.has(fullSha)) throw new Error(`mis-authored case: ${fullSha}`);

    // count toward coverage regardless of attribution outcome (the commit IS cited)
    citeCounts.set(fullSha, (citeCounts.get(fullSha) ?? 0) + 1);

    // --- attribution: bullet [label] vs the ground-truth unit's label ---
    const gt = i.shaToUnit.get(fullSha)!; // {repo, root}
    const correctUnit = i.units.find((u) => u.repo === gt.repo && u.root === gt.root);
    const correctLabel = correctUnit?.label;

    if (correctLabel !== undefined && norm(bullet.repo) === norm(correctLabel)) {
      continue; // correctly attributed
    }
    // Wrong label: fail ONLY if it norm-matches some OTHER unit (true misattribution); else warn.
    const matchesOther = i.units.some(
      (u) => norm(u.label) === norm(bullet.repo) && !(u.repo === gt.repo && u.root === gt.root)
    );
    findings.push({
      case: i.caseName,
      check: "G1",
      rule: "attribution",
      severity: matchesOther ? "fail" : "warn",
      detail: matchesOther
        ? `Commit ${fullSha.slice(0, 7)} (unit "${correctLabel ?? `${gt.repo}:${gt.root ?? "<root>"}`}") misattributed to a different unit's label [${bullet.repo}]`
        : `Recap bullet label [${bullet.repo}] for commit ${fullSha.slice(0, 7)} matches no unit (correct: [${correctLabel ?? "?"}]) — wording variance`,
    });
  }

  // --- coverage: every in-window ctx commit cited exactly once ---
  for (const sha of ctxCommitShas) {
    const n = citeCounts.get(sha) ?? 0;
    if (n === 1) continue;
    findings.push({
      case: i.caseName,
      check: "G1",
      rule: "coverage",
      severity: "fail",
      detail:
        n === 0
          ? `In-window commit ${sha.slice(0, 7)} is not cited by any recap bullet`
          : `In-window commit ${sha.slice(0, 7)} is cited by ${n} recap bullets (expected exactly 1)`,
    });
  }

  return findings;
};

/**
 * G4 Denylist check: flags suggestions that reference denylisted infra paths.
 * A suggestion fails if its text contains any denylisted path fragment.
 *
 * - fail: a suggestion text CONTAINS a denylist path entry
 * - clean suggestion or empty denylist → no finding
 */
export const g4Denylist: Check = (i: CheckInput): Finding[] => {
  const findings: Finding[] = [];

  for (const suggestion of i.struct.suggestions) {
    for (const deniedPath of i.denylist) {
      if (suggestion.text.includes(deniedPath)) {
        findings.push({
          case: i.caseName,
          check: "G4",
          rule: "denylist",
          severity: "fail",
          detail: `Suggestion contains denylisted path "${deniedPath}": ${suggestion.text}`,
        });
        break; // only report once per suggestion
      }
    }
  }

  return findings;
};

/**
 * All checks exported as an array for harness consumption.
 */

/**
 * G5 — the transcript "why" checks (slice 1.5b). Six rules over `struct.recap` AND `struct.resume`;
 * the latter had ZERO checks before this.
 *
 * ⚠ THE NO-OP PREDICATE GATES ON THE CASE CARRYING EVIDENCE (`i.transcripts`), NOT on the struct
 * containing a why. `CHECKS` is a flat array run against every gold case, so all six must no-op on
 * non-transcript cases — but a struct-shaped predicate silently defeats MUT8: a why rendered as its
 * own standalone bullet leaves no why-shaped field, so every check would no-op and the mutation
 * would pass. That is the exact failure the mutation discipline exists to catch.
 */
export const g5Whys: Check = (i: CheckInput): Finding[] => {
  const ev = i.transcripts;
  if (!ev) return [];                       // ⚠ gates on the CASE, not the struct
  const findings: Finding[] = [];
  const fail = (rule: Finding["rule"], detail: string) =>
    findings.push({ case: i.caseName, check: "G5", rule, severity: "fail", detail });

  const whys = i.struct.whys ?? {};
  const byNorm = new Map<string, { repo: string; root: string | null }>();
  for (const u of i.units) byNorm.set(norm(u.label), { repo: u.repo, root: u.root });

  for (const [label, text] of Object.entries(whys)) {
    const unit = byNorm.get(norm(label));
    const key = unit ? unitKey(unit.repo, unit.root) : undefined;
    // ⚠ THE ADOPTED A9 CURVE, not `ev.sources` alone. Resolving from the conservative map only was
    // the #181 regression: the union renders whys from EITHER rule, so a strict-majority-only why
    // had no `src` here, failed `why-attribution` as "not produced by the join" — a HARD rule — and
    // core.ts's fail-closed handler then deleted EVERY why. The union added coverage and G5 threw it
    // all away. One lookup helper, so the validator and the renderer can never disagree about which
    // whys exist.
    const src = key ? whySourceFor(ev, key) : undefined;

    // ── verbatim: the rendered why is byte-equal to the anchored turn, via textSha.
    // ⚠ "Capped" NEVER means truncated — the <=600 rule REJECTS, so an accepted turn's emitted bytes
    // are exactly the bytes textSha covers. Reading "capped" as "truncated" ships a check that
    // passes on every sub-600-char fixture and fails 100% in production.
    // ⚠ CALLS `matchesAnchor` rather than restating its comparison. An inline
    // `textSha(text) !== src.anchor.textSha` here was a second implementation of a single
    // equality — same class as `shouldEscalate` at harden r3 — and this one decides whether a
    // quotation is byte-equal to its source, which is invariant 5 itself.
    if (src && !matchesAnchor(src.anchor, text)) {
      fail("verbatim", `why for "${label}" is not byte-equal to its anchored turn (textSha mismatch)`);
    }

    // ── anchor: the composite resolves to exactly one line.
    if (src) {
      const r = resolveAnchor(src.anchor, [{ sessionId: src.anchor.sessionId, uuid: src.anchor.uuid, tsUtc: src.anchor.tsUtc, text: src.text }]);
      if (!r.resolved) fail("anchor", `anchor for "${label}" does not resolve (matched ${r.matched})`);
    }

    // ── freshness: the anchored turn sits inside the SCAN's window — not the git window. §3.1's
    // margin makes them different, and comparing against the git window would fail legitimately-early
    // turns.
    if (src) {
      const t = Date.parse(src.anchor.tsUtc);
      const lo = Date.parse(ev.window.startUtc), hi = Date.parse(ev.window.endUtc);
      if (!(Number.isFinite(t) && t >= lo && t <= hi)) {
        fail("freshness", `anchored turn for "${label}" (${src.anchor.tsUtc}) is outside the scan window`);
      }
    }

    // ── why-attribution: ATTRIB holds for that unit, and the quoted session is among its claimants.
    // ⚠ Under A9's union this is NOT "exactly one session" for every why: strict-majority exists to
    // resolve multi-claimant units, so `claimants > 1` is its normal state. Conservative still
    // requires the single-claimant invariant (its definition). BOTH branches require the anchored
    // session to be a real claimant — without that, a ghost sessionId on a sole-claimant unit
    // silently passed (measured 2026-08-11: conservative size===1 with sessionId "s-ghost" yielded
    // zero findings).
    if (!unit) {
      fail("why-attribution", `why for "${label}" matches no unit in this run`);
    } else if (!src) {
      fail("why-attribution", `why for "${label}" has no evidence entry — it was not produced by the join`);
    } else {
      const claimants = new Set(ev.segments.filter((sg) => sg.unitKey === key).map((sg) => sg.sessionId));
      if (claimants.size === 0) {
        fail("why-attribution", `no segment satisfies ATTRIB for "${label}"`);
      } else if (ev.sources.has(key!)) {
        // CONSERVATIVE resolved it — the single-claimant invariant is the rule's whole definition,
        // so >1 claimant here still means the ambiguity drop was bypassed. Unchanged by the union.
        if (claimants.size > 1) {
          fail("why-attribution", `${claimants.size} sessions satisfy ATTRIB for "${label}" — the ambiguity drop was bypassed`);
        } else if (!claimants.has(src.anchor.sessionId)) {
          fail("why-attribution", `the anchored session for "${label}" is not among the ${claimants.size} sessions claiming that unit`);
        }
      } else {
        // STRICT-MAJORITY resolved it. Multi-claimant is its NORMAL state — that rule exists
        // precisely to resolve units conservative dropped as ambiguous — so counting claimants
        // proves nothing here. ⚠ The >50%-file-coverage condition is NOT re-derived: join.ts owns
        // that computation and a second copy of a decision-feeding rule is the drift this codebase
        // keeps paying for. What IS re-checkable independently, and is the error that actually
        // matters, is that the quoted session is one that genuinely worked the unit.
        if (!claimants.has(src.anchor.sessionId)) {
          fail("why-attribution", `the anchored session for "${label}" is not among the ${claimants.size} sessions claiming that unit`);
        }
      }
    }

    // ── scope: intent only. RE-INVOKES the §3.5 outcome-verb function — one implementation, two
    // call sites, so the check and the suppression can never disagree.
    if (hasOutcomeVerb(text)) fail("scope", `why for "${label}" reports an outcome rather than intent`);
  }

  // ── surface: a why introduces only RECAP/RESUME units, never SUGGESTIONS, and never as its own
  // bullet. THREE clauses.
  const whyValues = new Set(Object.values(whys));
  for (const s of i.struct.suggestions) {
    if (whyValues.has(s.text) || parseWhy(s.text) !== null) {
      fail("surface", `a why reached SUGGESTIONS: ${JSON.stringify(s.text.slice(0, 60))}`);
    }
  }
  for (const t of i.struct.today ?? []) {
    if (whyValues.has(t.text) || parseWhy(t.text) !== null) {
      fail("surface", `a why reached \`today\`: ${JSON.stringify(t.text.slice(0, 60))}`);
    }
  }
  // ⚠ The standalone-bullet clause needs a PREDICATE or MUT8 is undetectable: a bullet whose text,
  // after stripping the app-owned quotation frame, is byte-equal to any value in `whys` is a why
  // masquerading as a bullet. EQUALITY, not a prefix match — the frame is ours and known.
  for (const b of [...i.struct.recap, ...i.struct.resume]) {
    const stripped = parseWhy(b.text) ?? b.text;
    if (whyValues.has(stripped)) {
      fail("surface", `a why is rendered as its own standalone bullet: ${JSON.stringify(b.text.slice(0, 60))}`);
    }
  }

  return findings;
};

/**
 * G6 — REDUNDANCY between sections of the rendered briefing (2026-08-10, user-directed).
 *
 * ⚠ WHY THIS EXISTS. Before it, all twelve rules across G1-G5 asked a PROVENANCE question: is this
 * claim tied to real evidence. Grounding was never the failing axis. On 2026-08-10 every suggestion
 * in the delivered briefing restated a RESUME bullet (containment 0.667 and 0.636 against the
 * corresponding bullet) and the harness would have scored it a clean pass, because no rule can see
 * the RELATIONSHIP BETWEEN TWO SECTIONS. That is the gap this closes.
 *
 * ⚠ THE DETECTOR IS DELIBERATELY NOT REIMPLEMENTED HERE. It is `postcheck.checkSuggestionRestatement`
 * — the same function that runs on the real morning briefing. Containment scoring is a
 * decision-feeding numerical computation, so a second copy would be free to drift from the deployed
 * one, and the two would silently disagree about what "restatement" means. One definition, two call
 * sites: the delivery path (INFO-only diagnostic) and this gate (observational).
 *
 * ⚠ SEVERITY IS `warn`, NOT `fail`, AND THAT IS THE POINT. See `thresholds.ts` for the full
 * rationale: the 0.45 threshold rests on one day and 14 pairs, so this rule REPORTS and does not
 * block. Raising it is a separate eval-integrity decision, not a refactor.
 *
 * No no-op predicate is needed (contrast G5's, which gates on the CASE carrying evidence): both
 * inputs come off `struct`, which every case has. An empty suggestions or resume list yields no
 * findings naturally, because the detector iterates suggestions and scores against resume.
 */
export const g6Redundancy: Check = (i: CheckInput): Finding[] =>
  checkSuggestionRestatement(i.struct.suggestions, i.struct.resume).map((p) => ({
    case: i.caseName,
    check: "G6" as const,
    rule: "redundancy" as const,
    severity: "warn" as const,
    detail: p.detail,
  }));

/**
 * G7 — RECENCY: did a RESUME bullet anchor on the NEWEST same-day work for its unit? (2026-08-10,
 * user-directed.) The other half of the day-25 defect; G6 covers the redundancy half.
 *
 * On 2026-08-10 RESUME anchored on the OLDEST same-day commit for two units out of two — `3fcc1d2`
 * (00:09, oldest of 11) and `e5f3650` (04:04, superseded 27 minutes later) — while `buildDoneBlock`
 * had handed the model those items ALREADY SORTED NEWEST-FIRST under a cap that truncated nothing.
 * Correct data, correct order, explicit instruction, wrong output. Only the rendered result can tell.
 *
 * ⚠ DETECTOR REUSED, NOT REIMPLEMENTED — `postcheck.checkResumeFreshness`, the same function running
 * on the real morning briefing, for the reason given on G6: one definition of what "stale" means.
 *
 * ⚠ NO-OP PREDICATE GATES ON THE CASE, NOT THE STRUCT. `doneToday` is the case's same-day evidence;
 * a case built entirely from `daysAgo: 1` commits has none and the check must no-op. Gating on the
 * struct instead (e.g. "does RESUME quote anything?") is the mistake Collision 5 documents for G5:
 * it silently passes exactly the mutation the check exists to catch.
 *
 * ⚠ UNDER-REPORTS BY DESIGN, inherited from the detector: matching is by subject equality against a
 * backtick-quoted span, so a bullet that PARAPHRASES yields no match and is skipped. Over-reporting
 * would mean accusing well-grounded prose of staleness, which is worse.
 *
 * ⚠ `warn`, not `fail` — same posture as G6, decided together. See thresholds.ts.
 */
export const g7Recency: Check = (i: CheckInput): Finding[] => {
  if (!i.doneToday?.length) return [];              // ⚠ gates on the CASE, not the struct
  return checkResumeFreshness(i.struct.resume, i.doneToday).map((p) => ({
    case: i.caseName,
    check: "G7" as const,
    rule: "recency" as const,
    severity: "warn" as const,
    detail: p.detail,
  }));
};

export const CHECKS: Check[] = [g1Attribution, g2Fabrication, g3Structure, g4Denylist, g5Whys, g6Redundancy, g7Recency];
