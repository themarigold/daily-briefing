import { expect, test, describe } from "bun:test";
import {
  contentTokens, containment, sharedTokens, quotedSubjects, MIN_SHARED_TOKENS,
  checkSuggestionRestatement, checkResumeFreshness, RESTATEMENT_THRESHOLD, doneSubjectAsShown,
  type DoneItem, type ResumeBullet,
} from "../src/postcheck";
import { norm as sharedNorm } from "../src/subprojects";
import { STAGE1_TEXT_CAP } from "../src/reduce";
import { norm as generatorNorm } from "../src/generator";

// ⚠ THESE FIXTURES ARE THE REAL 2026-08-10 BRIEFING, verbatim — not invented prose.
// That is deliberate and is the entire point of the module (EVAL.md day 25): the defect these
// checks exist for was GREEN under a prompt-text assertion and live in production on this exact
// output. A synthetic fixture could be tuned until it passed; this one cannot.
const RESUME: ResumeBullet[] = [
  { repo: "personal_code", text: "On branch feat/unreadable-doc-floor (ahead 8, behind 0)" },
  { repo: "personal_code", text: "Branch `feat/unreadable-doc-floor` is 8 commits ahead of its upstream with no local commits this window — nothing new to resume here beyond the ahead-count itself." },
  { repo: "accountant_ai", text: "B1 milestone is now marked merged in STATE.md (per today's `docs(state): B1 is merged, not merely built`) — the harden/build cycle for B1 is closed; resume by picking the next milestone of work." },
  { repo: "vault_autolog", text: "Left off having recovered quota-lost nights and recorded branch drift in the eval log (today's `fix(autolog): recover quota-lost nights, and record branch drift`) — resume by deciding what to do about the recorded drift." },
  { repo: "daily_briefing", text: "Left off hardening `prose_lib.sh`'s apply/merge path and pruning exit-3 prose rows (commit `7c25092`, Aug 9) — resume by re-checking that hardened merge path under real runs." },
  { repo: "daily_briefing_application", text: "Left off on `inspect-whys.ts`'s A9 curve work: honest overlap labels, a KEYING_DRIFT self-check, and new unit tests (commit `8f14f91`, Aug 9) — resume there if more A9 diagnostics are needed." },
  { repo: "quant_stocks", text: "Left off documenting exp009's `quintile_gross20` net/gross mislabel as a known (unfixed) defect (commit `9e357c6`, Aug 9) — the fix itself hasn't been made yet." },
];

const SUGGESTIONS = [
  { text: "Fix the `quintile_gross20` net/gross mislabel in exp009 that `quant_stocks/STATE.md` currently records as a known-but-unfixed defect." },
  { text: "Decide what to do about the branch drift vault_autolog's eval log recorded today — it was logged, not resolved." },
];

const ms = (hhmm: string) => Date.parse(`2026-08-10T${hhmm}:00-07:00`);

// The same-day commits actually handed to the model on 2026-08-10, newest-first as buildDoneBlock
// sorts them. DONE_ITEM_CAP is 30 and there were 15, so nothing was truncated — the model saw all
// of these, in this order, and still anchored RESUME on the oldest.
const DONE: DoneItem[] = [
  { label: "accountant_ai", subject: "fix: round-4 lens 2 — the .lower() defect at its THIRD call site", whenMs: ms("04:39") },
  { label: "accountant_ai", subject: "fix: round-4 findings — three more siblings of round 3's own fixes", whenMs: ms("04:36") },
  { label: "vault_autolog", subject: "fix(autolog): close the review findings, and retract a false justification", whenMs: ms("04:31") },
  { label: "accountant_ai", subject: "fix: round-3 findings — stale prose from my own fix, and 3 surviving mutations", whenMs: ms("04:19") },
  { label: "vault_autolog", subject: "fix(autolog): recover quota-lost nights, and record branch drift", whenMs: ms("04:04") },
  { label: "accountant_ai", subject: "docs(b1): booked-row immutability is a convention, not a DDL guarantee", whenMs: ms("02:37") },
  { label: "accountant_ai", subject: "docs(state): B1 is merged, not merely built", whenMs: ms("00:09") },
];

