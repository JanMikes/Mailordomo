/**
 * The "Today" command-center read model (PROJECT.md §11; PLAN.md §7 Phase 7a, decision D29).
 *
 * This is the shape the LOCAL backend assembles and the React frontend renders: 3-way promise
 * metric cards + done-vs-remaining task counts + the ranked do-next queue. It is the synchronization
 * point between Implementer A (this backend data layer) and Implementer B (the frontend).
 *
 * PRIVACY (Golden rule #3 — body-free BY CONSTRUCTION): although the Today model is a
 * backend → frontend LOCAL hop (it is never sent to the metadata server), every schema here is a
 * `z.strictObject` carrying ONLY metadata + the two sanctioned message-derived fields (subject /
 * snippet / sender). There is deliberately NO message-body, draft-body, or attachment field — a
 * smuggled `body`/`draftBody`/`content` key fails `parse()`, exactly as on the server boundary.
 */
import { z } from 'zod';
import {
  ImportanceSchema,
  PromiseDirectionSchema,
  StaleReasonSchema,
  TaskStateSchema,
  UrgencyLabelSchema,
} from './enums';
import { IdSchema, IsoDateTimeSchema, SenderSchema, SnippetSchema } from './primitives';

/**
 * One metric tile's counts for a single promise direction: how many promises exist (`total`), how
 * many are still actionable (`openCount` = open OR overdue), and how many of those are past due
 * (`overdueCount`). `overdueCount <= openCount <= total` by construction in the assembler.
 */
export const TodayPromiseMetricSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  openCount: z.number().int().nonnegative(),
  overdueCount: z.number().int().nonnegative(),
});
export type TodayPromiseMetric = z.infer<typeof TodayPromiseMetricSchema>;

/**
 * The three promise metric tiles (PROJECT.md §7): my-promises (deliver), they-asked (I owe),
 * awaiting-them (chase). One {@link TodayPromiseMetricSchema} per direction.
 */
export const TodayPromiseMetricsSchema = z.strictObject({
  myPromises: TodayPromiseMetricSchema,
  theyAsked: TodayPromiseMetricSchema,
  awaitingThem: TodayPromiseMetricSchema,
});
export type TodayPromiseMetrics = z.infer<typeof TodayPromiseMetricsSchema>;

/** Done-vs-remaining task counts for the project (PROJECT.md §11 "done-vs-remaining counts"). */
export const TodayTaskCountsSchema = z.strictObject({
  remaining: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
});
export type TodayTaskCounts = z.infer<typeof TodayTaskCountsSchema>;

/**
 * One ranked do-next card (PROJECT.md §8/§11). METADATA ONLY: subject/snippet/sender are the
 * sanctioned message-derived fields; everything else is task/promise metadata. The do-next ORDER is
 * the array order (the backend ranks per §8/D26); `myPromiseUrgency`/`theyAskedUrgency` are the
 * categorical labels for the two commitment tiers (null when that tier has no actionable promise).
 * `hasDraftReady` reflects draft METADATA existence only (never the draft body — Golden rule #3).
 */
export const DoNextCardSchema = z.strictObject({
  threadId: IdSchema,
  subject: z.string(),
  snippet: SnippetSchema,
  sender: SenderSchema,
  projectId: IdSchema,
  /** Resolved project display name (D32); null when the metadata service couldn't be reached. */
  projectName: z.string().nullable(),
  state: TaskStateSchema,
  importance: ImportanceSchema,
  deadline: IsoDateTimeSchema.nullable(),
  followUpAt: IsoDateTimeSchema.nullable(),
  lastActivityAt: IsoDateTimeSchema.nullable(),
  /** Unique set of promise directions present on this thread (drives the color dots). */
  promiseDirections: z.array(PromiseDirectionSchema),
  /** Urgency label for this thread's most-urgent actionable my-promise; null if none. */
  myPromiseUrgency: UrgencyLabelSchema.nullable(),
  /** Urgency label for this thread's most-urgent actionable they-asked promise; null if none. */
  theyAskedUrgency: UrgencyLabelSchema.nullable(),
  hasDraftReady: z.boolean(),
  staleReason: StaleReasonSchema.nullable(),
  /** Age in ms since last activity at generation time; null when last activity is unknown. */
  ageMs: z.number().nullable(),
});
export type DoNextCard = z.infer<typeof DoNextCardSchema>;

/**
 * The full Today read model for ONE project (single-project Today for v1 — D29). `generatedAt` is
 * the backend's wall clock at assembly; `doNext` is in rank order (capped by the assembler).
 */
export const TodayReadModelSchema = z.strictObject({
  generatedAt: IsoDateTimeSchema,
  projectId: IdSchema,
  promiseMetrics: TodayPromiseMetricsSchema,
  taskCounts: TodayTaskCountsSchema,
  doNext: z.array(DoNextCardSchema),
});
export type TodayReadModel = z.infer<typeof TodayReadModelSchema>;

/**
 * The lightweight WebSocket envelope (PLAN.md open Q #28 / D29). The server pushes `today:changed`
 * (the client refetches `GET /api/today`); `ping`/`pong` are the heartbeat. A discriminated union so
 * a malformed frame fails validation. Carries NO payload — never any body/metadata over the socket.
 */
export const WsMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('today:changed') }),
  z.strictObject({ type: z.literal('ping') }),
  z.strictObject({ type: z.literal('pong') }),
]);
export type WsMessage = z.infer<typeof WsMessageSchema>;
