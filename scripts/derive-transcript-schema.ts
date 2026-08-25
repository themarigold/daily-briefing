// Slice 1.5 T5.2 — regenerates the FACTS in `docs/transcript-schema.md` from the live corpus.
//
//   run: bun run scripts/derive-transcript-schema.ts [--root=<dir>]
//
// The doc it backs was hand-corrected four times (2026-08-03) because figures drifted from the
// corpus and, worse, because two of them were stated in a form that read as the OPPOSITE of the
// truth. This script exists so the next correction is a re-run rather than another round of
// hand-editing, and so a CC version bump is detected instead of assumed.
//
// ⚠ CONTAINS FIELD NAMES AND COUNTS ONLY — never a field value, never conversation content. That is
// what makes the artifact safe for a public repo, so it is a property of this script, not of the
// doc: every accumulator below is a counter or a name, and nothing reads a value into the output.
//
// ⚠ It streams. A single subagent line reaches 3.8 MB, so slurping a file is not an option.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = process.argv.find((a) => a.startsWith("--root="))?.slice(7)
  ?? join(homedir(), ".claude", "projects");

type Tier = "depth1" | "subagentTier1" | "subagentTier2";

type Facts = {
  depth1Files: number;
  subagentTier1Files: number;          // <session>/subagents/*.jsonl
  subagentTier2Files: number;          // <session>/subagents/workflows/wf_*/*.jsonl
  journalFiles: number;                // the THIRD file shape in tier 2
  toolResultDirs: number;
  linesDepth1: number;
  unparseable: number;
  longestDepth1: number;
  longestSubagent: number;
  /** field NAME -> occurrence count, never a value */
  fieldCounts: Map<string, number>;
  lineTypes: Map<string, number>;
  userShapes: { harness: number; humanString: number; textBlocks: number; documentBlocks: number; other: number };
  /** ⚠ VALUE counts, not presence — presence is 100% and carries no signal. */
  isSidechain: { depth1False: number; depth1True: number; subagentFalse: number; subagentTrue: number };
  promptSource: Map<string, number>;
  toolNames: Map<string, number>;
};

const emptyFacts = (): Facts => ({
  depth1Files: 0, subagentTier1Files: 0, subagentTier2Files: 0, journalFiles: 0, toolResultDirs: 0,
  linesDepth1: 0, unparseable: 0, longestDepth1: 0, longestSubagent: 0,
  fieldCounts: new Map(), lineTypes: new Map(),
  userShapes: { harness: 0, humanString: 0, textBlocks: 0, documentBlocks: 0, other: 0 },
  isSidechain: { depth1False: 0, depth1True: 0, subagentFalse: 0, subagentTrue: 0 },
  promptSource: new Map(), toolNames: new Map(),
});

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

async function* walk(dir: string): AsyncGenerator<{ path: string; tier: Tier }> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { yield* walk(p); continue; }
    if (!e.name.endsWith(".jsonl")) continue;
    // Tier is decided by PATH SHAPE, which is the whole point of the corrected layout section.
    const rel = p.slice(ROOT.length);
    const tier: Tier = !rel.includes("/subagents/") ? "depth1"
      : rel.includes("/subagents/workflows/") ? "subagentTier2" : "subagentTier1";
    yield { path: p, tier };
  }
}

async function collect(): Promise<Facts> {
  const f = emptyFacts();
  for await (const { path, tier } of walk(ROOT)) {
    if (tier === "depth1") f.depth1Files++;
    else if (tier === "subagentTier1") f.subagentTier1Files++;
    else { f.subagentTier2Files++; if (path.endsWith("/journal.jsonl")) f.journalFiles++; }

    const file = Bun.file(path);
    let pending = "";
    const consume = (line: string) => {
      if (!line) return;
      if (tier === "depth1") { f.linesDepth1++; f.longestDepth1 = Math.max(f.longestDepth1, line.length); }
      else f.longestSubagent = Math.max(f.longestSubagent, line.length);
      let o: Record<string, unknown>;
      try { o = JSON.parse(line); } catch { f.unparseable++; return; }
      if (!o || typeof o !== "object") { f.unparseable++; return; }

      for (const k of Object.keys(o)) bump(f.fieldCounts, k);           // NAMES only
      bump(f.lineTypes, String(o.type ?? "(none)"));

      // ⚠ isSidechain by VALUE, split by tier — the correction this script has to keep true.
      if (typeof o.isSidechain === "boolean") {
        const key = tier === "depth1"
          ? (o.isSidechain ? "depth1True" : "depth1False")
          : (o.isSidechain ? "subagentTrue" : "subagentFalse");
        f.isSidechain[key]++;
      }
      if (typeof o.promptSource === "string") bump(f.promptSource, o.promptSource);

      const m = o.message as Record<string, unknown> | undefined;
      const content = m && typeof m === "object" ? m.content : undefined;
      if (o.type === "user") {
        if ("toolUseResult" in o) f.userShapes.harness++;
        else if (typeof content === "string") f.userShapes.humanString++;
        else if (Array.isArray(content)) {
          const kinds = new Set(content.map((b) => (b as { type?: string })?.type));
          if (kinds.has("document")) f.userShapes.documentBlocks++;
          else if (kinds.has("text")) f.userShapes.textBlocks++;
          else f.userShapes.other++;
        } else f.userShapes.other++;
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          const blk = b as { type?: string; name?: string };
          if (blk?.type === "tool_use" && typeof blk.name === "string") bump(f.toolNames, blk.name);
        }
      }
    };

    for await (const chunk of file.stream().pipeThrough(new TextDecoderStream())) {
      pending += chunk;
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) { consume(pending.slice(0, nl)); pending = pending.slice(nl + 1); }
    }
    consume(pending);
  }
  return f;
}

