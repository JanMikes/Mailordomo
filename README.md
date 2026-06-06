# Mailordomo

A **local-first, AI-native email client for macOS** where **Claude is the engine, not a feature**.
It treats email as tasks: a background daemon triages mail, infers task state, tracks commitments
three ways, summarizes threads, drafts replies on signal, and surfaces a ranked "do-next" queue.
The human stays in control of the one irreversible act — **sending is always manual**.

> **Spec & plan:** [`PROJECT.md`](./PROJECT.md) is the authoritative "what and why";
> [`PLAN.md`](./PLAN.md) is the "how and when" + running log; [`PROGRESS.md`](./PROGRESS.md) is the
> per-session journal; [`CLAUDE.md`](./CLAUDE.md) is the operating manual for Claude Code.

## Golden rules (non-negotiable)

1. **Sending email is ALWAYS manual.** No code path sends mail without an explicit user action.
2. **No two-way database sync, ever.** IMAP is the truth for email; the metadata service for
   metadata; the local cache is disposable and rebuildable.
3. **Email bodies never leave the local machine.** Only metadata + subject/snippet/sender are shared.
4. **Never commit secrets.** Credentials live in the macOS Keychain or a local `{mailbox}.env`.

## Architecture (three layers)

- **Layer 1 — Email transport & truth:** IMAP/SMTP direct to providers; coarse task state mirrored
  to real IMAP folders so Apple Mail / iPhone stay consistent.
- **Layer 2 — Shared metadata service:** Dockerized, token-auth API (Hono + better-sqlite3). Source
  of truth for task state, deadlines, 3-way promises, notes, locks, and shared digest metadata.
- **Layer 3 — Local app:** Node/TS backend + React/Tailwind/shadcn frontend on localhost; spawns the
  headless `claude` binary; SQLite + raw `.eml` cache; tone-memory markdown synced via the server.

## Monorepo layout

```
packages/
  shared/     zod schemas + inferred types + routing/state constants (one source of truth)
  server/     metadata service (Hono + better-sqlite3) + Dockerfile + GHCR workflow
  backend/    local app backend (imap, smtp, cache, threading, claude, daemon, engines)
  frontend/   Vite + React + Tailwind + shadcn/ui
prompts/      editable per-task system-prompt markdown (read at runtime)
scripts/      tooling (e.g. refresh-fixtures for LLM golden cases)
```

## Requirements

- **Node 22 LTS** (pinned via `.nvmrc`). The dev machine may run a newer Node; `better-sqlite3`
  ships a prebuilt binary for current Node releases (verified on Node 25 / arm64).
- The headless **`claude`** binary on `PATH` for the reasoning core.

## Quick start

```bash
npm install        # installs workspaces + git hooks (husky)
npm run verify     # typecheck + lint + test + build — the single quality gate
```

`npm run verify` is the definition of "buildable." The git hooks run the same checks: a fast
**pre-commit** (typecheck + lint-staged + affected tests) and a full **pre-push** (`npm run verify`).

## Running it

Mailordomo is three processes: the **metadata service** (shared, Dockerized), the **local backend**
(loopback API + the background daemon), and the **frontend** (the UI).

1. **Metadata service** (Layer 2) — build + run the Docker image; see
   [`packages/server/README.md`](./packages/server/README.md) for the build/run command and its env
   (project token, volume). It listens on `:8787`.
2. **Configure** — either copy [`.env.example`](./.env.example) → `.env` (gitignored) and fill in the
   metadata + mailbox settings, **or** use the in-app **setup wizard** (the "Setup" view: project →
   mailbox + provider preset → repo → Claude health). Credentials go to the **macOS Keychain**
   (preferred) or a per-mailbox `{mailbox}.env` — **never committed** (golden rule #4).
3. **Backend + frontend** (dev):
   ```bash
   npm run build                                   # build the backend server bundle + the frontend
   npm start                                       # backend API on http://127.0.0.1:4317 (daemon OFF by default)
   npm run dev --workspace=@mailordomo/frontend    # the UI (Vite), proxying /api to the backend
   # optional: npm run seed:today                  # populate the metadata service with demo data to explore the UI
   ```
4. **Install as a background service** (macOS launchd) — runs the backend + daemon continuously:
   ```bash
   npm run build
   bash ops/install-launchd.sh   # renders + bootstraps ~/Library/LaunchAgents/com.mailordomo.backend.plist
   ```
   The service sets `MAILORDOMO_DAEMON=on`, so the daemon continuously polls → triages → tracks
   promises → summarizes → drafts the sanctioned overdue-nudge. **It never sends** — every send is a
   manual click in the work surface. Logs: `~/.mailordomo/logs/backend.{out,err}.log`; stop with
   `launchctl bootout gui/$(id -u)/com.mailordomo.backend`.

## Status

Feature-complete through the planned phases (scaffold → shared contracts → metadata service →
transport/cache/engines → Claude job runner → integration → 3-way promises/ranking → tone memory →
frontend → setup wizard → digest/daemon/E2E). See [`PLAN.md`](./PLAN.md) §10 for the phase log and
[`PROGRESS.md`](./PROGRESS.md) for the per-session journal.

## License

MIT — see [`LICENSE`](./LICENSE).
