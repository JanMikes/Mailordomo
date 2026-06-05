/**
 * The 3-way promise metric row (PROJECT.md §7): my promises (deliver, green) · they asked (owe,
 * amber) · awaiting them (chase, blue). Directional icons reinforce the meaning — outgoing arrow for
 * what I committed, incoming arrow for what was asked of me, clock for what I'm waiting on.
 */
import { ArrowDownLeft, ArrowUpRight, Clock } from 'lucide-react';
import type { TodayPromiseMetrics } from '@mailordomo/shared';

import { PROMISE_META } from '@/lib/labels';
import { MetricCard } from './metric-card';

export function PromiseMetricRow({ metrics }: { metrics: TodayPromiseMetrics }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <MetricCard
        meta={PROMISE_META['my-promise']}
        Icon={ArrowUpRight}
        metric={metrics.myPromises}
      />
      <MetricCard
        meta={PROMISE_META['they-asked']}
        Icon={ArrowDownLeft}
        metric={metrics.theyAsked}
      />
      <MetricCard meta={PROMISE_META['awaiting-them']} Icon={Clock} metric={metrics.awaitingThem} />
    </div>
  );
}
