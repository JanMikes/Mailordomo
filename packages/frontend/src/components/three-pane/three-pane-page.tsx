/**
 * The classic 3-pane fallback (PROJECT.md §11 / D32) — the deliberate "never trap the user in the
 * opinionated view" escape hatch. Three columns:
 *   - LEFT: the task states (per project) with counts from the board, selectable.
 *   - MIDDLE: the body-free thread list for the selected state (most-recent activity first).
 *   - RIGHT: a reading pane that REUSES the 7b `ThreadPane` (pinned summary + ordered messages, whose
 *     bodies come via the per-message LOCAL `…/body` hop — golden rule #3) + an "Open in work surface"
 *     escalation so drafting still flows through 7b (the 3-pane itself is read-first).
 *
 * The "never lose a thread" invariant: every thread on the board / Today is reachable here (it is the
 * SAME body-free board model), and from here every thread escalates to the full work surface.
 */
import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Columns3, PenLine, SquareArrowOutUpRight } from 'lucide-react';
import {
  TASK_STATES,
  type BoardThreadCard,
  type ProjectsBoard,
  type TaskState,
} from '@mailordomo/shared';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { ThreadPane } from '@/components/work-surface/thread-pane';
import { queryKeys } from '@/lib/api';
import { useProjectsBoard } from '@/lib/projects-hooks';
import { useThreadDetail } from '@/lib/work-surface-hooks';
import { useNav } from '@/lib/navigation';
import { useWsToday } from '@/lib/useWs';
import { STATE_DOT_CLASS, STATE_LABEL } from '@/lib/labels';
import { displaySender } from '@/lib/format';
import { cn } from '@/lib/utils';

/** A flattened selection: which project section + which state group is active in the left list. */
interface Selection {
  readonly projectId: string;
  readonly state: TaskState;
}

export function ThreePanePage() {
  const qc = useQueryClient();
  const board = useProjectsBoard();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);

  useWsToday(
    useCallback(() => {
      void qc.invalidateQueries({ queryKey: queryKeys.projectsBoard });
    }, [qc]),
  );

  const data = board.data ?? null;
  // Default the selection to the first non-empty state of the first project, once data arrives.
  const effectiveSelection = useMemo(() => selection ?? firstNonEmpty(data), [selection, data]);

  const threads = useMemo(
    () => selectedThreads(data, effectiveSelection),
    [data, effectiveSelection],
  );

  return (
    <div className="flex h-full min-h-0">
      <StateList
        board={data}
        loading={!data && !board.isError}
        selection={effectiveSelection}
        onSelect={(next) => {
          setSelection(next);
          setOpenThreadId(null);
        }}
      />
      <ThreadList
        threads={threads}
        loading={!data && !board.isError}
        isError={board.isError}
        openThreadId={openThreadId}
        onOpen={setOpenThreadId}
      />
      <ReadingPane threadId={openThreadId} />
    </div>
  );
}

/* ------------------------------- left: state list ------------------------------- */

