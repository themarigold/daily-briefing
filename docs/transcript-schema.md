# Claude Code transcript JSONL — derived schema reference

> **Derived, not documented.** Produced by walking the real local corpus. Anthropic does not publish
> this format and has said it will change. **Re-derive before trusting it against a new CC version.**
>
> | | |
> | --- | --- |
> | Derived | 2026-08-01 |
> | CC version | **2.1.220** |
> | Depth-1 session files | 605 |
> | `subagents/**` files | 2,907 (**two tiers** — see On-disk layout) |
> | Lines parsed (depth-1) | 124,038 |
> | Unparseable lines | 0 |
> | Longest line, depth-1 (chars) | 1,484,365 |
> | Longest line, **subagent tier** (chars) | **3,798,052** — ⚠ **2.6x the depth-1 figure** |
> | `timestamp` shape | `2026-MM-DDTHH:MM:SS.sssZ` (UTC `Z`) |
>
> ⚠ **Figures below are a 2026-08-01 snapshot and DRIFT — CC prunes on a rolling ~30-day window.**
> Re-derived 2026-08-03 with `scripts/derive-transcript-schema.ts`, which reproduces every corrected
> claim in this document and shows what moved: depth-1 files 605 → 7,166 and the subagent total
> 2,907 → 2,641 (pruning), while the load-bearing RATIOS held — the non-recursive glob still matches
> only **63.0%** of the subagent tier (was 65%), and the subagent max line is still **2.6x** the
> depth-1 one. `isSidechain` re-derived to **0 exceptions in both directions** (depth-1: 96,242
> false / 0 true; subagent: 0 false / 128,312 true).
>
> ⚠ **Off-by-one, stated rather than silently reconciled:** the longest-line figures here
> (1,484,365 / 3,798,052) count the trailing newline; the script reports 1,484,364 / 3,798,051
> because it measures the line after the separator is stripped. Same line, different convention.
>
> ⚠ **`Bash` re-derived at 28,019 uses against `Edit`+`Write`'s 7,432** — a wider blind spot than the
> design's 7,467 vs 4,908. Every edit made via heredoc, `sed -i`, `git` or a script carries no
> `file_path` and is invisible to attribution (R11).
>
> **Contains field NAMES and COUNTS only — no field values, no conversation content.** Safe for a
> public repo. Regenerate with `bun run scripts/derive-transcript-schema.ts` (see Slice 1.5 design §2).

## Line types (`type`)

| type | count |
| --- | ---: |
| `assistant` | 42,769 |
| `user` | 22,578 |
| `attachment` | 11,239 |
| `system` | 7,838 |
| `last-prompt` | 7,579 |
| `permission-mode` | 5,974 |
| `mode` | 5,965 |
| `ai-title` | 5,909 |
| `queue-operation` | 5,837 |
| `pr-link` | 4,000 |
| `file-history-snapshot` | 2,489 |
| `worktree-state` | 780 |
| `relocated` | 618 |
| `file-history-delta` | 306 |
| `agent-name` | 157 |

## Content block types (`message.content[].type`)

| block type | count |
| --- | ---: |
| `tool_result` | 17,539 |
| `tool_use` | 17,537 |
| `thinking` | 13,053 |
| `text` | 12,583 |
| `document` | 13 |
| `fallback` | 2 |

## Tool names (`tool_use.name`)

| tool | count |
| --- | ---: |
| `Bash` | 7,467 |
| `Edit` | 4,339 |
| `Read` | 2,022 |
| `Agent` | 1,993 |
| `Write` | 569 |
| `TaskUpdate` | 350 |
| `Skill` | 314 |
| `TaskCreate` | 200 |
| `ToolSearch` | 86 |
| `RemoteTrigger` | 57 |
| `Workflow` | 21 |
| `WebSearch` | 14 |
| `WebFetch` | 13 |
| `EnterWorktree` | 12 |
| `mcp__obsidian-vault__obsidian_patch_content` | 11 |
| `SendMessage` | 11 |
| `AskUserQuestion` | 10 |
| `ExitWorktree` | 9 |
| `mcp__obsidian-vault__obsidian_get_file_contents` | 6 |
| `TaskStop` | 6 |
| `ScheduleWakeup` | 5 |
| `mcp__obsidian-vault__obsidian_delete_file` | 3 |
| `Monitor` | 3 |
| `ReportFindings` | 2 |
| `mcp__obsidian-vault__obsidian_append_content` | 2 |
| `mcp__obsidian-vault__obsidian_simple_search` | 2 |
| `mcp__plugin_github_github__list_pull_requests` | 2 |
| `CronList` | 1 |
| `mcp__obsidian-vault__obsidian_complex_search` | 1 |
| `mcp__obsidian-vault__obsidian_list_files_in_dir` | 1 |

