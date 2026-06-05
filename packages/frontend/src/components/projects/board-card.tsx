/**
 * One body-free thread card for the projects board + the 3-pane middle list (PROJECT.md §11 / D32).
 * Renders ONLY `BoardThreadCard` fields — the sanctioned subject/snippet/sender + state/promise/
 * deadline metadata; there is no body (Golden rule #3). Clicking the card opens the 7b split work
 * surface (`nav.openThread`) — the task-board path into reading + drafting — so no thread is ever
 * unreachable from a board/list.
 *
 * It is a lean sibling of the Today `DoNextCard` (which carries inline actions + urgency tiers); this
 * card is read-first (a single open affordance) and reuses the same presentational `card-parts`.
 */
import type { BoardThreadCard } from '@mailordomo/shared';

import { Card } from '@/components/ui/card';
import { displaySender } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DeadlineChip, DraftReadyBadge, PromiseDots, StateBadge } from '../today/card-parts';

interface BoardCardProps {
  card: BoardThreadCard;
  /** Open the 7b work surface for this thread (board/list → reading pane → draft). */
  onOpen: (threadId: string) => void;
  /** Show the per-thread state badge (the board groups by state, so it omits it; the 3-pane shows it). */
  showState?: boolean;
}

export function BoardCard({ card, onOpen, showState = false }: BoardCardProps) {
  const hasChips = card.deadline !== null || card.followUpAt !== null;
  const hasMeta = showState || card.promiseDirections.length > 0 || card.hasDraftReady;

  return (
    <Card className="gap-0 p-0 shadow-none transition-colors">
      <button
        type="button"
        onClick={() => onOpen(card.threadId)}
        className={cn(
          'hover:bg-accent/40 focus-visible:ring-ring/50 w-full space-y-1.5 rounded-xl p-3 text-left outline-none transition-colors focus-visible:ring-2',
        )}
      >
        {hasMeta && (
          <div className="flex flex-wrap items-center gap-2">
            {showState && <StateBadge state={card.state} />}
            <PromiseDots directions={card.promiseDirections} />
            {card.hasDraftReady && <DraftReadyBadge />}
          </div>
        )}

        <h3 className="text-foreground truncate text-sm leading-snug font-medium">
          {card.subject || '(no subject)'}
        </h3>

        <p className="text-muted-foreground truncate text-xs">
          {card.sender ? displaySender(card.sender) : 'Unknown sender'}
        </p>

        {card.snippet && (
          <p className="text-muted-foreground/80 line-clamp-1 text-xs">{card.snippet}</p>
        )}

        {hasChips && (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <DeadlineChip deadline={card.deadline} followUpAt={card.followUpAt} />
          </div>
        )}
      </button>
    </Card>
  );
}
