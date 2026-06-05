/**
 * @mailordomo/backend · claude — the Claude job runner + the first two consumers (triage, summarize).
 *
 * PROJECT.md §4: Claude is invoked as the headless `claude` binary (no SDK), STATELESS per call,
 * with FIXED model routing (consumed from `@mailordomo/shared` `MODEL_ROUTING`) and editable per-task
 * system prompts under `prompts/`. The runner is an INTERFACE with a real (spawns `claude`) and a
 * fake (canned results) impl, split around two PURE seams — `buildClaudeArgs` and `parseClaudeJson` —
 * so every downstream piece is testable with no API.
 *
 * Layout:
 *  - `types`         — JobSpec / JobResult / ClaudeRunner / the raw envelope shape.
 *  - `build-args`    — PURE argv assembly (model from routing; flags from the spec).
 *  - `parse-json`    — PURE envelope → JobResult.
 *  - `runner`        — REAL runner (spawn + Node hang-guard; macOS has no `timeout`).
 *  - `fake-runner`   — canned-result runner for tests.
 *  - `subscription`  — startup guard: warns if `ANTHROPIC_API_KEY` is set (would divert to paid API).
 *  - `throttle`      — per-call usage logging + rolling-window usage throttle (injectable clock/store).
 *  - `queue`         — concurrency-limited job queue, usage-throttle-gated at dispatch.
 *  - `prompts`       — runtime resolution of the editable system-prompt markdown.
 *  - `triage` (+ `triage-schema`) — Haiku triage → state-machine event.
 *  - `summarize`     — Sonnet thread summary.
 *  - `extract-promises` (+ `promise-extraction-schema`) — Haiku promise candidates → reconciler.
 *  - `nudge`         — the OPUS overdue-nudge auto-draft (saveDraft-only; never sends).
 *  - `draft`         — the OPUS on-signal reply drafter + the replay-based refine chat (text only;
 *                      no `smtp/**` import — the caller persists the body locally and sends manually).
 */
export * from './types';
export * from './build-args';
export * from './parse-json';
export * from './runner';
export * from './fake-runner';
export * from './subscription';
export * from './throttle';
export * from './queue';
export * from './prompts';
export * from './triage-schema';
export * from './triage';
export * from './summarize';
export * from './promise-extraction-schema';
export * from './extract-promises';
export * from './nudge';
export * from './draft';