## Attachment kinds

| attachment kind | count |
| --- | ---: |
| `hook_success` | 4,608 |
| `task_reminder` | 2,540 |
| `skill_listing` | 705 |
| `deferred_tools_delta` | 671 |
| `hook_additional_context` | 638 |
| `agent_listing_delta` | 602 |
| `command_permissions` | 323 |
| `edited_text_file` | 271 |
| `queued_command` | 194 |
| `mcp_instructions_delta` | 104 |
| `date_change` | 103 |
| `file` | 85 |
| `opened_file_in_ide` | 75 |
| `compact_file_reference` | 75 |
| `plan_mode_exit` | 71 |
| `nested_memory` | 48 |
| `read_truncation_notice` | 30 |
| `invoked_skills` | 28 |
| `dynamic_skill` | 18 |
| `diagnostics` | 13 |
| `auto_mode` | 12 |
| `budget_usd` | 10 |
| `task_status` | 5 |
| `hook_non_blocking_error` | 5 |
| `plan_mode` | 4 |
| `max_turns_reached` | 1 |

## Top-level keys

| key | count |
| --- | ---: |
| `type` | 124,038 |
| `sessionId` | 121,243 |
| `timestamp` | 94,567 |
| `parentUuid` | 84,424 |
| `isSidechain` | 84,424 |
| `uuid` | 84,424 |
| `userType` | 84,424 |
| `entrypoint` | 84,424 |
| `cwd` | 84,424 |
| `version` | 84,424 |
| `gitBranch` | 84,424 |
| `slug` | 66,895 |
| `message` | 65,347 |
| `session_id` | 52,936 |
| `requestId` | 42,728 |
| `promptId` | 22,569 |
| `toolUseResult` | 17,539 |
| `sourceToolAssistantUUID` | 17,539 |
| `attachment` | 11,239 |
| `permissionMode` | 10,345 |
| `effort` | 8,805 |
| `subtype` | 7,838 |
| `leafUuid` | 7,579 |
| `lastPrompt` | 7,517 |
| `mode` | 5,965 |
| `aiTitle` | 5,909 |
| `operation` | 5,837 |
| `sessionKind` | 5,093 |
| `isMeta` | 4,549 |
| `promptSource` | 4,372 |
| `prNumber` | 4,000 |
| `prUrl` | 4,000 |
| `prRepository` | 4,000 |
| `attributionSkill` | 3,922 |
| `origin` | 3,806 |
| `level` | 3,785 |
| `content` | 3,780 |
| `durationMs` | 3,728 |
| `messageCount` | 3,728 |
| `hookCount` | 3,696 |

## `message` keys

| message key | count |
| --- | ---: |
| `role` | 65,347 |
| `content` | 65,347 |
| `id` | 42,769 |
| `model` | 42,769 |
| `stop_details` | 42,769 |
| `stop_reason` | 42,769 |
| `stop_sequence` | 42,769 |
| `type` | 42,769 |
| `usage` | 42,769 |
| `diagnostics` | 42,384 |
| `context_management` | 404 |
| `container` | 385 |

## `message.role`

| role | count |
| --- | ---: |
| `assistant` | 42,769 |
| `user` | 22,578 |

## On-disk layout — CORRECTED 2026-08-01

The Slice-1.5 design (and the decisions doc it descends from) describes subagent transcripts as
living at `<project>/subagents/`. **That is wrong for CC 2.1.220.** Measured:

```
~/.claude/projects/
  <munged-project>/
    <session-uuid>.jsonl          <- 605 depth-1 session files
    <session-uuid>/
      subagents/*.jsonl           <- 1,884 files   (ONE LEVEL DEEPER than documented)
      subagents/workflows/wf_*/   <- a SECOND, NESTED tier — 1,022 files total:
          agent-*.jsonl               1,008 files
          journal.jsonl                  14 files   <- a THIRD file shape, not an agent transcript
      tool-results/*              <- 496 files across 43 dirs  (NOT mentioned anywhere in the design)
```

