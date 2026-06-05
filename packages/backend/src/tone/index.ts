/**
 * @mailordomo/backend · tone — layered tone memory + cross-machine LWW sync (Phase 6, PROJECT.md
 * §3/§6). Tone files are "Claude's native memory": local Markdown Claude reads directly, layered
 * project → mailbox → contact (contact overrides), synced via the metadata server as the LWW arbiter.
 *
 * Layout (PURE engines split from the IO edges, per PLAN.md §2):
 *  - `resolve` — PURE: compose the applicable layers into one resolved tone document (contact last).
 *  - `lww`     — PURE: the per-file last-write-wins reconciler (push/pull/noop), mirroring the server.
 *  - `store`   — IO: local tone-file persistence (`TONE_DIR`, content + JSON index sidecar; content
 *                hash = `version_hash`). Kept SEPARATE from the disposable cache.
 *  - `sync`    — orchestrator: push local → adopt authoritative → pull server-only files (whole-file).
 */
export * from './resolve';
export * from './lww';
export * from './store';
export * from './sync';
