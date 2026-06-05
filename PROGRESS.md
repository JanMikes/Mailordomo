# PROGRESS.md — Mailordomo session journal

> Per-session journal (see `PLAN.md §4.7`). Append a dated entry at the **end of every work
> session**, committed with the code. Newest first. Format per entry:
> **What I did · What's half-done · Next · Surprises/decisions.**
> This complements `PLAN.md §10` (phase checklist) and `PLAN.md §9` (decisions) at a finer grain.

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
