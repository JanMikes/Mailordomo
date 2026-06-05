/**
 * Assemble the "Projects board" read model (PROJECT.md §11; PLAN.md §7 Phase 7c, decision D32) — the
 * all-projects / per-project view and the classic 3-pane fallback's left list. A PURE function — no
 * IO, no wall clock; `nowIso` is injected — so the grouping is fully unit-testable with a fixed clock
 * (mirrors `today-view.ts` / `thread-detail-view.ts`).
 *
 * It REUSES the today-view's thread+task+promise+draft join, but instead of ranking it GROUPS every
 * thread into its task `state` bucket, in the canonical state-machine order. Two invariants:
 *  - EVERY thread is bucketed (the "fallback never loses access to a thread" rule): a thread whose
 *    metadata has no task is bucketed under `needs-reply` (the initial state) rather than dropped.
 *  - `done` is included (unlike the do-next queue) — the board shows the whole task lifecycle.
 *
 * PRIVACY (Golden rule #3 — body-free BY CONSTRUCTION): the output carries ONLY the sanctioned
 * subject/snippet/sender + task/promise metadata (see `shared/src/projects-board.ts`). It never reads
 * a message body. Read-only assembly over metadata — no writable store, no reconciliation (rule #2).
 */
import type {
  BoardCounts,
  BoardGroups,
  BoardThreadCard,
  DraftMeta,
  ProjectBoardEntry,
  ProjectsBoard,
  PromiseDirection,
  PromiseRecord,
  Task,
  TaskState,
  Thread,
} from '@mailordomo/shared';
import { INITIAL_TASK_STATE, PROMISE_DIRECTIONS, TASK_STATES } from '@mailordomo/shared';

/** Identity (+ resolved name) of one project section on the board (one in v1 — D32). */
export interface ProjectBoardProjectInput {
  readonly projectId: string;
  /** Resolved display name, or null when the metadata service couldn't be reached (D32). */
  readonly projectName: string | null;
}

/** Everything {@link assembleProjectsBoard} needs — already-fetched, so it stays PURE. */
export interface ProjectsBoardInput {
  /** The project sections to render (a single entry in v1; the shape generalizes to N). */
  readonly projects: readonly ProjectBoardProjectInput[];
  readonly tasks: readonly Task[];
  readonly threads: readonly Thread[];
  readonly promises: readonly PromiseRecord[];
  readonly draftMeta: readonly DraftMeta[];
}

/** Unique directions present on a thread (ANY status), in the canonical 3-way order. */
function presentDirections(promises: readonly PromiseRecord[]): PromiseDirection[] {
  const present = new Set<PromiseDirection>(promises.map((p) => p.direction));
  return PROMISE_DIRECTIONS.filter((dir) => present.has(dir));
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

/** A fresh `Record<TaskState, V>` with one entry per canonical state (in order), via `make(state)`. */
function emptyByState<V>(make: () => V): Record<TaskState, V> {
  const out = {} as Record<TaskState, V>;
  for (const state of TASK_STATES) out[state] = make();
  return out;
}

/** Most-recent-first by `lastActivityAt` (nulls last); stable tie-break on `threadId`. */
function byActivityDesc(a: BoardThreadCard, b: BoardThreadCard): number {
  const la = a.lastActivityAt;
  const lb = b.lastActivityAt;
  if (la !== lb) {
    if (la === null) return 1;
    if (lb === null) return -1;
    return la > lb ? -1 : 1;
  }
  return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
}

/**
 * Assemble one project's section: bucket EVERY thread by its task state. The active (first non-done)
 * task supplies a thread's `state`/`importance`/`deadline`/`followUpAt`; a thread with NO task is
 * bucketed under `needs-reply` (never dropped). Cards are body-free; each group is sorted
 * most-recent-first.
 */
function assembleProjectEntry(
  project: ProjectBoardProjectInput,
  threads: readonly Thread[],
  tasksByThread: Map<string, Task[]>,
  promisesByThread: Map<string, PromiseRecord[]>,
  draftsByThread: Map<string, DraftMeta[]>,
): ProjectBoardEntry {
  const groups = emptyByState<BoardThreadCard[]>(() => []);

  for (const thread of threads) {
    const threadTasks = tasksByThread.get(thread.id) ?? [];
    // The active task drives the bucket: prefer the first non-done task, else any task, else none.
    const task = threadTasks.find((t) => t.state !== 'done') ?? threadTasks[0];
    const state: TaskState = task?.state ?? INITIAL_TASK_STATE; // no-task → needs-reply (never drop)
    const threadPromises = promisesByThread.get(thread.id) ?? [];

    const card: BoardThreadCard = {
      threadId: thread.id,
      subject: thread.subject,
      snippet: thread.snippet,
      sender: thread.sender,
      state,
      importance: task?.importance ?? 'normal',
      deadline: task?.deadline ?? null,
      followUpAt: task?.follow_up_at ?? null,
      lastActivityAt: thread.last_message_at,
      hasDraftReady: draftsByThread.has(thread.id),
      promiseDirections: presentDirections(threadPromises),
    };
    groups[state].push(card);
  }

  const counts = emptyByState<number>(() => 0);
  for (const state of TASK_STATES) {
    groups[state].sort(byActivityDesc);
    counts[state] = groups[state].length;
  }

  return {
    projectId: project.projectId,
    projectName: project.projectName,
    groups: groups as BoardGroups,
    counts: counts as BoardCounts,
  };
}

/**
 * Build the projects-board read model. For each configured project section, every thread is grouped
 * into its task-state bucket. Single-project in v1; the array shape generalizes to N without a change
 * to this assembler. Pure: `nowIso` is injected (used only as the `generatedAt` stamp).
 */
export function assembleProjectsBoard(input: ProjectsBoardInput, nowIso: string): ProjectsBoard {
  const tasksByThread = groupByThread(input.tasks);
  const promisesByThread = groupByThread(input.promises);
  const draftsByThread = groupByThread(input.draftMeta);

  const projects = input.projects.map((project) =>
    assembleProjectEntry(project, input.threads, tasksByThread, promisesByThread, draftsByThread),
  );

  return { generatedAt: nowIso, projects };
}
