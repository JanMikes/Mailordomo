/**
 * The LEFT pane of the work surface (PROJECT.md §11): Claude's summary PINNED at the top + a
 * repo-freshness indicator, then the ordered thread messages (oldest → newest) inside a scroll area.
 * A message expands to lazily fetch + show its rendered body — the one LOCAL-only body hop (golden
 * rule #3); the body is never part of the body-free `ThreadDetail`.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, GitBranch, Sparkles, TriangleAlert } from 'lucide-react';
import type { RepoFreshness, ThreadDetail, ThreadMessageMeta } from '@mailordomo/shared';

import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useMessageBody } from '@/lib/work-surface-hooks';
import { displaySender, formatRelativeDate } from '@/lib/format';
import { cn } from '@/lib/utils';

interface ThreadPaneProps {
  threadId: string;
  detail: ThreadDetail | null;
  isError: boolean;
}

export function ThreadPane({ threadId, detail, isError }: ThreadPaneProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-4">
        <PinnedSummary
          summary={detail?.pinnedSummary ?? null}
          repoFreshness={detail?.repoFreshness ?? null}
          loading={detail === null && !isError}
        />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-4">
          {detail === null && !isError && <MessagesSkeleton />}
          {isError && (
            <p className="text-muted-foreground py-8 text-center text-sm">
              This thread couldn&rsquo;t be loaded.
            </p>
          )}
          {detail !== null && detail.messages.length === 0 && (
            <p className="text-muted-foreground py-8 text-center text-sm">
              No messages cached yet.
            </p>
          )}
          {detail?.messages.map((message, i) => (
            <MessageItem
              key={message.messageId}
              threadId={threadId}
              message={message}
              defaultOpen={i === detail.messages.length - 1}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

/** Claude's pinned thread summary (Sonnet) + the repo-freshness indicator. */
function PinnedSummary({
  summary,
  repoFreshness,
  loading,
}: {
  summary: string | null;
  repoFreshness: RepoFreshness | null;
  loading: boolean;
}) {
  return (
    <Card className="bg-muted/40 gap-2 border-none p-3 shadow-none">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs font-medium">
          <Sparkles className="size-3.5" aria-hidden />
          Summary
        </span>
        <RepoFreshnessBadge freshness={repoFreshness} />
      </div>
      {loading ? (
        <div className="space-y-1.5 pt-0.5">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-4/5" />
        </div>
      ) : summary ? (
        <p className="text-foreground/90 text-sm leading-relaxed">{summary}</p>
      ) : (
        <p className="text-muted-foreground text-sm italic">Summary unavailable.</p>
      )}
    </Card>
  );
}

/**
 * The repo-freshness indicator (PROJECT.md §10/§11). Repo pointers land in Phase 8, so `null` (no repo
 * linked) and `unknown` render quietly. Kept in NEUTRAL styling — the semantic hues are reserved for
 * the 3-way promise directions — with only the stale warning carrying an amber icon accent.
 */
function RepoFreshnessBadge({ freshness }: { freshness: RepoFreshness | null }) {
  if (freshness === null) return null;
  if (freshness === 'stale') {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
        <TriangleAlert className="size-3 text-amber-500" aria-hidden />
        Repo may be stale
      </span>
    );
  }
  return (
    <span className="text-muted-foreground/80 inline-flex items-center gap-1 text-xs">
      <GitBranch className="size-3" aria-hidden />
      {freshness === 'fresh' ? 'Repo fresh' : 'Repo unknown'}
    </span>
  );
}

/** One message row — metadata always shown; the body is fetched lazily on expand (local-only hop). */
function MessageItem({
  threadId,
  message,
  defaultOpen,
}: {
  threadId: string;
  message: ThreadMessageMeta;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const body = useMessageBody(threadId, message.messageId, open);

  return (
    <Card className="gap-0 overflow-hidden p-0 shadow-none">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="hover:bg-accent/40 flex w-full items-start gap-2 p-3 text-left transition-colors"
      >
        <span className="text-muted-foreground mt-0.5 shrink-0">
          {open ? (
            <ChevronDown className="size-4" aria-hidden />
          ) : (
            <ChevronRight className="size-4" aria-hidden />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="text-foreground/90 truncate text-sm font-medium">
              {message.sender ? displaySender(message.sender) : 'Unknown sender'}
            </span>
            {message.date !== null && (
              <span className="text-muted-foreground/70 shrink-0 text-xs">
                {formatRelativeDate(message.date)}
              </span>
            )}
          </span>
          {!open && message.snippet && (
            <span className="text-muted-foreground mt-0.5 line-clamp-1 block text-xs">
              {message.snippet}
            </span>
          )}
        </span>
      </button>

      {open && (
        <div className="border-t px-3 py-2.5">
          {body.isLoading ? (
            <div className="space-y-1.5">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-11/12" />
              <Skeleton className="h-3.5 w-3/4" />
            </div>
          ) : body.isError ? (
            <p className="text-muted-foreground text-xs">
              This message&rsquo;s body isn&rsquo;t cached locally.
            </p>
          ) : (
            <pre
              className={cn(
                'text-foreground/90 font-sans text-sm leading-relaxed break-words whitespace-pre-wrap',
              )}
            >
              {body.data}
            </pre>
          )}
        </div>
      )}
    </Card>
  );
}

function MessagesSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-xl" />
      ))}
    </div>
  );
}
