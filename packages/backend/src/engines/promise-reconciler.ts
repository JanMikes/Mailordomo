/**
 * The deterministic 3-way promise RECONCILER — THE load-bearing engine of PROJECT.md §7. PURE: no IO,
 * no wall clock, no randomness (ids + "now" are injected). This is the SECOND half of the tracker: it
 * takes the LLM's structured promise *candidates* (from `claude/extract-promises.ts`, validated by
 * `PromiseCandidateSchema`) and produces reconciled `PromiseRecord`s — the canonical shared shape.
 *
 * It does three things, all deterministically:
 *
 *  1. BUCKET each candidate into one of the three directions (§7):
 *       · my-promise    🟢  — I committed to deliver           (I deliver)
 *       · they-asked    🟡  — they asked me / their deadline of me (I owe)
 *       · awaiting-them  🔵  — they committed to me             (I chase if overdue)
 *     The model gives a `direction_hint`; we TRUST it but CORRECT it from the unambiguous `who`/`whom`
 *     ("me"↔other) when those contradict the hint, so a mis-hint can't put a promise in the wrong
 *     column. (See `bucketDirection`.)
 *
 *  2. RESOLVE the due date: trust the model's anchored ISO `due_at` if it is a valid datetime;
 *     otherwise fall back to the PURE deterministic resolver (`resolveRelativeDeadline`) over
 *     `due_raw`, anchored to the message-received date in Europe/Prague (§7/§9). `due_raw` is carried
 *     through verbatim on the record so extraction and reconciliation stay separable.
 *
 *  3. Set STATUS in the lifecycle `open → fulfilled | overdue | cancelled` (§7):
 *       · the model's `fulfillment_signal` ('fulfilled'/'cancelled') wins (an explicit signal in the
 *         same message), else
 *       · `overdue` iff a resolved `due_at` is strictly before `now` AND it is still open, else
 *       · `open`.
 *     `overdue` is a LIVE state (still open, past due) — exactly what drives the chase/nudge.
 *
 * The reconciler is also `reconcileExisting` — re-evaluating ALREADY-stored records against a new
 * `now` (the daemon's stale pass) WITHOUT the LLM: an `open` record whose `due_at` has passed flips to
 * `overdue`; `fulfilled`/`cancelled` are terminal and never reopened here. This is the deterministic
 * step the do-next ranker and the overdue-nudge predicate read.
 */
import type {
  Actor,
  PromiseDirection,
  PromiseRecord,
  PromiseStatus,
  ThreadId,
} from '@mailordomo/shared';
import { AUTOMATED_ACTOR } from '@mailordomo/shared';
import type {
  PromiseCandidate,
  PromiseFulfillmentSignal,
} from '../claude/promise-extraction-schema';
import { resolveRelativeDeadline } from './relative-deadline';

/** Tokens that denote "the user" in a candidate's `who`/`whom`. Case/space-insensitive match. */
const SELF_TOKENS = new Set(['me', 'i', 'self', 'user', 'myself']);

function isSelf(party: string): boolean {
  return SELF_TOKENS.has(party.trim().toLowerCase());
}

/**
 * Finalize the DIRECTION (the bucket) for a candidate. The model's `direction_hint` is the default;
 * `who`/`whom` (the OBLIGOR / beneficiary) only override a hint that CONTRADICTS them.
 *
 * The subtlety (§7): `my-promise` AND `they-asked` BOTH have ME as the obligor ("I owe the
 * deliverable") — they differ only by who INITIATED (I volunteered vs they requested), which the
 * model reads from prose and the `who`/`whom` fields cannot distinguish. Only `awaiting-them` has the
 * OTHER party as obligor. So:
 *  - obligor = OTHER, beneficiary = me ⇒ force `awaiting-them` (the only "they owe me" direction);
 *    if the hint already says that, no change.
 *  - obligor = ME ⇒ it must be an "I owe" direction; keep the hint if it is `my-promise`/`they-asked`,
 *    but CORRECT a contradicting `awaiting-them` hint to `my-promise` (a default "I owe" bucket).
 *  - otherwise (ambiguous: both me, both other, or neither me) ⇒ trust the model's hint.
 */
export function bucketDirection(candidate: PromiseCandidate): PromiseDirection {
  const whoSelf = isSelf(candidate.who);
  const whomSelf = isSelf(candidate.whom);

  // The other party is obligated to me → unambiguously "they owe me".
  if (!whoSelf && whomSelf) {
    return 'awaiting-them';
  }
  // I am the obligor → an "I owe" direction. Keep the hint unless it contradicts (says they owe me).
  if (whoSelf && !whomSelf) {
    return candidate.direction_hint === 'awaiting-them' ? 'my-promise' : candidate.direction_hint;
  }
  // Ambiguous obligor/beneficiary → trust the model's hint (it read the full prose).
  return candidate.direction_hint;
}

/**
 * Resolve a candidate's deadline to an absolute ISO string (or null). Trust the model's anchored
 * `due_at` when it is a valid datetime; otherwise fall back to the deterministic resolver over
 * `due_raw`, anchored to the message-received instant in Europe/Prague. Pure.
 */
