/**
 * The split work surface (PROJECT.md §11; PLAN.md §7 Phase 7b / D31): the thread on the LEFT (Claude's
 * summary pinned at top + a repo-freshness indicator + the ordered messages) and the draft +
 * refine-chat on the RIGHT (model badge, Send as the primary action, edit/snooze beside it, the
 * instruction textarea pinned at the bottom).
 *
 * On open it acquires the thread LOCK (presence — D27): if another actor holds it, a read-only banner
 * names the holder and Send is disabled; while we hold it a heartbeat refreshes it, and it is released
 * on close/unmount. Sending is ALWAYS a manual click (golden rule #1); bodies stay on the local
 * backend (golden rule #3).
 */
import { ArrowLeft, Lock } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useThreadDetail,
  useThreadLock,
  holdsLock,
  type LockPresence,
} from '@/lib/work-surface-hooks';
import { displaySender } from '@/lib/format';
import { ThreadPane } from './thread-pane';
import { DraftPane } from './draft-pane';

interface WorkSurfaceProps {
  threadId: string;
  /** Kick off a draft immediately (the do-next "Draft" action opened the surface). */
  autoDraft: boolean;
  /** Return to Today. */
  onClose: () => void;
}

export function WorkSurface({ threadId, autoDraft, onClose }: WorkSurfaceProps) {
  const detail = useThreadDetail(threadId);
  const presence = useThreadLock(threadId);
  const canEdit = holdsLock(presence);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-5 py-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground -ml-2 gap-1.5"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back to today
        </Button>
        <div className="min-w-0 flex-1">
          {detail.data ? (
            <>
              <h1 className="truncate text-[15px] font-semibold tracking-tight">
                {detail.data.subject || '(no subject)'}
              </h1>
              {detail.data.sender !== null && (
                <p className="text-muted-foreground truncate text-xs">
                  {displaySender(detail.data.sender)}
                </p>
              )}
            </>
          ) : detail.isError ? (
            <h1 className="text-muted-foreground text-[15px] font-medium">Thread unavailable</h1>
          ) : (
            <Skeleton className="h-4 w-48" />
          )}
        </div>
      </header>

      <PresenceBanner presence={presence} />

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
        <div className="min-h-0 min-w-0 border-b lg:border-r lg:border-b-0">
          <ThreadPane threadId={threadId} detail={detail.data ?? null} isError={detail.isError} />
        </div>
        <div className="min-h-0 min-w-0">
          <DraftPane
            threadId={threadId}
            canWrite={canEdit}
            autoDraft={autoDraft}
            onClose={onClose}
          />
        </div>
      </div>
    </div>
  );
}

/** A calm, read-only presence banner shown when this user does NOT hold the lock (contended/lost). */
function PresenceBanner({ presence }: { presence: LockPresence }) {
  if (presence.kind === 'contended') {
    return (
      <Banner>
        <Lock className="size-3.5 shrink-0" aria-hidden />
        <span>
          Locked by <span className="font-medium">{presence.lock.locked_by}</span> · holds until{' '}
          {formatLockTime(presence.lock.expires_at)}. Editing and sending are paused.
        </span>
      </Banner>
    );
  }
  if (presence.kind === 'lost') {
    return (
      <Banner>
        <Lock className="size-3.5 shrink-0" aria-hidden />
        <span>You no longer hold this thread&rsquo;s lock. Editing and sending are paused.</span>
      </Banner>
    );
  }
  return null;
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-muted/60 text-muted-foreground flex items-center gap-2 border-b px-5 py-2 text-xs">
      {children}
    </div>
  );
}

/** A lock expiry is minutes away, so a wall-clock time reads better than a relative date. */
function formatLockTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'soon';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
