/**
 * Closed vocabularies shared across the system. Each is exported three ways:
 *  - a `const` tuple (`X_VALUES`) for building `Record<…>` maps and exhaustiveness checks,
 *  - a zod schema (`XSchema`) for runtime validation,
 *  - an inferred TypeScript union (`type X`).
 */
import { z } from 'zod';

/**
 * Email-as-task state machine (PROJECT.md §6). Exactly these five states; `done` includes the
 * no-reply-needed case ("they just said thanks"). The allowed edges between them — and which are
 * auto-set vs proposed-for-confirmation — live in `states.ts` as data.
 */
export const TASK_STATES = ['needs-reply', 'drafted', 'waiting', 'follow-up', 'done'] as const;
export const TaskStateSchema = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskStateSchema>;

/**
 * Whether a state transition is applied automatically or proposed for human confirmation
 * (PROJECT.md §6: "auto-sets obvious transitions … and proposes ambiguous ones").
 */
export const TRANSITION_MODES = ['auto', 'propose'] as const;
export const TransitionModeSchema = z.enum(TRANSITION_MODES);
export type TransitionMode = z.infer<typeof TransitionModeSchema>;

/**
 * The 3-way promise tracker direction (PROJECT.md §7). Exactly three values, named for the
 * actor + obligation they encode:
 *  - `my-promise`    — commitments I made          → I deliver           (🟢 green)
 *  - `they-asked`    — their request/deadline of me → I owe              (🟡 amber)
 *  - `awaiting-them` — their promise to me          → I chase if overdue (🔵 blue)
 */
export const PROMISE_DIRECTIONS = ['my-promise', 'they-asked', 'awaiting-them'] as const;
export const PromiseDirectionSchema = z.enum(PROMISE_DIRECTIONS);
export type PromiseDirection = z.infer<typeof PromiseDirectionSchema>;

/**
 * Promise status lifecycle (PROJECT.md §7): `open → fulfilled | overdue | cancelled`.
 * `overdue` is a live state (still open but past due) that the reconciler sets from `due_at`.
 */
export const PROMISE_STATUSES = ['open', 'fulfilled', 'overdue', 'cancelled'] as const;
export const PromiseStatusSchema = z.enum(PROMISE_STATUSES);
export type PromiseStatus = z.infer<typeof PromiseStatusSchema>;

/**
 * Tone-memory layering scope (PROJECT.md §6 / §3): `project → mailbox → contact`, with contact
 * overriding mailbox overriding project at resolution time.
 */
export const TONE_SCOPES = ['project', 'mailbox', 'contact'] as const;
export const ToneScopeSchema = z.enum(TONE_SCOPES);
export type ToneScope = z.infer<typeof ToneScopeSchema>;

/**
 * Sender / task importance, the second input to the do-next ranker (PROJECT.md §8: paying
 * clients > internal > newsletters). Seeded heuristically server-side and user-adjustable.
 * Ordering for ranking lives in `routing.ts`/ranker; the mapping is high≈client, normal≈internal,
 * low≈newsletter.
 */
export const IMPORTANCE_LEVELS = ['high', 'normal', 'low'] as const;
export const ImportanceSchema = z.enum(IMPORTANCE_LEVELS);
export type Importance = z.infer<typeof ImportanceSchema>;

/** Fixed model aliases (PROJECT.md §4). Resolve to latest stable via the `claude` binary. */
export const MODEL_ALIASES = ['haiku', 'sonnet', 'opus'] as const;
export const ModelAliasSchema = z.enum(MODEL_ALIASES);
export type ModelAlias = z.infer<typeof ModelAliasSchema>;

/** The kinds of Claude job the runner dispatches; the key space of the model-routing map. */
export const TASK_KINDS = [
  'triage',
  'promise-extraction',
  'summarize',
  'digest',
  'rank',
  'draft',
  'nudge',
  'repo-answer',
  // Silent-learning analysis (Phase 6): turns a recurring instruction or a draft-vs-sent diff into a
  // durable tone-memory lesson + a changelog summary. INTERNAL memory work, NOT outgoing text — so it
  // routes to Sonnet (NOT in `OUTGOING_TEXT_TASK_KINDS`) and is DEFERRABLE (not in the essential set).
  'learn',
] as const;
export const TaskKindSchema = z.enum(TASK_KINDS);
export type TaskKind = z.infer<typeof TaskKindSchema>;

/**
 * Actor attribution. A stable identifier for whoever performed an action: a human user key
 * (e.g. "jan", "simona") or {@link AUTOMATED_ACTOR} when Claude/the daemon acted. Drives the
 * digest's "what Simona handled" line and distinguishes auto from human transitions.
 */
export const ActorSchema = z.string().min(1);
export type Actor = z.infer<typeof ActorSchema>;

/** Actor value recorded when Claude/the background daemon performs an action (default). */
export const AUTOMATED_ACTOR = 'claude';

/**
 * Categorical urgency LABEL of a dated commitment, surfaced on the Today do-next cards
 * (PROJECT.md §8/§11). Derived from a promise's resolved deadline relative to "now":
 *  - `overdue`   — past its `due_at` (most urgent),
 *  - `due-soon`  — a future deadline within the next 48h,
 *  - `dated`     — a future deadline further out,
 *  - `undated`   — a live commitment with no resolved date.
 * This is a DISPLAY vocabulary only; the ranker still orders by the precise numeric urgency, so the
 * label and the ordering can never disagree on which band a card is in.
 */
export const URGENCY_LABELS = ['overdue', 'due-soon', 'dated', 'undated'] as const;
export const UrgencyLabelSchema = z.enum(URGENCY_LABELS);
export type UrgencyLabel = z.infer<typeof UrgencyLabelSchema>;

/**
 * Why a thread is STALE (the pure `detectStale` engine in `backend/engines/stale.ts`). This is the
 * SINGLE SOURCE OF TRUTH for the vocabulary: the backend engine imports this union rather than
 * declaring its own, so the contract and the detector can never drift. Each value maps to UI copy +
 * which action the Today card offers:
 *  - `follow-up-deadline-passed` — a follow-up/hard deadline has elapsed,
 *  - `awaiting-reply-too-long`   — `waiting` with no deadline, silent past the threshold,
 *  - `in-follow-up-state`        — already flagged to chase (act now),
 *  - `unanswered-too-long`       — `needs-reply`/`drafted` I'm sitting on past the threshold.
 */
export const STALE_REASONS = [
  'follow-up-deadline-passed',
  'awaiting-reply-too-long',
  'in-follow-up-state',
  'unanswered-too-long',
] as const;
export const StaleReasonSchema = z.enum(STALE_REASONS);
export type StaleReason = z.infer<typeof StaleReasonSchema>;
