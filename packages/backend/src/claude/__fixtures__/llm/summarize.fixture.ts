// GENERATED — do not hand-edit; run `npm run refresh-fixtures`
//
// Recorded `claude --output-format json` envelope for a SUMMARIZE job (PLAN.md §4.8). A
// deliberately-regenerated artifact: tests replay it through `parseClaudeJson`; a diff here means
// "the model output shifted", an explicit reviewable act — never a silent test change.
//
//   task:        summarize
//   model alias: sonnet           (resolved id: claude-sonnet-4-6)
//   schema:      none (free-text summary returned in `result`)
//   prompt hash: sha256:764fd3c9796f5042fbf07261e04e20e51a95d98f02d4d8b2825e968cdcfacc05 (summarize.md)
//   captured:    <DATE>           (placeholder; set on the next `refresh-fixtures` run)
//
// Same envelope shape as the triage ground truth, but a Sonnet summary: `result` carries prose and
// there is NO `structured_output` (no `--json-schema` for summaries).
import type { ClaudeJsonEnvelope } from '../../types';

export const SUMMARIZE_FIXTURE: ClaudeJsonEnvelope = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  api_error_status: null,
  duration_ms: 6120,
  num_turns: 2,
  result:
    'Petr asked for the v2 API spec ahead of the Friday demo and flagged the staging outage as blocking.\n\n' +
    '- You committed to send the API spec by Thursday EOD.\n' +
    '- Petr owes you the updated staging credentials (you are waiting on this).\n' +
    '- Deadline: the spec is due before the Friday 10:00 demo.',
  stop_reason: 'end_turn',
  session_id: 'b1f9c2a4-7d3e-4f10-9c21-2a6e5b8f0d44',
  total_cost_usd: 0.0193245,
  usage: {
    input_tokens: 642,
    output_tokens: 118,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    service_tier: 'standard',
  },
  modelUsage: {
    'claude-sonnet-4-6': { costUSD: 0.0193245 },
  },
  uuid: 'd7e0a1b2-3c4d-5e6f-8a9b-0c1d2e3f4a5b',
};