describe("containment vs jaccard — the metric choice is load-bearing", () => {
  test("MEASURED: both live restatements clear the threshold, noise floor is far below", () => {
    // Regression pins on the real numbers quoted in postcheck.ts's threshold comment. If tokenizing
    // or the stopword list drifts, these move and the comment silently becomes fiction — which is
    // the exact failure class this module was built to answer.
    const quant = containment(contentTokens(SUGGESTIONS[0]!.text), contentTokens(RESUME[6]!.text));
    const autolog = containment(contentTokens(SUGGESTIONS[1]!.text), contentTokens(RESUME[3]!.text));
    expect(quant).toBeCloseTo(0.667, 2);
    expect(autolog).toBeCloseTo(0.636, 2);
    expect(quant).toBeGreaterThan(RESTATEMENT_THRESHOLD);
    expect(autolog).toBeGreaterThan(RESTATEMENT_THRESHOLD);
  });

  test("the nearest NON-corresponding pair stays far below the threshold", () => {
    let worst = 0;
    for (const s of SUGGESTIONS) {
      for (const [i, r] of RESUME.entries()) {
        if ((s === SUGGESTIONS[0] && i === 6) || (s === SUGGESTIONS[1] && i === 3)) continue; // the true pairs
        worst = Math.max(worst, containment(contentTokens(s.text), contentTokens(r.text)));
      }
    }
    expect(worst).toBeLessThan(0.2);
    expect(worst).toBeLessThan(RESTATEMENT_THRESHOLD / 2); // the band is wide, not balanced on an edge
  });

  test("containment is asymmetric where jaccard is not — a short subset scores 1.0", () => {
    const short = contentTokens("quintile_gross20 mislabel");
    const long = contentTokens("the quintile_gross20 mislabel in exp009 recorded as a known defect");
    expect(containment(short, long)).toBe(1);
  });

  test("empty input cannot divide by zero", () => {
    expect(containment(new Set(), contentTokens("anything"))).toBe(0);
    expect(containment(contentTokens("anything"), new Set())).toBe(0);
  });

  test("⚠ NON-LATIN text yields real tokens — the ASCII splitter silently no-opped both checks", () => {
    // MEASURED under the old /[^a-z0-9]+/ splitter: accents split words mid-token and non-Latin
    // scripts produced NOTHING, so containment returned 0 and both checks silently passed on every
    // non-English briefing. No crash, no signal, invisible from outside.
    //   "café résumé naïve déployé" -> { caf, sum, ploy }
    //   "исправить ошибку"          -> { }
    expect([...contentTokens("café résumé naïve déployé")]).toEqual(["café", "résumé", "naïve", "déployé"]);
    expect(contentTokens("исправить ошибку").size).toBe(2);
    expect(contentTokens("Fehlerbehebung für Änderungen").size).toBeGreaterThan(0);

    // A real restatement in Cyrillic is now detectable where it previously scored 0.
    expect(containment(contentTokens("исправить ошибку авторизации"),
                       contentTokens("начал исправить ошибку авторизации вчера"))).toBeGreaterThan(0.9);

    // HONEST LIMIT, pinned so the comment cannot drift: separator-less scripts collapse to ONE
    // token per run — better than zero, but not segmentation.
    expect(contentTokens("認証リファクタを完了する").size).toBe(1);
  });

  test("the 2026-08-10 calibration numbers are UNCHANGED by the unicode splitter", () => {
    // The whole threshold rests on these. Measured before and after the tokenizer change: identical.
    expect(containment(contentTokens(SUGGESTIONS[0]!.text), contentTokens(RESUME[6]!.text))).toBeCloseTo(0.6667, 4);
    expect(containment(contentTokens(SUGGESTIONS[1]!.text), contentTokens(RESUME[3]!.text))).toBeCloseTo(0.6364, 4);
    expect(sharedTokens(contentTokens(SUGGESTIONS[0]!.text), contentTokens(RESUME[6]!.text))).toBe(10);
    expect(sharedTokens(contentTokens(SUGGESTIONS[1]!.text), contentTokens(RESUME[3]!.text))).toBe(7);
  });
});

