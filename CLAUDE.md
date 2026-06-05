# CLAUDE.md — Mailordomo

Standing instructions for Claude Code. Read this at the start of every session. It survives
context resets; `PROJECT.md` (the spec) and `PLAN.md` (the live plan + progress) are your other
two durable references — re-read all three when context is fresh.

## What this is

**Mailordomo** is a local-first, AI-native email client for macOS where Claude is the engine,
not a feature. It treats email as tasks, triages and drafts autonomously in the background,
tracks commitments three ways, and surfaces what to do next. Full intent lives in `PROJECT.md`.
Do not re-derive the architecture from memory — `PROJECT.md` is authoritative; if something
here and there conflict, `PROJECT.md` wins and you should fix this file.

## Golden rules (do not violate)

1. **Sending email is ALWAYS manual.** No code path sends mail without an explicit user action.
   The background daemon may draft (including the sanctioned overdue-nudge case) but never send.
2. **No two-way database sync, ever.** IMAP is the truth for email; the metadata service is the
   truth for metadata; the local SQLite + message-file cache is disposable and rebuildable.
   Tone-memory markdown syncs via the server as arbiter, last-write-wins per file. If you find
   yourself writing merge/reconciliation logic between two writable stores, stop — you've taken
   a wrong turn.
3. **Email bodies never leave the local machine.** Only metadata + subject/snippet/sender go to
   the server.
4. **Never commit secrets.** Credentials live in local `{mailboxName}.env` (or Keychain if
   implemented). Always provide `.env.example`. Scan diffs before committing.
5. **Claude is invoked as the headless binary** (`claude -p`, `--model` per task). No SDK. Each
   call is stateless — pass all needed context as files/args; replay history for the refine chat.
6. **Fixed model routing.** Haiku = triage/extraction; Sonnet = summaries/digest/ranking; Opus =
   drafts & repo-aware code answers. Never route outgoing-text generation below Opus.

## Autonomous working agreement

- **Push directly to `main`.** Small, coherent commits with clear messages
  (`feat:`, `fix:`, `chore:`, `test:`, `docs:`).
- **Keep `main` buildable at every phase boundary.** Never end a session with a broken build.
- **Use subagents** for independent workstreams (metadata service, IMAP/SMTP sync, Claude job
  runner, frontend, setup wizard) to parallelize and keep contexts tight.
- **Update `PLAN.md` as you go** — check off milestones, note decisions, record anything you
  deferred. It is the running log of the build.
- When you hit an underspecified decision: pick the simplest option consistent with the golden
  rules, **record it in `PLAN.md` under "Decisions made"**, and continue. Don't stall.
- The only mandatory stop is after the initial `PROJECT.md` + `PLAN.md` are committed — wait for
  approval before implementing. After that, run.

## Architecture quick map

- **Email transport:** IMAP/SMTP direct to providers. Bidirectional — moves/flags/sends reflect
  on the server (Apple Mail / iPhone / Simona stay consistent). Coarse task state mirrors to
  **real IMAP folders**.
- **Metadata service:** Dockerized, token-auth API. Source of truth for task state, deadlines,
  3-way promises, notes, repo pointers, draft history, locks, and subject/snippet/sender for
  shared digests. Ships `Dockerfile` + GHCR build-and-publish Actions workflow (no deploy) +
  `README.md`. Default stack Node/TS (Hono/Fastify) unless `PLAN.md` justifies otherwise.
- **Local app:** Node/TS backend + React/Tailwind/shadcn frontend on localhost; spawns the
  Claude binary; SQLite index + raw message files as disposable cache; tone-memory markdown
  files synced via server. Installable as a launchd service.

## Code conventions

- **TypeScript everywhere it's reasonable**; strict mode on. Share types between client and
  server via a common package.
- **Frontend:** React + Tailwind + shadcn/ui + Lucide. Sentence case in UI copy. Light/dark.
  Don't trap the user in the opinionated view — the 3-pane fallback must always work.
- **No HTML `<form>` submits where an event handler is cleaner; no browser localStorage as a
  source of truth.**
- **Tests:** unit-cover the load-bearing engines — promise extraction (3-way), the task state
  machine, the do-next ranking, and IMAP folder mapping — plus the metadata API. One thin E2E
  for poll → triage → draft → send(stub).
- **Editable per-task system prompts** live as markdown files under a known dir; the app reads
  them at runtime so they can be tuned without code changes.

## Behavioral invariants to honor in code

- Task states: `needs-reply → drafted → waiting → follow-up(+deadline) → done` ("done" includes
  no-reply-needed). Auto-set obvious transitions; propose ambiguous ones.
- Organizing/moving may be autonomous but **proposed-with-undo and logged**.
- Learning is **silent + changelog + revertable**, sourced from recurring instructions and the
  draft-vs-sent diff. Tone memory is layered: project → mailbox → contact (contact overrides).
- 3-way promise tracker: my promises (deliver) / they asked (I owe) / awaiting them (chase).
- Do-next ranking order: my promises → sender importance → staleness → consequence.
- Thread **locks** (`locked_by` + `locked_at` + timeout) prevent Jan/Simona double-handling.

## When in doubt

Prefer the simplest thing that respects the golden rules. Favor deleting complexity over adding
sync. Keep the daemon's autonomy conservative for v1 (draft-on-signal), but structure the code
so eagerness can be raised later without a rewrite.
