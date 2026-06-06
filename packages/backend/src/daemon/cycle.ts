/**
 * The background-daemon ORCHESTRATOR (PROJECT.md §6; PLAN.md D34) — one pass over new messages,
 * composing the existing engines. It REIMPLEMENTS NOTHING: it calls `triageMessage` (Haiku → state
 * machine), `extractPromises` (Haiku → reconciler), `detectStale`, `summarizeThread` (Sonnet), and
 * the sanctioned overdue-`draftNudge` (Opus, draft-only), and turns their outputs into METADATA
 * writes through the injected port.
 *
 * AUTONOMY (§6): "auto-set the obvious, propose the ambiguous." Triage transitions are applied ONLY
 * when the state machine says `apply` (auto); `propose` edges are left for the user. Brand-new
 * threads get a task in the triaged state. The stale pass auto-advances `waiting → follow-up` only on
 * an `auto` edge. The ONLY unprompted draft is the overdue nudge for a lapsed INBOUND promise — and
 * it DRAFTS, never sends (the filer is a saveDraft-only seam; there is no transport on this path).
 *
 * THROTTLE (§4): every job is gated on the usage window. ESSENTIAL kinds (triage, promise-extraction,
 * nudge) proceed even over the throttle (with a logged warning); the DEFERRABLE summary is dropped
 * under backpressure so the daemon never starves the user's interactive Claude work.
 *
 * GOLDEN RULE #1 (structural): this file imports NO `smtp/**`, NO `api/**`, NO root barrel — only the
 * pure engines, the claude consumers, and the injected metadata/filer seams. It cannot transmit.
 */
import { randomUUID } from 'node:crypto';
import type { CreatePromiseRequest, PromiseRecord, TaskState } from '@mailordomo/shared';
import { AUTOMATED_ACTOR, modelForTask } from '@mailordomo/shared';
import { triageMessage } from '../claude/triage';
import type { TriageResult } from '../claude/triage';
import { extractPromises } from '../claude/extract-promises';
import { summarizeThread } from '../claude/summarize';
import { draftNudge } from '../claude/nudge';
import { eventTargetState, resolveEvent } from '../engines/state-machine';
import { detectStale } from '../engines/stale';
import { shouldNudgeAt } from '../engines/overdue-nudge';
import type { DaemonCycleDeps, DaemonCycleResult, DaemonMessage } from './types';

/** Mutable per-cycle tallies (folded into the immutable {@link DaemonCycleResult} at the end). */
interface Tallies {
  processed: number;
  tasksCreated: number;
  transitions: number;
  promisesCreated: number;
  summarized: number;
  nudgesDrafted: number;
  deferred: number;
  errors: { threadId: string; error: string }[];
}

/**
 * Run ONE daemon pass: poll new messages and, for each, triage → (state writes) → extract promises →
 * stale check → (throttled) summarize → overdue-nudge. Resilient: a failure on one message is
 * recorded and the pass continues. Pure-ish — all IO/nondeterminism is injected via {@link deps}.
 */
export async function runDaemonCycle(deps: DaemonCycleDeps): Promise<DaemonCycleResult> {
  const log = deps.logger ?? ((message, meta) => console.info(`[daemon] ${message}`, meta ?? ''));
  const messages = await deps.source.poll();

  const tallies: Tallies = {
    processed: 0,
    tasksCreated: 0,
    transitions: 0,
    promisesCreated: 0,
    summarized: 0,
    nudgesDrafted: 0,
    deferred: 0,
    errors: [],
  };

  for (const message of messages) {
    try {
      await processMessage(message, deps, tallies);
      tallies.processed += 1;
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      tallies.errors.push({ threadId: message.threadId, error });
      log(`message failed for thread ${message.threadId}`, error);
    }
  }

  return {
    processed: tallies.processed,
    tasksCreated: tallies.tasksCreated,
    transitions: tallies.transitions,
    promisesCreated: tallies.promisesCreated,
    summarized: tallies.summarized,
    nudgesDrafted: tallies.nudgesDrafted,
    deferred: tallies.deferred,
    errors: tallies.errors,
  };
}

