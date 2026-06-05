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
    "refresh-fixtures": "node scripts/refresh-fixtures.mjs",      // regenerate recorded LLM fixtures (live calls)
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
- [ ] **`PROGRESS.md`** session entry appended (did / half-done / next / surprises) and committed
      with the code (see §4.7).

### 4.6 Structural no-autonomous-send guard (defense in depth)

Golden rule #1 (sending is always manual) is enforced **structurally**, not just by tests:

- The **daemon** (`backend/src/daemon/`) and the **send path** (`backend/src/smtp/send`) live in
  **separate modules with no import path between them.** The daemon can *draft* (write a draft via
  the metadata/cache layer) but has no reference to anything that can transmit over SMTP.
- An **ESLint `no-restricted-imports`/`no-restricted-paths` rule** forbids any import from
  `daemon/**` into the send module (and vice-versa). A violation **fails `lint` → fails the
  pre-commit/pre-push gate immediately**, before tests even run.
- This is **established in Phase 0** (rule + a fixture test proving the rule trips on a deliberate
  violating import) and **kept alongside** the behavioral tests in Phases 5 and 9 (assert no send
  path is reachable from the daemon). Structure blocks the mistake; tests prove the behavior.

### 4.7 Session journaling — `PROGRESS.md`

A running **session journal**, committed **with the code at the end of every work session** (not
only at phase boundaries):

- Append a dated entry: **What I did · What's half-done · Next · Surprises/decisions.**
- Purpose: continuity across context resets and visibility into a long autonomous run. It
  complements §10 (phase checklist) and §9 (decisions) at a finer, per-session grain.
- `PROGRESS.md` is created in Phase 0 and updated every session thereafter.

### 4.8 Recorded LLM fixtures are deliberately-regenerated artifacts

- Recorded `claude` outputs used in tests live under `**/__fixtures__/llm/` and each carries a
  header/sidecar marking it a **deliberately-regenerated artifact** (model alias, prompt hash,
  date captured, `// GENERATED — do not hand-edit; run \`npm run refresh-fixtures\``).
- **`npm run refresh-fixtures`** re-captures them with **live** `claude` calls (the only place
  live calls happen). Tests/CI **never** call live; they replay these files.
- Regeneration is an explicit, reviewable act — a fixture diff in a PR signals "model output
  shifted," not a silent test change.

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
  no live API calls in tests. Fixtures are managed as deliberately-regenerated artifacts per
  §4.8 (`npm run refresh-fixtures`).
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
  Vitest; **husky pre-commit/pre-push**; **root `verify`** (+ `refresh-fixtures` scaffold, §4.8);
  `.nvmrc` (Node 22); `.env.example`; top-level `README.md`; **`PROGRESS.md`** seeded (§4.7);
  the **structural no-send guard** ESLint rule + module-boundary skeleton (§4.6); CI workflow
  skeleton (`verify` job only until Phase 2 adds the image build).
- **Tests:** a trivial smoke test per package so `verify` exercises the whole pipeline; a test
  proving the pre-commit hook **fails** on a deliberately broken file (gate actually gates); a
  fixture proving the **send-guard ESLint rule trips** on a deliberate `daemon → send` import.
- **DoD note:** `verify` green on an essentially empty repo; hooks demonstrably block bad commits;
  send-guard rule demonstrably blocks a cross-import.

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
- **🛑 HUMAN CHECKPOINT (mandatory stop — see §12):** before Phases 4–9 build on the transport
  layer, **stop** and let the user connect **one real mailbox** and verify, live: **read-only
  sync** (no writes/sends), **SPECIAL-USE folder resolution**, **JWZ threading** on real
  messages, and **`uidValidity` handling** (incl. a forced-resync path). Provide a short
  read-only verification runbook. Resume to Phase 4 only on the user's go-ahead.

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

### Phase 4.5 — First integration milestone (backend ↔ server ↔ frontend) *(named)*
- **Goal:** prove the three layers actually wire together end-to-end before more features stack on
  top — the first time real data flows across all boundaries.
- **Deliverables:** a minimal but **real** vertical slice: backend connects to the metadata
  service with a project token; cached threads (from Phase 3) surface their metadata to the
  service and back; a **real cache rebuild-from-empty** runs end-to-end (delete cache → rebuild
  from IMAP fixtures + metadata API) and the app comes back consistent; a **lock set on one
  backend instance is visible to a second instance** via the metadata service (the Jan/Simona
  presence primitive); a thin "health/wiring" screen or endpoint shows all three layers green.