describe("#157 — suggestion restates a RESUME bullet (was a prompt clause, GREEN while live)", () => {
  test("catches BOTH live restatements from the 2026-08-10 briefing", () => {
    const found = checkSuggestionRestatement(SUGGESTIONS, RESUME);
    expect(found).toHaveLength(2);
    expect(found.every((f) => f.rule === "suggestion-restates")).toBe(true);
    expect(found[0]!.detail).toContain("quant_stocks");
    expect(found[1]!.detail).toContain("vault_autolog");
  });

  test("a genuinely NEW suggestion is not flagged", () => {
    const fresh = [{ text: "Sweep the `.lower()` normalisation defect across every remaining quarantine arm — it has now appeared at three separate call sites." }];
    expect(checkSuggestionRestatement(fresh, RESUME)).toHaveLength(0);
  });

  test("one suggestion overlapping two bullets reports ONE finding, not two", () => {
    const dupResume = [RESUME[3]!, { repo: "vault_autolog", text: RESUME[3]!.text }];
    expect(checkSuggestionRestatement([SUGGESTIONS[1]!], dupResume)).toHaveLength(1);
  });

  test("no suggestions, or no resume bullets, yields nothing rather than throwing", () => {
    expect(checkSuggestionRestatement([], RESUME)).toHaveLength(0);
    expect(checkSuggestionRestatement(SUGGESTIONS, [])).toHaveLength(0);
  });

  test("⚠ a SHORT suggestion cannot trip the check on ratio alone (MIN_SHARED_TOKENS)", () => {
    // Containment divides by min(|A|,|B|), so short suggestions quantize: 1 topical token scores 0
    // or exactly 1.000. This repo's OWN generator fixture demonstrated it — "open the PR for
    // feature/auth" vs "finish the auth refactor (branch feature/auth)" scores 0.667, identical to
    // a real restatement, on 2 shared tokens of 3. Different next actions, no signal.
    const short = [{ text: "open the PR for feature/auth" }];
    const bullet: ResumeBullet[] = [{ repo: "r1", text: "finish the auth refactor (branch feature/auth)" }];
    expect(containment(contentTokens(short[0]!.text), contentTokens(bullet[0]!.text))).toBeCloseTo(0.667, 2);
    expect(sharedTokens(contentTokens(short[0]!.text), contentTokens(bullet[0]!.text))).toBe(2);
    // Since the day-33 near-miss telemetry (user-directed), a floor-blocked pair surfaces as an
    // INFO row — whether MIN_SHARED_TOKENS ever binds is itself calibration data — but must still
    // never be a FINDING. The pin's claim is unchanged: "cannot trip the check" means no finding.
    const shortOut = checkSuggestionRestatement(short, bullet);
    expect(shortOut.filter((f) => !f.info)).toHaveLength(0);                // ratio high, evidence thin
    expect(shortOut.every((f) => f.rule === "suggestion-restates-near")).toBe(true);

    // The degenerate case: one topical token scores a perfect 1.000 on a single coincidence.
    const oneToken = [{ text: "deploy" }];
    const anyBullet: ResumeBullet[] = [{ repo: "r1", text: "deploy the new binary tomorrow morning" }];
    expect(containment(contentTokens(oneToken[0]!.text), contentTokens(anyBullet[0]!.text))).toBe(1);
    expect(checkSuggestionRestatement(oneToken, anyBullet).filter((f) => !f.info)).toHaveLength(0);
  });

  test("the floor does NOT suppress the two real 2026-08-10 restatements", () => {
    // Guards the fix against over-correction: 10 and 7 shared tokens, both well clear of 4.
    expect(sharedTokens(contentTokens(SUGGESTIONS[0]!.text), contentTokens(RESUME[6]!.text))).toBeGreaterThanOrEqual(MIN_SHARED_TOKENS);
    expect(sharedTokens(contentTokens(SUGGESTIONS[1]!.text), contentTokens(RESUME[3]!.text))).toBeGreaterThanOrEqual(MIN_SHARED_TOKENS);
    expect(checkSuggestionRestatement(SUGGESTIONS, RESUME)).toHaveLength(2);
  });
});

