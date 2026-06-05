/**
 * One 3-way promise metric tile (PROJECT.md §7/§11). The direction's semantic hue is the anchor: a
 * tinted icon chip + the live count (`openCount`) in the direction color. `overdueCount` is called
 * out in red when present; `total` is the quiet context line.
 */
import type { LucideIcon } from 'lucide-react';
import type { TodayPromiseMetric } from '@mailordomo/shared';

import { Card } from '@/components/ui/card';
import type { PromiseMeta } from '@/lib/labels';
import { cn } from '@/lib/utils';

interface MetricCardProps {
  meta: PromiseMeta;
  Icon: LucideIcon;
  metric: TodayPromiseMetric;
}

export function MetricCard({ meta, Icon, metric }: MetricCardProps) {
  return (
    <Card className="gap-0 p-4">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md',
            meta.tintClass,
            meta.textClass,
          )}
        >
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="leading-tight">
          <p className="text-sm font-medium">{meta.label}</p>
          <p className="text-muted-foreground text-xs">{meta.action}</p>
        </div>
      </div>

      <div className="mt-3 flex items-end justify-between">
        <span className={cn('text-3xl font-semibold tracking-tight tabular-nums', meta.textClass)}>
          {metric.openCount}
        </span>
        <div className="text-right text-xs leading-tight">
          {metric.overdueCount > 0 ? (
            <p className="text-destructive font-medium">{metric.overdueCount} overdue</p>
          ) : (
            <p className="text-muted-foreground">
              {metric.openCount === 0 ? 'all clear' : 'on track'}
            </p>
          )}
          <p className="text-muted-foreground/60 tabular-nums">{metric.total} total</p>
        </div>
      </div>
    </Card>
  );
}
