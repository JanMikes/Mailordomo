/**
 * Assemble the "Today" command-center read model (PROJECT.md §11; PLAN.md §7 Phase 7a, D29) from
 * metadata the backend already holds. A PURE function — no IO, no wall clock; `nowIso` is injected —
 * so it is fully unit-testable with a fixed clock (mirrors `threads-view.ts`).
 *
 * It REUSES the load-bearing pure engines rather than re-implementing them: `detectStale` for the
 * stale verdict (with the user-adjustable thresholds from settings, D27) and `rankTasks` for the
 * do-next order (with the D26 two-tier my-promise / they-asked key). It computes nothing the engines
 * already own.
 *
 * PRIVACY (Golden rule #3): the output is body-free by construction — the cards carry only the
 * sanctioned subject/snippet/sender plus task/promise metadata (see `shared/src/today.ts`).
 */
import type {
  AppSettings,
  DoNextCard,
  DraftMeta,
  PromiseDirection,
  PromiseRecord,
  Task,
  Thread,
  TodayPromiseMetric,
  TodayPromiseMetrics,
  TodayReadModel,
  TodayTaskCounts,
  UrgencyLabel,
} from '@mailordomo/shared';
import { PROMISE_DIRECTIONS } from '@mailordomo/shared';
import { detectStale, rankTasks } from '../engines';
import type { RankableTask } from '../engines';

/** The metadata the assembler reasons over. `projectId` is the configured single Today project (D29). */
export interface TodayViewInput {
  readonly projectId: string;
  readonly tasks: readonly Task[];
  readonly threads: readonly Thread[];
  readonly promises: readonly PromiseRecord[];
  readonly draftMeta: readonly DraftMeta[];
  readonly settings: AppSettings;
}

/** Max do-next cards emitted (PLAN.md D29: a future setting). Counts/metrics are NOT capped. */
export const MAX_DO_NEXT_CARDS = 50;

/** "Due soon" window for the urgency label: a future deadline within the next 48h. */
const DUE_SOON_MS = 48 * 60 * 60 * 1000;

/** A promise is actionable (counts toward open/urgency) iff still `open` or `overdue`. */
function isActionable(p: Pick<PromiseRecord, 'status'>): boolean {
  return p.status === 'open' || p.status === 'overdue';
}

/** Group records by `thread_id`, preserving input order within each bucket. */
function groupByThread<T extends { thread_id: string }>(records: readonly T[]): Map<string, T[]> {
  const byThread = new Map<string, T[]>();
  for (const record of records) {
    const bucket = byThread.get(record.thread_id);
    if (bucket === undefined) byThread.set(record.thread_id, [record]);
    else bucket.push(record);
  }
  return byThread;
}

/**
 * The categorical urgency label for a set of ACTIONABLE same-direction promises (overdue > due-soon
 * > dated > undated), or null when the set is empty. Aligned with the ranker's numeric urgency band
 * so the label and the ordering can never disagree.
 */
function urgencyLabel(
  actionable: readonly Pick<PromiseRecord, 'due_at'>[],
  nowMs: number,
): UrgencyLabel | null {
  if (actionable.length === 0) return null;
  let hasOverdue = false;
  let hasDueSoon = false;
  let hasDated = false;
  for (const promise of actionable) {
    if (promise.due_at === null) continue;
    const due = Date.parse(promise.due_at);
    if (Number.isNaN(due)) continue;
    const msFromNow = due - nowMs;
    if (msFromNow < 0) hasOverdue = true;
    else if (msFromNow <= DUE_SOON_MS) hasDueSoon = true;
    else hasDated = true;
  }
  if (hasOverdue) return 'overdue';
  if (hasDueSoon) return 'due-soon';
  if (hasDated) return 'dated';
  return 'undated'; // actionable commitment(s) but none carry a resolved date
}

/** Unique directions present on a thread (ANY status), in the canonical 3-way order. */
function presentDirections(promises: readonly PromiseRecord[]): PromiseDirection[] {
  const present = new Set<PromiseDirection>(promises.map((p) => p.direction));
  return PROMISE_DIRECTIONS.filter((dir) => present.has(dir));
}

