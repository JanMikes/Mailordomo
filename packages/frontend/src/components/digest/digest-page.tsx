/**
 * The morning digest view (PROJECT.md §9 / D34): the locally-synthesized PROSE narrative up top, then
 * the four metadata sections — what needs you today, promises due, what Simona handled, what Claude
 * drafted. It is READ-ONLY: every thread row escalates to the existing 7b work surface (no send path
 * lives here, Golden rule #1).
 *
 * Privacy (Golden rule #3): this renders ONLY the body-free digest DTO (sanctioned subject/snippet/
 * sender + metadata) plus the local prose; it talks only to the local `/api/digest` and persists
 * nothing in localStorage. The prose is synthesized on this machine — the server never sees it.
 */
import {
  CircleAlert,
  Handshake,
  Inbox,
  PenLine,
  RefreshCw,
  Sunrise,
  UserRoundCheck,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { DigestView } from '@/lib/api';
import { useDigest } from '@/lib/digest-hooks';
import { formatRelativeDate } from '@/lib/format';
import {
  DigestSection,
  DraftedRow,
  HandledRow,
  NeedsYouRow,
  PromiseDueRow,
} from './digest-sections';

export function DigestPage() {
  const digest = useDigest();

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
      <DigestHeader meta={digest.data?.metadata} />
      {digest.data ? (
        <DigestContent view={digest.data} />
      ) : digest.isError ? (
        <ErrorState
          message={digest.error instanceof Error ? digest.error.message : 'Unknown error'}
          onRetry={() => void digest.refetch()}
        />
      ) : (
        <LoadingState />
      )}
    </div>
  );
}

/** The view title + the digest window phrase (e.g. "since yesterday morning"), once metadata loads. */
function DigestHeader({ meta }: { meta: DigestView['metadata'] | undefined }) {
  const phrase = meta ? describeDigestWindow(meta.window_start, meta.generated_at) : null;
  return (
    <div className="flex items-start gap-3">
      <span className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-xl">
        <Sunrise className="size-5" aria-hidden />
      </span>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Digest</h1>
        <p className="text-muted-foreground text-sm">
          Your morning briefing{phrase ? ` — ${phrase}` : ''}.
        </p>
      </div>
    </div>
  );
}

function DigestContent({ view }: { view: DigestView }) {
  const m = view.metadata;
  return (
    <div className="space-y-8">
      <ProseBlock prose={view.prose} />

      <DigestSection
        title="What needs you today"
        Icon={Inbox}
        count={m.needs_you.length}
        emptyLabel="Nothing needs you right now."
      >
        {m.needs_you.map((entry) => (
          <NeedsYouRow key={entry.thread_id} entry={entry} />
        ))}
      </DigestSection>

      <DigestSection
        title="Promises due"
        Icon={Handshake}
        count={m.promises_due.length}
        emptyLabel="No promises due."
      >
        {m.promises_due.map((entry) => (
          <PromiseDueRow key={entry.promise_id} entry={entry} />
        ))}
      </DigestSection>

      <DigestSection
        title="What Simona handled"
        Icon={UserRoundCheck}
        count={m.handled.length}
        emptyLabel="Nothing was handled while you were away."
      >
        {m.handled.map((entry) => (
          <HandledRow key={entry.task_id} entry={entry} />
        ))}
      </DigestSection>

      <DigestSection
        title="What Claude drafted"
        Icon={PenLine}
        count={m.drafted.length}
        emptyLabel="No new drafts."
      >
        {m.drafted.map((entry, i) => (
          <DraftedRow key={`${entry.thread_id}-${i}`} entry={entry} />
        ))}
      </DigestSection>
    </div>
  );
}

/**
 * The locally-synthesized narrative, rendered as readable paragraphs (blank lines split paragraphs;
 * single newlines are preserved within one). When the backend declined synthesis (backpressure / no
 * runner) the prose is empty — show a calm note and let the sections below carry the briefing.
 */
function ProseBlock({ prose }: { prose: string }) {
  const paragraphs = prose
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return (
      <Card className="bg-muted/30 px-5 py-4 shadow-none">
        <p className="text-muted-foreground text-sm">
          No written summary this morning — the highlights are below.
        </p>
      </Card>
    );
  }

  return (
    <Card className="bg-muted/30 gap-3 px-5 py-5 shadow-none">
      {paragraphs.map((p, i) => (
        <p key={i} className="text-foreground/90 text-[15px] leading-relaxed whitespace-pre-line">
          {p}
        </p>
      ))}
    </Card>
  );
}

/** Describe the digest window as a human phrase from its start relative to when it was generated. */
function describeDigestWindow(windowStart: string, generatedAt: string): string {
  const rel = formatRelativeDate(windowStart, Date.parse(generatedAt));
  if (rel === 'yesterday') return 'since yesterday morning';
  if (rel === 'today') return 'since this morning';
  if (!rel) return 'over the last day';
  return `since ${rel}`;
}

function LoadingState() {
  return (
    <div className="space-y-8" aria-hidden>
      <Card className="bg-muted/30 gap-2.5 px-5 py-5 shadow-none">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-3/4" />
      </Card>
      {Array.from({ length: 2 }).map((_, s) => (
        <div key={s} className="space-y-2.5">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-[68px] w-full rounded-lg" />
          <Skeleton className="h-[68px] w-full rounded-lg" />
        </div>
      ))}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="items-center gap-3 py-12 text-center">
      <span className="bg-destructive/10 text-destructive flex size-11 items-center justify-center rounded-full">
        <CircleAlert className="size-5" aria-hidden />
      </span>
      <div className="space-y-1">
        <p className="font-medium">Couldn&rsquo;t load the digest</p>
        <p className="text-muted-foreground mx-auto max-w-md text-sm">{message}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry} className="mt-1 gap-2">
        <RefreshCw className="size-4" aria-hidden />
        Try again
      </Button>
    </Card>
  );
}