async function processMessage(
  message: DaemonMessage,
  deps: DaemonCycleDeps,
  tallies: Tallies,
): Promise<void> {
  const { runner, throttle, metadata } = deps;
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const newId = deps.newId ?? randomUUID;

  // 1) TRIAGE (essential) → state-machine outcome → task create / auto-transition.
  let triageApplied = false;
  if (throttle.check('triage').allowed) {
    const result = await triageMessage(
      runner,
      {
        subject: message.subject,
        sender: message.sender,
        snippet: message.snippet,
        ...(message.body.trim() !== '' ? { body: message.body } : {}),
      },
      message.task.state,
    );
    throttle.record('triage', result);
    triageApplied = await applyTriage(message, result, deps, tallies);
  }

  // 2) EXTRACT PROMISES (essential) → reconcile → create promise metadata.
  if (throttle.check('promise-extraction').allowed) {
    const extraction = await extractPromises(
      runner,
      {
        subject: message.subject,
        sender: message.sender,
        body: message.body,
        receivedIso: message.receivedIso,
        ...(message.timezone !== undefined ? { timezone: message.timezone } : {}),
      },
      { threadId: message.threadId, nowIso: now, actor: AUTOMATED_ACTOR, newId },
    );
    throttle.record('promise-extraction', extraction);
    if (extraction.promises.length > 0) {
      // DEDUP against promises already recorded on this thread, so re-processing a message never
      // creates duplicate rows. The daemon MUST be idempotent here: the cache is disposable
      // (rebuild-from-empty re-emits the recent backlog), an IDLE-hot + cold-poll overlap can
      // re-enumerate, and a re-delivered message would otherwise multiply promises every cycle.
      const existing = await metadata.listPromises(message.threadId);
      const seen = new Set(existing.map(promiseDedupKey));
      for (const promise of extraction.promises) {
        const key = promiseDedupKey(promise);
        if (seen.has(key)) continue;
        seen.add(key); // guard against duplicates WITHIN one extraction too
        await metadata.createPromise(toCreatePromise(promise));
        tallies.promisesCreated += 1;
      }
    }
  }

  // 3) STALE DETECTION → auto `waiting → follow-up` (only if triage did not already move the state).
  if (!triageApplied && message.task.id !== null && message.task.state === 'waiting') {
    const verdict = detectStale(
      {
        state: message.task.state,
        lastActivityIso: message.task.lastActivityIso,
        followUpAtIso: message.task.followUpAtIso,
        deadlineIso: message.task.deadlineIso,
      },
      now,
      deps.staleThresholds ?? {},
    );
    if (verdict.stale) {
      const outcome = resolveEvent('waiting', 'deadline-lapsed');
      if (outcome.kind === 'apply') {
        await metadata.createTransition(message.task.id, {
          to: outcome.to,
          actor: AUTOMATED_ACTOR,
          expected_from: 'waiting',
        });
        tallies.transitions += 1;
      }
    }
  }

  // 4) SUMMARIZE (deferrable) — gated; dropped under throttle backpressure.
  if (message.threadMessages.length > 0) {
    if (throttle.check('summarize').allowed) {
      const summary = await summarizeThread(runner, message.threadMessages, {
        subject: message.subject,
      });
      throttle.record('summarize', summary);
      deps.onSummary?.(message.threadId, summary.summary);
      tallies.summarized += 1;
    } else {
      tallies.deferred += 1;
    }
  }

  // 5) OVERDUE NUDGE — the ONE sanctioned auto-draft, for a lapsed INBOUND promise. Draft, never send.
  await maybeNudge(message, deps, now, tallies);
}

/**
 * Apply the triage outcome to metadata. Returns `true` iff a state-changing write happened (so the
 * stale pass knows the state is no longer what the message reported). New thread → create a task in
 * the triaged state; existing task → record ONLY an `auto` transition (propose is left for the user).
 */
