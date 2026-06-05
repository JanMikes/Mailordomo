# PROGRESS.md — Mailordomo session journal

> Per-session journal (see `PLAN.md §4.7`). Append a dated entry at the **end of every work
> session**, committed with the code. Newest first. Format per entry:
> **What I did · What's half-done · Next · Surprises/decisions.**
> This complements `PLAN.md §10` (phase checklist) and `PLAN.md §9` (decisions) at a finer grain.

---

## 2026-06-06 — Phase 7b: split work surface + refine chat (CHECKPOINT 2 cleared)

**What I did**
- **Cleared CHECKPOINT 2** (D30) — the user eyeballed the Today command center live vs seed and approved
  (ranking reads correctly, my-promises leading). Carried two steers: don't wire live mail yet (Phase 8/9);
  carry forward the recorded 7a deferrals.
- Ran **Phase 7b** via the **four-role split** (orchestrator-as-architect **D31** → backend impl → frontend impl
  → **separate test-author** → independent **reviewer**), all golden-rule-clean:
  - **Backend:** `claude/draft.ts` (Opus, tone-layered via `--append-system-prompt-file`, **replay** refine —
    rule #5); a dedicated **local `DraftStore`** (`drafts.db`, body + transcript, **never synced** — rules #2/#3);
    the work-surface API (body-free `ThreadDetail` + a **local-only** `.eml` body hop; draft/refine/get; **manual
    `POST /send`** via a **stub transport** — D30; lock acquire/refresh/release consuming `lockTimeoutMinutes` →
    `ttl_seconds`; `GET /learning` + **LIFO-guarded** `POST /learning/:id/revert`); the **draft-vs-sent learning
    trigger** (the Phase 6 trigger, finally wired, best-effort). Only body-free `DraftMeta` crosses to the server.
  - **Frontend:** the **split work surface** (pinned summary + repo-freshness + thread left; editable draft +
    model badge + refine chat + **instruction textarea pinned** + **Send primary** right), no-router view switch,
    lock acquire/heartbeat/release + presence banner, a **Memory** view with LIFO-guarded revert. +2 Radix deps.
  - **Hardened the no-send guard (D31):** `app.ts` now imports `smtp/send`, so the root barrel transitively
    reaches it — extended the ESLint guard so `daemon/**` + `learning/**` can't import `api/**` or the self-name
    barrel; +4 sendguard fixture cases (11 total). The reviewer traced the graph and confirmed **`tone/**` is not
    a gap**.
- Regenerated the **cross-platform lockfile** in a Linux `node:22` container (2 new Radix deps); **`npm ci`
  validated green on Linux** (the @emnapi chain + macOS binaries both retained).
- Separate test-author added **38 intent-derived tests** (**6 mutation-checked**, failed-then-passed); **no bugs
  found**. Reviewer: **PASS**, all three golden rules upheld with evidence.
- **`npm run verify` green: 1744 tests.** Pushed in 6 small commits.

**What's half-done**
- Nothing in 7b — DoD met (§4.5). Two recorded polish deferrals (→ Phase 9): the unbounded `summaryMemo` (cap with
  an LRU) and the synchronous summary-on-GET (move to async/WS once the daemon pre-computes summaries).

**Next**
- **Phase 7c — classic 3-pane fallback + all-projects / per-project views**, plus the **project-NAME field** on
  cards (the recorded 7a→7c display gap) and the D28 out-of-order-revert structured guard if tackled there.

**Surprises/decisions**
- **The first user-triggered send path** went in this phase. It lives ONLY in `api/` (the sanctioned manual
  layer), uses a **stub transport** (no live creds until Phase 8), and is provably unreachable from the daemon —
  the barrel-transitive hole it introduced was closed by hardening the lint guard rather than restructuring the
  barrel (nothing relied on the barrel reaching `app`).
- **A frontend implementer agent returned corrupted output (0 tool uses, did nothing).** Confirmed the tree was
  untouched and re-dispatched a fresh agent, which succeeded — a reminder to verify a failed agent's blast radius
  before retrying.
- **Learning revert leans on the authoritative server-side 409 LIFO guard, not UI pre-disabling** — the shared
  `LearningEntry` deliberately lacks the local tone-file `path` (server stores **summary only**, D28), so the UI
  can't correctly pre-compute per-file eligibility; the 409 is always-correct and never blocks a valid revert.

---

## 2026-06-05 — Phase 7a: Today command center + do-next cards (🛑 CHECKPOINT 2)

**What I did**
- Ran Phase 7a via a **four-role split**: a code-architect **blueprint** first (it found the
  load-bearing fact that the **daemon loop is still a stub** → CHECKPOINT-2 needs a **seed path**),
  then **Implementer A** (shared `today.ts`/`settings.ts` contracts + **D26 ranker extension** + pure
  Today assembler + file settings store + `GET /api/today`, `GET/PUT /api/settings`, mark-done/snooze
  endpoints + **WebSocket** `today:changed` + `seed:today`), **Implementer B** (frontend foundation:
  **Tailwind v4 + shadcn/ui + Lucide + React Query**, app shell + theming via `AppSettings.colorScheme`
  (no localStorage-as-truth), the Today view — 3-way metric cards green/amber/blue, done-vs-remaining,
  ranked do-next cards, settings popover; **Draft is an inert disabled stub** — no send path), a
  **separate test-author** (+49 intent-derived tests, ranker tier-separation mutation-checked), and an
  independent **reviewer** (PASS-WITH-CONCERNS, all 3 golden rules upheld).
- **Live boot smoke** (real server + seed + backend processes): `/api/today` returns a valid model with
  the **D26 tiers visibly correct** and `hasBody:false` on every card. The checkpoint runbook works.
- Sequenced the phase to dodge the **cross-platform lockfile** gotcha: implementers installed deps
  locally; I regenerated `package-lock.json` in a Linux `node:22` container (twice — frontend deps, then
  the `@mailordomo/shared` fix) and validated `npm ci` green each time.
- Fixed the reviewer's one real concern (frontend manifest missing its `@mailordomo/shared` dep).
- **`npm run verify` green: 1664 tests.** Committed; **about to push, then STOP at CHECKPOINT 2.**

**What's half-done**
- Nothing in 7a — DoD met. **Deliberately paused at CHECKPOINT 2** (per the user's steer) before 7b/7c so
  the user can eyeball the core UI against real mail.

**Next (after the checkpoint go-ahead)**
- **Phase 7b — split work surface + refine chat** (thread + pinned summary left; draft + refine-chat
  right, **Send as the primary action**, instruction textarea pinned). This is where the **thread lock**
  acquire/refresh (consuming `lockTimeoutMinutes` → `ttl_seconds`), the **learning daemon trigger**
  (draft-vs-sent), and the **learning revert UI** (the D28 LIFO/structured guard) land.

**Surprises/decisions**
- **The daemon loop is still a stub (D29):** triage/extraction exist but nothing yet polls real mail →
  metadata in a running loop (that is Phase 9). So CHECKPOINT-2 uses `seed:today` (real cached threads
  where present + synthetic task/promise overlays across all 3 directions) to make the UI reviewable.
- **D26 is live and correct:** the ranker key `[hasMyPromise, myPromiseUrgency, hasTheyAsked,
  theyAskedUrgency, importance, age]` keeps my-promise STRICTLY above they-asked — verified by a
  mutation check AND seen in the live `/api/today` ordering.
- **Known display gap (→ 7c):** cards show the raw `projectId` (the model has no project-NAME field yet).

---

## 2026-06-05 — Phase 6: tone memory + silent learning + cross-machine sync

**What I did**
- Folded the two Phase 5→6 boundary steers into PLAN (**D26** separate do-next tiers — my-promise
  strictly above they-asked, NOT merged; **D27** stale/lock thresholds become user-adjustable Phase 7
  settings, defaults unchanged), approved the recorded defaults (#21–#30, throttle 2.50/5h), and added
  **CHECKPOINT 2** (mandatory stop at end of 7a). Pushed.
- Built **Phase 6** (three-role split: implementer → separate test-author → independent reviewer) on the
  existing Phase 1 contracts + Phase 2 endpoints: pure tone **layer resolver** (project→mailbox→contact,
  contact wins), pure **LWW reconciler** mirroring the server (`version_hash` = sha256 of content only),
  whole-file **sync** (no merge, golden rule #2), and the **silent-learning** engine (pure
  recurring-instruction + draft-vs-sent-diff signals → Sonnet `learn` job → tone append + LOCAL revert
  snapshots + server **summary-only** changelog). Added the `learn` task kind (sonnet, deferrable, not
  outgoing-text), the MetadataClient tone/learning methods, and extended the no-send guard to
  `learning/** → smtp/**`.
- Separate test-author added **58 intent-derived tests** (mutation-checked twice). Reviewer:
  PASS-WITH-CONCERNS, **all three golden rules confirmed upheld**.
- **`npm run verify` green: 1594 tests.** Pushed.

**What's half-done**
- Nothing. Phase 6 DoD met. The learning **daemon trigger** (fire after a real send, diff draft-vs-sent)
  wires in Phase 7b when drafts/sends flow — the engine is built ready + fully tested with the fake
  runner + in-process server.

**Next**
- **Phase 7a — Today command center + do-next cards** (app shell + theming + REST/WS data layer + the
  Today view), folding **D26** (ranker gains the they-asked tier) + **D27** (settings surface). **🛑
  Mandatory stop at the end of 7a (CHECKPOINT 2)** — the user eyeballs the core UI against real mail
  before 7b/7c build on it.

**Surprises/decisions**
- **Reviewer's must-fix (a real §6 hole):** `applyLearning` mutated the tone file BEFORE the server
  changelog call, so a server error left an untracked, unrevertable tone edit. Reordered to record on
  the server first (+ roll the tone file back if the local log-append throws) — "tone mutated ⟺ logged"
  now holds on the failure path.
- **Deferred the out-of-order-revert guard (D28):** snapshot revert is correct for LIFO (the only v1
  path; **no revert caller exists yet**). Phase 7's revert UI must design it holistically (LIFO guard or
  structured-tone rebuild that respects manual edits) — recorded rather than baking in a possibly-wrong
  constraint.
- **`version_hash` = sha256(content) only** is exactly what makes the cross-machine LWW no-op + tie-break
  correct: identical tone content on any machine → identical hash → a true no-op re-push.

---

## 2026-06-05 — CI fix #2: cross-platform lockfile (the real @emnapi root cause)

**What I did**
- CI's `npm ci` was still failing: `Missing: @emnapi/core@1.10.0 / @emnapi/runtime@1.10.0 from lock
  file`. The earlier npm-11 pin didn't fix it because the root cause is **platform, not npm version**:
  `@emnapi/core`+`runtime` are a wasm-fallback chain (via `@napi-rs/wasm-runtime` ← `unrs-resolver`,
  a transitive ESLint dep). npm 11 on **macOS/arm64 prunes them** from the lock (native binding used),
  but **Linux CI needs them** — so the committed lock was cross-platform-incomplete.
- Fix: **regenerated `package-lock.json` inside a Linux `node:22` container with npm 11.16.0** (the
  exact env CI uses), which captures the Linux `@emnapi` chain AND keeps the macOS rollup binary.
  Verified `npm ci` + `npm run verify` green locally (1518 tests). Only the lock changed.

**Gotcha for future dep changes (IMPORTANT):** running plain `npm install` on macOS (npm 11) will
RE-PRUNE the `@emnapi` chain and re-break CI. When deps change, regenerate the lock cross-platform:
`docker run --rm -v "$PWD":/app -w /app node:22-bookworm-slim sh -c "npm i -g npm@11 && npm install --package-lock-only && chown $(id -u):$(id -g) package-lock.json"`

---

## 2026-06-05 — Phase 5: 3-way promise tracker + ranker + stale + overdue-nudge

**What I did**
- Built the load-bearing commitment tracker (three-role split): the **LLM-extraction /
  deterministic-reconciler split** (pure reconciler buckets candidates into deliver/owe/chase,
  tracks status, anchors deadlines to the message date in Europe/Prague with **DST computed in-code**
  — no tz-db, stays pure); the **do-next ranker** (§8 steps 1→3 deterministic, step-4 Sonnet
  consequence a separate permutation-guarded tie-break seam); **stale** detection; and the **one
  sanctioned overdue-nudge** — structurally send-proof.
- Independent test-author added 134 intent-derived tests (backend 474), incl. adversarial DST and a
  full direction×status nudge sweep. Reviewer: PASS-WITH-CONCERNS, **Golden rule #1 confirmed safe**
  (nudge can never send). Fixed: strict candidate schemas, a comment, a daemon nudge-wiring note.
- **`npm run verify` green: 1518 tests.** Pushed.

**What's half-done**
- Nothing. Phase 5 DoD met. One recorded deferral: §8 step-1 scope (my-promise vs +they-asked) is a
  caller-projection policy to settle when the do-next queue is wired in Phase 7a (open Q #31).

**Next**
- **Phase 6 — tone memory + silent learning + cross-machine sync**: layered tone files
  (project→mailbox→contact), learning from recurring instructions + the draft-vs-sent diff
  (revertable changelog), synced via the server (LWW per file).

**Surprises/decisions**
- **The load-bearing bucketing insight (D25):** my-promise and they-asked are both "me owes" and
  can't be told apart by who/whom — only `awaiting-them` (they owe me) is structurally forced; the
  reconciler trusts the model's hint between the two "I owe" directions.
- **Golden rule #1 is enforced by TYPES here:** the nudge's `DraftFiler` seam has no transmit verb,
  so a sending function can't even typecheck as a nudge filer — caught structurally, not just by a test.
- Kept the Prague DST resolver dependency-free (in-code EU last-Sunday rule) to keep the deadline
  engine pure and deterministically testable.

---

## 2026-06-05 — Phase 4.5: first integration slice (backend ↔ server ↔ frontend)

**What I did**
- Built the first REAL vertical slice (three-role split): a typed `MetadataClient` (Bearer +
  X-Project-Id, shared-DTO-validated, injectable fetch, body-free); a thin localhost Hono API
  (`/api/wiring` three-layer health + `/api/threads` metadata-only) on 127.0.0.1; a minimal
  (un-styled) frontend wiring view + Vite `/api` proxy. **Verified live** — the wiring endpoint runs.
- Separate test-author wrote 21 **integration** tests against the REAL in-process server (via
  `app.fetch`): real-client round-trip, end-to-end cache rebuild-from-empty, cross-instance lock
  visibility (the Jan/Simona presence primitive), and a privacy capture-and-scan (no body crosses).
- Reviewer: PASS-WITH-CONCERNS, all four DoD items MET; fixed the one real issue (`checkClaude`
  false-green on a bad `CLAUDE_BIN` → now resolves via `which`).
- **`npm run verify` green: 1312 tests.** Pushed.

**What's half-done**
- Nothing. Phase 4.5 DoD met. The three layers provably wire together.

**Next**
- **Phase 5 — 3-way promises + ranking + stale detection + the one sanctioned overdue-nudge**
  (load-bearing commitment tracker + do-next queue). The `promise-extraction` Haiku route exists;
  Phase 5 adds the extractor → deterministic reconciler + ranker + the nudge (draft, never send).

**Surprises/decisions**
- **Privacy holds end-to-end with the real client:** the integration test captures the actual
  outbound bytes and deep-scans them — a stronger proof than the schema-level rejection alone.
- `MailboxSync` doesn't populate `snippet` from IMAP envelopes (no standard field) — snippet
  derivation (from body parsing, locally) is a Phase 5+ item; the rebuild test's snippet check is
  vacuous until then.

---

## 2026-06-05 — Phase 4: Claude job runner + triage + summaries (+ CI fix, throttle reframe)

**What I did**
- **Ground-truthed the `claude` invocation model live** before building the runner: confirmed the
  flags, captured the `--output-format json` envelope, and verified `--json-schema` populates
  `structured_output`. Two real findings: **macOS has no `timeout` binary** (so the hang-guard is
  Node-side AbortController, not shell `timeout`); `--permission-mode dontAsk` is valid.
- **Phase 4** (three-role split): runner interface (real spawns `claude -p`, prompt via stdin,
  Node timeout; fake for tests; pure buildClaudeArgs + parseClaudeJson seams), concurrency queue,
  editable `prompts/triage.md` + `summarize.md`, triage (Haiku + json-schema → state machine) and
  summarization (Sonnet) consumers, recorded fixtures + real `refresh-fixtures` logic. 245 backend
  tests. Reviewer: PASS-WITH-CONCERNS, all 9 adversarial checks clean; fixed 3 (timer clear, latch,
  window>0) + a dev-script timeout.
- **Handled two user messages mid-flight:**
  1. **CI red** (`npm ci` out of sync): root cause was npm 10 (Node 22 CI) vs npm 11 (dev Node 25)
     producing different locks. Pinned npm 11 in the CI workflow + Dockerfile builder. `npm ci` clean.
  2. **Cost model reframe:** Claude Code runs on the user's **subscription**, not paid API. Reframed
     the "daily budget cap" → a **usage throttle** (rolling 5h window, notional `total_cost_usd`
     signal, backpressure on deferrable jobs) protecting the shared subscription window; added a
     **startup warning if `ANTHROPIC_API_KEY` is set** (would divert to paid API). (D24)
- **`npm run verify` green: 1289 tests.** All pushed to main.

**What's half-done**
- Nothing half-done. Phase 4 DoD met.

**Next**
- **Phase 4.5 — first integration milestone:** wire backend ↔ metadata service ↔ a thin frontend;
  prove end-to-end cache rebuild-from-empty and cross-instance lock visibility (the Jan/Simona
  presence primitive) with the REAL metadata client (not the fake).

**Surprises/decisions**
- **Live ground-truthing paid off:** the macOS-no-`timeout` finding would have made every daemon job
  exit 127 if we'd followed the plan's "shell timeout" literally.
- **npm 10↔11 lockfile divergence** (optional `@emnapi/*` deps + `peer` markers) is the CI gotcha of
  running dev on Node 25 while targeting Node 22 — pinned npm 11 everywhere that runs `npm ci`.
- **Subscription, not API:** the whole cost framing flipped from "don't overspend dollars" to "don't
  starve the user's interactive window" — a throttle, with an API-key guard. (D24)

---

## 2026-06-05 — Phases 2 + 3: metadata service + transport/cache/engines (→ mailbox checkpoint)

**What I did**
- Ran **Phase 2 (server)** and **Phase 3 (backend)** as **parallel** workstreams — file-disjoint
  packages, each with the full three-role split (implementer → separate test-author → reviewer).
  Pre-installed third-party deps first (hono, imapflow, mailparser, nodemailer, better-sqlite3) to
  avoid lockfile races between concurrent agents.
- **Phase 2:** Hono metadata service on better-sqlite3 (WAL) behind a repository interface; bearer +
  X-Project-Id auth (sha256, timing-safe); tasks/transitions/promises/notes/repos/draft-meta/locks/
  tone-LWW/learning/digest; 30-min lock TTL; plain SQL migrations; Dockerfile + GHCR publish
  workflow. Privacy enforced by the shared strict DTOs (no body column). 211 tests.
- **Phase 3:** pure engines (state machine over the shared table; folder mapper + SPECIAL-USE
  resolution); better-sqlite3+FTS5 cache keyed by (mailbox,uidValidity,uid) + .eml on disk; own JWZ;
  imapflow sync with an injected client seam, own reconnect, uidValidity invalidation, IDLE/poll;
  manual-only nodemailer send; a read-only `verify-mailbox` checkpoint script. 122 tests.
- **`npm run verify` green: 1166 tests** across the integrated tree.

**What's half-done**
- Nothing half-done — but Phases 2/3 are DoD-complete and I am **STOPPING at the mandatory Phase 3
  mailbox checkpoint** (PLAN §12 CHECKPOINT 1) before building Phase 4+ on the transport layer.

**Next (after the checkpoint)**
- **Phase 4 — Claude job runner + triage + summaries**, then 4.5 integration, 5–9. Resume only once
  the user has connected a real mailbox and verified live read-only sync.

**Surprises/decisions**
- **The separate test-author discipline paid off concretely:** the Phase 3 test author found a real
  cache-corruption bug — a CONDSTORE flags-only delta (fires when you read/star mail in Apple Mail/
  iPhone) was wiping the cached envelope via the full upsert. Fixed by routing flag-deltas through a
  dedicated `updateFlags`. (D22)
- **Read-only safety is structural, not just careful:** the reviewer confirmed the sync engine holds
  an `ImapClient` with no write verbs at all (APPEND lives on a separate `ImapAppendClient` used only
  by the send path), so a sync *cannot* write to IMAP. That's what makes the live checkpoint safe.
- Both parallel reviews were PASS-WITH-CONCERNS with clean adversarial probes (server auth/scoping/
  privacy; backend write-free read path + no-send guard). Minor concerns fixed before stopping.

> **🛑 CHECKPOINT — awaiting the user.** See the checkpoint runbook in the session summary / the
> `verify-mailbox` script. Resume to Phase 4 only on the user's go-ahead after live verification.

**CHECKPOINT CLEARED (same session):** the user delegated verification ("you verify") and supplied a
real Seznam mailbox. `verify-mailbox` passed all five criteria live (read-only; SPECIAL-USE by flag —
the `spam`/`\Junk` folder proved by-flag-not-name; uidValidity read; JWZ correct on real
cross-provider data). Real finding: **Seznam has no CONDSTORE** — `computeSyncPlan` degrades
gracefully (new-mail UID-range sync works; flag-delta sync is CONDSTORE-only; non-CONDSTORE flag
rescan deferred as a future "deep poll"). Credentials used ephemerally, never persisted. Resuming to
Phase 4. (→ D23, §10 checkpoint note)

---

## 2026-06-05 — Phase 1: shared types & contracts

**What I did**
- Built `packages/shared` — the single cross-boundary source of truth — via the full three-role
  split: an **implementer** subagent wrote the zod 4.4.3 contracts; a **separate test-author**
  subagent (fresh context) derived invariants from PROJECT.md intent and wrote the suite; an
  independent **reviewer** subagent audited the diff. I read the load-bearing modules myself
  (routing/states/privacy) since this is the keystone every later phase imports.
- Contracts: primitives, enums (closed vocabularies), 11 §5 entities (all `z.strictObject`),
  digest read models, metadata-API request/response DTOs, fixed model routing, and the task-state
  transition table as data with auto/propose modes.
- **`npm run verify` green: exit 0, 845 tests** (shared 832, incl. a 700+-case privacy matrix).

**What's half-done**
- Nothing. Phase 1 DoD met. This is the synchronization point — Phases 2 (server), 3 (transport),
  and 4 (job runner) can now proceed as parallel subagent workstreams against these contracts.

**Next**
- **Phase 2 — metadata service** (Hono + better-sqlite3 WAL + repo layer + bearer auth + locks +
  tone-file LWW + Dockerfile + GHCR workflow) and **Phase 3 — transport/cache/state machine** can
  start in parallel. Phase 3 ends at the **mandatory mailbox checkpoint** (live one-mailbox
  read-only verification) — the one sanctioned stop.

**Surprises/decisions**
- **Privacy is enforced structurally, not by convention:** every server-bound payload is a strict
  zod object (incl. nested), so a stray email/draft-body key fails `parse()`. The reviewer's
  adversarial probe (non-strict nested schema? `.omit()` leak?) came back clean. (D20)
- **Reviewer caught a golden-rule narrowing:** the implementer excluded `repo-answer` from the
  Opus floor guard via a comment ("not outgoing email"), but Golden rule #6 says "outgoing-text
  generation" and §4 pairs drafts with repo answers. Fixed — all three Opus-tier kinds are guarded.
- Inferred Promise type named `PromiseRecord` to avoid shadowing the global `Promise`.

---

## 2026-06-05 — Phase 0: scaffold + quality gates

**What I did**
- **Verified the load-bearing native dep first:** `better-sqlite3` 12.10.0 installs a prebuilt
  arm64 binary on Node 25 (no source compile), with **FTS5 + WAL** both working. The user's flagged
  risk is clear — proceeded without needing Xcode CLT (present anyway). (D16)
- Scaffolded the gated npm-workspaces monorepo: `shared`/`server`/`backend`/`frontend`, strict
  TypeScript 6, ESLint 10 flat + Prettier, Vitest 4, Vite 8 + React 19, tsup bundling. Each package
  has a smoke test so `verify` exercises the whole pipeline.
- Built the quality gate: root `npm run verify` (typecheck+lint+test+build), husky pre-commit
  (typecheck + lint-staged) and pre-push (full verify), CI workflow running the identical verify.
- Established the **structural no-send guard** (Golden rule #1): ESLint rule forbidding any import
  path between the daemon and the SMTP module, plus a daemon/smtp module skeleton.
- Three-role split honored: implemented directly (foundational tooling), then an **independent
  reviewer** (fresh context) audited Phase 0. Acted on its findings (see below).
- `verify` green: **exit 0, 14 tests / 6 files.** Committed (6c17d8d) + this hardening commit.

**What's half-done**
- Nothing half-done. Phase 0 DoD fully met. Packages are skeletons by design — real contracts/code
  land Phase 1+.

**Next**
- **Phase 1 — shared types & contracts** (zod schemas + inferred types + model-routing constants).
  This is the synchronization point that unblocks Phases 2/3/4 to run as parallel subagents.

**Surprises/decisions**
- **Caught a real gate bug:** hooks lacked `set -e`, so a failing `npm run typecheck` did **not**
  fail the pre-commit hook (last command's exit wins). Fixed; re-proved the hook blocks a broken
  staged file (exit 2) and passes clean (exit 0). This is exactly why "prove the gate gates" exists. (D19)
- **Reviewer's best find:** `no-restricted-imports` is static-only — a daemon `await
  import('../smtp/send')` would bypass it. Hardened the guard to also forbid dynamic `import()`/
  `require` and the whole `smtp/` subtree (both directions); added bypass tests. (D18)
- Toolchain resolved to current majors: ESLint 10, **TypeScript 6** (deprecates `baseUrl`/`paths` →
  switched to workspace symlinks + `exports` for `@mailordomo/*` resolution, D17), Vitest 4, Vite 8,
  React 19, @types/node 25.
- Kept `skipLibCheck: true` (deliberate; near-universal for app code, load-bearing once Hono/zod
  land in Phase 2).

---

## 2026-06-05 — Planning + approval + plan refinements

**What I did**
- Authored `PROJECT.md` (authoritative spec) and `PLAN.md` (phased build plan + quality gates),
  committed and pushed to `main`. Plan approved.
- Ground-truthed two load-bearing unknowns via research subagents: the headless `claude`
  invocation model (v2.1.165 on this machine) and the Node IMAP/SMTP/cache stack.
- Folded in the 6 approved refinements: (1) mandatory human checkpoint after Phase 3; (2)
  structural no-send guard via ESLint import boundary in Phase 0; (3) `PROGRESS.md` session
  journaling; (4) named integration milestone Phase 4.5; (5) Phase 7 split into 7a/7b/7c; (6)
  `npm run refresh-fixtures` + fixtures labeled as deliberately-regenerated artifacts.

**What's half-done**
- Nothing in code yet — about to start Phase 0 (scaffold + quality gates).

**Next**
- Build Phase 0 → 1 → 2 → 3, then **stop at the Phase 3 mailbox checkpoint** for live one-mailbox
  read-only verification.

**Surprises/decisions**
- `claude` supports `--json-schema` (reliable structured extraction) and `--system-prompt-file`
  (editable markdown prompts) → baked into the engine design.
- Hard constraints carried into the plan: `imapflow` has **no auto-reconnect** and needs **one
  connection per IDLEd mailbox**; `node:sqlite` lacks **FTS5** → use `better-sqlite3`.
- Dev machine runs **Node 25** (non-LTS); repo targets **Node 22 LTS** (`.nvmrc`), `engines` kept
  permissive (`>=22`) so the build runs on 25. `better-sqlite3` native install on 25 to be
  watched at Phase 2.
