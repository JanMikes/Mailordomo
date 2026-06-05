/**
 * One ranked do-next card (PROJECT.md §8/§11). Renders ONLY `DoNextCard` fields — the sanctioned
 * subject/snippet/sender + task/promise metadata; there is no body to show (Golden rule #3).
 *
 * Inline actions are metadata-only and safe: Mark done (a state transition) and Snooze (a
 * `follow_up_at` write) are live mutations. Open thread opens the split work surface (7b); Draft opens
 * it AND kicks off a draft — both via the nav controller, never a direct send (Golden rule #1).
 */
import {
  AlarmClock,
  Check,
  type LucideIcon,
  LoaderCircle,
  PenLine,
  SquareArrowOutUpRight,
} from 'lucide-react';
import type { DoNextCard as DoNextCardModel } from '@mailordomo/shared';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useMarkDone, useSnooze } from '@/lib/today-hooks';
import { useNav } from '@/lib/navigation';
import { displaySender } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  DeadlineChip,
  DraftReadyBadge,
  PromiseDots,
  StaleIndicator,
  StateBadge,
} from './card-parts';

export function DoNextCard({ card }: { card: DoNextCardModel }) {
  const markDone = useMarkDone();
  const snooze = useSnooze();
  const nav = useNav();
  const busy = markDone.isPending || snooze.isPending;
  const hasChips = card.deadline !== null || card.followUpAt !== null || card.staleReason !== null;

  return (
    <Card
      className={cn(
        'gap-0 p-0 transition-colors',
        'hover:bg-accent/40',
        busy && 'pointer-events-none opacity-60',
      )}
    >
      <div className="flex items-start gap-3 p-4">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StateBadge state={card.state} />
            <PromiseDots directions={card.promiseDirections} />
            {card.hasDraftReady && <DraftReadyBadge />}
          </div>

          <h3 className="text-foreground truncate text-[15px] leading-snug font-medium">
            {card.subject || '(no subject)'}
          </h3>

          <p className="text-muted-foreground truncate text-sm">
            <span className="text-foreground/80">{displaySender(card.sender)}</span>
            <span aria-hidden className="text-muted-foreground/40 px-1.5">
              ·
            </span>
            <span>{card.projectName ?? card.projectId}</span>
          </p>

          {hasChips && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <DeadlineChip deadline={card.deadline} followUpAt={card.followUpAt} />
              {card.staleReason !== null && <StaleIndicator reason={card.staleReason} />}
            </div>
          )}
        </div>

        <InlineActions
          onMarkDone={() => markDone.mutate(card.threadId)}
          onSnooze={() => snooze.mutate({ threadId: card.threadId })}
          onOpenThread={() => nav.openThread(card.threadId)}
          onDraft={() => nav.openThread(card.threadId, { draft: true })}
          markDonePending={markDone.isPending}
          snoozePending={snooze.isPending}
        />
      </div>
    </Card>
  );
}

interface InlineActionsProps {
  onMarkDone: () => void;
  onSnooze: () => void;
  onOpenThread: () => void;
  onDraft: () => void;
  markDonePending: boolean;
  snoozePending: boolean;
}

function InlineActions({
  onMarkDone,
  onSnooze,
  onOpenThread,
  onDraft,
  markDonePending,
  snoozePending,
}: InlineActionsProps) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <ActionButton Icon={Check} label="Mark done" onClick={onMarkDone} pending={markDonePending} />
      <ActionButton
        Icon={AlarmClock}
        label="Snooze"
        tooltip="Snooze 24 hours"
        onClick={onSnooze}
        pending={snoozePending}
      />
      <ActionButton Icon={SquareArrowOutUpRight} label="Open thread" onClick={onOpenThread} />
      <ActionButton
        Icon={PenLine}
        label="Draft"
        tooltip="Open and draft a reply"
        onClick={onDraft}
      />
    </div>
  );
}

interface ActionButtonProps {
  Icon: LucideIcon;
  label: string;
  tooltip?: string;
  onClick: () => void;
  pending?: boolean;
}

function ActionButton({ Icon, label, tooltip, onClick, pending = false }: ActionButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          onClick={onClick}
          disabled={pending}
          className="text-muted-foreground hover:text-foreground size-8"
        >
          {pending ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
          ) : (
            <Icon className="size-4" aria-hidden />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip ?? label}</TooltipContent>
    </Tooltip>
  );
}