describe("#155 — RESUME anchored on stale same-day work (also a prompt clause, also GREEN)", () => {
  test("catches BOTH live stale anchors, and names the newer commit", () => {
    const found = checkResumeFreshness(RESUME, DONE);
    expect(found).toHaveLength(2);
    const acct = found.find((f) => f.detail.includes("accountant_ai"))!;
    expect(acct.detail).toContain("B1 is merged");
    expect(acct.detail).toContain("THIRD call site"); // the newer commit is named, not just flagged
    expect(acct.detail).toContain("270 min later");   // 00:09 -> 04:39
    const autolog = found.find((f) => f.detail.includes("vault_autolog"))!;
    expect(autolog.detail).toContain("close the review findings");
    expect(autolog.detail).toContain("27 min later");  // 04:04 -> 04:31
  });

  test("a bullet citing the NEWEST commit is clean", () => {
    const fresh: ResumeBullet[] = [{ repo: "accountant_ai", text: "Left off at `fix: round-4 lens 2 — the .lower() defect at its THIRD call site` — sweep the remaining arms." }];
    expect(checkResumeFreshness(fresh, DONE)).toHaveLength(0);
  });

  test("UNDER-reports by design: a paraphrasing bullet that quotes nothing is skipped", () => {
    const paraphrase: ResumeBullet[] = [{ repo: "accountant_ai", text: "B1 is merged; pick the next milestone." }];
    expect(checkResumeFreshness(paraphrase, DONE)).toHaveLength(0);
  });

  test("⚠ duplicate subjects: the verdict must not depend on DONE array order", () => {
    // `done.find(...)` returned the FIRST subject match, so two same-day commits sharing a subject
    // (a retry, "wip", a recurring bot subject) made this order-dependent. Reproduced before the
    // fix: older-first → 1 finding, newer-first → 0. Same input, opposite verdict.
    const older: DoneItem[] = [{ label: "r", subject: "wip", whenMs: 1000 }, { label: "r", subject: "wip", whenMs: 9999 }];
    const bullet: ResumeBullet[] = [{ repo: "r", text: "per `wip`" }];
    expect(checkResumeFreshness(bullet, older)).toHaveLength(0);            // cited subject IS the newest
    expect(checkResumeFreshness(bullet, [...older].reverse())).toHaveLength(0);
    expect(checkResumeFreshness(bullet, older)).toEqual(checkResumeFreshness(bullet, [...older].reverse()));
  });

  test("⚠ a bullet citing BOTH an old and the newest commit is not stale", () => {
    // Flagging on the first stale quoted span called this bullet stale while it explicitly anchors
    // on the newest work. Reproduced before the fix: 1 finding.
    const done2: DoneItem[] = [{ label: "r", subject: "old work", whenMs: 1000 }, { label: "r", subject: "new work", whenMs: 9999 }];
    const both: ResumeBullet[] = [{ repo: "r", text: "Finished `old work`, then landed `new work` — resume from there" }];
    expect(checkResumeFreshness(both, done2)).toHaveLength(0);
    // …but citing ONLY the old one still flags, so the fix did not just disable the check.
    const onlyOld: ResumeBullet[] = [{ repo: "r", text: "Finished `old work` — resume there" }];
    expect(checkResumeFreshness(onlyOld, done2)).toHaveLength(1);
  });

  test("⚠ a bullet quoting the TRUNCATED subject the prompt showed still matches", () => {
    // buildDoneBlock slices subjects to STAGE1_TEXT_CAP before the model sees them, but the DoneItem
    // stores the full subject. A model faithfully quoting what it was shown produced a string that
    // never equalled the stored subject, so the check silently under-reported. Rare (1 of 1184
    // subjects in this repo exceeds the cap) — but the asymmetry is the defect, not the frequency.
    const longSubject = "fix(core): " + "a".repeat(STAGE1_TEXT_CAP);      // comfortably over the cap
    const done2: DoneItem[] = [
      { label: "r", subject: longSubject, whenMs: 1000 },
      { label: "r", subject: "later work", whenMs: 9999 },
    ];
    const asShown = longSubject.slice(0, STAGE1_TEXT_CAP);                // what the prompt rendered
    expect(asShown).not.toBe(longSubject);                                 // the truncation is real
    expect(checkResumeFreshness([{ repo: "r", text: `per \`${asShown}\`` }], done2)).toHaveLength(1);
    expect(checkResumeFreshness([{ repo: "r", text: `per \`${longSubject}\`` }], done2)).toHaveLength(1);
  });

  test("the finding says 'work', not 'commit' — todaySuppress also carries merges", () => {
    const withMerge: DoneItem[] = [
      { label: "r", subject: "an early commit", whenMs: 1000 },
      { label: "r", subject: "Merged #171 (feat/x)", whenMs: 9999 },
    ];
    const f = checkResumeFreshness([{ repo: "r", text: "per `an early commit`" }], withMerge);
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toContain("NEWER same-day work");
    expect(f[0]!.detail).not.toContain("NEWER same-day commit");           // a merge is not a commit
  });

  test("a unit with no same-day commits is skipped, not flagged", () => {
    const other: ResumeBullet[] = [{ repo: "quant_stocks", text: "Left off at `9e357c6`." }];
    expect(checkResumeFreshness(other, DONE)).toHaveLength(0);
  });

  test("label matching is case- and whitespace-tolerant", () => {
    const cased: ResumeBullet[] = [{ repo: "  Accountant_AI ", text: "per `docs(state): B1 is merged, not merely built`" }];
    expect(checkResumeFreshness(cased, DONE)).toHaveLength(1);
  });

  test("⚠ MARKDOWN-DECORATED labels still match — the regression that shipped in #169", () => {
    // MEASURED 2026-08-10 on the merged code: `[accountant_ai]` produced 1 finding and
    // `[**accountant_ai**]` produced 0, because postcheck carried its OWN `norm`
    // (`toLowerCase().trim()`, no decoration strip) instead of the shared one. The model really does
    // emit decorated labels — generator.ts's own comment cites `**app**` as the motivating case — so
    // this silently disabled the whole check on exactly those days. The case-and-whitespace test
    // above passed throughout, which is why the gap survived review until it was looked for.
    for (const decorated of ["**accountant_ai**", "*accountant_ai*", "`accountant_ai`", "**Accountant_AI**."]) {
      const r: ResumeBullet[] = [{ repo: decorated, text: "per `docs(state): B1 is merged, not merely built`" }];
      expect(checkResumeFreshness(r, DONE)).toHaveLength(1);
    }
  });

  test("there is exactly ONE label normalizer — generator re-exports subprojects', same object", () => {
    // Pins the FIX rather than the symptom. Identity (`toBe`) not equality: two structurally
    // identical copies would pass a value check and are precisely what caused the bug.
    expect(generatorNorm).toBe(sharedNorm);
    expect(sharedNorm("**App**.")).toBe("app");
  });
});