Consequences for the design:

1. ⚠ **The subagent glob must RECURSE: `<project>/*/subagents/` + `**` + `/*.jsonl`**, not
   `<project>/subagents/*.jsonl` and **not** the non-recursive `<project>/*/subagents/*.jsonl` this
   document prescribed until 2026-08-03. The originally documented form matches **zero** files, so
   the empty-join escalation would never fire at all. The non-recursive form is worse, because it
   fails *quietly*: it matches **1,884 of 2,907 files — 65%** — and under-reads the remaining 35%
   with no error, so the escalation appears to work while missing a third of the evidence.
   ⚠ **The recursive glob also ingests the 14 `journal.jsonl` workflow journals.** They are
   deliberately NOT name-excluded: the fail-closed rule handles them, since any line whose shape is
   unrecognised is skipped and counted. Name-excluding would encode an assumption that the tier is
   homogeneous, which it is not.
   ⚠ **Size the bounded-line read off the SUBAGENT maximum (3,798,052), not the depth-1 one
   (1,484,365).** A cap derived from the depth-1 figure silently skips real subagent lines on exactly
   the escalation path where under-reading is already invisible.
2. **`tool-results/` is a third data location the design does not model.** Q5 drops tool *outputs* as
   the largest secret reservoir; if outputs live in separate files, confirm whether the transform can
   simply never open this directory (cheap and total) — and whether anything else on the machine does.
3. Depth-1 discovery (`projects/*/*.jsonl`) is unaffected and still correct.

## Findings that bear on the Slice 1.5 design

### The harness-vs-human discriminator — RESOLVED 2026-08-01

The design needs to select "the segment-first substantive **non-synthetic user turn**" and says ~50%
of `user` lines are harness plumbing. Measured over 22,554 `user` lines (45-day window):

| `user` line shape | share | meaning |
| --- | ---: | --- |
| has a `tool_result` block **and** a top-level `toolUseResult` key | **77.6%** | harness plumbing — a tool response replayed as a "user" turn |
| `message.content` is a plain **string** | **20.7%** | **genuine human-typed turn** |
| `content` is text blocks only | 1.6% | |
| `content` has `document` blocks | 0.1% | |

**Discriminator: `toolUseResult` present ⇒ harness. `content` is a string ⇒ human.** Mechanical, no
heuristics. Useless as a discriminator, measured: `userType` is uniformly `"external"`.

⚠ **`isSidechain` is NOT useless — this document said so until 2026-08-03 and had it exactly
backwards.** Its *presence* is 100%, which is why a presence statistic reads as "always the same,
therefore no signal". Its **VALUE** is an exact main-vs-subagent discriminator: measured over the
whole corpus, `false` on **22,725 / 22,725** depth-1 user lines and `true` on **47,674 / 47,674**
subagent lines — zero exceptions in either direction. Do not confuse presence with value. A reader
that tests `"isSidechain" in line` is always true and classifies every depth-1 line as a subagent
line.

⚠ **The design's "~50%" understates it — the real figure is 77.6%.**

Other flags on `user` lines: `isMeta` 461 (2.0%), `isCompactSummary` 34 (0.15%).

- **`isCompactSummary` exists but is RARE: 34 occurrences against 22,578 `user` lines (0.15%).**
  The design says ~50% of `user` lines are harness plumbing that must be filtered, and names
  `isCompactSummary` as the exclusion. **It cannot be the mechanism** — it fires on 0.15% of user
  lines, not 50%. It is a narrow sub-case, not the filter. **The actual discriminator is
  `toolUseResult` / string-content — see the section above.** Keep `isCompactSummary` as an additional
  exclusion (the design requires it), but it is not the mechanism.
- **Fail-closed is mandatory.** The attachment-kind count is known to drift within hours
  (16 -> 23 -> 24 across three scans on 2026-07-25). Treat every enum here as open.
- **`thinking` is a first-class block type** and must sit in the not-readable tier.
- **`cwd` is present on most lines and is NOT trustworthy for attribution** — session resume rewrites
  it. See the design's ban.

