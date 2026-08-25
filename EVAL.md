# EVAL — self-audit protocol

The tool ships its own evaluation harness; this file is where YOU accumulate results for your
own briefings (the author's log is private and not part of this repo).

- `bun run audit` — adversarially evaluates today's briefing: deterministic checks (every cited
  SHA resolves; same-day commits the briefing missed; repos with unnamed uncommitted work) plus an
  LLM judge fed an independent git ground truth. Prints a report and a ready-to-paste row.
- `bun run eval` — replays the gold cases in `src/eval/` against your configured provider.

The LLM judge is deliberately **non-gating**: it has produced confident, specific, wrong claims —
treat it as an input to a row, never an authority over one.

| Day | Date | Ground | Judge | Act | Notes |
| --- | --- | --- | --- | --- | --- |
