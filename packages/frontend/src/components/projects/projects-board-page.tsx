/**
 * The "All projects" board (PROJECT.md §11 / D32): each project section lists its threads GROUPED BY
 * task state in the canonical state-machine order (needs-reply → drafted → waiting → follow-up → done).
 * It serves as both the all-projects view (every project section) and per-project (each project a
 * section) — single-project in v1, but the shape generalizes to N.
 *
 * Body-free by construction (the board model carries only subject/snippet/sender + state metadata).
 * Clicking any thread opens the 7b split work surface via the nav controller, so no thread on the
 * board is ever unreachable. A `today:changed` WS push invalidates the board too, so it stays live.
 */
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Folders, RefreshCw } from 'lucide-react';
import { TASK_STATES, type ProjectBoardEntry, type TaskState } from '@mailordomo/shared';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/api';
import { useProjectsBoard } from '@/lib/projects-hooks';
import { useNav } from '@/lib/navigation';
import { useWsToday } from '@/lib/useWs';
import { STATE_DOT_CLASS, STATE_LABEL } from '@/lib/labels';
import { cn } from '@/lib/utils';
import { BoardCard } from './board-card';

export function ProjectsBoardPage() {
  const qc = useQueryClient();
  const board = useProjectsBoard();

  // The same live-update socket the Today view uses; a metadata change reshapes the board too.
  useWsToday(
    useCallback(() => {
      void qc.invalidateQueries({ queryKey: queryKeys.projectsBoard });
    }, [qc]),
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">All projects</h1>
        <p className="text-muted-foreground text-sm">Every thread, grouped by where it stands.</p>
      </header>

      {board.data ? (
        board.data.projects.length === 0 ? (
          <EmptyBoard />
        ) : (
          <div className="space-y-8">
            {board.data.projects.map((project) => (
              <ProjectSection key={project.projectId} project={project} />
            ))}
          </div>
        )
      ) : board.isError ? (
        <ErrorState
          message={board.error instanceof Error ? board.error.message : 'Unknown error'}
          onRetry={() => void board.refetch()}
        />
      ) : (
        <LoadingState />
      )}
    </div>
  );
}

/** One project's section: a heading (resolved name, falling back to the id) + its state groups. */
function ProjectSection({ project }: { project: ProjectBoardEntry }) {
  const nav = useNav();
  const total = TASK_STATES.reduce((sum, state) => sum + project.counts[state], 0);
  // Non-empty groups in canonical state order; empty states are omitted (their count is implied 0).
  const groups = TASK_STATES.filter((state) => project.groups[state].length > 0);

  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-lg font-semibold tracking-tight">
          {project.projectName ?? project.projectId}
        </h2>
        <span className="text-muted-foreground/60 text-xs tabular-nums">{total}</span>
      </div>

      {groups.length === 0 ? (
        <Card className="text-muted-foreground border-dashed py-8 text-center text-sm shadow-none">
          No threads in this project yet.
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {groups.map((state) => (
            <StateColumn
              key={state}
              state={state}
              count={project.counts[state]}
              cards={project.groups[state]}
              onOpen={(threadId) => nav.openThread(threadId)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** A labelled column for one task state: the state name + count, then its body-free thread cards. */
function StateColumn({
  state,
  count,
  cards,
  onOpen,
}: {
  state: TaskState;
  count: number;
  cards: ProjectBoardEntry['groups'][TaskState];
  onOpen: (threadId: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-0.5">
        <span className={cn('size-1.5 rounded-full', STATE_DOT_CLASS[state])} aria-hidden />
        <span className="text-sm font-medium">{STATE_LABEL[state]}</span>
        <span className="text-muted-foreground/60 text-xs tabular-nums">{count}</span>
      </div>
      <div className="flex flex-col gap-2">
        {cards.map((card) => (
          <BoardCard key={card.threadId} card={card} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

function EmptyBoard() {
  return (
    <Card className="items-center gap-3 border-dashed py-14 text-center shadow-none">
      <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
        <Folders className="size-6" aria-hidden />
      </span>
      <div className="space-y-1">
        <p className="font-medium">No projects yet</p>
        <p className="text-muted-foreground mx-auto max-w-sm text-sm">
          Threads appear here grouped by state once a project is configured and mail is triaged.
        </p>
      </div>
    </Card>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-6 w-40" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, col) => (
          <div key={col} className="space-y-2">
            <Skeleton className="h-4 w-24" />
            {Array.from({ length: 2 }).map((__, row) => (
              <Skeleton key={row} className="h-20 w-full rounded-xl" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="items-center gap-3 py-12 text-center">
      <span className="bg-destructive/10 text-destructive flex size-11 items-center justify-center rounded-full">
        <CircleAlert className="size-5" aria-hidden />
      </span>
      <div className="space-y-1">
        <p className="font-medium">Couldn&rsquo;t load the board</p>
        <p className="text-muted-foreground mx-auto max-w-md text-sm">{message}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry} className="mt-1 gap-2">
        <RefreshCw className="size-4" aria-hidden />
        Try again
      </Button>
    </Card>
  );
}