describe("quotedSubjects", () => {
  test("extracts every backticked span, and nothing when there are none", () => {
    expect(quotedSubjects("per today's `a: b` and `c`")).toEqual(["a: b", "c"]);
    expect(quotedSubjects("no backticks here")).toEqual([]);
  });

  test("an unterminated backtick yields no match rather than swallowing the line", () => {
    expect(quotedSubjects("dangling `open subject")).toEqual([]);
  });
});

// ── The DONE-subject rendering is ONE definition, shared with buildDoneBlock ────────────────────
// Regression cover for a drift found by review on 2026-08-10: the renderer collapsed newlines
// BEFORE slicing, the matcher sliced the raw subject, and `norm()` does not collapse internal
// whitespace — so a subject containing a newline rendered one way and was compared another. It was
// unreachable only because `today` holds git `%s` commits (single-line by git's guarantee), i.e.
// correct by an invariant recorded nowhere. These pin the shared definition instead.

test("doneSubjectAsShown collapses newlines BEFORE slicing — the drifted half", () => {
  expect(doneSubjectAsShown("fix: a\nb")).toBe("fix: a b");
  expect(doneSubjectAsShown("fix: a\r\n\n b")).toBe("fix: a  b"); // run collapses to ONE space
  expect(doneSubjectAsShown("x".repeat(250)).length).toBe(STAGE1_TEXT_CAP);
});

