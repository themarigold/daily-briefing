// src/render.ts
import type { BriefingStruct } from "./types";
import { norm } from "./generator";
import { renderWhy } from "./transcripts/frame";

// Neutralize terminal-escape / control-character injection. Git-derived filenames and branch names —
// and raw provider text — can carry ANSI escapes or C0/C1 control bytes (all legal in POSIX filenames,
// droppable into a working tree by a cloned repo's build script or a checked-out PR branch). This
// string is written BOTH to the user's terminal and to briefing-latest.md, so an unsanitized
// `\x1b]0;pwned\x07` or a CSI sequence would execute against the terminal. Strip every C0 control
// (incl. newline/CR/tab), DEL, and C1 (0x80–0x9f) byte. Applied PER LINE, before the structural
// newlines are re-added by join(), so an embedded newline in a field can't forge an extra bullet
// either. Emoji and non-Latin filenames (U+00A0 and up) are untouched. Removing just the control byte
// leaves any escape sequence as inert, visible text (e.g. `\x1b[31m` → `[31m`), flagging the tampering.
// Deliberately NOT stripped: Unicode bidi overrides (U+202A–202E / U+2066–2069, the "Trojan Source"
// visual-reordering class) and U+2028/U+2029 — these can't execute an escape or forge a line (neither
// the terminal nor CommonMark treats U+2028/9 as a line break), and stripping the bidi range would
// corrupt legitimate right-to-left filenames. That's a visual-spoofing concern, out of this scope.
export const stripControl = (s: string): string => s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");

// Sanitize a FREE-FORM multi-line string: strip control bytes from each real line but KEEP the
// line structure. Use this (not stripControl on the whole string, which would delete the newlines,
// nor a per-array-element map, which flattens any element that is itself multi-line) for text with
// genuine internal newlines — e.g. the audit report's LLM-judge verdict.
export const stripControlLines = (s: string): string => s.split("\n").map(stripControl).join("\n");

