/**
 * The Today command center (PROJECT.md §11 / D29). Fetches the assembled read model via React Query
 * and subscribes to the live-update socket: a `today:changed` push invalidates `['today']`, so the
 * view refetches the instant the backend's metadata changes. Renders header → promise metrics →
 * task counts → ranked do-next list, with tasteful loading/error/empty states.
 */
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, RefreshCw } from 'lucide-react';
import type { TodayReadModel } from '@mailordomo/shared';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/api';
import { useTodayQuery } from '@/lib/today-hooks';
import { useWsToday } from '@/lib/useWs';
import { DoNextList, DoNextListSkeleton } from './do-next-list';
import { PromiseMetricRow } from './promise-metrics';
import { TaskCountsBar } from './task-counts-bar';
import { TodayPageHeader } from './today-header';

export function TodayPage() {
  const qc = useQueryClient();
  const today = useTodayQuery();

  useWsToday(
    useCallback(() => {
      void qc.invalidateQueries({ queryKey: queryKeys.today });
    }, [qc]),
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <TodayPageHeader />
      {today.data ? (
        <TodayContent model={today.data} />
      ) : today.isError ? (
        <ErrorState
          message={today.error instanceof Error ? today.error.message : 'Unknown error'}
          onRetry={() => void today.refetch()}
        />
      ) : (
        <LoadingState />
      )}
    </div>
  );
}

function TodayContent({ model }: { model: TodayReadModel }) {
  return (
    <div className="space-y-6">
      <PromiseMetricRow metrics={model.promiseMetrics} />
      <TaskCountsBar counts={model.taskCounts} />
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-muted-foreground text-sm font-medium">Do next</h2>
          {model.doNext.length > 0 && (
            <span className="text-muted-foreground/60 text-xs tabular-nums">
              {model.doNext.length}
            </span>
          )}
        </div>
        <DoNextList cards={model.doNext} />
      </section>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-4 w-full max-w-md" />
      <div className="space-y-3">
        <Skeleton className="h-4 w-16" />
        <DoNextListSkeleton />
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
        <p className="font-medium">Couldn&rsquo;t load Today</p>
        <p className="text-muted-foreground mx-auto max-w-md text-sm">{message}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry} className="mt-1 gap-2">
        <RefreshCw className="size-4" aria-hidden />
        Try again
      </Button>
    </Card>
  );
}
