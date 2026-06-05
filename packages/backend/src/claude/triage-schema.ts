/**
 * The triage JSON Schema + the runtime validator for the schema-constrained `structured_output`
 * that Haiku returns (PROJECT.md §4: "`--json-schema` for the decision"; §6: triage → state).
 *
 * The schema is the contract we hand to `claude --json-schema`; the zod schema validates what comes
 * back (defense in depth — the CLI constrains output, we still parse it before trusting it). Both
 * describe the same shape, deliberately small so Haiku is fast and cheap on every inbound message.
 *
 * Fields:
 *  - `disposition`  — the triage verdict that maps to a state-machine event (see `triage.ts`):
 *       'needs-reply'      → a reply is owed (new inbound obligating the thread)
 *       'no-reply-needed'  → an inbound "thanks"/FYI that closes the thread (→ done)
 *       'fyi'              → informational, no action and not a closer (no state change)
 *  - `needs_reply`  — explicit boolean the model commits to (cross-checks `disposition`).
 *  - `importance`   — the sender-importance HINT feeding the do-next ranker (PROJECT.md §8).
 *  - `confidence`   — model self-rated confidence; low confidence makes the mapper PROPOSE not auto.
 *  - `reason`       — a short human-readable justification (shown in the UI / logs).
 */
import { z } from 'zod';

/** The closed set of triage dispositions. */
export const TRIAGE_DISPOSITIONS = ['needs-reply', 'no-reply-needed', 'fyi'] as const;
export type TriageDisposition = (typeof TRIAGE_DISPOSITIONS)[number];

/** Sender-importance hint levels (mirrors shared `IMPORTANCE_LEVELS`). */
export const TRIAGE_IMPORTANCE = ['high', 'normal', 'low'] as const;
export type TriageImportance = (typeof TRIAGE_IMPORTANCE)[number];

/** Confidence buckets — coarse on purpose; only the `low` bucket changes auto→propose behavior. */
export const TRIAGE_CONFIDENCE = ['high', 'medium', 'low'] as const;
export type TriageConfidence = (typeof TRIAGE_CONFIDENCE)[number];

/** Runtime validator for the model's structured triage decision. */
export const TriageDecisionSchema = z.object({
  disposition: z.enum(TRIAGE_DISPOSITIONS),
  needs_reply: z.boolean(),
  importance: z.enum(TRIAGE_IMPORTANCE),
  confidence: z.enum(TRIAGE_CONFIDENCE),
  reason: z.string().min(1).max(500),
});
export type TriageDecision = z.infer<typeof TriageDecisionSchema>;

/**
 * The JSON Schema handed to `claude --json-schema`. Hand-authored (not derived) so it stays a plain,
 * CLI-friendly object with `additionalProperties:false` and every field required — exactly what the
 * constrained-decoding path wants. Keep it in lockstep with {@link TriageDecisionSchema}.
 */
export const TRIAGE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['disposition', 'needs_reply', 'importance', 'confidence', 'reason'],
  properties: {
    disposition: {
      type: 'string',
      enum: [...TRIAGE_DISPOSITIONS],
      description:
        'The triage verdict: needs-reply (a reply is owed), no-reply-needed (a thanks/FYI that closes the thread), or fyi (informational, no action).',
    },
    needs_reply: {
      type: 'boolean',
      description: 'True iff the recipient owes a reply.',
    },
    importance: {
      type: 'string',
      enum: [...TRIAGE_IMPORTANCE],
      description:
        'Sender-importance hint: high (paying client / urgent), normal (internal/colleague), low (newsletter/automated).',
    },
    confidence: {
      type: 'string',
      enum: [...TRIAGE_CONFIDENCE],
      description: 'How confident you are in this classification.',
    },
    reason: {
      type: 'string',
      description: 'One short sentence justifying the disposition.',
    },
  },
} as const;
