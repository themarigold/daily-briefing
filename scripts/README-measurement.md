# Transcript measurement scripts (dev-only, Python 3)

Not part of the shipped binary (`install.sh` compiles `src/main.ts` only). They exist so the
`[V]` figures in the Slice 1.5 design are **reproducible**, not merely once-measured.

⚠ **They read the local Claude Code transcript corpus** (`~/.claude/projects`). They extract only
`sessionId`, timestamps, and `tool_use.input.file_path`, and emit **aggregate counts only** — no
conversation content is printed or written. Nothing is sent anywhere.

| Script | Produces |
| --- | --- |
| `derive-transcript-schema.ts` | regenerates the facts behind `docs/transcript-schema.md`; field NAMES and COUNTS only |
| *(schema)* | `docs/transcript-schema.md` was derived by the same method; regenerate before trusting it against a new CC version |

One-off measurement tools, not product code — a further set of dated, author-machine-specific
measurement scripts exists only in the author's private tree and is deliberately not shipped.