const pct = (n: number, d: number) => d ? `${((n / d) * 100).toFixed(1)}%` : "n/a";
const top = (m: Map<string, number>, n: number) =>
  [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `| \`${k}\` | ${v.toLocaleString()} |`).join("\n");

function report(f: Facts): string {
  const users = f.userShapes.harness + f.userShapes.humanString + f.userShapes.textBlocks + f.userShapes.documentBlocks + f.userShapes.other;
  const sub = f.subagentTier1Files + f.subagentTier2Files;
  const L: string[] = [];
  L.push("# Derived transcript facts (regenerated)", "");
  L.push("**Field NAMES and COUNTS only — no values, no conversation content.**", "");
  L.push("| | |", "| --- | --- |");
  L.push(`| Root | \`${ROOT}\` |`);
  L.push(`| Depth-1 session files | ${f.depth1Files.toLocaleString()} |`);
  L.push(`| Subagent tier 1 (\`<session>/subagents/\`) | ${f.subagentTier1Files.toLocaleString()} |`);
  L.push(`| Subagent tier 2 (\`.../workflows/wf_*/\`) | ${f.subagentTier2Files.toLocaleString()} |`);
  L.push(`| …of which \`journal.jsonl\` | ${f.journalFiles.toLocaleString()} |`);
  L.push(`| **Subagent total** | **${sub.toLocaleString()}** |`);
  L.push(`| Non-recursive glob would match | ${f.subagentTier1Files.toLocaleString()} (**${pct(f.subagentTier1Files, sub)}** — the silent under-read) |`);
  L.push(`| Lines parsed (depth-1) | ${f.linesDepth1.toLocaleString()} |`);
  L.push(`| Unparseable lines | ${f.unparseable.toLocaleString()} |`);
  L.push(`| Longest line, depth-1 | ${f.longestDepth1.toLocaleString()} |`);
  L.push(`| Longest line, subagent | **${f.longestSubagent.toLocaleString()}** (${(f.longestSubagent / Math.max(1, f.longestDepth1)).toFixed(1)}x depth-1) |`);
  L.push("");
  L.push("## user-line shapes", "", "| shape | count | share |", "| --- | ---: | ---: |");
  L.push(`| \`toolUseResult\` present (harness) | ${f.userShapes.harness.toLocaleString()} | ${pct(f.userShapes.harness, users)} |`);
  L.push(`| \`content\` is a string (**human**) | ${f.userShapes.humanString.toLocaleString()} | ${pct(f.userShapes.humanString, users)} |`);
  L.push(`| text blocks only | ${f.userShapes.textBlocks.toLocaleString()} | ${pct(f.userShapes.textBlocks, users)} |`);
  L.push(`| \`document\` blocks | ${f.userShapes.documentBlocks.toLocaleString()} | ${pct(f.userShapes.documentBlocks, users)} |`);
  L.push(`| other | ${f.userShapes.other.toLocaleString()} | ${pct(f.userShapes.other, users)} |`);
  L.push("");
  L.push("## `isSidechain` — by VALUE, not presence", "");
  L.push("⚠ Presence is ~100% and carries NO signal; the value is an exact main-vs-subagent test.", "");
  L.push("| tier | `false` | `true` |", "| --- | ---: | ---: |");
  L.push(`| depth-1 | ${f.isSidechain.depth1False.toLocaleString()} | ${f.isSidechain.depth1True.toLocaleString()} |`);
  L.push(`| subagent | ${f.isSidechain.subagentFalse.toLocaleString()} | ${f.isSidechain.subagentTrue.toLocaleString()} |`);
  L.push("");
  L.push("## `promptSource` values", "", "| value | count |", "| --- | ---: |", top(f.promptSource, 8), "");
  L.push("## line types", "", "| `type` | count |", "| --- | ---: |", top(f.lineTypes, 10), "");
  L.push("## tool_use names", "", "| tool | count |", "| --- | ---: |", top(f.toolNames, 12), "");
  L.push("## top field names", "", "| field | count |", "| --- | ---: |", top(f.fieldCounts, 20), "");
  return L.join("\n");
}

if (import.meta.main) {
  const f = await collect();
  console.log(report(f));
}

export { collect, report, emptyFacts, type Facts };