function StateList({
  board,
  loading,
  selection,
  onSelect,
}: {
  board: ProjectsBoard | null;
  loading: boolean;
  selection: Selection | null;
  onSelect: (next: Selection) => void;
}) {
  return (
    <aside className="bg-muted/20 flex w-60 shrink-0 flex-col border-r">
      <div className="border-b px-4 py-3">
        <h1 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Columns3 className="size-4" aria-hidden />
          3-pane
        </h1>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {loading && <StateListSkeleton />}
          {board?.projects.map((project) => (
            <div key={project.projectId} className="space-y-1">
              <p className="text-muted-foreground/70 truncate px-1.5 text-xs font-medium">
                {project.projectName ?? project.projectId}
              </p>
              {TASK_STATES.map((state) => {
                const count = project.counts[state];
                const active =
                  selection?.projectId === project.projectId && selection.state === state;
                return (
                  <button
                    key={state}
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    disabled={count === 0}
                    onClick={() => onSelect({ projectId: project.projectId, state })}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none transition-colors',
                      count === 0 && 'cursor-default opacity-40',
                      active
                        ? 'bg-accent text-accent-foreground'
                        : count > 0 &&
                            'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                    )}
                  >
                    <span
                      className={cn('size-1.5 shrink-0 rounded-full', STATE_DOT_CLASS[state])}
                      aria-hidden
                    />
                    <span className="flex-1 truncate">{STATE_LABEL[state]}</span>
                    <span className="text-muted-foreground/60 text-xs tabular-nums">{count}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {board?.projects.length === 0 && (
            <p className="text-muted-foreground px-1.5 py-6 text-center text-sm">
              No projects yet.
            </p>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}

/* ------------------------------ middle: thread list ----------------------------- */

function ThreadList({
  threads,
  loading,
  isError,
  openThreadId,
  onOpen,
}: {
  threads: readonly BoardThreadCard[];
  loading: boolean;
  isError: boolean;
  openThreadId: string | null;
  onOpen: (threadId: string) => void;
}) {
  return (
    <div className="flex w-80 shrink-0 flex-col border-r">
      <div className="text-muted-foreground border-b px-4 py-3 text-xs font-medium">
        {loading ? 'Loading…' : `${threads.length} thread${threads.length === 1 ? '' : 's'}`}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="divide-border flex flex-col divide-y">
          {loading && <ThreadListSkeleton />}
          {isError && (
            <p className="text-muted-foreground px-4 py-8 text-center text-sm">
              The board couldn&rsquo;t be loaded.
            </p>
          )}
          {!loading && !isError && threads.length === 0 && (
            <p className="text-muted-foreground px-4 py-8 text-center text-sm">
              Nothing in this group.
            </p>
          )}
          {threads.map((card) => {
            const active = card.threadId === openThreadId;
            return (
              <button
                key={card.threadId}
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => onOpen(card.threadId)}
                className={cn(
                  'space-y-0.5 px-4 py-3 text-left outline-none transition-colors',
                  active ? 'bg-accent/70' : 'hover:bg-accent/40',
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-foreground truncate text-sm font-medium">
                    {card.sender ? displaySender(card.sender) : 'Unknown sender'}
                  </span>
                  {card.hasDraftReady && (
                    <PenLine className="text-muted-foreground/70 size-3 shrink-0" aria-hidden />
                  )}
                </div>
                <p className="text-foreground/90 truncate text-sm">
                  {card.subject || '(no subject)'}
                </p>
                {card.snippet && (
                  <p className="text-muted-foreground line-clamp-1 text-xs">{card.snippet}</p>
                )}
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

/* ------------------------------ right: reading pane ----------------------------- */

/**
 * The reading pane reuses the 7b {@link ThreadPane} verbatim — the pinned summary + ordered messages
 * whose bodies are fetched via the per-message LOCAL `…/body` hop (golden rule #3). A header escalation
 * opens the full split work surface (where drafting/sending live — the 3-pane stays read-first).
 */
function ReadingPane({ threadId }: { threadId: string | null }) {
  const nav = useNav();
  const detail = useThreadDetail(threadId ?? '', threadId !== null);

  if (threadId === null) {
    return (
      <div className="text-muted-foreground flex min-w-0 flex-1 items-center justify-center px-6 text-center text-sm">
        Select a thread to read it here.
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold tracking-tight">
            {detail.data?.subject || (detail.isError ? 'Thread unavailable' : ' ')}
          </h2>
          {detail.data?.sender != null && (
            <p className="text-muted-foreground truncate text-xs">
              {displaySender(detail.data.sender)}
            </p>
          )}
        </div>
        <Button size="sm" onClick={() => nav.openThread(threadId)} className="shrink-0 gap-1.5">
          <SquareArrowOutUpRight className="size-4" aria-hidden />
          Open in work surface
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <ThreadPane threadId={threadId} detail={detail.data ?? null} isError={detail.isError} />
      </div>
    </div>
  );
}

/* ---------------------------------- selection helpers ---------------------------------- */

/** The first non-empty (project, state) pair in canonical order, or `null` if the board is empty. */
function firstNonEmpty(board: ProjectsBoard | null): Selection | null {
  if (!board) return null;
  for (const project of board.projects) {
    for (const state of TASK_STATES) {
      if (project.groups[state].length > 0) {
        return { projectId: project.projectId, state };
      }
    }
  }
  return null;
}

/** The thread cards for the selected (project, state), most-recent activity first. */
function selectedThreads(
  board: ProjectsBoard | null,
  selection: Selection | null,
): readonly BoardThreadCard[] {
  if (!board || !selection) return [];
  const project = board.projects.find((p) => p.projectId === selection.projectId);
  const cards = project?.groups[selection.state] ?? [];
  return [...cards].sort((a, b) => activityMs(b) - activityMs(a));
}

function activityMs(card: BoardThreadCard): number {
  if (card.lastActivityAt === null) return 0;
  const ms = Date.parse(card.lastActivityAt);
  return Number.isNaN(ms) ? 0 : ms;
}

function StateListSkeleton() {
  return (
    <div className="space-y-1.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-7 w-full rounded-md" />
      ))}
    </div>
  );
}

function ThreadListSkeleton() {
  return (
    <div className="space-y-3 p-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-lg" />
      ))}
    </div>
  );
}
