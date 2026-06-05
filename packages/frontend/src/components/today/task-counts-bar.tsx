/**
 * Done-vs-remaining counts (PROJECT.md §11) with a slim progress bar. `remaining` is the emphasized
 * number (what's left to clear); the bar shows the done ratio. Neutral by design — color stays with
 * the promise metrics above.
 */
import type { TodayTaskCounts } from '@mailordomo/shared';

export function TaskCountsBar({ counts }: { counts: TodayTaskCounts }) {
  const total = counts.remaining + counts.done;
  const donePct = total === 0 ? 0 : Math.round((counts.done / total) * 100);

  return (
    <div className="flex items-center gap-3 text-sm">
      <p className="text-muted-foreground whitespace-nowrap">
        <span className="text-foreground font-medium tabular-nums">{counts.remaining}</span>{' '}
        remaining
        <span aria-hidden className="text-muted-foreground/40 px-1.5">
          ·
        </span>
        <span className="tabular-nums">{counts.done}</span> done
      </p>
      <div
        className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={donePct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Tasks done"
      >
        <div
          className="bg-foreground/70 h-full rounded-full transition-[width] duration-500"
          style={{ width: `${donePct}%` }}
        />
      </div>
      <span className="text-muted-foreground/70 text-xs tabular-nums">{donePct}%</span>
    </div>
  );
}
