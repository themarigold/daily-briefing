// Day-33 decision batch (2026-08-18, user-directed): near-miss telemetry, twin dedupe,
// window merges, rename delete-half. One file so the batch's behaviour pins live together.
import { describe, expect, test } from "bun:test";
import { checkSuggestionRestatement, NEAR_MISS_FLOOR, RESTATEMENT_THRESHOLD } from "../src/postcheck";
import { renamedFromOf, displayFile } from "../src/git";
import { dedupeTwins } from "../src/extractor";
import { activityLine } from "../src/generator";
import { renderBriefing } from "../src/render";
import type { Activity, BriefingStruct } from "../src/types";

// ── Near-miss telemetry (postcheck) ────────────────────────────────────────────────────────────
describe("suggestion-restates near-miss telemetry", () => {
  // The REAL day-33 pair, verbatim from briefings/2026-08-18.md — measured 0.423/11, under the
  // 0.45 threshold. It must surface as info telemetry, NOT as a finding.
  const sugg = [{ text: "Switch on the transcript layer in `daily_briefing_application` — the day-32 audit (`3da8804`) records it was never enabled, so `src/transcripts/discover.ts` and its restored old-self-prompt guard (`46159b3`) are likely still dormant in the real run path." }];
  const bullet = [{ repo: "daily_briefing_application", text: "You left off at the day-32 audit follow-up (`23a76d3`), which concluded `46159b3`'s HIGH was latent rather than live — so no incident to chase. The open observation from the same audit day is that the transcript layer was never switched on (`3da8804`), while `46159b3` fixed the guard `db22f09` had silently dropped for old self-prompts. Looks like the first-wake briefing rework (`db22f09`) is the live shape of the app now." }];

  test("day-33 pair emits info near-miss, not a finding", () => {
    const out = checkSuggestionRestatement(sugg, bullet);
    expect(out).toHaveLength(1);
    expect(out[0]!.rule).toBe("suggestion-restates-near");
    expect(out[0]!.info).toBe(true);
    expect(out[0]!.detail).toContain("0.42"); // the measured containment, so the log carries the number
  });

  test("a tripping pair is still a finding, not telemetry", () => {
    const dup = [{ text: "reconcile the editor setup interpreter still resolves per-sub-project settings workspace" }];
    const b = [{ repo: "quant_stocks", text: "reconcile the editor setup interpreter still resolves per-sub-project settings workspace gone" }];
    const out = checkSuggestionRestatement(dup, b);
    expect(out).toHaveLength(1);
    expect(out[0]!.rule).toBe("suggestion-restates");
    expect(out[0]!.info).toBeUndefined();
  });

  test("below the near-miss floor emits nothing", () => {
    const out = checkSuggestionRestatement(
      [{ text: "wire the verify script into whatever runs on commit continuous integration" }],
      [{ repo: "x", text: "completely unrelated prose about calendars and vaults and mornings" }],
    );
    expect(out).toHaveLength(0);
  });

  test("floor sits between noise and threshold", () => {
    expect(NEAR_MISS_FLOOR).toBeGreaterThan(0.143);
    expect(NEAR_MISS_FLOOR).toBeLessThan(RESTATEMENT_THRESHOLD);
  });
});

// ── Rename delete-half (defect C) ──────────────────────────────────────────────────────────────
describe("renamedFromOf", () => {
  test("plain rename keeps old side; displayFile keeps new", () => {
    const raw = "accountant_ai/scripts/verify-b2a.sh => accountant_ai/scripts/verify-safe-subset.sh";
    expect(renamedFromOf(raw)).toBe("accountant_ai/scripts/verify-b2a.sh");
    expect(displayFile(raw)).toBe("accountant_ai/scripts/verify-safe-subset.sh");
  });
  test("brace-collapsed rename (the real ff1622f row)", () => {
    const raw = "accountant_ai/scripts/{verify-b2a.sh => verify-safe-subset.sh}";
    expect(renamedFromOf(raw)).toBe("accountant_ai/scripts/verify-b2a.sh");
    expect(displayFile(raw)).toBe("accountant_ai/scripts/verify-safe-subset.sh");
  });
  test("intermediate-directory brace with suffix", () => {
    expect(renamedFromOf("src/{old => new}/f.ts")).toBe("src/old/f.ts");
  });
  test("non-rename returns undefined", () => {
    expect(renamedFromOf("src/main.ts")).toBeUndefined();
  });
});

describe("activityLine renders both rename sides", () => {
  const act: Activity = {
    source: "git", kind: "commit", event_id: "ff1622ff00", repo: "/r", timestamp: "2026-08-16T22:16:59-07:00",
    text: "repurpose the frozen relay verify script",
    meta: { diffstat: [{ file: "scripts/verify-safe-subset.sh", added: 8, removed: 1, renamedFrom: "scripts/verify-b2a.sh" }] },
  };
  test("evidence shows old → new", () => {
    expect(activityLine(act)).toContain("scripts/verify-b2a.sh → scripts/verify-safe-subset.sh");
  });
});

