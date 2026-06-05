/**
 * The Memory / learning changelog (PROJECT.md §6 — "a changelog the user can review and revert";
 * PLAN.md D28). Lists the silent-learning entries (summary + scope + applied/reverted state). Each
 * still-applied entry can be reverted behind an alert-dialog confirmation.
 *
 * The D28 LIFO guard is enforced SERVER-SIDE (the backend refuses unless the target is the last
 * un-reverted change for its tone-file). The frontend can't pre-compute per-file eligibility — the
 * shared `LearningEntry` carries `scope` but not the tone-file `path` (that's local-only) — so Revert
 * is offered on every applied entry and a refusal comes back as a calm 409 message ("revert the most
 * recent change to this file first") rather than an alarming error. Reverted entries show as reverted.
 */
import { useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import type { LearningEntry } from '@mailordomo/shared';

import { ApiError } from '@/lib/api';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useLearningEntries, useRevertLearning } from '@/lib/work-surface-hooks';
import { formatRelativeDate } from '@/lib/format';

export function MemoryPage() {
  const entries = useLearningEntries();
  const revert = useRevertLearning();
  const [attemptedId, setAttemptedId] = useState<string | null>(null);

  function confirmRevert(id: string) {
    setAttemptedId(id);
    revert.mutate(id);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <History className="size-6" aria-hidden />
          Memory
        </h1>
        <p className="text-muted-foreground text-sm">
          What Claude learned from your edits and instructions. Review the changelog and revert
          anything that missed.
        </p>
      </header>

      {entries.data ? (
        entries.data.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="space-y-2.5">
            {entries.data.map((entry) => (
              <li key={entry.id}>
                <EntryRow
                  entry={entry}
                  onConfirmRevert={confirmRevert}
                  pending={revert.isPending && attemptedId === entry.id}
                  error={attemptedId === entry.id ? revert.error : null}
                />
              </li>
            ))}
          </ul>
        )
      ) : entries.isError ? (
        <Card className="py-10 text-center">
          <p className="text-muted-foreground text-sm">
            {entries.error instanceof Error
              ? entries.error.message
              : 'Couldn’t load the changelog.'}
          </p>
        </Card>
      ) : (
        <LoadingState />
      )}
    </div>
  );
}

function EntryRow({
  entry,
  onConfirmRevert,
  pending,
  error,
}: {
  entry: LearningEntry;
  onConfirmRevert: (id: string) => void;
  pending: boolean;
  error: unknown;
}) {
  const reverted = entry.reverted_at !== null;

  return (
    <Card className="gap-2 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-sm leading-snug">{entry.summary}</p>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <Badge variant="outline" className="font-normal capitalize">
              {entry.scope}
            </Badge>
            <span>Applied {formatRelativeDate(entry.applied_at)}</span>
          </div>
        </div>

        {reverted ? (
          <Badge variant="secondary" className="text-muted-foreground shrink-0 font-normal">
            Reverted {formatRelativeDate(entry.reverted_at as string)}
          </Badge>
        ) : (
          <RevertButton entry={entry} onConfirm={onConfirmRevert} pending={pending} />
        )}
      </div>

      {error !== null && error !== undefined && <RevertError error={error} />}
    </Card>
  );
}

function RevertButton({
  entry,
  onConfirm,
  pending,
}: {
  entry: LearningEntry;
  onConfirm: (id: string) => void;
  pending: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={pending} className="shrink-0 gap-1.5">
          <RotateCcw className="size-3.5" aria-hidden />
          {pending ? 'Reverting…' : 'Revert'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revert this change?</AlertDialogTitle>
          <AlertDialogDescription>
            Claude will undo what it learned from this entry and restore the tone memory it had
            before. You can&rsquo;t redo a revert.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => onConfirm(entry.id)}>Revert</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Turn a failed revert into a calm message — the 409 LIFO refusal reads as guidance, not an error. */
function RevertError({ error }: { error: unknown }) {
  let message = error instanceof Error ? error.message : 'Couldn’t revert this change.';
  if (error instanceof ApiError && error.status === 409) {
    message = 'Revert the most recent change to this file first.';
  } else if (error instanceof ApiError && error.status === 503) {
    message = 'Reverting isn’t available right now.';
  }
  return <p className="text-muted-foreground border-t pt-2 text-xs">{message}</p>;
}

function EmptyState() {
  return (
    <Card className="items-center gap-2 border-dashed py-12 text-center shadow-none">
      <History className="text-muted-foreground/50 size-7" aria-hidden />
      <p className="font-medium">Nothing learned yet</p>
      <p className="text-muted-foreground mx-auto max-w-sm text-sm">
        As you edit Claude&rsquo;s drafts and give recurring instructions, the changes it makes to
        tone memory show up here.
      </p>
    </Card>
  );
}

function LoadingState() {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-20 w-full rounded-xl" />
      ))}
    </div>
  );
}
