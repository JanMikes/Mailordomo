/**
 * The four labelled sections of the morning digest (PROJECT.md §9 / D34) and their compact rows:
 * "What needs you today", "Promises due", "What Simona handled", and "What Claude drafted".
 *
 * Every row renders ONLY the sanctioned digest metadata — subject/snippet/sender + state / promise
 * direction+status / model / actor / time — and NEVER a body (Golden rule #3). Each entry references
 * a thread, so the whole row is a button that escalates to the existing 7b work surface
 * (`nav.openThread`); no digest item is a dead end, and there is no send path here. An empty section
 * degrades to a single quiet line rather than vanishing.
 */
import type { ReactNode } from 'react';
import { ArrowRight, type LucideIcon } from 'lucide-react';
import type {
  DigestDraftEntry,
  DigestPromiseEntry,
  DigestThreadRef,
  DigestTransitionEntry,
} from '@mailordomo/shared';

import { Badge } from '@/components/ui/badge';
import { PROMISE_META, PROMISE_STATUS_LABEL, STATE_LABEL } from '@/lib/labels';
import { displaySender, formatRelativeDate } from '@/lib/format';
import { useNav } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { DeadlineChip, StateBadge } from '../today/card-parts';

/** A labelled section: an icon + title + count header, then its rows — or one quiet empty line. */
export function DigestSection({
  title,
  Icon,
  count,
  emptyLabel,
  children,
}: {
  title: string;
  Icon: LucideIcon;
  count: number;
  emptyLabel: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-center gap-2">
        <Icon className="text-muted-foreground size-4" aria-hidden />
        <h2 className="text-foreground text-sm font-semibold">{title}</h2>
        {count > 0 && (
          <span className="text-muted-foreground/60 text-xs tabular-nums">{count}</span>
        )}
      </div>
      {count > 0 ? (
        <div className="flex flex-col gap-2">{children}</div>
      ) : (
        <p className="text-muted-foreground/70 px-0.5 text-sm">{emptyLabel}</p>
      )}
    </section>
  );
}

/**
 * A clickable row shell: opens the 7b work surface for `threadId` (read-only escalation — never a
 * send, Golden rule #1). A trailing arrow surfaces on hover/focus to signal it opens the thread.
 */
function RowButton({ threadId, children }: { threadId: string; children: ReactNode }) {
  const nav = useNav();
  return (
    <button
      type="button"
      onClick={() => nav.openThread(threadId)}
      className="group hover:bg-accent/40 focus-visible:ring-ring/50 flex w-full items-start gap-3 rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-2"
    >
      {children}
      <ArrowRight
        className="mt-0.5 size-4 shrink-0 text-transparent transition-colors group-hover:text-muted-foreground/60 group-focus-visible:text-muted-foreground/60"
        aria-hidden
      />
    </button>
  );
}

/** Capitalize an actor key for display ("simona" → "Simona", "claude" → "Claude"). */
function displayActor(actor: string): string {
  return actor.charAt(0).toUpperCase() + actor.slice(1);
}

/** The quiet interpunct separator used between inline metadata bits. */
function Dot() {
  return (
    <span aria-hidden className="text-muted-foreground/40 px-1.5">
      ·
    </span>
  );
}

/** "What needs you today": a thread with its state badge + (optional) deadline chip. */
export function NeedsYouRow({ entry }: { entry: DigestThreadRef }) {
  return (
    <RowButton threadId={entry.thread_id}>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge state={entry.state} />
          <DeadlineChip deadline={entry.deadline} followUpAt={null} />
        </div>
        <p className="text-foreground truncate text-sm font-medium">
          {entry.subject || '(no subject)'}
        </p>
        <p className="text-muted-foreground truncate text-xs">{displaySender(entry.sender)}</p>
      </div>
    </RowButton>
  );
}

/** "Promises due": the 3-way direction dot + the promise text + its subject + due/status chip. */
export function PromiseDueRow({ entry }: { entry: DigestPromiseEntry }) {
  const meta = PROMISE_META[entry.direction];
  return (
    <RowButton threadId={entry.thread_id}>
      <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', meta.dotClass)} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-foreground text-sm">{entry.text}</p>
        <p className="text-muted-foreground truncate text-xs">
          <span className={meta.textClass}>{meta.label}</span>
          <Dot />
          <span>{entry.subject || '(no subject)'}</span>
        </p>
        <PromiseDueChip dueAt={entry.due_at} status={entry.status} />
      </div>
    </RowButton>
  );
}

const CHIP =
  'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap';

/** The promise status + (optional) due date — red when overdue, the strongest "chase this" signal. */
function PromiseDueChip({
  dueAt,
  status,
}: {
  dueAt: string | null;
  status: DigestPromiseEntry['status'];
}) {
  const overdue = status === 'overdue';
  const date = dueAt ? formatRelativeDate(dueAt) : null;
  return (
    <span
      className={cn(
        CHIP,
        overdue ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
      )}
    >
      {PROMISE_STATUS_LABEL[status]}
      {date && ` · due ${date}`}
    </span>
  );
}

/** "What Simona handled": an actor-attributed transition — "{actor}: {from} → {to}" + subject/time. */
export function HandledRow({ entry }: { entry: DigestTransitionEntry }) {
  return (
    <RowButton threadId={entry.thread_id}>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-foreground truncate text-sm">
          <span className="font-medium">{displayActor(entry.actor)}</span>
          <span className="text-muted-foreground">: {STATE_LABEL[entry.from]} </span>
          <span aria-hidden className="text-muted-foreground/60">
            →
          </span>
          <span className="text-muted-foreground"> {STATE_LABEL[entry.to]}</span>
        </p>
        <p className="text-muted-foreground truncate text-xs">
          {entry.subject || '(no subject)'}
          <Dot />
          {formatRelativeDate(entry.at)}
        </p>
      </div>
    </RowButton>
  );
}

/** "What Claude drafted": draft METADATA only — subject + model badge + author/time (never a body). */
export function DraftedRow({ entry }: { entry: DigestDraftEntry }) {
  return (
    <RowButton threadId={entry.thread_id}>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-foreground truncate text-sm font-medium">
          {entry.subject || '(no subject)'}
        </p>
        <p className="text-muted-foreground truncate text-xs">
          {displayActor(entry.author)} drafted
          <Dot />
          {formatRelativeDate(entry.at)}
        </p>
      </div>
      <Badge variant="secondary" className="text-muted-foreground shrink-0 font-normal capitalize">
        {entry.model}
      </Badge>
    </RowButton>
  );
}
