# Contributing

Thanks for your interest in `daily-briefing`! This is a small, focused tool — a local, resumption-focused
morning briefing for developers who work with AI coding assistants. Contributions are welcome; this guide
covers how to get set up and what to expect.

## Ground rules

- **Open an issue first for anything non-trivial.** For bugs, a small reproduction helps. For features,
  a quick "here's the problem / here's the shape of the fix" discussion avoids wasted work — the tool has
  a deliberate scope (read local git → generate a resumption briefing), and not every idea fits it.
- **Keep it local-first and provider-agnostic.** The tool reads *local* git history and calls a
  **bring-your-own** AI CLI. Please don't add network calls to third-party services, telemetry, or a
  hardcoded/bundled AI provider.
- **Keep changes scoped to this tool.** One fix or feature at a time, inside this project's own
  tree.

## Prerequisites

- [Bun](https://bun.sh) **1.3.14+** (CI pins `1.3.14` for reproducibility).
- Git (the tool shells out to it).
- macOS for the *scheduled-delivery* path (launchd); the core CLI itself is cross-platform.

## Setup

```bash
bun install --frozen-lockfile
bun run start          # run the briefing against your own repos (see README for config)
```

## The gate — run this before every push

CI runs a frozen-lockfile install (`bun install --frozen-lockfile` — so a dependency change must be
committed to `bun.lock`) plus exactly these two checks (see the CI workflow),
and a PR won't merge until all pass. Run the two checks locally first:

```bash
bunx tsc --noEmit      # strict type-check (or: bun run typecheck)
bun test               # the full suite (or: bun run test)
```

Both must be clean. That's the whole bar for a green build.

## Tests

This project is **test-driven** — a change should come with tests, and existing behavior must stay green.

- **Write the failing test first**, then the fix. New tests must be **non-vacuous**: a good check is that
  reverting your source change makes the new test *fail*. (Reviews explicitly look for this.)
- Prefer small, focused test cases over broad end-to-end ones. Use the existing fixtures
  (`test/fixtures/`) and patterns (`buildRepo`, `withEnv`, `captureConsole`, `spyOn(Bun, "spawn")`).
- Pure logic belongs in `src/` (unit-testable); CLI orchestration lives in `scripts/`. If you're adding
  logic to a script, factor the testable part into `src/` so it gets coverage.

## Frozen contracts

`src/types.ts` defines `Activity`, `BriefingStruct`, and `ReducedContext`. These are **frozen**: only
**additive, optional** fields may be appended. Never rename, remove, retype, or change the required-ness
of an existing field — downstream consumers depend on the shape. The type-check gate will catch most
violations, but be deliberate here.

## Commits & pull requests

- **Conventional Commits**: `type(dba): summary` — e.g. `feat(dba): …`, `fix(dba): …`, `perf(dba): …`,
  `docs(dba): …`, `test(dba): …`.
- Keep PRs **small and single-purpose** — one fix or feature per PR, with its tests. A focused PR is far
  easier to review and merge than a large mixed one.
- In the PR description, say what changed and how you verified it (the `tsc` + `bun test` result).
- Branch off `main`, push your branch, and open the PR against `main`. CI runs automatically.

## Reporting security issues

If you find a security issue (e.g. something that lets a hostile repo's data escape the local boundary),
please open an issue describing it — since the tool is local-only, there's no server to disclose to
privately, but flag it clearly so it can be prioritized.

## Questions

Not sure whether something fits, or how to test it? Open an issue and ask — happy to help.
