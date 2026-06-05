// GENERATED — do not hand-edit; run `npm run refresh-fixtures`
//
// Recorded `claude --output-format json` envelope for a TRIAGE job (PLAN.md §4.8). A deliberately-
// regenerated artifact: tests replay it through `parseClaudeJson`; a diff here means "the model
// output shifted", an explicit reviewable act — never a silent test change.
//
//   task:        triage
//   model alias: haiku            (resolved id: claude-haiku-4-5-20251001)
//   schema:      TRIAGE_JSON_SCHEMA (disposition/needs_reply/importance/confidence/reason)
//   prompt hash: sha256:ad9bdad8e628007c5b4c3644b70aefa628394cb5b425b6fa4f797133f9ba1536 (triage.md)
//   captured:    <DATE>           (placeholder; set on the next `refresh-fixtures` run)
//
// The shape is the real ground-truth envelope (/tmp/claude_groundtruth.json) with the triage
// schema's `structured_output`. The CLI returns an empty `result` for a pure-structured job.
import type { ClaudeJsonEnvelope } from '../../types';

export const TRIAGE_FIXTURE: ClaudeJsonEnvelope = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  api_error_status: null,
  duration_ms: 4461,
  num_turns: 2,
  result: '',
  stop_reason: 'end_turn',
  session_id: '847e32d1-529d-4688-8c0e-1570ba28c821',
  total_cost_usd: 0.04118875,
  usage: {
    input_tokens: 18,
    output_tokens: 294,
    cache_creation_input_tokens: 29011,
    cache_read_input_tokens: 28770,
    service_tier: 'standard',
  },
  modelUsage: {
    'claude-haiku-4-5-20251001': { costUSD: 0.04118875 },
  },
  structured_output: {
    disposition: 'needs-reply',
    needs_reply: true,
    importance: 'high',
    confidence: 'high',
    reason: 'A production outage affecting customers requires an acknowledgement and action.',
  },
  uuid: '3cdc6d19-6162-4592-aa81-c801afcf5ce2',
};