export function renderBriefing(b: BriefingStruct): string {
  const L: string[] = [];
  // ⚠ "Morning" was DROPPED 2026-08-17 (scope decision, user-directed): the deliverable is a
  // FIRST-WAKE briefing, not an 07:20 one, and the old header promised a time the product never
  // offered — `morningTime` only SUPPRESSES ticks below the floor (`main.ts:96`), it never requires
  // delivery at it. Day-31's judge put it exactly: "a 12:41 'morning briefing' against a 07:20 floor
  // is stale by name."
  // ⚠ ANY change to this string is a PARSER change too: `audit.ts`'s `lastBriefing` splits
  // `briefing.log` into per-day blocks by matching it, and 31 days of archived briefings carry the
  // OLD text — so its matcher accepts both spellings and must keep doing so. See
  // `BRIEFING_HEADER_RE` in audit.ts (named rather than line-cited: a line number in a comment goes
  // stale silently, and this workspace has already shipped one such citation off by three).
  L.push(`☀️  Daily briefing — ${b.date}  (this machine: ${b.machineScope})`);
  L.push("");
  // The outage line OPENS the briefing — the silence is what made the 2026-08-23 outage invisible for a
  // day and a half, so the recovery notice cannot be a trailing warning. Deliberately NOT the `warnings`
  // channel below, which renders after "Suggested next", semicolon-joined with unrelated text.
  if (b.outage) {
    L.push(`⚠️  No briefing for ${b.outage.missedDays} day${b.outage.missedDays === 1 ? "" : "s"} — account "${b.outage.label}" was at its usage limit.`);
    L.push("");
  }
  // Working-tree facts are volatile (repos auto-commit, the user works while the provider runs) —
  // stamp when they were true instead of presenting them as durable (audit 2026-07-10 #1).
  // ── Slice 1.5b (§3.5): the why lines.
  //
  // ⚠ PRE-PASS FIRST, because this renderer emits RESUME BEFORE RECAP. A unit whose label appears in
  // RECAP gets its line in RECAP ONLY; every other unit with a why gets it in RESUME. Emitting
  // inline in document order would put every line in RESUME first, which is the opposite of intent.
  //
  // ⚠ Walks ONLY `resume` and `recap`. NEVER `today` — its bullets carry the same unit labels and
  // render as a third section, so a generic "walk each section" loop would quote an in-window turn
  // against commits §3.2 deliberately excludes from `unitFiles`. `today` joins `suggestions` on the
  // "Not:" list.
  //
  // ⚠ This WHYS pre-pass does NOT group or reorder anything — a transcript-side feature changing
  // the rendered shape of the GIT-ONLY briefing is what invariant 8 forbids. (The recap's own
  // display clustering below is a deliberate product change to the git briefing itself, driven by
  // the code-side `group` stamp — different author, different rule.)
  const whys = b.whys ?? {};
  const recapKeys = new Set(b.recap.map((r) => norm(r.repo)));
  const emitted = new Set<string>();
  /** The why line for this bullet, or null. Emitted once, before the FIRST bullet with that key —
   *  non-contiguous bullets for one label are fine. Invariant 1 is structural here: this is only
   *  ever reached from inside a bullet's own map, so a why can never create a bullet. */
  const whyFor = (label: string, section: "resume" | "recap"): string | null => {
    const key = norm(label);
    const turn = whys[key];
    if (turn === undefined || emitted.has(key)) return null;
    const home = recapKeys.has(key) ? "recap" : "resume";   // the pre-pass decision
    if (home !== section) return null;
    emitted.add(key);
    return renderWhy(turn);
  };

  // Day-23: floor AND actual time, both stated, no cause inferred. A briefing that lands hours after
  // the floor is CORRECT behaviour for a lid-closed laptop (2026-07-16 design: "ready when the user
  // first sits down") — but with only one timestamp printed it is indistinguishable from a failure,
  // and on 2026-08-08 it was misread as one by two readers in sequence.
  // ⚠ RE-FRAMED 2026-08-17, not re-plumbed. The floor is still PRINTED — the day-23 property above
  // (both times stated, so a late delivery is not indistinguishable from a failure) is exactly the
  // confusion the scope decision fixes, so it gets stronger, not weaker. What changed is what the
  // floor is called: it is the time below which ticks are suppressed, NOT a delivery target, so the
  // stamp now names the delivery as "first wake" and the floor as the thing it is past.
  const stamp = b.stateAsOf
    ? `  (${b.morningFloor ? `first wake past ${b.morningFloor} · ` : "first wake · "}state as of ${b.stateAsOf})`
    : "";
  L.push(`▶ Where you left off${stamp}`);
  // Branch state FIRST, above the model's resume bullets: it is the frame those bullets are read
  // in. On 2026-08-06 the only resume item was interpreted wrongly for want of exactly this line,
  // and a correction placed after the thing it corrects is read too late (the same reasoning that
  // moved drift out of the footer and into the suggestions themselves).
  L.push(...(b.branchState ?? []).map((s) => `   • [${s.repo}] ${s.text}`));
  L.push(...(b.resume.length
    ? b.resume.flatMap((r) => { const w = whyFor(r.repo, "resume"); const line = `   • [${r.repo}] ${r.text}`; return w ? [w, line] : [line]; })
    : ["   (nothing in progress)"]));
  L.push("");
  // Recap count in the header (day-16 finding 4: with no count, suppression is invisible). Suffix
  // only — every consumer substring-matches "What you did"; nothing parses this line.
  L.push(`▶ What you did${b.recap.length ? ` \u2014 ${b.recap.length} commit${b.recap.length === 1 ? "" : "s"}` : ""}`);
  if (b.recap.length) {
    // Group-aware walk (T1.3): the FIRST entry of each `group` emits a code-built story line, then
    // every member of that cluster nested (\u25e6, two extra spaces) — each member keeps its exact
    // flat-line content (label, text, evidence), so every SHA/label the audit mines is still on its
    // own line. Later occurrences of an emitted cluster are skipped in the main walk (their lines
    // already rendered under the story). Ungrouped entries render byte-identically to the old shape.
    // Every entry renders exactly once — the skip test is the emitted-cluster set, nothing else.
    const emittedClusters = new Set<string>();
    const bulletOf = (r: (typeof b.recap)[number], indent: string, glyph: string) =>
      `${indent}${glyph} [${r.repo}] ${r.text}${r.evidence ? `  (${r.evidence})` : ""}`;
    for (const r of b.recap) {
      if (!r.group) {
        const w = whyFor(r.repo, "recap");
        if (w) L.push(w);
        L.push(bulletOf(r, "   ", "\u2022"));
        continue;
      }
      const ck = `${norm(r.repo)}\x1f${r.group}`;
      if (emittedClusters.has(ck)) continue;   // members already nested under the story line
      emittedClusters.add(ck);
      const w = whyFor(r.repo, "recap");
      if (w) L.push(w);
      L.push(`   \u2022 [${r.repo}] ${r.group}`);
      for (const m of b.recap) {
        if (m.group === r.group && norm(m.repo) === norm(r.repo)) L.push(bulletOf(m, "      ", "\u25e6"));
      }
    }
  } else {
    L.push("   (no commits in the window)");
  }
  // In-window PR landings (defect D — EVAL day 33): deterministic dated 🔀 lines at the FOOT of the
  // recap, code-rendered like `today`'s merge lines so they cannot be hallucinated. Foot, not
  // interleaved: the recap above is model prose in model order, and these carry their own dates.
  // Stable label sort (T1.3): with real unit labels the foot reads grouped per unit; within a
  // label the original (date) order is preserved (Array.sort is stable).
  L.push(...[...(b.windowMerges ?? [])].sort((a, z) => a.repo.localeCompare(z.repo)).map((m) => `   • [${m.repo}] ${m.text}`));
  L.push("");
  if (b.today?.length) {
    L.push("▶ Today so far");
    L.push(...b.today.map((t) => `   • [${t.repo}] ${t.text}`));
    L.push("");
  }
  L.push("▶ Suggested next");
  // `(from resume)` (S1): PROVENANCE, not decoration. A promoted line is the verbatim tail of a
  // RESUME bullet the reader has already seen 20 lines up, so without the label it reads as the model
  // repeating itself — the exact redundancy the day-43 judge called out. The label says "this is the
  // action you stated, carried down here", which is why the duplication is the point.
  L.push(...(b.suggestions.length
    ? b.suggestions.map((s) => `   • ${s.text}${s.promoted ? "  (from resume)" : ""}`)
    : ["   (none)"]));
  if (b.warnings?.length) { L.push(""); L.push("⚠ " + b.warnings.join("; ")); }
  L.push("");
  L.push(`— generated locally via ${b.provider}`);
  // Sanitize each line, THEN join — structural newlines are added here, so no field can inject one.
  return L.map(stripControl).join("\n");
}