- **Tests:** end-to-end cache rebuild assertion; **cross-instance lock visibility** (instance A
  locks → instance B sees `locked_by`/`expires_at`; timeout releases); metadata round-trip across
  the real client (not the fake).
- **DoD:** the §4.5 template **plus**: (a) cache rebuild-from-empty verified end-to-end; (b)
  cross-instance lock visibility demonstrated by an automated test; (c) no body data crosses to
  the server (privacy assertion); (d) `verify` green with the real metadata client in the loop.

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

### Phase 7 — Frontend *(split into 7a/7b/7c for smaller, reviewable diffs)*
Shared foundation established in 7a and reused by 7b/7c: Vite + React + Tailwind + shadcn/ui +
Lucide, **REST + WebSocket** client to the backend, React Query, light/dark, sentence case.

- **Phase 7a — Today command center + do-next cards**
  - **Deliverables:** app shell + theming + data layer (REST/WS + React Query); the **Today**
    view: 3-way promise metric cards, done-vs-remaining counts, ranked **do-next task cards**
    (state badge, project, deadline, draft-ready indicator, inline actions).
  - **Tests:** do-next card actions; metric cards reflect metadata; live-update wiring.
  - **DoD:** §4.5 template; recreates the *Today* reference mockup's structure.
- **Phase 7b — Split work surface + refine chat**
  - **Deliverables:** the split work surface — thread + **pinned Claude summary** + repo-freshness
    left; **draft + refine-chat** right (model badge, **Send as primary action**, edit/snooze
    beside it, **instruction textarea pinned at bottom**, history replayed per golden rule #5).
  - **Tests:** draft → refine → (Send as primary) action wiring; instruction-textarea round-trip;
    summary pinning.
  - **DoD:** §4.5 template; recreates the *split thread+draft+refine* reference mockup's structure.
- **Phase 7c — Classic 3-pane fallback + project views**
  - **Deliverables:** **All-projects** + **per-project** (threads grouped by state); the
    **classic 3-pane fallback** toggle so the user is never trapped in the opinionated view.
  - **Tests:** view toggle; per-project grouping by state; fallback never loses access to a thread.
  - **DoD:** §4.5 template.

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
26. **Usage throttle (NOT a dollar budget)** → Mailordomo runs `claude` under the user's **Claude
    subscription** (shared rolling ~5-hour window + weekly cap), not pay-per-token API. So the runner
    **throttles the background daemon's notional usage** (proxied by the binary's reported
    `total_cost_usd`) over a rolling window aligned to the subscription window, applying backpressure
    to **deferrable** jobs (summaries/digest/ranking) while **essential** triage proceeds. Plus a
    **startup warning if `ANTHROPIC_API_KEY` is set** (it would silently divert to paid API billing).
    Default throttle/window TBD — *what notional ceiling + window do you want?* [NEEDS STEER] (→ D24)
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
- **D9** *(refinement)* **Structural no-send guard**: daemon and send path are separate modules
  with an **ESLint import-boundary rule** forbidding any path between them; established Phase 0,
  behavioral tests kept in Phases 5/9.
- **D10** *(refinement)* **`PROGRESS.md` session journal** committed with code at the end of every
  session (did / half-done / next / surprises); added to the per-phase DoD.
- **D11** *(refinement)* **Mandatory human checkpoint after Phase 3** for live one-mailbox
  read-only verification; the single exception to "no further stops."
- **D12** *(refinement)* **Recorded LLM fixtures** are deliberately-regenerated artifacts under
  `__fixtures__/llm/`, regenerated only via **`npm run refresh-fixtures`** (the sole live-call
  path); tests always replay.
- **D13** *(refinement)* **Named integration milestone Phase 4.5** owns first real
  backend↔server↔frontend wiring (end-to-end cache rebuild + cross-instance lock visibility).
- **D14** *(refinement)* **Phase 7 split** into 7a (Today + do-next), 7b (split work surface +
  refine), 7c (3-pane + project views) for smaller reviewable diffs.
- **D15** *(Phase 0)* **Root `lint` is a single ESLint+Prettier pass** over the whole monorepo
  (`eslint . && prettier --check .`), not the per-workspace fan-out sketched in §4.1. One flat
  config covers all packages + root docs in one pass; fanning out would re-resolve the same config
  N times and miss root-level files. `typecheck`/`test`/`build` still fan out per workspace.