export function resolveDueAt(
  candidate: Pick<PromiseCandidate, 'due_at' | 'due_raw'>,
  messageReceivedIso: string,
): string | null {
  if (candidate.due_at !== null) {
    const ms = Date.parse(candidate.due_at);
    if (!Number.isNaN(ms)) {
      return new Date(ms).toISOString();
    }
  }
  if (candidate.due_raw !== null && candidate.due_raw.trim() !== '') {
    const resolved = resolveRelativeDeadline(candidate.due_raw, messageReceivedIso);
    if (resolved !== null) {
      return resolved.toISOString();
    }
  }
  return null;
}

/**
 * Map an explicit fulfillment signal + the due/now relationship to a status in the §7 lifecycle.
 * Pure. `dueAt`/`now` are ISO strings; `overdue` requires a resolved due strictly in the past.
 */
export function deriveStatus(
  signal: PromiseFulfillmentSignal,
  dueAtIso: string | null,
  nowIso: string,
): PromiseStatus {
  if (signal === 'fulfilled') return 'fulfilled';
  if (signal === 'cancelled') return 'cancelled';
  if (dueAtIso !== null) {
    const due = Date.parse(dueAtIso);
    const now = Date.parse(nowIso);
    if (!Number.isNaN(due) && !Number.isNaN(now) && due < now) {
      return 'overdue';
    }
  }
  return 'open';
}

/** Context the reconciler needs that is NOT on the candidate itself. */
export interface ReconcileContext {
  readonly threadId: ThreadId;
  /** ISO-8601 instant the source message was received — the deadline-resolution anchor (§7/§9). */
  readonly messageReceivedIso: string;
  /** ISO-8601 "now" — injected for deterministic overdue evaluation (no wall clock here). */
  readonly nowIso: string;
  /** Actor to attribute extracted records to (default {@link AUTOMATED_ACTOR} — the daemon). */
  readonly actor?: Actor;
  /** Deterministic id factory (e.g. a counter or ULID gen). Injected so output is reproducible. */
  readonly newId: () => string;
  /**
   * Drop candidates at/below this confidence. Default keeps all. The 3-way view tolerates a missed
   * promise better than a phantom one, but extraction confidence is conservative; default is inclusive.
   */
  readonly minConfidence?: 'high' | 'medium' | 'low';
}

const CONFIDENCE_RANK: Record<'high' | 'medium' | 'low', number> = { low: 0, medium: 1, high: 2 };

/**
 * Reconcile a batch of freshly-extracted candidates from ONE message into canonical `PromiseRecord`s.
 * Pure and total: every kept candidate yields exactly one record; nothing is mutated, no IO. Records
 * are NOT de-duplicated against existing stored promises here — that join (by thread + text similarity)
 * belongs to the metadata layer; this engine is the deterministic transform from candidate → record.
 */
export function reconcileCandidates(
  candidates: readonly PromiseCandidate[],
  context: ReconcileContext,
): PromiseRecord[] {
  const actor = context.actor ?? AUTOMATED_ACTOR;
  const floor = context.minConfidence;
  const records: PromiseRecord[] = [];

  for (const candidate of candidates) {
    if (floor !== undefined && CONFIDENCE_RANK[candidate.confidence] < CONFIDENCE_RANK[floor]) {
      continue;
    }
    const direction = bucketDirection(candidate);
    const dueAt = resolveDueAt(candidate, context.messageReceivedIso);
    const status = deriveStatus(candidate.fulfillment_signal, dueAt, context.nowIso);

    records.push({
      id: context.newId(),
      thread_id: context.threadId,
      direction,
      text: candidate.text,
      due_at: dueAt,
      due_raw: candidate.due_raw,
      status,
      actor,
      created_at: context.nowIso,
    });
  }

  return records;
}

/**
 * Deterministically RE-EVALUATE already-stored records against a fresh `now` WITHOUT the LLM — the
 * daemon's periodic stale pass. The only live transition here is `open → overdue` when a resolved
 * `due_at` has passed; `fulfilled`/`cancelled`/already-`overdue` are returned unchanged (terminal or
 * stable). Pure: returns a NEW array, mutating nothing.
 */
export function reconcileExisting(
  records: readonly PromiseRecord[],
  nowIso: string,
): PromiseRecord[] {
  return records.map((record) => {
    if (record.status !== 'open') {
      return record;
    }
    if (record.due_at === null) {
      return record;
    }
    const due = Date.parse(record.due_at);
    const now = Date.parse(nowIso);
    if (!Number.isNaN(due) && !Number.isNaN(now) && due < now) {
      return { ...record, status: 'overdue' as PromiseStatus };
    }
    return record;
  });
}

/** Bucket reconciled records by direction — the shape the 3-way color-coded view consumes (§7). */
export interface ThreeWayBuckets {
  readonly myPromises: PromiseRecord[];
  readonly theyAsked: PromiseRecord[];
  readonly awaitingThem: PromiseRecord[];
}

/** Group records into the three directional buckets, preserving input order within each. */
export function groupByDirection(records: readonly PromiseRecord[]): ThreeWayBuckets {
  const buckets: ThreeWayBuckets = { myPromises: [], theyAsked: [], awaitingThem: [] };
  for (const record of records) {
    switch (record.direction) {
      case 'my-promise':
        buckets.myPromises.push(record);
        break;
      case 'they-asked':
        buckets.theyAsked.push(record);
        break;
      case 'awaiting-them':
        buckets.awaitingThem.push(record);
        break;
    }
  }
  return buckets;
}
