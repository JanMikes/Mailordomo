/**
 * The ranked do-next queue (array order = rank order from the backend, PROJECT.md §8 / D26), plus its
 * empty and loading states. Empty = "all caught up"; loading = shaped skeletons that match a card.
 */
import { CheckCheck } from 'lucide-react';
import type { DoNextCard as DoNextCardModel } from '@mailordomo/shared';

import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DoNextCard } from './do-next-card';

export function DoNextList({ cards }: { cards: readonly DoNextCardModel[] }) {
  if (cards.length === 0) return <EmptyState />;
  return (
    <div className="flex flex-col gap-2.5">
      {cards.map((card) => (
        <DoNextCard key={card.threadId} card={card} />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <Card className="items-center gap-3 border-dashed py-14 text-center shadow-none">
      <span className="bg-promise-deliver/10 text-promise-deliver flex size-12 items-center justify-center rounded-full">
        <CheckCheck className="size-6" aria-hidden />
      </span>
      <div className="space-y-1">
        <p className="font-medium">You&rsquo;re all caught up</p>
        <p className="text-muted-foreground mx-auto max-w-sm text-sm">
          Nothing needs you right now. New mail shows up here as it&rsquo;s triaged.
        </p>
      </div>
    </Card>
  );
}

export function DoNextListSkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: 4 }).map((_, i) => (
        <DoNextCardSkeleton key={i} />
      ))}
    </div>
  );
}

function DoNextCardSkeleton() {
  return (
    <Card className="gap-0 p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 space-y-2.5">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-24 rounded-md" />
            <Skeleton className="h-2 w-10 rounded-full" />
          </div>
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3.5 w-2/5" />
        </div>
        <div className="flex gap-1">
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="size-8 rounded-md" />
        </div>
      </div>
    </Card>
  );
}
