# Editable per-task system prompts

These Markdown files are the **editable per-task system prompts** the Claude job runner passes via
`--system-prompt-file`, layered with the relevant tone-memory file via `--append-system-prompt-file`
(PROJECT.md §4). They are read at **runtime**, so they can be tuned without code changes.

Files (added with their consumers in Phases 4–9):

- `triage.md` — triage / state classification (Haiku, `--json-schema`) — **added (Phase 4)**
- `summarize.md` — thread summarization (Sonnet) — **added (Phase 4)**
- `extract-promises.md` — 3-way promise extraction (Haiku→Sonnet, `--json-schema`) — Phase 5
- `draft.md` — reply drafting (Opus) — Phase 5/7
- `digest.md` — morning digest synthesis (Sonnet) — Phase 9
- `nudge.md` — the one sanctioned overdue-nudge auto-draft (Opus) — Phase 5

The backend resolves this directory at runtime (`packages/backend/src/claude/prompts.ts`): it walks
up from the module to find `prompts/`, or honors `CLAUDE_PROMPTS_DIR` if set. Editing a file here
changes the system prompt with no code change or rebuild.