/** Per-direction metric: total (any status), open (actionable), overdue. */
function metricFor(
  promises: readonly PromiseRecord[],
  direction: PromiseDirection,
): TodayPromiseMetric {
  let total = 0;
  let openCount = 0;
  let overdueCount = 0;
  for (const promise of promises) {
    if (promise.direction !== direction) continue;
    total += 1;
    if (isActionable(promise)) openCount += 1;
    if (promise.status === 'overdue') overdueCount += 1;
  }
  return { total, openCount, overdueCount };
}

/**
 * Build the Today read model. The flow: group promises + drafts by thread; compute the 3-way metric
 * tiles + done/remaining counts over ALL input; then for each NON-DONE task with a known thread,
 * run `detectStale`, partition its actionable promises, derive the two urgency labels, and assemble a
 * {@link DoNextCard}; finally `rankTasks` orders the cards (D26 two-tier key) and the list is capped.
 */
export function assembleTodayView(input: TodayViewInput, nowIso: string): TodayReadModel {
  const nowMs = Date.parse(nowIso);
  const { settings } = input;

  const promisesByThread = groupByThread(input.promises);
  const draftsByThread = groupByThread(input.draftMeta);
  const threadsById = new Map(input.threads.map((thread) => [thread.id, thread] as const));

  // 3-way metric tiles over every promise in the project.
  const promiseMetrics: TodayPromiseMetrics = {
    myPromises: metricFor(input.promises, 'my-promise'),
    theyAsked: metricFor(input.promises, 'they-asked'),
    awaitingThem: metricFor(input.promises, 'awaiting-them'),
  };

  // Done-vs-remaining over every task.
  let done = 0;
  let remaining = 0;
  for (const task of input.tasks) {
    if (task.state === 'done') done += 1;
    else remaining += 1;
  }
  const taskCounts: TodayTaskCounts = { remaining, done };

  // Build one card per thread for the actionable (non-done) tasks. Dedupe by thread so the ranker
  // (which keys by thread id) never sees a duplicate id; the first non-done task for a thread wins.
  const rankables: RankableTask[] = [];
  const cardsByThread = new Map<string, DoNextCard>();

  for (const task of input.tasks) {
    if (task.state === 'done') continue;
    const threadId = task.thread_id;
    if (cardsByThread.has(threadId)) continue;
    const thread = threadsById.get(threadId);
    if (thread === undefined) continue; // no cached thread → cannot render a (body-free) card

    const threadPromises = promisesByThread.get(threadId) ?? [];
    const actionableMy = threadPromises.filter(
      (p) => p.direction === 'my-promise' && isActionable(p),
    );
    const actionableTheyAsked = threadPromises.filter(
      (p) => p.direction === 'they-asked' && isActionable(p),
    );

    const verdict = detectStale(
      {
        state: task.state,
        lastActivityIso: thread.last_message_at,
        followUpAtIso: task.follow_up_at,
        deadlineIso: task.deadline,
      },
      nowIso,
      {
        waitingStaleDays: settings.waitingStaleDays,
        needsReplyStaleDays: settings.needsReplyStaleDays,
      },
    );

    rankables.push({
      id: threadId,
      importance: task.importance,
      myPromises: actionableMy,
      theyAsked: actionableTheyAsked,
      lastActivityIso: thread.last_message_at,
    });

    cardsByThread.set(threadId, {
      threadId,
      subject: thread.subject,
      snippet: thread.snippet,
      sender: thread.sender,
      projectId: thread.project_id,
      state: task.state,
      importance: task.importance,
      deadline: task.deadline,
      followUpAt: task.follow_up_at,
      lastActivityAt: thread.last_message_at,
      promiseDirections: presentDirections(threadPromises),
      myPromiseUrgency: urgencyLabel(actionableMy, nowMs),
      theyAskedUrgency: urgencyLabel(actionableTheyAsked, nowMs),
      hasDraftReady: draftsByThread.has(threadId),
      staleReason: verdict.reason ?? null,
      ageMs: verdict.ageMs,
    });
  }

  const { ordered } = rankTasks(rankables, nowIso);
  const doNext: DoNextCard[] = [];
  for (const threadId of ordered) {
    const card = cardsByThread.get(threadId);
    if (card !== undefined) doNext.push(card);
    if (doNext.length >= MAX_DO_NEXT_CARDS) break;
  }

  return {
    generatedAt: nowIso,
    projectId: input.projectId,
    promiseMetrics,
    taskCounts,
    doNext,
  };
}
