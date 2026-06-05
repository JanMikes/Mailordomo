# PROGRESS.md — Mailordomo session journal

> Per-session journal (see `PLAN.md §4.7`). Append a dated entry at the **end of every work
> session**, committed with the code. Newest first. Format per entry:
> **What I did · What's half-done · Next · Surprises/decisions.**
> This complements `PLAN.md §10` (phase checklist) and `PLAN.md §9` (decisions) at a finer grain.

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
