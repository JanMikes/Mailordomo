# PLAN.md — Mailordomo build plan & running log

> **Status:** Awaiting review. Per the brief and `CLAUDE.md`, the **only mandatory stop** is
> after `PROJECT.md` + `PLAN.md` are committed. **Do not implement until this plan is approved.**
>
> This document is the **how and when** + the **living progress log**. `PROJECT.md` is the
> authoritative spec (the what and why); re-read it when context resets. Update this file as you
> build: check off milestones, append to *Decisions made*, record deferrals and phase reviews.

## How to use this doc

- **Phases** ([§7](#7-phased-build-plan)) are the build order. Each has a **Definition of Done
  (DoD)** that includes the quality gates. A phase is not "done" until its DoD is fully checked.
- **Quality gates** ([§4](#4-quality-gates)) and **Testing strategy** ([§5](#5-testing-strategy))
  are mandatory for every phase — they are how quality survives a long autonomous run.
- **Assumptions & open questions** ([§8](#8-assumptions--open-questions)) flags everywhere the
  brief was underspecified, with a proposed resolution and whether it **needs your steer** or is
  **resolved and proceeding**.
- **Decisions made** ([§9](#9-decisions-made)) is the append-only log of choices.
- **Progress log** ([§10](#10-progress-log)) is the checklist updated as phases complete.

---

## 1. Goals for the build

1. Deliver the v1 feature set in `PROJECT.md §9` without ever violating a golden rule.
2. Keep `main` **buildable at every phase boundary** (`npm run verify` green).
3. Make the **load-bearing engines provably correct** via tests written by a *separate* context
   from the one that wrote the code.
4. Parallelize independent workstreams with subagents while keeping each context tight.

---

## 2. Repository layout (monorepo, npm workspaces)

```
mailordomo/
├── package.json                # root: workspaces + verify/typecheck/lint/test/build scripts
├── tsconfig.base.json          # strict TS, shared compiler options + path aliases
├── .nvmrc                      # Node 22 LTS
├── .husky/                     # pre-commit, pre-push hooks
├── .github/workflows/
│   └── server-image.yml        # re-run verify + build & publish server image to GHCR (no deploy)
├── eslint.config.js            # flat config (typescript-eslint + react-hooks for frontend)
├── .prettierrc
├── packages/
│   ├── shared/                 # zod schemas + inferred types + constants (model routing, states)
│   │   └── src/{schemas,types,routing,states}.ts
│   ├── server/                 # metadata service (Hono + better-sqlite3) + Dockerfile + README
│   │   └── src/{routes,repo,auth,db,locks}.ts
│   ├── backend/                # local app backend (Node/TS)
│   │   └── src/{imap,smtp,cache,threading,claude,daemon,engines,metadata-client,keychain,api}/
│   └── frontend/               # Vite + React + Tailwind + shadcn/ui
│       └── src/{views,components,lib}/
├── prompts/                    # editable per-task system-prompt markdown (read at runtime)
│   └── {triage,extract-promises,summarize,draft,digest,nudge}.md
├── .env.example                # documented, no secrets
├── PROJECT.md  PLAN.md  CLAUDE.md  README.md  LICENSE
```

**Engines live in `backend/src/engines/` as pure functions** (no IO): the **task state machine**,
the **3-way promise reconciler**, the **do-next ranker**, and the **IMAP folder mapper**. Purity
is what makes them unit-testable and is a deliberate architectural choice, not incidental.

---

## 3. Tech stack & rationale

The decided stack is tabulated in `PROJECT.md §12`. Build-tooling rationale:

- **npm workspaces** (not pnpm/turbo): the user's gate is `npm run verify`; one tool, no extra
  layer. Root scripts fan out with `--workspaces --if-present`. Revisit turborepo only if build
  times hurt.
- **Vitest** (not Jest): native ESM/TS, fast, and `vitest related <files>` powers the
  affected-tests step in the pre-commit hook.
- **ESLint (flat) + Prettier** (not Biome): broader plugin ecosystem (`eslint-plugin-react-hooks`
  matters for the frontend). Biome noted as a faster swap if lint time becomes a problem.
- **better-sqlite3 on both server and cache:** one DB technology across the system; synchronous
  API suits an index/cache; ships **FTS5** (the built-in `node:sqlite` does **not**).
- **Hono** server behind a **repository layer** so the SQLite→Postgres swap stays mechanical.

---

## 4. Quality gates

> This section implements the two additions requested for the autonomous run: **local-first CI
> gating** and **test-first discipline with a subagent split.** These are mandatory and baked
> into every phase's DoD.

### 4.1 The single source of truth: `npm run verify`

Root `package.json`:

```jsonc
{
  "scripts": {
    "typecheck": "npm run typecheck --workspaces --if-present",   // tsc --noEmit per package
    "lint":      "npm run lint --workspaces --if-present",        // eslint + prettier --check
    "test":      "npm run test --workspaces --if-present",        // vitest run
    "build":     "npm run build --workspaces --if-present",       // tsc build / vite build / server bundle
    "verify":    "npm run typecheck && npm run lint && npm run test && npm run build",
    "prepare":   "husky"
  }
}
```

**Green `verify` is the definition of "buildable at a phase boundary."** Both the git hooks and a
human run the *identical* check on demand.

### 4.2 Git hooks (husky + lint-staged) — the PRIMARY gate

- **`prepare: husky`** installs hooks on `npm install` so the gate is active for every clone,
  including this autonomous agent's own commits.
- **`.husky/pre-commit`** (fast, runs on the staged set):
  - `tsc --noEmit` (incremental) — **typecheck**
  - `lint-staged` → `eslint --fix` + `prettier --write` on staged `*.{ts,tsx}` — **lint**
  - `vitest related --run` on staged files — **affected unit tests**
- **`.husky/pre-push`** (full): **`npm run verify`**. This is the real barrier before code reaches
  `origin/main`. **A commit/push that fails the gate must not land on `main`.**

> The agent runs `git commit`/`git push` via Bash, so these hooks gate the autonomous build
> itself. If a hook fails, fix forward — never bypass with `--no-verify`.

### 4.3 GitHub Actions — the SECONDARY gate

`.github/workflows/server-image.yml`, on push to `main` and on tags:
1. `npm ci && npm run verify` (re-run the identical gate in CI).
2. Build the **server** image and **publish to GHCR** (`docker/build-push-action`,
   `permissions: packages: write`). **No deploy step** — producing the image is enough.

The local hook is primary; CI is the backstop. CI does **not** replace the hook.

### 4.4 Test/review subagent split (context hygiene)

Three distinct subagent roles, each a **fresh context**, to stop self-rubber-stamping over a
multi-day run:

| Role | Reads | Does | Agent type |
|---|---|---|---|
| **Implementer** | `PROJECT.md`, `PLAN.md` phase, `shared` schemas | Builds the workstream; may scaffold skeletons | general-purpose / feature-dev:code-architect |
| **Test author** | **`PROJECT.md` (intent), the phase goals, `shared` schemas — NOT the implementation first** | Derives expected behavior from intent, writes/hardens tests, then runs them against the impl | general-purpose (separate context) |
| **Phase reviewer** | The **diff**, the phase's goals in `PLAN.md`, `PROJECT.md` | Runs `verify`, compares diff↔goals, records gaps in `PLAN.md` | feature-dev:code-reviewer / Explore |

**Protocol (enforced in every spawn prompt):**
- The **test author is a different subagent than the implementer**, and is explicitly told to
  derive assertions from `PROJECT.md` intent **before** reading the implementation — otherwise it
  just encodes whatever the code happens to do.
- For **LLM-dependent engines**, tests use the **fake job runner** + recorded fixtures (see
  [§5](#5-testing-strategy)); they assert the **deterministic** logic (reconciliation, state
  transitions, ranking), never live API output.
- After each phase, the **phase reviewer** runs `verify`, diffs against the phase goals, and
  appends a short **"Phase N review"** note (gaps, risks, deferrals) to [§10](#10-progress-log)
  before the next phase starts.

### 4.5 Per-phase Definition of Done (DoD template)

Every phase is done only when **all** are checked:

- [ ] Implementation complete (workstream subagents).
- [ ] Tests authored by a **separate** subagent that read `PROJECT.md` for intent.
- [ ] All **load-bearing engine** tests for this phase are green.
- [ ] **`npm run verify` green at repo root.**
- [ ] **Phase reviewer** ran `verify`, diffed against this phase's goals, recorded gaps in §10.
- [ ] Committed in small, well-messaged units **and pushed to `main`**; hooks passed (no
      `--no-verify`).
- [ ] `main` is buildable at the phase boundary.
- [ ] §10 progress log updated (checkboxes, decisions, deferrals).

---

## 5. Testing strategy

- **What gets unit tests (load-bearing):** the **3-way promise reconciler**, the **task state
  machine**, the **do-next ranker**, the **IMAP folder mapper**, and the **metadata API**. These
  are pure/near-pure and are the correctness core.
- **Test-first:** for each engine, the test author writes tests from `PROJECT.md` intent
  *alongside or before* the implementation; **passing tests are the milestone completion
  criterion**.
- **Isolating the LLM:** the Claude job runner is an **interface**. The real impl spawns
  `claude -p`; the **fake** returns canned `structured_output`. Engines consume *structured
  results*, so they test deterministically. A handful of **recorded real `claude` outputs** are
  checked in as fixtures for golden cases (extraction, triage) — captured once, replayed in CI;
  no live API calls in tests.
- **Transport tests:** the IMAP sync delta logic and folder mapping test against a **fake IMAP**
  surface / recorded fixtures (no live mailbox in CI). Threading (JWZ) tests against crafted
  header sets including malformed/missing references.
- **Metadata API tests:** Hono test client; cover auth/pairing, lock acquire/timeout/release, and
  tone-file last-write-wins conflict resolution.
- **One thin E2E** (Phase 9): `poll → triage → draft → send(stub)` with the fake runner and a
  **stubbed SMTP** (never really sends), asserting the critical loop wires together.

---

## 6. Subagent & parallelization strategy

- **Phase 1 (shared contracts)** is the synchronization point: once `shared` schemas exist,
  Phases **2 (server)**, **3 (transport/cache)**, and the **4 (job runner)** interface can proceed
  **in parallel** as independent subagent workstreams.
- Within a phase, split by module (e.g. Phase 3: sync-engine ∥ cache/threading ∥ state-machine +
  mapper ∥ send-path), each its own implementer subagent, then a separate test author per engine.
- Use **feature-dev:code-architect** to produce a component blueprint at the start of a complex
  phase, **feature-dev:code-explorer** to map existing code before extending it, and
  **feature-dev:code-reviewer** as the phase reviewer.
- Keep the **orchestrator** (main context) thin: dispatch, integrate, run `verify`, update
  `PLAN.md`. Push integration work down into subagents to preserve context budget.

---

## 7. Phased build plan

> Phases refine the brief's suggested 9-step phasing. Each lists **Goal · Workstreams ·
> Deliverables · Tests (test-first, separate author) · DoD** (DoD = §4.5 template; only
> phase-specific notes called out).

### Phase 0 — Scaffold + quality gates + docs *(do this first; it makes every later phase gated)*
- **Goal:** a buildable empty monorepo with the full quality gate live.
- **Deliverables:** npm workspaces; `tsconfig.base.json` (strict); ESLint flat + Prettier;
  Vitest; **husky pre-commit/pre-push**; **root `verify`**; `.nvmrc` (Node 22); `.env.example`;
  top-level `README.md`; CI workflow skeleton (`verify` job only until Phase 2 adds the image
  build).
- **Tests:** a trivial smoke test per package so `verify` exercises the whole pipeline; a test
  proving the pre-commit hook **fails** on a deliberately broken file (gate actually gates).
- **DoD note:** `verify` green on an essentially empty repo; hooks demonstrably block bad commits.

### Phase 1 — Shared types & contracts
- **Goal:** one source of truth for all cross-boundary shapes.
- **Deliverables (`packages/shared`):** zod schemas + inferred types for task states &
  transitions (+actor), 3-way promise records, deadlines/follow-ups, notes, repo pointers, draft
  **metadata**, locks, digest metadata (subject/snippet/sender), tone-file sync, learning
  changelog, **metadata API request/response contracts**, and **model-routing constants**
  (triage→haiku, extract→haiku, summarize/digest/rank→sonnet, draft→opus).
- **Tests:** schema round-trip + rejection of invalid payloads; the state-transition *table*
  (allowed/forbidden edges) as data the state machine will consume.
- **Parallelization:** unblocks Phases 2/3/4.

### Phase 2 — Metadata service *(parallel workstream)*
- **Goal:** the shared source of truth for metadata, with auth, locks, and the GHCR image.
- **Deliverables:** Hono app; **better-sqlite3 (WAL)** + repository layer; **bearer-token
  auth/pairing** (project `id` + `token_hash`); endpoints for tasks/transitions, promises, notes,
  locks (with **timeout**), digest-metadata, tone-file sync (**LWW per file**), learning
  changelog; **`Dockerfile`**; **GHCR build-and-publish workflow** (extends Phase 0 CI; no
  deploy); service **`README.md`**.
- **Tests (load-bearing — metadata API):** auth accept/reject; CRUD round-trips; **lock
  acquire/contend/timeout/release**; **tone-file LWW** conflict resolution; never-stores-body
  assertion (schema rejects body fields).
- **DoD note:** image builds locally; workflow publishes to GHCR.

### Phase 3 — Transport + cache + state machine + folder mirroring *(parallel workstream)*
- **Goal:** bidirectional email truth + disposable local cache + coarse state mirrored to IMAP.
- **Workstreams:** (a) **sync engine** (imapflow: per-mailbox connections, IDLE hot + poll cold,
  **own reconnect/backoff**, UID/modseq incremental sync, `uidValidity` invalidation); (b)
  **cache** (better-sqlite3 + **FTS5**, raw `.eml` + attachments on disk keyed by
  `(mailbox,uidValidity,uid)` + Message-ID index) and **JWZ threading**; (c) **task state
  machine** + **IMAP folder mapper** (both pure engines); (d) **send path** (nodemailer, manual
  only; set `In-Reply-To`/`References`; **`append()` to Sent/Drafts**; SPECIAL-USE folder
  resolution).
- **Tests (load-bearing):** **state machine** transitions (incl. ambiguous→propose); **folder
  mapper** (state↔folder both directions); JWZ threading on crafted/broken headers; sync delta
  logic against fake IMAP/fixtures. **No live mailbox in CI.**
- **DoD note:** cache rebuild-from-empty works; no two-way DB sync introduced.

### Phase 4 — Claude job runner + triage + summaries *(parallel workstream; integrates after 3)*
- **Goal:** the engine that spawns `claude` with fixed routing + editable prompts, plus the first
  two consumers.
- **Deliverables:** concurrency-limited **job queue**; **runner interface** (real spawns
  `claude -p` with `--model`, `--output-format json`, `--system-prompt-file` +
  `--append-system-prompt-file` for layered tone, **`--json-schema`**, `--permission-mode dontAsk
  --allowedTools Read`, `--add-dir` for repo jobs, shell `timeout`; **fake** for tests);
  **per-call cost/usage logging**; editable **prompt markdown** under `prompts/`; **triage**
  (Haiku → state machine) and **thread summarization** (Sonnet).
- **Tests:** model routing table; prompt+flag assembly; JSON-result + cost parsing;
  `structured_output` handling; triage→state mapping (**fake runner**); recorded-fixture golden
  cases.
- **DoD note:** verify `--bare` behavior for the daemon (open question #9).

### Phase 5 — 3-way promises + ranking + stale detection + overdue-nudge
- **Goal:** the load-bearing commitment tracker and the do-next queue.
- **Deliverables:** LLM **extraction** (`--json-schema`, Haiku→Sonnet) → **deterministic
  reconciler** (my promises / they asked / awaiting them; status lifecycle; deadline anchoring to
  message date + mailbox tz); **do-next ranker** (deterministic order per `PROJECT.md §8`, Sonnet
  tie-break only); **stale-thread detection**; the **one sanctioned auto-draft** (Opus) for
  lapsed inbound promises (drafts, never sends).
- **Tests (load-bearing):** reconciler bucketing + status transitions + deadline anchoring;
  ranker ordering (incl. ties); stale thresholds; overdue-nudge **trigger only when inbound
  promise lapses** (and produces a draft, not a send). Extraction mocked.
- **DoD note:** assert no send path is reachable from the daemon.

### Phase 6 — Tone memory + silent learning + cross-machine sync
- **Goal:** Claude's native memory, layered and self-improving, synced safely.
- **Deliverables:** layered tone files (**project → mailbox → contact**, contact overrides);
  silent learning from (a) recurring draft instructions and (b) **draft-vs-sent diff**;
  **revertable changelog**; sync via metadata server (**LWW per file**, content-hash/version).
- **Tests:** layer resolution/override precedence; changelog apply/**revert**; LWW conflict
  resolution; "learning never auto-sends / never edits a sent message" guard.

### Phase 7 — Frontend
- **Goal:** the polished command center + work surface + fallback.
- **Deliverables (Vite + React + Tailwind + shadcn/ui + Lucide):** **Today** command center
  (3-way metric cards, done-vs-remaining, ranked do-next cards w/ badges & inline actions);
  **All-projects** + **per-project** (grouped by state); **classic 3-pane fallback** toggle;
  **split work surface** (thread + pinned summary + repo-freshness left; draft + refine-chat with
  pinned instruction textarea, model badge, **Send as primary** right); **REST + WebSocket** to
  backend (live mail/daemon/lock-presence/draft-ready), React Query; light/dark; sentence case.
- **Tests:** thin component/interaction tests for the load-bearing flows (do-next card actions,
  draft→refine→send-as primary action wiring, view toggle); recreate the two reference mockups'
  structure.

### Phase 8 — Setup wizard + repo pointers + credentials
- **Goal:** guided onboarding without trapping a dev.
- **Deliverables:** wizard (project → mailbox → IMAP/SMTP creds → repo) **and** raw `.env`
  editing; **macOS Keychain** via `security` CLI (+ `.env` fallback); **Claude binary
  health-check**; repo pointer **two modes** (local path via `--add-dir`; git URL + **read-only
  mirror** with **auto-pull checkbox** + scheduler); provider presets (iCloud app-password
  guidance, Gmail).
- **Tests:** wizard validation; credential read/write abstraction (Keychain mocked); repo-mirror
  pull scheduling; provider preset correctness (hosts/ports).

### Phase 9 — Digest + E2E + polish + launchd + docs
- **Goal:** ship-ready.
- **Deliverables:** **morning digest** (what needs you today / promises due / **what Simona
  handled** (from server metadata + actor attribution) / what Claude drafted — Sonnet synthesis,
  my-mailbox content synthesized **locally**); **thin E2E** (poll→triage→draft→send-stub);
  **launchd** plist + install script; final **README**s + `.env.example` completeness; polish.
- **Tests:** the E2E critical loop; digest assembly from metadata (privacy boundary asserted:
  Simona's part uses server metadata only).

---

## 8. Assumptions & open questions

> Every place the brief was silent or ambiguous, with a proposed resolution. **[RESOLVED]** =
> proceeding with this unless you object. **[NEEDS STEER]** = a low-stakes default I'll use, but
> your call could change it. I will proceed with all proposed defaults if not told otherwise.

**Resolved (proceeding):**
1. **Name** → **Mailordomo** (matches `CLAUDE.md`/dir). [RESOLVED]
2. **Package manager** → **npm workspaces** (matches `npm run verify`). [RESOLVED]
3. **Server framework** → **Hono**. [RESOLVED]
4. **Refine chat** → **replay history** into stateless `-p` (not local session resume). [RESOLVED]
5. **Structured LLM output** → **`--json-schema`** for triage + extraction. [RESOLVED]
6. **Editable prompts** → **`--system-prompt-file`** + `--append-system-prompt-file` (layer tone
   memory onto the task prompt). [RESOLVED]
7. **Frontend build** → **Vite** (localhost SPA, no SSR). [RESOLVED]
8. **Test runner** → **Vitest**; **lint/format** → ESLint+Prettier. [RESOLVED]
9. **Deadline resolution** → LLM returns ISO/relative; **anchor to message-received date +
   mailbox tz (Europe/Prague)**. [RESOLVED]
10. **"What Simona handled"** → **actor attribution** on task transitions in the metadata service;
    digest reads it from the server. [RESOLVED]
11. **Privacy boundary for digest** → my-mailbox content synthesized **locally**; Simona's part
    from **server metadata only**. [RESOLVED]
12. **Draft history conflict** → server stores **draft metadata only**; bodies stay local.
    [RESOLVED]
13. **Repo identity vs path** → identity (name + git URL) shared; **local path is machine-local**.
    [RESOLVED]
14. **Sender importance** → stored per contact/project in metadata service, **seeded
    heuristically** (project-domain ⇒ client; newsletter patterns ⇒ demote), user-adjustable.
    [RESOLVED]
15. **Shared types** → consumed as TS source via workspace + path aliases; compiled for the server
    image. [RESOLVED]
16. **Testing LLM code** → **fake runner** + recorded fixtures; no live calls in CI. [RESOLVED]
17. **Server token storage** → store **`token_hash`** (not plaintext). [RESOLVED]
18. **Attachment storage** → files on disk, content-hash dedup, paths in DB (not BLOBs).
    [RESOLVED]
19. **E2E send** → **stubbed SMTP**, never really sends. [RESOLVED]
20. **Monorepo task runner** → plain npm scripts (turborepo only if needed). [RESOLVED]

**Needs your steer (defaults chosen, easily changed):**
21. **Server persistence: SQLite-on-server vs Postgres.** Default **SQLite (WAL) behind a repo
    layer** — at 2-user scale it's simpler, one DB tech, trivial Docker (image + volume, no
    compose). Swap to Postgres is mechanical. *Steer if you expect more users/teams.* [NEEDS STEER]
22. **Credentials: Keychain vs `.env`.** Default **Keychain-first** (`security` CLI, no native
    dep) with `.env` fallback. *Steer if you'd rather keep it `.env`-only for portability.*
    [NEEDS STEER]
23. **Node version.** Default **pin Node 22 LTS** (`.nvmrc` + `engines`) for `better-sqlite3`
    prebuilt binaries. **Your machine runs Node 25** (non-LTS) — on 25, better-sqlite3 may compile
    from source (needs Xcode CLT). *Steer: install Node 22 (recommended) or accept a source
    build on 25.* [NEEDS STEER]
24. **Lock timeout default** → **30 min**, refreshed by a heartbeat while a thread is open.
    [NEEDS STEER]
25. **IDLE/poll strategy** → **IDLE INBOX (+ Sent)**, **poll other folders every 5 min**,
    `maxIdleTime` ~5–10 min; respect iCloud's tight connection cap. [NEEDS STEER]
26. **Daily cost budget** → per-call cost logged; **a daily USD cap applies backpressure** to
    non-essential jobs. Default cap TBD — *what monthly/daily ceiling do you want?* [NEEDS STEER]
27. **Repo auto-pull (git URL mode) auth** → read-only **`git clone --mirror` + scheduled
    `git fetch`**; private repos need a **PAT or SSH key** the user provides (stored in Keychain).
    *Steer on preferred auth.* [NEEDS STEER]
28. **Frontend↔backend transport** → **REST + WebSocket**, bound to **127.0.0.1**, with an
    **optional local token** to stop other local processes hitting the API. [NEEDS STEER]
29. **DB migrations** → **server: plain SQL migration files** (small schema, source of truth);
    **cache: drop-and-rebuild** (disposable). *Steer if you'd prefer drizzle-kit.* [NEEDS STEER]
30. **`--bare` mode for daemon jobs** → likely yes (skip hook/plugin discovery for clean headless
    runs); **to verify empirically in Phase 4.** [NEEDS STEER / verify]

---

## 9. Decisions made

*(Append-only. Seeded with the resolutions above; add to it as the build proceeds.)*

- **D1** Project name = **Mailordomo**.
- **D2** Monorepo via **npm workspaces**; single root **`npm run verify`** = the gate.
- **D3** Quality gate = **husky pre-commit (typecheck + lint + affected tests)** and **pre-push
  (`verify`)**; CI re-runs `verify` + builds/publishes the **server** image to GHCR (no deploy).
- **D4** **Three-role subagent split** (implementer / separate test author reading `PROJECT.md` /
  phase reviewer) baked into the per-phase DoD.
- **D5** Stack: **Hono + better-sqlite3 (WAL)** server; **imapflow/mailparser/nodemailer**
  transport; **better-sqlite3 + FTS5** cache + on-disk `.eml`/attachments; **own JWZ** threading;
  **Vite + React + Tailwind + shadcn/ui** frontend; **Vitest**; **ESLint + Prettier**.
- **D6** Claude engine: headless `claude -p`, **alias model routing**, **`--json-schema`**,
  **`--system-prompt-file`** (+append for tone), **`--permission-mode dontAsk --allowedTools
  Read`**, `--add-dir` for repos, **replay-history** refine chat, runner behind a **fake-able
  interface** with **per-call cost logging**.
- **D7** Privacy: server stores **metadata + subject/snippet/sender + draft metadata + tone
  files** only; **bodies and draft content never leave** the machine.
- **D8** Pure **engines** (state machine, 3-way reconciler, ranker, folder mapper) isolated from
  IO for testability.

---

## 10. Progress log

*(Update as you build. Phase boxes use the §4.5 DoD. Add a "Phase N review" note from the phase
reviewer before moving on.)*

- [x] **Planning** — `PROJECT.md` + `PLAN.md` authored and committed. **← awaiting approval.**
- [ ] **Phase 0** — scaffold + quality gates + docs
- [ ] **Phase 1** — shared types & contracts
- [ ] **Phase 2** — metadata service (+ Docker + GHCR)
- [ ] **Phase 3** — transport + cache + state machine + folder mirroring
- [ ] **Phase 4** — Claude job runner + triage + summaries
- [ ] **Phase 5** — 3-way promises + ranking + stale + overdue-nudge
- [ ] **Phase 6** — tone memory + learning + sync
- [ ] **Phase 7** — frontend
- [ ] **Phase 8** — setup wizard + repo pointers + credentials
- [ ] **Phase 9** — digest + E2E + polish + launchd + docs

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **ImapFlow has no auto-reconnect; iCloud caps connections** | Own backoff/reconnect; IDLE only hot folders + poll the rest; `maxIdleTime` < 29 min; per-mailbox connection |
| **better-sqlite3 native build on Node 25** | Pin **Node 22 LTS**; if stuck on 25, ensure Xcode CLT for source build (open Q #23) |
| **Context drift degrades tests over a long run** | **Separate test-author subagent** reading `PROJECT.md`; **phase reviewer** diffs vs goals (§4.4) |
| **LLM nondeterminism leaks into tests** | Engines consume *structured* results; **fake runner** + recorded fixtures; no live calls in CI |
| **Accidental autonomous send** | No send path in daemon; explicit unit test asserts unreachability (Phases 5/9) |
| **Body/PII leaking to server** | Schemas **reject** body fields; privacy-boundary test in metadata API + digest |
| **uidValidity change corrupts cache** | Detect change → invalidate that mailbox's cache; cache is rebuildable by design |
| **Sent mail not filed / broken threading** | `append()` to Sent/Drafts; set `In-Reply-To`/`References`; SPECIAL-USE folder resolution |
| **Cost runaway** | Per-call cost logging + daily budget backpressure (open Q #26) |

---

## 12. Checkpoints (explicit stops)

- **CHECKPOINT 0 (now):** `PROJECT.md` + `PLAN.md` committed → **STOP, await approval.** ← we are here.
- After approval: build Phases 0→9 autonomously, keeping `main` buildable at every boundary,
  updating §10 as each phase's DoD is met. No further mandatory stops unless a golden-rule
  conflict or a high-stakes ambiguity arises (then record it here and ask).