test("⚠ a bullet quoting a NEWLINE-bearing subject as the model was shown it still matches", () => {
  // The exact case the drift broke. Pre-fix the matcher compared against the raw subject, so this
  // quotation matched nothing, `cited` stayed undefined, and the bullet was silently skipped —
  // a stale RESUME would have gone unreported.
  const done: DoneItem[] = [
    { label: "app", subject: "feat: ship it\nwith a body line", whenMs: 1_000 },
    { label: "app", subject: "chore: newer work", whenMs: 9_000 },
  ];
  const resume = [{ repo: "app", text: "Left off at `feat: ship it with a body line` — resume there." }];
  const found = checkResumeFreshness(resume, done);
  expect(found.length).toBe(1);
  expect(found[0]!.rule).toBe("resume-stale");
  expect(found[0]!.detail).toContain("chore: newer work");
});

test("⚠ a NON-FINITE whenMs is skipped, not compared — one bad item must not silence a unit", () => {
  // `whenMs` is `new Date(a.timestamp ?? 0).getTime()` (core.ts) — NaN when a timestamp is present
  // but unparseable. Every comparison against NaN is false, so before the fix a NaN item arriving
  // FIRST stayed "newest" forever and `cited.whenMs < NaN` was false too: the unit's freshness
  // findings were all suppressed, silently, and the silence looked like a pass.
  const done: DoneItem[] = [
    { label: "app", subject: "fix(app): unparseable timestamp", whenMs: Number.NaN },   // arrives first
    { label: "app", subject: "fix(app): the older real commit", whenMs: 1_000 },
    { label: "app", subject: "fix(app): the newest real commit", whenMs: 9_000 },
  ];
  const resume = [{ repo: "app", text: "Left off at `fix(app): the older real commit` — resume there." }];
  const found = checkResumeFreshness(resume, done);
  expect(found.length).toBe(1);
  expect(found[0]!.detail).toContain("the newest real commit");
});

test("⚠ a NON-FINITE whenMs on a CITED item is skipped too — the other half of the same guard", () => {
  // The test above pins only the `newestFor` side: its NaN item carries a subject nothing quotes, so
  // it can never be selected as `cited`. Review on 2026-08-11 found the `cited` reduce unguarded and
  // reproduced it — this is that repro. A DUPLICATE subject is what makes it reachable: the bullet
  // quotes "wip", both the NaN item and a real one match, and the reduce seeds `acc` with whichever
  // arrives first. `!acc` accepts the NaN item unconditionally; every later `d.whenMs > NaN` is
  // false so nothing displaces it; `NaN < newest.whenMs` is false so the finding is suppressed.
  // Array-order-dependent, i.e. defect (a) in checkResumeFreshness returning by another route.
  const done: DoneItem[] = [
    { label: "app", subject: "wip", whenMs: Number.NaN },   // arrives first, and IS cited
    { label: "app", subject: "wip", whenMs: 1_000 },
    { label: "app", subject: "chore: the newest real commit", whenMs: 9_000 },
  ];
  const resume = [{ repo: "app", text: "Left off at `wip` — resume there." }];
  const found = checkResumeFreshness(resume, done);
  expect(found.length).toBe(1);
  expect(found[0]!.rule).toBe("resume-stale");
  expect(found[0]!.detail).toContain("the newest real commit");
});