// ── Twin dedupe (defect E) ─────────────────────────────────────────────────────────────────────
describe("dedupeTwins", () => {
  const mk = (sha: string, subject: string, ts: string, repo = "/r"): Activity =>
    ({ source: "git", kind: "commit", event_id: sha, repo, timestamp: ts, text: subject });

  test("patch-identical same-subject pair keeps the NEWER copy", async () => {
    const branch = mk("aaa", "fix: the barrier", "2026-08-18T02:36:00-07:00");
    const mainline = mk("bbb", "fix: the barrier", "2026-08-18T03:06:00-07:00");
    const ids = async () => new Map([["aaa", "P1"], ["bbb", "P1"]]);
    const out = await dedupeTwins([branch, mainline], ids);
    expect(out.map((a) => a.event_id)).toEqual(["bbb"]);
  });

  test("same subject but DIFFERENT patches both survive", async () => {
    const a = mk("aaa", "fix typo", "2026-08-18T01:00:00Z");
    const b = mk("bbb", "fix typo", "2026-08-18T02:00:00Z");
    const ids = async () => new Map([["aaa", "P1"], ["bbb", "P2"]]);
    expect(await dedupeTwins([a, b], ids)).toHaveLength(2);
  });

  test("fails open: unmapped SHAs are never dropped", async () => {
    const a = mk("aaa", "same", "2026-08-18T01:00:00Z");
    const b = mk("bbb", "same", "2026-08-18T02:00:00Z");
    const ids = async () => new Map<string, string>(); // patch-id failed entirely
    expect(await dedupeTwins([a, b], ids)).toHaveLength(2);
  });

  test("no subject collision → patchIds never called", async () => {
    let called = 0;
    const ids = async () => { called++; return new Map<string, string>(); };
    const out = await dedupeTwins([mk("aaa", "one", "2026-08-18T01:00:00Z"), mk("bbb", "two", "2026-08-18T02:00:00Z")], ids);
    expect(out).toHaveLength(2);
    expect(called).toBe(0);
  });

  test("same subject across DIFFERENT repos is not a twin group", async () => {
    let called = 0;
    const ids = async () => { called++; return new Map<string, string>(); };
    await dedupeTwins([mk("aaa", "same", "2026-08-18T01:00:00Z", "/r1"), mk("bbb", "same", "2026-08-18T02:00:00Z", "/r2")], ids);
    expect(called).toBe(0);
  });
});

// ── Window merges render (defect D) ────────────────────────────────────────────────────────────
describe("windowMerges rendering", () => {
  const base: BriefingStruct = {
    date: "2026-08-18", machineScope: "test", provider: "test",
    resume: [], suggestions: [{ text: "s" }],
    recap: [{ repo: "r", text: "did a thing", evidence: "abc1234" }],
    windowMerges: [{ repo: "personal_code", text: "🔀 Merged #241 (test/split-accuracy-gate) (Aug 17)  (21db663)" }],
  };
  test("dated 🔀 line lands at the foot of What you did", () => {
    const out = renderBriefing(base);
    const lines = out.split("\n");
    const recapIdx = lines.findIndex((l) => l.includes("What you did"));
    const mergeIdx = lines.findIndex((l) => l.includes("Merged #241"));
    const nextIdx = lines.findIndex((l) => l.includes("Suggested next"));
    expect(mergeIdx).toBeGreaterThan(recapIdx);
    expect(mergeIdx).toBeLessThan(nextIdx);
    expect(lines[mergeIdx]).toContain("(Aug 17)");
  });
  test("absent field renders nothing new", () => {
    const { windowMerges, ...rest } = base;
    expect(renderBriefing(rest as BriefingStruct)).not.toContain("Merged #241");
  });
});

// ── Features echo (decision 3, 2026-08-18) ─────────────────────────────────────────────────────
import { featuresLine } from "../src/audit";
import { PROMPT_HEADER } from "../src/generator";
import { HISTORICAL_PROMPT_HEADERS, isSelfPrompt } from "../src/transcripts/discover";

describe("featuresLine", () => {
  test("enabled transcripts + subprojects + defaults render as on", () => {
    const line = featuresLine(
      { transcripts: { enabled: true }, subprojects: [{ repo: "/r", roots: ["a", "b"] }], provider: { timeoutMs: 300000 } },
      { enabled: true, root: "/home/u/.claude/projects" },
    );
    expect(line).toContain("transcripts=on (root=/home/u/.claude/projects)");
    expect(line).toContain("subprojects=2 root(s)");
    expect(line).toContain("harden=on");
    expect(line).toContain("timeout=300s");
  });
  test("the day-29/32 failure shape renders LOUDLY as OFF", () => {
    const line = featuresLine({ provider: {} }, { enabled: false, root: "/x" });
    expect(line).toContain("transcripts=OFF");
    expect(line).toContain("subprojects=OFF (single-unit repos)");
    expect(line).toContain("timeout=120s"); // the default, stated rather than implied
  });
});

// ── The Daily-briefing rename's coupling guard (the db22f092 regression class) ─────────────────
describe("PROMPT_HEADER rename coupling", () => {
  test("every historical header is still recognised as a self-prompt", () => {
    for (const h of HISTORICAL_PROMPT_HEADERS) expect(isSelfPrompt(h + "\nGIT ACTIVITY: …")).toBe(true);
    expect(isSelfPrompt(PROMPT_HEADER + "\nGIT ACTIVITY: …")).toBe(true);
  });
  test("the pre-rename header (2026-08-17 spelling) is in the FROZEN list", () => {
    // The literal, not a derivation — if the rename had been done without growing the list, this fails.
    expect(HISTORICAL_PROMPT_HEADERS).toContain(
      "You are writing a developer's resumption-focused briefing from LOCAL GIT ACTIVITY on THIS machine only.",
    );
  });
  test("the current header carries the final name", () => {
    expect(PROMPT_HEADER).toContain("daily briefing");
  });
});
