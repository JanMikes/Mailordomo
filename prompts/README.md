# Editable per-task system prompts

These Markdown files are the **editable per-task system prompts** the Claude job runner passes via
`--system-prompt-file`, layered with the relevant tone-memory file via `--append-system-prompt-file`
(PROJECT.md §4). They are read at **runtime**, so they can be tuned without code changes.

Planned files (added with their consumers in Phases 4–9):

- `triage.md` — triage / state classification (Haiku, `--json-schema`)
- `extract-promises.md` — 3-way promise extraction (Haiku→Sonnet, `--json-schema`)
- `summarize.md` — thread summarization (Sonnet)
- `draft.md` — reply drafting (Opus)
- `digest.md` — morning digest synthesis (Sonnet)
- `nudge.md` — the one sanctioned overdue-nudge auto-draft (Opus)
