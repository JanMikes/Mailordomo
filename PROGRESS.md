# PROGRESS.md — Mailordomo session journal

> Per-session journal (see `PLAN.md §4.7`). Append a dated entry at the **end of every work
> session**, committed with the code. Newest first. Format per entry:
> **What I did · What's half-done · Next · Surprises/decisions.**
> This complements `PLAN.md §10` (phase checklist) and `PLAN.md §9` (decisions) at a finer grain.

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