async function applyTriage(
  message: DaemonMessage,
  result: TriageResult,
  deps: DaemonCycleDeps,
  tallies: Tallies,
): Promise<boolean> {
  const { metadata } = deps;
  if (message.task.id === null) {
    // Brand-new thread: open a task in the inferred state. No event (FYI) ⇒ nothing owed ⇒ done.
    const state: TaskState = result.event === null ? 'done' : eventTargetState(result.event);
    await metadata.createTask({ thread_id: message.threadId, state });
    tallies.tasksCreated += 1;
    return state !== message.task.state;
  }
  if (result.transition?.kind === 'apply') {
    await metadata.createTransition(message.task.id, {
      to: result.transition.to,
      actor: AUTOMATED_ACTOR,
      expected_from: result.transition.from,
    });
    tallies.transitions += 1;
    return true;
  }
  return false;
}

/**
 * Draft the sanctioned overdue nudge if a lapsed INBOUND promise exists on the thread. Dedup: skip if
 * the thread already has a draft (so we never pile nudges every cycle). One nudge per thread per pass
 * (the most-overdue lapsed promise). Files via the injected saveDraft-only seam — NEVER sends.
 */
async function maybeNudge(
  message: DaemonMessage,
  deps: DaemonCycleDeps,
  now: string,
  tallies: Tallies,
): Promise<void> {
  const { runner, throttle, metadata, filer } = deps;
  const promises = await metadata.listPromises(message.threadId);
  const lapsed = promises
    .filter((promise) => shouldNudgeAt(promise, now))
    .sort((a, b) => dueAtAsc(a, b));
  if (lapsed.length === 0) return;

  // Dedup against any existing draft (a prior nudge OR a user draft) for this thread.
  const existingDrafts = await metadata.listDraftMeta(message.threadId);
  if (existingDrafts.length > 0) return;

  if (!throttle.check('nudge').allowed) return; // nudge is essential → effectively always allowed
  const target = lapsed[0];
  if (target === undefined) return;
  const nudge = await draftNudge(
    runner,
    {
      promise: {
        text: target.text,
        due_at: target.due_at,
        due_raw: target.due_raw,
        direction: target.direction,
        status: target.status,
      },
      recipient: message.sender,
      subject: message.subject,
      nowIso: now,
    },
    filer,
  );
  throttle.record('nudge', nudge);
  // Record body-free draft metadata so Today flags `hasDraftReady` and the next cycle dedups. The
  // DraftMeta model is the routing ALIAS; the nudge is always Opus (Golden rule #6 floor).
  await metadata.createDraftMeta({
    thread_id: message.threadId,
    version: 1,
    model: modelForTask('nudge'),
    author: AUTOMATED_ACTOR,
  });
  tallies.nudgesDrafted += 1;
}

/**
 * Identity of a promise ON A THREAD for dedup: same direction + same (trimmed) text + same resolved
 * deadline ⇒ the same commitment. Used so re-processing a message never creates a duplicate row.
 * `JSON.stringify` over the tuple keeps the dedup key unambiguous (no separator collides).
 */
function promiseDedupKey(promise: Pick<PromiseRecord, 'direction' | 'text' | 'due_at'>): string {
  return JSON.stringify([promise.direction, promise.text.trim(), promise.due_at]);
}

/** Map a reconciled {@link PromiseRecord} onto the body-free create request. */
function toCreatePromise(promise: PromiseRecord): CreatePromiseRequest {
  return {
    thread_id: promise.thread_id,
    direction: promise.direction,
    text: promise.text,
    due_at: promise.due_at,
    due_raw: promise.due_raw,
    status: promise.status,
    actor: promise.actor,
  };
}

/** Sort lapsed promises most-overdue first (earliest `due_at`); nulls last. */
function dueAtAsc(a: PromiseRecord, b: PromiseRecord): number {
  if (a.due_at === null) return b.due_at === null ? 0 : 1;
  if (b.due_at === null) return -1;
  return Date.parse(a.due_at) - Date.parse(b.due_at);
}
