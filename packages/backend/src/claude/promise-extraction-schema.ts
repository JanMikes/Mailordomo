/**
 * The promise-extraction JSON Schema + the runtime validator for the schema-constrained
 * `structured_output` the extraction model returns (PROJECT.md §7: "an LLM extraction step
 * (`--json-schema`, Haiku→Sonnet) produces structured promise candidates; a deterministic
 * reconciler buckets them …"). Routed to Haiku via the shared `MODEL_ROUTING` map.
 *
 * This is the FIRST half of the load-bearing 3-way tracker — the LLM half. It is deliberately kept
 * to EXTRACTION ONLY: it surfaces raw promise *candidates* with a direction HINT and, when present,
 * the verbatim relative deadline ("by Friday") AND the model's resolution of it to an absolute ISO
 * date (anchored, in the prompt, to the message-received date in the mailbox timezone — §7/§9). It
 * does NOT do bucketing, status lifecycle, or due-date reconciliation — that is the PURE
 * `promise-reconciler` engine's job. Splitting the two is exactly what makes the engine
 * unit-testable (extraction mocked via the fake runner; reconciliation pure).
 *
 * The JSON Schema is the contract handed to `claude --json-schema`; the zod schema validates what
 * comes back (defense in depth — the CLI constrains output, we still parse before trusting it).
 * Both describe the same shape; keep them in lockstep. Mirrors the hand-authored style of
 * `triage-schema.ts`: a flat object, `additionalProperties:false`, every field required.
 */
import { z } from 'zod';
import { PROMISE_DIRECTIONS } from '@mailordomo/shared';

/**
 * The direction HINT the model assigns to a candidate. Identical vocabulary to the shared
 * `PROMISE_DIRECTIONS` (§7) — it is only a *hint* because the deterministic reconciler is the
 * authority that finalizes the bucket (it may correct an obvious mis-hint against `who`/`whom`).
 *  - `my-promise`    — the USER committed to do/deliver something.
 *  - `they-asked`    — the OTHER party asked the user for something (the user owes).
 *  - `awaiting-them` — the OTHER party committed to the user (the user chases if it lapses).
 */
export const PROMISE_DIRECTION_HINTS = PROMISE_DIRECTIONS;
export type PromiseDirectionHint = (typeof PROMISE_DIRECTION_HINTS)[number];

/**
 * A fulfillment / cancellation signal the model may attach when the SAME message makes a candidate's
 * resolution evident (e.g. "as promised, here is the spec" fulfils a prior my-promise; "never mind,
 * cancel that" cancels a request). Default `none` — most candidates are freshly `open`. The
 * reconciler maps these to the shared `PROMISE_STATUSES` lifecycle deterministically.
 */
export const PROMISE_FULFILLMENT_SIGNALS = ['none', 'fulfilled', 'cancelled'] as const;
export type PromiseFulfillmentSignal = (typeof PROMISE_FULFILLMENT_SIGNALS)[number];

/**
 * One extracted promise candidate. Kept small and flat for constrained decoding.
 *
 * Fields:
 *  - `direction_hint`     — which of the three directions this looks like (a hint; see above).
 *  - `text`               — the concise promise/request, paraphrased in the user's frame.
 *  - `due_raw`            — the VERBATIM relative/absolute deadline phrase as written ("by Friday",
 *                           "end of next week"), or null if none was stated. Carried so the
 *                           deterministic resolver can re-anchor it if it ever needs to.
 *  - `due_at`             — the model's RESOLUTION of `due_raw` to an absolute ISO-8601 datetime,
 *                           anchored to the message-received date + mailbox tz given in the prompt;
 *                           null when there is no deadline. The reconciler trusts a valid value and
 *                           falls back to its own deterministic resolver otherwise.
 *  - `who`                — the party OBLIGATED by this item, as `"me"` (the user) or the other
 *                           party's name/handle. Lets the reconciler sanity-check the direction.
 *  - `whom`               — the BENEFICIARY, same encoding. (`who`→`whom` owes the thing.)
 *  - `fulfillment_signal` — whether this same message already fulfils/cancels the item.
 *  - `confidence`         — model self-rating; the reconciler may drop `low`-confidence candidates.
 */
export const PromiseCandidateSchema = z.object({
  direction_hint: z.enum(PROMISE_DIRECTION_HINTS),
  text: z.string().min(1).max(1000),
  due_raw: z.string().max(200).nullable(),
  due_at: z.iso.datetime({ offset: true }).nullable(),
  who: z.string().min(1).max(200),
  whom: z.string().min(1).max(200),
  fulfillment_signal: z.enum(PROMISE_FULFILLMENT_SIGNALS),
  confidence: z.enum(['high', 'medium', 'low']),
});
export type PromiseCandidate = z.infer<typeof PromiseCandidateSchema>;

/** The model returns an OBJECT with a `promises` array (an array root is awkward for the CLI). */
export const PromiseExtractionSchema = z.object({
  promises: z.array(PromiseCandidateSchema),
});
export type PromiseExtraction = z.infer<typeof PromiseExtractionSchema>;

/**
 * The JSON Schema handed to `claude --json-schema`. Hand-authored (not derived from zod) so it stays
 * a plain, CLI-friendly object with `additionalProperties:false` and every field required — exactly
 * what constrained decoding wants. Keep in lockstep with {@link PromiseExtractionSchema}.
 */
export const PROMISE_EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['promises'],
  properties: {
    promises: {
      type: 'array',
      description:
        'Every commitment, request, or awaited deliverable found in the message. Empty array if none.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'direction_hint',
          'text',
          'due_raw',
          'due_at',
          'who',
          'whom',
          'fulfillment_signal',
          'confidence',
        ],
        properties: {
          direction_hint: {
            type: 'string',
            enum: [...PROMISE_DIRECTION_HINTS],
            description:
              "Direction from the USER's perspective: my-promise (the user committed to deliver), they-asked (the other party asked the user — the user owes), awaiting-them (the other party committed to the user — the user chases if late).",
          },
          text: {
            type: 'string',
            description:
              "The commitment/request in one short clause, phrased from the user's frame. E.g. 'Send Petr the v2 API spec'.",
          },
          due_raw: {
            type: ['string', 'null'],
            description:
              "The deadline phrase EXACTLY as written ('by Friday', 'end of next week', 'tomorrow'), or null if no deadline was stated.",
          },
          due_at: {
            type: ['string', 'null'],
            description:
              'The deadline resolved to an absolute ISO-8601 datetime WITH timezone offset, anchored to the message-received date and timezone given above. Null if there is no deadline.',
          },
          who: {
            type: 'string',
            description:
              'Who is OBLIGATED to deliver this item: "me" for the user, otherwise the other party\'s name or handle.',
          },
          whom: {
            type: 'string',
            description:
              'Who BENEFITS / is owed this item: "me" for the user, otherwise the other party\'s name or handle.',
          },
          fulfillment_signal: {
            type: 'string',
            enum: [...PROMISE_FULFILLMENT_SIGNALS],
            description:
              "Whether THIS message already resolves the item: 'fulfilled' (it was delivered/done here), 'cancelled' (it was withdrawn), or 'none' (still outstanding).",
          },
          confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'How confident you are this is a real, actionable promise/request.',
          },
        },
      },
    },
  },
} as const;
