/**
 * The `learn` JSON Schema + the runtime validator for the schema-constrained `structured_output` the
 * silent-learning model returns (PROJECT.md §6 "Continuous learning … writing a changelog the user
 * can review and revert"). Routed to SONNET via the shared `MODEL_ROUTING` map (`learn` is INTERNAL
 * analysis, not outgoing text — never Opus, never in `OUTGOING_TEXT_TASK_KINDS`).
 *
 * The model's job: given a recurring draft instruction OR a draft-vs-sent diff for a tone `scope`,
 * produce exactly two things —
 *   - `tone_update`: a concise, durable voice/tone LESSON to APPEND to that scope's tone memory. It is
 *     GUIDANCE for future drafting ("Prefer a one-line sign-off; the user trims long closings"), NEVER
 *     email text addressed to a recipient.
 *   - `summary`: a one-line changelog entry (what was learned), the ONLY field that crosses to the
 *     server (Golden rule #3 — no draft/message body leaves the machine).
 *
 * Mirrors the hand-authored style of `claude/promise-extraction-schema.ts` / `triage-schema.ts`: a
 * flat object, `additionalProperties:false`, every field required. The zod schema validates what comes
 * back (defense in depth — the CLI constrains output, we still parse before trusting it).
 */
import { z } from 'zod';

/** Validates the `learn` job's `structured_output`. Both fields required + non-empty. */
export const LearnOutputSchema = z.strictObject({
  tone_update: z.string().min(1).max(2000),
  summary: z.string().min(1).max(200),
});
export type LearnOutput = z.infer<typeof LearnOutputSchema>;

/**
 * The JSON Schema handed to `claude --json-schema`. Hand-authored (not derived from zod) so it stays a
 * plain, CLI-friendly object with `additionalProperties:false` and every field required — what
 * constrained decoding wants. Keep in lockstep with {@link LearnOutputSchema}.
 */
export const LEARN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tone_update', 'summary'],
  properties: {
    tone_update: {
      type: 'string',
      description:
        "A concise, durable voice/tone LESSON to append to this scope's tone memory. Write GUIDANCE for future drafting (e.g. 'Prefer a brief one-line sign-off; the user trims long closings.'). MUST NOT be email text addressed to a recipient, a greeting, or a draft — only instruction for how to write.",
    },
    summary: {
      type: 'string',
      description:
        "A single-line changelog entry naming what was learned (e.g. 'Learned: shorter sign-offs for this contact.'). One sentence, no body text.",
    },
  },
} as const;
