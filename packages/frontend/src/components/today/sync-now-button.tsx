/**
 * "Sync now" — trigger an immediate daemon poll→triage cycle instead of waiting for the cold-poll
 * interval or an IDLE push. The cycle runs in the background; when it finishes the daemon broadcasts
 * `today:changed` and this view refetches. A 503 (daemon off / no mailbox yet) is surfaced calmly, not
 * as an alarming failure. GOLDEN RULE #1: a sync only polls + drafts — it NEVER sends.
 */
import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { useSyncNow } from '@/lib/today-hooks';
import { cn } from '@/lib/utils';

export function SyncNowButton() {
  const sync = useSyncNow();
  const reason =
    sync.error instanceof ApiError && sync.error.status === 503
      ? 'Daemon is off — enable it and restart to sync.'
      : sync.error instanceof Error
        ? sync.error.message
        : null;

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        onClick={() => sync.mutate()}
        disabled={sync.isPending}
        className="gap-1.5"
        title="Pull new mail now (poll → triage). Never sends."
      >
        <RefreshCw className={cn('size-4', sync.isPending && 'animate-spin')} aria-hidden />
        {sync.isPending ? 'Syncing…' : 'Sync now'}
      </Button>
      {reason && (
        <span className="text-destructive max-w-[15rem] text-right text-xs">{reason}</span>
      )}
    </div>
  );
}
