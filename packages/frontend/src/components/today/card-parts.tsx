/**
 * Presentational leaf parts of a do-next card (PROJECT.md §8/§11): the state badge, the 3-way
 * promise-direction dots, the deadline/follow-up chip, the stale indicator, and the draft-ready
 * badge. Pure — they take only `DoNextCard` fields; no data fetching, no body text.
 */
import { Clock, PenLine, TriangleAlert } from 'lucide-react';
import type { PromiseDirection, StaleReason, TaskState } from '@mailordomo/shared';

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  PROMISE_META,
  PROMISE_ORDER,
  STALE_LABEL,
  STATE_DOT_CLASS,
  STATE_LABEL,
} from '@/lib/labels';
import { formatRelativeDate, isPast } from '@/lib/format';
import { cn } from '@/lib/utils';

const CHIP = 'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium';

/** The email-as-task state, as a quiet outline pill with a state-colored status dot. */
export function StateBadge({ state }: { state: TaskState }) {
  return (
    <Badge
      variant="outline"
      className={cn('gap-1.5 font-medium', state === 'done' && 'text-muted-foreground')}
    >
      <span className={cn('size-1.5 rounded-full', STATE_DOT_CLASS[state])} aria-hidden />
      {STATE_LABEL[state]}
    </Badge>
  );
}

/** The semantic 3-way promise dots (green deliver / amber owe / blue chase), with a naming tooltip. */
export function PromiseDots({ directions }: { directions: readonly PromiseDirection[] }) {
  if (directions.length === 0) return null;
  const ordered = PROMISE_ORDER.filter((d) => directions.includes(d));
  const summary = ordered.map((d) => PROMISE_META[d].label).join(', ');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={`Promises: ${summary}`}
          className="focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded-full outline-none focus-visible:ring-2"
        >
          {ordered.map((d) => (
            <span
              key={d}
              className={cn('size-2 rounded-full', PROMISE_META[d].dotClass)}
              aria-hidden
            />
          ))}
        </span>
      </TooltipTrigger>
      <TooltipContent className="flex flex-col gap-1">
        {ordered.map((d) => (
          <span key={d} className="flex items-center gap-2">
            <span className={cn('size-2 rounded-full', PROMISE_META[d].dotClass)} aria-hidden />
            <span>
              {PROMISE_META[d].label} — {PROMISE_META[d].action}
            </span>
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The deadline (preferred) or follow-up chip. Turns red when the date is in the past — the strongest
 * "deliver this" signal — and stays muted otherwise.
 */
export function DeadlineChip({
  deadline,
  followUpAt,
  now,
}: {
  deadline: string | null;
  followUpAt: string | null;
  now?: number;
}) {
  const date = deadline ?? followUpAt;
  if (date === null) return null;
  const overdue = isPast(date, now);
  const prefix = deadline === null ? 'Follow up' : 'Due';

  return (
    <span
      className={cn(
        CHIP,
        overdue ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
      )}
    >
      <Clock className="size-3" aria-hidden />
      {prefix} {formatRelativeDate(date, now)}
    </span>
  );
}

/** A muted chip flagging why the thread is stale; the warning icon carries the only color. */
export function StaleIndicator({ reason }: { reason: StaleReason }) {
  return (
    <span className={cn(CHIP, 'bg-muted text-muted-foreground')}>
      <TriangleAlert className="size-3 text-amber-500" aria-hidden />
      {STALE_LABEL[reason]}
    </span>
  );
}

/** A calm signal that Claude has a draft waiting (metadata only — never the draft body). */
export function DraftReadyBadge() {
  return (
    <Badge variant="secondary" className="text-muted-foreground gap-1 font-normal">
      <PenLine className="size-3" aria-hidden />
      Draft ready
    </Badge>
  );
}