- **D16** *(Phase 0)* **better-sqlite3 verified on Node 25** before scaffolding: v12.10.0 installs a
  **prebuilt arm64 binary** (no source compile), and **FTS5 + WAL** both work (SQLite 3.53.1). The
  load-bearing native dep is green on the dev machine; Xcode CLT is present as a fallback.
- **D17** *(Phase 0)* **Cross-package TS resolution via workspace symlinks + package `exports`**
  (no tsconfig `baseUrl`/`paths`, which TS 6 deprecates). `moduleResolution: "bundler"` resolves
  `@mailordomo/*` through `node_modules` symlinks to each package's `src/index.ts`.
- **D18** *(Phase 0, hardened after review)* **Structural no-send guard covers the whole `smtp/`
  subtree and dynamic `import()`/`require`**, both directions — not just `send`/`transport` static
  imports. `no-restricted-imports` catches static imports; a `no-restricted-syntax` rule catches
  dynamic `import()`/`require` (which the former cannot see). The daemon has no legitimate reason
  to import anything under `smtp/`, so the whole subtree is forbidden (also closing barrel
  re-export holes). Defense in depth for Golden rule #1; behavioral tests still come in Phases 5/9.
- **D19** *(Phase 0)* **Hook scripts use `set -e`** — without it a failing `npm run typecheck`
  would not fail the pre-commit hook (the last command's exit code wins). Caught empirically while
  proving the gate gates.
- **D20** *(Phase 1)* **Shared contracts are zod 4.4.3 schemas** in `packages/shared`, the single
  cross-boundary source of truth; snake_case fields mirror PROJECT.md §5; the inferred Promise type
  is named **`PromiseRecord`** to avoid shadowing the global `Promise`. **Privacy (Golden rule #3)
  is enforced by construction:** every server-bound payload is a `z.strictObject` (incl. nested),
  so an undeclared email/draft-body key fails `parse()` before it can be serialized; the two
  sanctioned exceptions (`Note.body`, `ToneFile.content`) are declared fields. **The model-routing
  floor (Golden rule #6) guards all three Opus-tier kinds** — `draft`, `nudge`, **and**
  `repo-answer` (compile-time `OUTGOING_TEXT_MODELS` + runtime `assertOutgoingTextRouting` +
  self-check on import); corrected after review from the implementer's narrower draft/nudge-only set.
- **D21** *(Phase 2)* **Metadata service** = Hono + `@hono/node-server` over **better-sqlite3 (WAL)
  behind a `Repository` interface** (SQLite→Postgres swap stays mechanical). Auth = **bearer token +
  `X-Project-Id` header**; `token_hash = sha256`, **timing-safe** compare; `/health` + `/pair`
  public, all data routes behind the guard and **project-scoped**. **Locks**: 30-min TTL,
  same-holder re-acquire = heartbeat, expired = acquirable, different unexpired = 409; release for a
  thread outside the caller's project returns `released:false` (never reveals existence). **Tone
  LWW**: newer `updated_at` wins, tie-break **strictly-greater** `version_hash` (identical re-push =
  no-op). **Plain SQL migrations** idempotent on startup. **Docker** multi-stage (tsup inlines
  `shared`; better-sqlite3 external) + **GHCR build-and-publish** (needs verify, push-only, no
  deploy). Privacy is enforced by the shared strict DTOs — **no body column** exists.
- **D22** *(Phase 3)* **Transport/cache/engines.** Pure engines: state machine interprets the shared
  `TASK_STATE_TRANSITIONS` table (apply/propose/noop); folder mapper + `resolveSpecialUseFolders`
  (by SPECIAL-USE flag, never English names). Cache = better-sqlite3 + **FTS5**, keyed by
  **(mailbox, uidValidity, uid)** + Message-ID index, `.eml`/attachments on disk (content-hash
  dedup), one-way mirror, rebuild-from-empty. Own **JWZ** threading. IMAP via an **injected
  `ImapClient` seam** — the read path is **structurally write-free** (a separate `ImapAppendClient`
  carries APPEND, used only by the send path), so sync can't write to IMAP; **own reconnect**
  (backoff+jitter, imapflow has none) re-validates `uidValidity`; IDLE hot + poll 5 min; uidValidity
  change → invalidate + resync. **CONDSTORE flag-deltas route through `updateFlags`, never the full
  upsert**, so a flag toggle can't null the cached envelope (a real bug the separate test author
  caught). Send path (nodemailer) is **manual-only** and stubbable. `verify-mailbox` checkpoint
  script fetches by **sequence number** (robust to UID gaps) and is strictly read-only.
- **D23** *(Phase 3 checkpoint, live)* The transport layer is **verified live read-only** against a
  real Seznam mailbox (see §10 checkpoint note). **Not every provider supports CONDSTORE** (Seznam
  doesn't): the sync degrades gracefully (UID-range new-message fetch works everywhere; incremental
  flag-delta sync is CONDSTORE-only). Recorded limitation: non-CONDSTORE servers need a periodic
  full-folder flag rescan to surface externally-made flag changes — a future "deep poll" enhancement,
  not a v1 blocker. Credentials were used ephemerally for verification only and **never persisted**
  (Golden rule #4); per-mailbox creds will live in Keychain/`{mailbox}.env` once Phase 8 lands.
- **D24** *(Phase 4, user steer)* **The cost cap is a usage THROTTLE, not a dollar budget.** Claude
  Code runs on the user's **subscription** (shared rolling ~5-hour window + weekly cap), not
  pay-per-token API. So the runner throttles the **background daemon's notional usage** (proxied by
  the binary's `total_cost_usd`) over a rolling window aligned to the subscription window, backpressuring
  **deferrable** jobs (summaries/digest/rank) while **essential** triage proceeds; `total_cost_usd`
  is kept purely as the usage signal. A **startup check warns if `ANTHROPIC_API_KEY` is set** (it would
  silently divert `claude` to paid API billing instead of consuming the subscription). Env:
  `CLAUDE_USAGE_THROTTLE` (notional units/window) + `CLAUDE_USAGE_WINDOW_HOURS` (default 5), replacing
  the old `CLAUDE_DAILY_BUDGET_USD`. Throttle default + weekly handling is [NEEDS STEER].

---

## 10. Progress log

*(Update as you build. Phase boxes use the §4.5 DoD. Add a "Phase N review" note from the phase
reviewer before moving on.)*

- [x] **Planning** — `PROJECT.md` + `PLAN.md` authored, committed, **approved with refinements**.
- [x] **Phase 0** — scaffold + quality gates (incl. structural send guard) + `PROGRESS.md` + docs ✅
- [x] **Phase 1** — shared types & contracts ✅
- [x] **Phase 2** — metadata service (+ Docker + GHCR) ✅
- [x] **Phase 3** — transport + cache + state machine + folder mirroring ✅
- [x] **🛑 Phase 3 HUMAN CHECKPOINT** — live one-mailbox read-only verification ✅ (verified live against a real Seznam mailbox)
- [ ] **Phase 4** — Claude job runner + triage + summaries
- [ ] **Phase 4.5** — first integration milestone (backend↔server↔frontend; rebuild + lock visibility)
- [ ] **Phase 5** — 3-way promises + ranking + stale + overdue-nudge
- [ ] **Phase 6** — tone memory + learning + sync
- [ ] **Phase 7a** — Today + do-next cards
- [ ] **Phase 7b** — split work surface + refine chat
- [ ] **Phase 7c** — 3-pane fallback + project views
- [ ] **Phase 8** — setup wizard + repo pointers + credentials
- [ ] **Phase 9** — digest + E2E + polish + launchd + docs

> Per-session notes live in `PROGRESS.md` (§4.7); per-phase reviewer notes are appended here.

### Phase 0 review (independent reviewer, fresh context)

**Verdict:** PASS-WITH-CONCERNS → concerns addressed; **`npm run verify` green (exit 0), 14 tests
across 6 files** (backend 11: index 2 + gate 2 + sendguard 7; shared/server/frontend 1 each).

**All Phase 0 deliverables present:** npm workspaces (shared/server/backend/frontend, each with a
smoke test); strict `tsconfig.base.json`; ESLint flat + Prettier; Vitest; husky pre-commit +
pre-push; root `verify`; `refresh-fixtures` scaffold; `.nvmrc` (22); `.env.example`; `README.md`;
`PROGRESS.md` seeded; structural no-send guard + daemon/smtp skeleton; CI workflow (verify only).

**Acted on (this session):**
- **Hardened the no-send guard** (reviewer's top adversarial finding): static `no-restricted-imports`
  only sees static imports, so a daemon `await import('../smtp/send')` would have slipped past. Now
  a `no-restricted-syntax` rule also forbids dynamic `import()`/`require`; the whole `smtp/` subtree
  is forbidden from the daemon (closing barrel re-export holes); the reverse guard was broadened
  from two filenames to `smtp/**`. Added bypass tests (dynamic import, barrel) — sendguard is now 7
  cases incl. two positive controls. (→ D18)
- **Declared workspace test deps** (`vitest` in all four, `eslint` in backend, which imports it in
  tests) so packages are honest about deps and survive isolated builds. (Finding 4)
- **Fixed a real gate bug caught empirically:** hooks lacked `set -e`, so a failing typecheck did
  not fail the pre-commit hook. Added `set -e`; re-demonstrated the hook blocks a type-broken
  staged file (exit 2) and passes a clean tree (exit 0). (→ D19)

**Kept (with rationale):** `skipLibCheck: true` — near-universal for application (non-library) code
and load-bearing once Phase 2 pulls in Hono/zod/better-sqlite3 types (avoids being broken by
third-party `.d.ts`). Deliberate, not an oversight.

**Deferred / recorded for later:**
- `gate.test.ts` typechecks an isolated temp file (proves `tsc` catches type errors) rather than
  the project config chain — a nit; the per-workspace `extends` of the strict base is low-risk.
- **Phase 2 prerequisite:** the server Docker image must build with `shared` consumed as **TS
  source** — the server bundle (tsup/esbuild) **inlines** `shared` via the workspace symlink +
  `exports`, so no separate `shared` build is needed; declare `typescript`/`tsup`/`better-sqlite3`
  on the server package when wiring the image.

### Phase 1 review (independent reviewer, fresh context)

**Verdict:** PASS-WITH-CONCERNS → both concerns fixed; **`npm run verify` green (exit 0), 845 tests**
(shared **832**, backend 11, frontend 1, server 1). Implemented by one subagent, tested by a
**separate** subagent that derived invariants from PROJECT.md intent and proved them
non-tautological via a mutation check (dropping the snippet bound failed exactly the snippet tests).

**All 11 PROJECT.md §5 entities present** with correct fields; zod **4.4.3**; clean module layout
(primitives/enums/entities/digest/api/routing/states/privacy).

**Adversarial privacy probe came back clean (the key result):** every object schema is
`z.strictObject` (zero `z.object`), **all nested schemas are also strict**, `.omit()` preserves
strictness, `DraftMeta` is body-free, and the forbidden-key matrix is exhaustive over the outbound
surface (29 strict contracts × every forbidden key). Golden rule #3 is enforced by construction.

**Acted on (this session):**
- **Routing floor extended to `repo-answer`** (reviewer's MAJOR finding): §4 / Golden rule #6 name
  drafts and repo-aware answers together as the Opus tier; the rule says "outgoing-text generation"
  and a repo answer is model-generated text. The implementer had narrowed the guard to draft/nudge
  via a code comment — a spec deviation. Now all three are guarded (compile-time + runtime +
  self-check), with a tampered-map test. (→ D20)
- **Entity count corrected** 12→11: `LocalRepoConfig` is machine-local, not a §5 server entity
  (`isEntity=false`), with a test asserting that classification.
- **Transition-mode coverage hardened:** `waiting→done`, `follow-up→done`, `done→needs-reply` are
  asserted `propose` (no silent auto-close/reopen) per §6.
- **Forbidden-key list extended** with refine-chat/transcript keys (local-only per §5).

**Deferred / noted:** `subject` is unbounded (a sanctioned shared field; a cap is an open product
question, not a contract violation); transition *legality* is enforced by the Phase 3 state machine,
not the wire DTO (intentional separation). Branded ID types deferred as an additive enhancement.

### Phase 2 review (independent reviewer, fresh context) — metadata service

**Verdict:** PASS-WITH-CONCERNS → concerns fixed. **`verify` green; server 211 tests** (210 by a
separate test-author, 3 mutation-checked). Built in parallel with Phase 3 (file-disjoint packages).

**Adversarial auth/privacy/scoping probe came back CLEAN (the key result):** bearer compare is
timing-safe (length-guarded `crypto.timingSafeEqual`), `token_hash` is sha256 (never plaintext),
**every** data route is behind the auth middleware (health/pair registered before it), **project A
cannot read/modify project B's rows** on any endpoint (all repo reads join on project), there is
**no body column** (only sanctioned `notes.body`/`tone_files.content`), every write parses through a
**strict** shared DTO, lock ops are transactional (better-sqlite3 is synchronous), expiry compares
are UTC-normalized, migrations idempotent, and the only write-on-read is the tone LWW arbitration
(no two-way sync).

**Fixed:** `releaseLock` for a foreign-project thread now returns `released:false` (was a misleading
`true`; the lock was never actually freed); tone tie-break is strictly-greater (identical re-push =
no-op); pairing router documented as intentionally unauthenticated.
**Deferred:** PATCH/learning cross-project *scoping tests* (impl confirmed correct by the probe, just
coverage gaps); Docker hand-enumerates better-sqlite3's runtime closure (fragile on version bump).

### Phase 3 review (independent reviewer, fresh context) — transport/cache/engines

**Verdict:** PASS-WITH-CONCERNS → concerns fixed. **`verify` green; backend 122 tests** (by a
separate test-author, which found the flag-delta bug). **Checkpoint-ready.**

**READ-ONLY SAFETY confirmed provably write-free (the critical result for the checkpoint):** the
sync engine holds an `ImapClient` whose interface has **no** APPEND/STORE/MOVE/EXPUNGE verb — those
live on a separate `ImapAppendClient` injected only into the send path — so a sync **structurally
cannot** write to IMAP; it only writes the local cache. `verify-mailbox` issues only
LIST/SELECT(readonly)/FETCH/LOGOUT. **No-send guard intact** (smtp not re-exported; daemon can't
reach a transmit; guard covers static/dynamic/require/barrel). Flag-delta fix correct; engines
faithful to §6; cache a strict one-way mirror; own reconnect + uidValidity invalidation sound; JWZ
robust to malformed/looping headers.

**Fixed:** `verify-mailbox` now fetches by sequence number (a uidNext-based UID range could hide
recent mail on a sparse mailbox).
**Deferred:** `computeSyncPlan` post-invalidation reason-code precision + a never-cached-changed-UID
test (behavior correct, coverage gap). **Phase 5 note:** the nudge auto-draft must use `saveDraft`
(never `sendReply`); assert it behaviorally then.

### Phase 3 HUMAN CHECKPOINT — verified live ✅

Verified live (read-only) against a real **Seznam** mailbox (`jan@myspeedpuzzling.com`,
`imap.seznam.cz:993`) via `verify-mailbox`. All five criteria passed:
1. Connected **read-only** (`readOnly=true`); ended "no writes or sends were performed".
2. **SPECIAL-USE resolved by flag, not name** — the `spam` folder flagged `\Junk` mapped to the
   junk slot, the unflagged `newsletters` folder was left unmapped (the exact by-flag adversarial case).
3. **uidValidity** read (1; uidNext 4197; exists 34).
4. **JWZ threading** correct on messy real cross-provider data — a 3-deep `Re:` chain nested, and
   replies whose parents live in Sent grouped under `(referenced, not fetched)` empty containers.
5. The sequence-based `verify-mailbox` fix fetched the last N correctly.

**Real-world finding — Seznam has no CONDSTORE** (`highestModseq` absent). Confirmed
`computeSyncPlan` degrades gracefully: a flag-delta pass needs BOTH local+server modseq, so on a
non-CONDSTORE server it falls back to UID-range new-message fetches (new mail still syncs). **Known
limitation (recorded for later):** on non-CONDSTORE servers, flag changes made in another client
surface only on a periodic full-folder rescan — a future enhancement (e.g. a "deep poll"), not a v1
blocker. (→ D23) Resumed to Phase 4 on the user's delegation ("you verify").

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
| **Subscription-window exhaustion by the daemon** | Usage **throttle** (notional, rolling window) backpressures deferrable background jobs; essential triage proceeds; **startup warns if `ANTHROPIC_API_KEY` is set** (would divert to paid API). Not a dollar budget — runs under the subscription (open Q #26 / D24) |

---

## 12. Checkpoints (explicit stops)

- **CHECKPOINT 0:** `PROJECT.md` + `PLAN.md` committed → **approved with refinements.** ✅ done.
- **CHECKPOINT 1 — after Phase 3 (the single mid-build stop):** before Phases 4–9 build on the
  transport layer, **STOP** and let the user connect **one real mailbox** and verify live
  read-only sync, SPECIAL-USE folder resolution, JWZ threading on real messages, and
  `uidValidity` handling. Resume only on the user's go-ahead. *(This is the one sanctioned
  exception to "no further stops.")*
- Otherwise: build Phases 0→9 autonomously, keeping `main` buildable at every boundary, updating
  §10 + `PROGRESS.md` as each DoD is met. The only other stop is a **golden-rule conflict** or a
  **high-stakes ambiguity** (record it here and ask).
