#!/usr/bin/env node
/**
 * Regenerate recorded LLM fixtures by making LIVE `claude` calls (PLAN.md §4.8).
 *
 * This script is the ONLY place live Claude calls are allowed. Tests and CI always
 * replay the checked-in fixtures under `packages/**\/__fixtures__/llm/` and never call live.
 * A fixture diff in a commit therefore signals "the model output shifted" — an explicit,
 * reviewable act, not a silent test change.
 *
 * Phase 0: no fixtures exist yet. The real capture logic lands with the Claude job runner
 * (Phase 4), which defines the prompts and `--json-schema` shapes that produce these fixtures.
 */

console.log(
  'refresh-fixtures: no LLM fixtures to regenerate yet. Capture logic arrives with the job runner (Phase 4).',
);
process.exit(0);
