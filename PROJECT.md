# PROJECT.md — Mailordomo

> **Status:** Authoritative specification. This is the durable "what and why."
> `PLAN.md` is the "how and when" (phases, tooling, progress). `CLAUDE.md` is the standing
> operating manual for Claude Code. If any two conflict, **PROJECT.md wins** and the other
> should be corrected.
>
> Renamed from the brief's working title "Postino" → **Mailordomo** (already the directory and
> `CLAUDE.md` name). See [§13](#13-gaps-and-decisions) for naming.

---

## 1. What Mailordomo is

Mailordomo is a **local-first, single-user-per-machine, AI-native email client for macOS** in
which **Claude is the engine, not a feature**. It is built for a power user (a PHP/TS developer)
who runs **multiple employers**, each with **one or more mailboxes**, and who **shares some
mailboxes with a second person (Simona)**.

The guiding principle: **email is treated as tasks.** The default surface is not an inbox; it is
a productivity command center that answers one question — *"what do I need to deliver, and to
whom?"* A background daemon continuously triages mail, infers task state, tracks commitments in
three directions, summarizes threads, drafts replies on signal, and surfaces a ranked
"do-next" queue. The human stays in control of the one irreversible act: **sending**.

What makes it *AI-native* rather than *AI-assisted*: the Claude binary is invoked headlessly as
the system's reasoning core on every inbound message and at every decision point, with fixed,
predictable model routing and editable per-task prompts. Email content is read by Claude
**locally**; only non-body metadata is ever shared.

---

## 2. Golden rules (non-negotiable invariants)

These constrain every design and code decision. They mirror `CLAUDE.md §Golden rules` and are
authoritative here.

1. **Sending email is ALWAYS manual.** No code path sends mail without an explicit user action.
   The daemon may *draft* — including the one sanctioned overdue-nudge case — but **never sends**.
2. **No two-way database sync, ever.** IMAP is the truth for email; the metadata service is the
   truth for metadata; the local SQLite + message-file cache is **disposable and rebuildable**.
   Tone-memory markdown syncs via the server as arbiter, **last-write-wins per file**. If we ever
   find ourselves writing merge/reconciliation logic between two *writable* stores, we have taken
   a wrong turn.
3. **Email bodies never leave the local machine.** Only **metadata + subject + snippet + sender**
   go to the server. (See [§5](#5-data-model-and-the-privacy-boundary) for the exact shared
   surface and the two sanctioned, non-body exceptions: bounded *snippets* and *tone-memory
   files*.)
4. **Never commit secrets.** Credentials live in **macOS Keychain** (preferred) or local
   `{mailboxName}.env` (fallback). Always ship `.env.example`. Scan diffs before committing.
5. **Claude is invoked as the headless binary** (`claude -p`, `--model` per task). **No SDK.**
   Each call is **stateless**; all persistent context is passed as files/args. The multi-turn
   "refine draft" chat works by **replaying history** into a fresh call.
6. **Fixed model routing.** Haiku = triage/extraction; Sonnet = summaries/digest/ranking; Opus =
   drafts & repo-aware code answers. **Never route outgoing-text generation below Opus.**

---

## 3. The three-layer architecture (the spine — do not collapse it)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  LAYER 1 — EMAIL TRANSPORT & TRUTH        (IMAP/SMTP, direct to providers)      │
│  • Source of truth for raw email + COARSE task state (real IMAP folders)        │
│  • Bidirectional: moves/flags/sends reflect on the server (Mail.app, iPhone,    │
│    Simona's client stay consistent)                                             │
└───────────────▲───────────────────────────────────────────────┬───────────────┘
                │ raw messages, flags, folders                   │ moves/flags/append
                │                                                 ▼
┌───────────────┴───────────────────────────────────────────────────────────────┐
│  LAYER 3 — LOCAL APP (per machine)         the client + the Claude engine        │
│                                                                                  │
│   ┌────────────┐   ┌─────────────┐   ┌──────────────┐   ┌────────────────────┐  │
│   │ IMAP/SMTP  │   │ Disposable  │   │ Claude job   │   │ React frontend     │  │
│   │ sync engine│──▶│ cache:      │◀──│ runner       │◀─▶│ (Today / projects/ │  │
│   │ (imapflow) │   │ SQLite+FTS5 │   │ (spawns      │   │  3-pane / split)   │  │
│   │ + nodemailer│  │ + .eml files│   │  `claude -p`)│   │  on localhost      │  │
│   └────────────┘   └─────────────┘   └──────────────┘   └────────────────────┘  │
│         │                                   │  ▲                                 │
│         │            background daemon:     │  │ tone-memory markdown (local)    │
│         │            poll→triage→state→     │  │                                 │
│         │            promises→stale→summary │  │                                 │
└─────────┼───────────────────────────────────┼──┼─────────────────────────────────┘
          │ metadata only (token auth)         │  │ tone-memory sync (LWW per file)
          ▼                                     ▼  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  LAYER 2 — SHARED METADATA SERVICE          (Dockerized, token-auth API)        │
│  Source of truth for: task state & transitions, deadlines/follow-ups,           │
│  3-way promises, notes, repo pointers, draft *metadata*, locks, and             │
│  subject/snippet/sender for shared digests. Ships Dockerfile + GHCR workflow.    │
│  NEVER stores raw email bodies or draft bodies.                                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Layer 1 — Email transport & truth (IMAP/SMTP, direct to providers)

- Full IMAP sync (read) and SMTP send. **Bidirectional**: when the app moves/flags/sends, it is
  reflected on the server so Apple Mail / iPhone / Simona's normal client stay consistent.
- The **IMAP server is the source of truth** for raw email and for the **coarse task state**
  (done / not-done, optionally waiting) **mirrored as real IMAP folders** — clean and universally
  visible in Mail.app — so a second human operating the same mailbox stays in sync without
  Mailordomo.
- Library: **`imapflow`** (IMAP) + **`mailparser`** (parsing) + **`nodemailer`** (SMTP). All MIT,
  same author (Postal Systems), designed to interoperate. Two hard constraints baked into the
  design (see [§4 Transport notes](#transport-engine-notes)): ImapFlow does **not** auto-reconnect,
  and IDLE requires **one connection per watched mailbox**.

### Layer 2 — Shared metadata service (Dockerized, token-authenticated)

- **Source of truth for everything that is not raw email and needs sharing** between Jan and
  Simona: task states & transitions (with actor attribution), deadlines/follow-ups, the **3-way
  promise records**, per-thread notes, repo pointers, **draft metadata** (existence/model/
  timestamps — *not* content), **locks** (`locked_by` + `locked_at` + timeout), and
  **subject/snippet/sender** for shared digests.
- **Auth & pairing:** a **project** has an `id` + **secret token**; both Jan's and Simona's local
  apps are configured with it. The token pairs them to the shared project. Simple bearer auth.
- **Stack:** **Hono** on Node/TS, **`better-sqlite3` (WAL mode)** persistence behind a thin
  repository layer (justification in `PLAN.md`). Shares types with the local app via the
  `shared` package.
- **Ships:** `Dockerfile`, a **GitHub Actions workflow that builds and publishes the image to
  GHCR** on push/tag (**no deploy step**), and a service `README.md`.

### Layer 3 — Local app, per machine (the client + the Claude engine)

- A **local web app** (not Electron, not Docker): a Node/TS backend serving a React frontend on
  `localhost`. The backend spawns the Claude binary and reaches the local filesystem/repos.
  Runs via `npm start`; installable as a macOS **launchd** service.
- **Disposable local cache:** **`better-sqlite3`** index (fast search/threading/sorting, **FTS5**
  full-text) **plus raw `.eml` message files + attachments on disk** that Claude reads natively.
  The cache is **never** a synced replica — if deleted it rebuilds from IMAP (email) + the
  metadata API (metadata). **No two-way DB sync anywhere.**
- **Tone / voice memory:** local **Markdown files** Claude reads directly, kept in sync across
  machines via the metadata server as the reconciliation point (**server arbitrates,
  last-write-wins per file**; edits are rare and small so conflicts are negligible). These are
  "Claude's native memory."

---

## 4. The Claude engine (execution model)

Claude is invoked as the **headless `claude` binary** — **no SDK**. Each invocation is
**stateless**; all persistent context lives in files (tone memory, thread summaries, cached
messages) and the metadata API. The local backend runs a **job queue** that spawns these
invocations with **fixed model routing** and **editable per-task system prompts**.

### Verified invocation model (ground-truthed against `claude` v2.1.165 on this machine)

| Need | Mechanism |
|---|---|
| One-shot prompt | `claude -p "<prompt>"` (or via stdin; **stdin capped at 10 MB**) |
| Model routing | `--model haiku\|sonnet\|opus` (aliases resolve to latest stable: opus→`claude-opus-4-8[1m]`, sonnet→`claude-sonnet-4-6`, haiku→`claude-haiku-4-5`). **Pin by alias.** |
| Cost/usage per call | `--output-format json` → `{ result, structured_output, session_id, total_cost_usd, usage{input/output/cache tokens}, modelUsage, is_error, api_error_status, num_turns }` |
| **Editable prompts** | `--system-prompt-file <task.md>` (+ `--append-system-prompt-file <tone.md>`) — **layer** the per-task system prompt with the relevant tone-memory file. Files are read at runtime → tunable without code changes |
| **Reliable structured output** | `--json-schema '<schema>'` → constrained result returned in `structured_output`. Used for triage classification and promise extraction (no fragile free-text parsing) |
| Non-hanging daemon jobs | `--permission-mode dontAsk --allowedTools "Read"` for read-only jobs; never `default`/`plan` (they block on prompts). Consider `--bare` to skip hook/plugin discovery |
| Repo-aware reads | `--add-dir <repoPath> --allowedTools "Read"` scopes a job to a repo |
| Hang protection | wrap each call in shell `timeout` (e.g. `timeout 60s claude -p …`) |
| Concurrency | multiple `claude -p` processes run safely in parallel (each gets a unique `session_id`) |
| Multi-turn refine chat | **Replay full history** into a fresh `-p` call each turn (golden rule #5). `--continue`/`--resume` exist but we do not depend on local session state |

### Fixed model routing (predictable cost)

| Task | Model | Notes |
|---|---|---|
| Triage / state classification | **Haiku** | Runs on every incoming message (high volume). `--json-schema` for the decision |
| Promise extraction (structured) | **Haiku** (escalate to **Sonnet** if quality demands) | `--json-schema`; feeds the deterministic 3-way reconciler |
| Thread summarization, daily digest, do-next tie-breaks | **Sonnet** | Much of ranking is deterministic code; model used only for judgment tie-breaks |
| Drafting replies & repo-aware technical answers | **Opus** | Anything sent under the user's name or touching code. **Never cheap out here.** |

### Job runner notes

- The runner is an **interface** with a real (spawns `claude`) and a **fake** (returns canned
  `structured_output`) implementation, so all downstream logic is testable without the API.
- Every call logs `total_cost_usd` + token usage; a **daily budget cap** applies backpressure to
  non-essential jobs (see `PLAN.md` open questions).

### Transport engine notes

- **ImapFlow does NOT auto-reconnect.** The sync engine owns reconnection (exponential backoff +
  jitter on `'close'`/`'error'`), re-validates `uidValidity`, and resyncs from the last-seen
  UID/modseq (CONDSTORE/QRESYNC make deltas cheap).
- **One IMAP connection per watched mailbox.** IDLE only *hot* folders (INBOX, maybe Sent);
  **poll** the rest on an interval. Respect provider connection caps (iCloud is conservative).
  Set `maxIdleTime` comfortably under the ~29-minute RFC ceiling so IDLE self-renews.
- **SMTP send does not file a Sent copy** (except Gmail) → after sending, `append()` the raw MIME
  to the **Sent** folder; same pattern for **Drafts**. Resolve folder names via **SPECIAL-USE**
  flags (`\Sent`, `\Drafts`, `\Trash`, `\Junk`), never hardcode English names.
- Replies must set **`In-Reply-To` + `References`** from the parent for correct threading; capture
  the returned `Message-ID`.

---

## 5. Data model and the privacy boundary

The single most important architectural rule is **where each piece of data lives**. Raw email is
IMAP's; metadata is the service's; the local cache is disposable.

### What lives WHERE

| Data | Local machine (cache/files) | Metadata service (shared) | Never stored on server |
|---|:---:|:---:|:---:|
| Raw email bodies (`.eml`), attachments | ✅ (truth: IMAP) | — | ✅ never |
| Draft **bodies** + refine-chat transcripts | ✅ | — | ✅ never |
| Subject, **snippet** (bounded ~200 chars), sender | ✅ | ✅ (for shared digest) | — |
| Task state, transitions (+ **actor**), deadlines, follow-ups | mirror | ✅ **truth** | — |
| 3-way promises (direction, text, due, status) | mirror | ✅ **truth** | — |
| Per-thread notes | mirror | ✅ **truth** | — |
| Repo pointers (identity: name + git URL) | local path is **machine-local** | ✅ identity only | local path stays local |
| Draft **metadata** (exists?, model, timestamps, author) | ✅ | ✅ (for "what Claude drafted") | draft body never |
| Locks (`locked_by`, `locked_at`, `expires_at`) | mirror | ✅ **truth** | — |
| Tone-memory markdown files | ✅ (Claude reads here) | ✅ synced (LWW per file) | — |
| Learning changelog (revertable) | ✅ | ✅ (alongside tone files) | — |
| IMAP/SMTP credentials | ✅ **Keychain**/`.env` | — | ✅ never |

**Two sanctioned non-body exceptions** to "bodies never leave," both explicit in the brief:
1. **Snippet** — a short, bounded excerpt (subject + ~200-char preview) needed for shared digests.
2. **Tone-memory files** — *derived* voice/style memory the user controls and opts into syncing;
   they are not raw inbound email. (Where an example phrasing is stored, it is memory, not a live
   message body.)

**Clarification (resolving an apparent conflict in the brief):** the brief lists "draft history"
as a metadata-service responsibility *and* says bodies never leave. We resolve this by storing
**draft metadata only** on the server (that a draft exists, which model, when, by whom) and
keeping **draft content local**. This satisfies the shared digest's "what Claude drafted" line
without exporting body text.

### Entities (metadata service)

`Project(id, name, token_hash)` · `Thread(id, project_id, mailbox_address, root_message_id,
subject, snippet, sender, …)` · `Task(thread_id, state, deadline, follow_up_at, importance,
…)` · `TaskTransition(task_id, from, to, actor, at)` · `Promise(thread_id, direction, text,
due_at, status, actor)` · `Note(thread_id, author, body, at)` · `RepoPointer(project_id, name,
git_url, …)` · `DraftMeta(thread_id, version, model, author, at)` · `Lock(thread_id, locked_by,
locked_at, expires_at)` · `ToneFile(project_id, scope, path, content, version_hash, updated_by,
updated_at)` · `LearningEntry(scope, summary, applied_at, reverted_at?)`.

The full shape lives as **zod schemas in the `shared` package** and is the single source of
truth for both client and server types.

---

## 6. Behavior & autonomy model

### Email-as-task state machine

```
needs-reply ──▶ drafted ──▶ waiting ──▶ follow-up(+deadline) ──▶ done
     │                                                            ▲
     └────────────────────── (no reply needed: "thanks") ────────┘
```

- `done` includes the **no-reply-needed** case ("they just said thanks").
- Claude **auto-sets obvious transitions** (I sent → `waiting`; inbound "thanks" → `done`) and
  **proposes ambiguous ones** for confirmation.
- **Coarse** state (done / not-done, optionally waiting) is **mirrored to real IMAP folders** so
  Simona and Mail.app stay consistent; **fine** state lives in the metadata service.

### Autonomy

- **Background daemon** polls IMAP and runs: triage + state inference, 3-way promise tracking,
  stale-thread detection, thread summarization. It does **not** draft unprompted — **except** the
  one sanctioned case: when an **inbound promise lapses** (someone promised *you* a reply and the
  deadline passed), it **auto-drafts a nudge, ready to send** (still requires a manual send).
- **Drafting is on-signal** for v1: the user opens a thread and clicks draft, with an optional
  **instruction textarea** ("context for Claude") — the reusable primitive that appears at draft
  time and in the refine chat. Designed so eagerness can be dialed up later without a rewrite.
- **Sending is ALWAYS manual.** The user edits a draft directly or refines it by chatting.
- **Organizing / moving** may be **autonomous but proposed-with-undo**, and **fully logged**.
- **Continuous learning is silent + logged + revertable:** Claude updates tone-memory markdown
  from (a) recurring draft instructions and (b) the **diff between its draft and what the user
  actually sent**, writing a changelog the user can review and revert. Tone memory is **layered:
  project → mailbox → contact** (contact overrides).
- **Locks** prevent Jan and Simona double-handling a thread: claim on open (`locked_by` +
  `locked_at`), visible presence indicator, **timeout release**.

---

## 7. The 3-way promise tracker (load-bearing — must be good)

One extraction engine pointed three directions, surfaced in one unified, color-coded view, and
driving the top of the do-next queue:

| Direction | Meaning | Action | Color |
|---|---|---|---|
| **My promises** | Commitments I made | **Deliver** these | 🟢 green |
| **They asked** | Their requests/deadlines of me | I **owe** | 🟡 amber |
| **Awaiting them** | Their promises to me | **Chase/nudge** if overdue | 🔵 blue |

Design: an **LLM extraction step** (`--json-schema`, Haiku→Sonnet) produces structured promise
candidates; a **deterministic reconciler** buckets them into the three directions, tracks status
(`open → fulfilled | overdue | cancelled`), and resolves due dates. Splitting LLM extraction from
deterministic reconciliation is what makes this engine **unit-testable** (extraction mocked;
reconciliation pure). Natural-language deadlines ("by Friday") are resolved by anchoring the
LLM's relative date to the **message received date** in the **mailbox timezone**
(Europe/Prague).

---

## 8. "Do next" ranking priority (in order)

1. **Promises/deadlines I made** (commitments first).
2. **Sender importance** (paying clients > internal > newsletters).
3. **Age / staleness** (oldest unanswered first).
4. **Claude's judgment of consequence** (what hurts most if ignored — Sonnet **tie-break only**).

Ranking is **mostly deterministic code** over metadata; the model is used only to break ties at
step 4. Sender importance is sourced from per-contact/per-project importance stored in the
metadata service, seeded heuristically (project-domain match ⇒ client; newsletter patterns ⇒
demote) and user-adjustable.

---

## 9. Feature set (v1 must-haves)

Triage & state inference · auto-draft on signal (ready & waiting) · 3-way promise/follow-up
tracking · thread summarization · **morning digest** (what needs you today, promises due, what
Simona handled, what Claude drafted) · repo-aware technical answering · **"what should I do
next" ranked queue** · stale-thread nudge detection.

---

## 10. Projects, mailboxes, repos (setup)

- Organize as **Projects** (employers) → each has one or more **mailboxes** (IMAP/SMTP).
- **Guided setup wizard:** add project → add mailbox → enter IMAP/SMTP creds → link a repo.
  **Raw config/`.env` editing must also always work** for a dev.
- **Credentials:** **macOS Keychain** preferred (via the `security` CLI — no native dependency),
  with per-mailbox `{mailboxName}.env` as a documented fallback/dev mode. iCloud (`@me.com`)
  **requires an app-specific password**; Gmail needs OAuth2 or an app password (personal + 2FA).
- **Repo pointer — two modes:**
  - **Local path** (preferred): the maintainer's live clone; Claude reads files directly via
    `--add-dir`.
  - **Git URL fallback** (e.g. for Simona, a non-maintainer): keep a **read-only mirror**; an
    **"actively git pull" checkbox** keeps it fresh on a schedule so even a non-maintainer's
    Claude has current code for context.

---

## 11. UI / UX

- **Stack:** React + **Tailwind** + **shadcn/ui** + **Lucide**. Polished, productivity-focused,
  native-feeling. **Light/dark.** **Sentence case** in UI copy.
- **Views:**
  - **"Today" command center** (default): 3-way promise metric cards + done-vs-remaining counts
    + ranked do-next task cards (state badge, project, deadline, draft-ready indicator, inline
    actions).
  - **All-projects** and **per-project** (threads grouped by state).
  - **Classic 3-pane fallback** toggle — the user is **never trapped** in the opinionated view.
- **Work surface (split):** **thread on the left** (Claude's summary pinned at top + a
  repo-freshness indicator), **draft + refine-chat on the right** (model badge, **Send as primary
  action**, edit/snooze beside it, refine chat with the **instruction textarea pinned at bottom**).
- Two reference mockups (Today command center; split thread+draft+refine) were produced in the
  design conversation; recreate their structure and intent faithfully, refining visual details
  with good design judgment.

---

## 12. Technology stack (decided)

| Concern | Choice | One-line justification |
|---|---|---|
| Language | **TypeScript**, strict | One language client→server→shared; share types |
| Monorepo | **npm workspaces** | Matches `npm run verify`; no extra tooling |
| Shared contracts | **zod** schemas in `shared` | Runtime validation + inferred types, one source |
| Metadata service | **Hono** | Lightweight, fast, first-class TS, recommended |
| Server persistence | **better-sqlite3** (WAL) behind a repo layer | 2 users, low writes; one DB tech; trivial Docker; Postgres swap stays mechanical |
| IMAP / parse / SMTP | **imapflow / mailparser / nodemailer** | MIT, same team, the de-facto Node email stack |
| Local cache | **better-sqlite3** (+**FTS5**) + `.eml`/attachments on disk | `node:sqlite` lacks FTS5; raw files for Claude to read |
| Threading | **own JWZ** (RFC 5256) | No maintained lib; standard is to port the algorithm |
| Frontend build | **Vite** + React | localhost SPA, no SSR needed |
| UI | **Tailwind + shadcn/ui + Lucide** | Per brief |
| Test runner | **Vitest** | Fast, TS-native, `vitest related` for hooks |
| Lint/format | **ESLint (flat) + Prettier** | Broad ecosystem (react-hooks); Biome noted as alt |
| Hooks | **husky + lint-staged** | Per the quality-gate requirement |
| Credentials | **macOS Keychain** (`security` CLI) + `.env` fallback | No native dep; encrypted at rest |
| Runtime | **Node 22 LTS** (pinned via `.nvmrc`/`engines`) | better-sqlite3 prebuilds; dev machine runs 25 (see PLAN risks) |

---

## 13. Gaps and decisions

The brief is unusually complete. The **full enumerated list of assumptions, underspecified
points, and proposed resolutions** lives in **`PLAN.md → Assumptions & open questions`** and the
running **`Decisions made`** log (the brief asked for those flags in `PLAN.md`). The
**product/architecture-level** resolutions already folded into this spec:

1. **Name:** Postino → **Mailordomo** (matches `CLAUDE.md` + directory).
2. **Server persistence:** **SQLite-on-server** (not Postgres) behind a repository layer at this
   scale; swap path preserved.
3. **Draft history vs "bodies never leave":** server stores **draft metadata only**; draft bodies
   stay local.
4. **Repo pointer identity vs local path:** repo *identity* (name + git URL) is shared; the
   *local path* is machine-local config.
5. **Refine chat:** **replay history** into stateless `-p` calls (not local session resume).
6. **Structured LLM output:** use **`--json-schema`** for triage + promise extraction.
7. **Credentials:** **Keychain-first**, `.env` fallback.
8. **Deadline resolution:** anchor LLM relative dates to message-received date + mailbox tz.

---

## 14. Non-goals / out of scope for v1

- No autonomous sending, ever (this is a permanent non-goal, not just v1).
- No two-way DB sync / no offline-merge/CRDT machinery.
- No mobile/Windows/Linux client (macOS local app only; the *server* is portable).
- No calendar/contacts integration, no mail-merge/marketing features.
- No server-side storage of email or draft bodies.
- Eager/proactive autonomous drafting beyond the sanctioned overdue-nudge (structure allows it
  later, but it is **not** a v1 behavior).
