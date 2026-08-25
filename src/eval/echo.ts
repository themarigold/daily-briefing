// src/eval/echo.ts — a faithful, LLM-free Provider for the eval harness.
//
// Given buildPrompt's exact GIT ACTIVITY body (generator.ts ~lines 82-146), echoes its structure
// back as a valid briefing: one RECAP bullet per `  - (commit) [<sha>] <text>` line (grouped under
// its enclosing `UNIT <label> —` block), one RESUME bullet per UNIT label, and SUGGESTIONS derived
// from `  - uncommitted: <f1, f2>` lines. A `REPO <label> —` banner (degraded repo — no commit
// lines) contributes no RECAP bullets. All three `##` headers are ALWAYS emitted, even for an
// empty/degraded prompt, so echo output always round-trips parseBriefing (generator.ts ~line 160).
import type { Provider } from "../types";

// `UNIT <label> — <summary>` / `REPO <label> — <summary>` — label is everything before the first
// " — " (em dash) after the prefix.
function matchBlockLabel(line: string, prefix: string): string | null {
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  const idx = rest.indexOf(" — ");
  return (idx === -1 ? rest : rest.slice(0, idx)).trim();
}

// `  - (commit) [<shortSha>] <text> — files: <f1, f2> — <YYYY-MM-DD>` — BOTH suffixes are optional.
//
// The date (D4a) is stripped FIRST, by its own $-anchored regex, rather than by keying off the files
// marker: `filesPart` in generator.ts is CONDITIONAL, so an empty-diffstat commit ("chore: trigger
// CI") emits no " — files:" at all. A files-only strip then finds no anchor and leaves the date
// inside <text>, so echo emits `- [r] chore: trigger CI — 2026-07-30 | evidence: 35e3573`.
// Reproduced with a real `git commit --allow-empty`.
//
// The `$` anchor matters independently: a subject that legitimately ends in a date ("backfill
// 2026-07-01") must survive, and only the generator's own appended suffix sits at end-of-line.
function matchCommitLine(line: string): { sha: string; text: string } | null {
  const m = line.match(/^\s*-\s*\(commit\)\s*\[([0-9a-fA-F]*)\]\s*(.*)$/);
  if (!m) return null;
  const sha = m[1] ?? "";
  let text = (m[2] ?? "").replace(/ — \d{4}-\d{2}-\d{2}$/, "");
  const filesIdx = text.indexOf(" — files:");
  if (filesIdx !== -1) text = text.slice(0, filesIdx);
  return { sha, text: text.trim() };
}

export function echoProvider(): Provider {
  return {
    async generate(prompt: string): Promise<string> {
      const labels: string[] = [];
      const recapBullets: string[] = [];
      const uncommittedPaths: string[] = [];
      let currentLabel: string | null = null; // null = outside any UNIT block (or inside a REPO banner)

      for (const line of prompt.split("\n")) {
        const unitLabel = matchBlockLabel(line, "UNIT ");
        if (unitLabel !== null) {
          currentLabel = unitLabel;
          labels.push(unitLabel);
          continue;
        }
        if (matchBlockLabel(line, "REPO ") !== null) {
          currentLabel = null; // degraded banner — no commit lines follow, per generator.ts
          continue;
        }
        if (currentLabel !== null) {
          const commit = matchCommitLine(line);
          if (commit) {
            recapBullets.push(`- [${currentLabel}] ${commit.text} | evidence: ${commit.sha}`);
            continue;
          }
        }
        const trimmed = line.trim();
        if (trimmed.startsWith("- uncommitted:")) {
          const rest = trimmed.slice("- uncommitted:".length).trim();
          for (const p of rest.split(",").map((s) => s.trim()).filter(Boolean)) uncommittedPaths.push(p);
        }
      }

      const resumeLines = labels.length
        ? labels.map((l) => `- [${l}] resuming from the latest recorded activity`)
        : ["- [repo] resuming from the latest recorded activity"];

      const suggestionLines = uncommittedPaths.length
        ? uncommittedPaths.map((p) => `- review uncommitted ${p}`)
        : ["- review outstanding work"];

      // Fallback (always): all three headers present even when recapBullets is empty (a REPO
      // banner block, or a prompt with no UNIT blocks at all) — keeps degraded/empty prompts valid.
      // A genuinely EMPTY RECAP body needs one placeholder line: parseBriefing's section() regex
      // (generator.ts ~line 149) greedily folds a zero-content section into the next header when
      // there's nothing between them, so RECAP would otherwise wrongly swallow "## SUGGESTIONS"
      // and its bullets. A lone "-" gives the regex a real boundary to stop at, while parseBriefing's
      // own bullet-prefix strip (`replace(/^\s*[-*]\s?/, "")`) reduces it to "" and filters it out —
      // struct.recap still ends up empty, as required.
      const recapLines = recapBullets.length ? recapBullets : ["-"];

      return [
        "## RESUME",
        ...resumeLines,
        "## RECAP",
        ...recapLines,
        "## SUGGESTIONS",
        ...suggestionLines,
      ].join("\n");
    },
  };
}


// ── Slice 1.5b (T8.6) — the ADVERSARIAL echo, REDEFINED for quotation ────────────────────────────
//
// ⚠ What it is NOT, because the earlier definition became impossible: it is not a "why-bearing
// fixture provider". Under §3.5 a provider CANNOT produce a why-bearing briefing at all — whys are
// injected by the app AFTER parsing, so no provider output can contain one. Nor is it the source of
// the checks' test input; the struct hook and the fixture's `TranscriptEvidence` already supply that.
//
// ⚠ What it IS: an adversarial provider emitting bullets designed to BREAK THE LABEL→UNIT JOIN,
// which is the one thing quotation actually made fragile. The render step and the `whys` projection
// both key on `norm(label)`, and `repoLabel` is not injective — so the join is where a why can land
// against the wrong unit's bullets. Four shapes, each a distinct way for that to happen:
//
//   1. a label matching NO unit            — the why must be dropped, the bullet must still render
//   2. two labels colliding after `norm`   — the collision rule must omit BOTH
//   3. a duplicate label across sections   — the pre-pass must emit in RECAP only, never twice
//   4. one unit with bullets in BOTH       — same, and the RESUME bullet must still render bare
export function adversarialEchoProvider(opts?: { realLabel?: string }): Provider {
  const real = opts?.realLabel ?? "unit";
  return {
    generate: async () => [
      "## RESUME",
      `- [${real}] resume the real unit`,                    // 4: same label as a RECAP bullet below
      "- [no-such-unit] resume a label matching no unit",    // 1
      "## RECAP",
      `- [${real}] did the real work`,                       // 4
      `- [**${real}**] did it again, with model decoration`, // 3: norm-collides with the line above
      `- [${real.toUpperCase()}.] and again, differently decorated`, // 3
      "- [no-such-unit] did work under a label matching no unit",    // 1
      "## SUGGESTIONS",
      "- a suggestion that carries no label at all",
    ].join("\n"),
  };
}
