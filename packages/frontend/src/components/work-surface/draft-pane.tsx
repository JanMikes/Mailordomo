/**
 * The RIGHT pane of the work surface (PROJECT.md §11): the draft + refine chat. A model badge (drafts
 * are Opus — golden rule #6), the EDITABLE draft body (the user's edit is exactly what gets sent and
 * what feeds draft-vs-sent learning), **Send as the PRIMARY action** with edit/snooze beside it, and
 * the refine chat with the instruction textarea pinned at the bottom.
 *
 * GOLDEN RULE #1 (manual send): the ONLY call to `…/send` is `send.mutate(...)` inside the Send
 * button's onClick — there is no effect, timer, or auto-path that sends. Send is additionally disabled
 * while another actor holds the lock. (Auto-DRAFTING on open is allowed — only sending is manual.)
 */
import { useEffect, useRef, useState } from 'react';
import { AlarmClock, Check, CircleAlert, PencilLine, Send } from 'lucide-react';

import { ApiError, type DraftResponse } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useSnooze } from '@/lib/today-hooks';
import { useDraft, useGenerateDraft, useRefineDraft, useSendDraft } from '@/lib/work-surface-hooks';
import { InstructionInput } from './instruction-input';
import { RefineChat } from './refine-chat';

interface DraftPaneProps {
  threadId: string;
  /** This user holds the lock (or no one does) — may draft / refine / edit / send. */
  canWrite: boolean;
  /** Kick off a first draft on open (the do-next "Draft" action). */
  autoDraft: boolean;
  /** Leave the surface (back to Today). */
  onClose: () => void;
}

export function DraftPane({ threadId, canWrite, autoDraft, onClose }: DraftPaneProps) {
  const draftQuery = useDraft(threadId);
  const generate = useGenerateDraft(threadId);
  const refine = useRefineDraft(threadId);
  const send = useSendDraft(threadId);

  const draft = draftQuery.data ?? null;
  const draftUnavailable = draftQuery.error instanceof ApiError && draftQuery.error.status === 503;

  // Auto-draft once on open (drafting is allowed without a click; only sending is manual).
  const autoDraftedRef = useRef(false);
  useEffect(() => {
    if (
      autoDraft &&
      canWrite &&
      !autoDraftedRef.current &&
      draftQuery.isSuccess &&
      draft === null &&
      !generate.isPending
    ) {
      autoDraftedRef.current = true;
      generate.mutate(undefined);
    }
  }, [autoDraft, canWrite, draftQuery.isSuccess, draft, generate]);

  if (send.isSuccess) {
    return <SentConfirmation filedTo={send.data.filedTo} onClose={onClose} />;
  }

  return (
    <div className="flex h-full flex-col">
      {draftQuery.isLoading ? (
        <DraftLoading />
      ) : draftUnavailable ? (
        <Unavailable message="Drafting isn’t configured yet. Connect Claude in setup to draft replies." />
      ) : draftQuery.isError ? (
        <PaneError
          message={draftQuery.error instanceof Error ? draftQuery.error.message : 'Unknown error'}
          onRetry={() => void draftQuery.refetch()}
        />
      ) : draft === null ? (
        <DraftAReply
          onDraft={(instruction) => generate.mutate(instruction || undefined)}
          pending={generate.isPending}
          canWrite={canWrite}
          error={generate.error}
        />
      ) : (
        <DraftEditor
          threadId={threadId}
          draft={draft}
          canWrite={canWrite}
          onRefine={(instruction) => refine.mutate(instruction)}
          refinePending={refine.isPending}
          onClose={onClose}
          send={send}
        />
      )}
    </div>
  );
}

/* --------------------------------- the editor --------------------------------- */

function DraftEditor({
  threadId,
  draft,
  canWrite,
  onRefine,
  refinePending,
  onClose,
  send,
}: {
  threadId: string;
  draft: DraftResponse;
  canWrite: boolean;
  onRefine: (instruction: string) => void;
  refinePending: boolean;
  onClose: () => void;
  send: ReturnType<typeof useSendDraft>;
}) {
  const snooze = useSnooze();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The editable body is seeded from the draft and RE-seeded whenever a new version arrives (refine).
  const [body, setBody] = useState(draft.body);
  const lastVersionRef = useRef(draft.version);
  useEffect(() => {
    if (draft.version !== lastVersionRef.current) {
      lastVersionRef.current = draft.version;
      setBody(draft.body);
    }
  }, [draft.version, draft.body]);

  const canSend = canWrite && body.trim().length > 0 && !send.isPending;

  return (
    <>
      <div className="shrink-0 space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <Badge variant="secondary" className="gap-1.5 font-normal">
            <PencilLine className="size-3" aria-hidden />
            <span>{`Draft · ${modelLabel(draft.model)}`}</span>
            <span className="text-muted-foreground/70">{`v${draft.version}`}</span>
          </Badge>
        </div>

        <Textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          readOnly={!canWrite}
          aria-label="Draft reply"
          className="min-h-48 resize-y leading-relaxed"
        />

        <div className="flex items-center gap-2">
          {/* PRIMARY action. Golden rule #1: fires ONLY on this explicit click. */}
          <Button onClick={() => send.mutate(body)} disabled={!canSend} className="gap-1.5">
            <Send className="size-4" aria-hidden />
            {send.isPending ? 'Sending…' : 'Send'}
          </Button>
          <Button
            variant="outline"
            onClick={() => textareaRef.current?.focus()}
            disabled={!canWrite}
            className="gap-1.5"
          >
            <PencilLine className="size-4" aria-hidden />
            Edit
          </Button>
          <Button
            variant="outline"
            onClick={() => snooze.mutate({ threadId }, { onSuccess: onClose })}
            disabled={snooze.isPending}
            className="gap-1.5"
          >
            <AlarmClock className="size-4" aria-hidden />
            Snooze
          </Button>
        </div>

        {send.isError && (
          <p className="text-destructive flex items-center gap-1.5 text-xs">
            <CircleAlert className="size-3.5" aria-hidden />
            {send.error instanceof Error ? send.error.message : 'Send failed'}
          </p>
        )}
        {!canWrite && (
          <p className="text-muted-foreground text-xs">
            Another person holds this thread — editing and sending are paused.
          </p>
        )}
      </div>

      <Separator />

      <RefineChat
        transcript={draft.transcript}
        onRefine={onRefine}
        pending={refinePending}
        canWrite={canWrite}
      />
    </>
  );
}

/* ------------------------------- empty / states ------------------------------- */

/** No draft yet: an optional instruction + a primary "Draft reply" (drafting is on-signal, §6). */
function DraftAReply({
  onDraft,
  pending,
  canWrite,
  error,
}: {
  onDraft: (instruction: string) => void;
  pending: boolean;
  canWrite: boolean;
  error: unknown;
}) {
  const unavailable = error instanceof ApiError && error.status === 503;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
      <div className="max-w-sm space-y-1.5 text-center">
        <h2 className="text-base font-medium">Draft a reply</h2>
        <p className="text-muted-foreground text-sm">
          Claude drafts with Opus. Add any context below, or just draft — you can refine and edit
          before sending.
        </p>
      </div>
      <div className="w-full max-w-md">
        <InstructionInput
          placeholder="Optional: context for Claude (tone, points to make)…"
          submitLabel={pending ? 'Drafting…' : 'Draft reply'}
          onSubmit={onDraft}
          pending={pending}
          disabled={!canWrite}
        />
        {unavailable ? (
          <p className="text-muted-foreground mt-2 text-center text-xs">
            Drafting isn’t configured yet. Connect Claude in setup to draft replies.
          </p>
        ) : error ? (
          <p className="text-destructive mt-2 text-center text-xs">
            {error instanceof Error ? error.message : 'Draft failed'}
          </p>
        ) : !canWrite ? (
          <p className="text-muted-foreground mt-2 text-center text-xs">
            Another person holds this thread right now.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The confirmation after a successful MANUAL send (the task auto-moved to waiting). */
function SentConfirmation({ filedTo, onClose }: { filedTo: string | null; onClose: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <span className="bg-promise-deliver/10 text-promise-deliver flex size-12 items-center justify-center rounded-full">
        <Check className="size-6" aria-hidden />
      </span>
      <div className="space-y-1">
        <p className="font-medium">Sent</p>
        <p className="text-muted-foreground mx-auto max-w-xs text-sm">
          Your reply went out and the thread moved to waiting.
          {filedTo !== null && ` A copy was filed to ${filedTo}.`}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onClose}>
        Back to today
      </Button>
    </div>
  );
}

function Unavailable({ message }: { message: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <PencilLine className="text-muted-foreground/60 size-7" aria-hidden />
      <p className="text-muted-foreground max-w-xs text-sm">{message}</p>
    </div>
  );
}

function PaneError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <CircleAlert className="text-destructive size-7" aria-hidden />
      <p className="text-muted-foreground max-w-xs text-sm">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function DraftLoading() {
  return (
    <div className="space-y-3 p-4">
      <Skeleton className="h-5 w-28 rounded-md" />
      <Skeleton className="h-48 w-full rounded-md" />
      <div className="flex gap-2">
        <Skeleton className="h-9 w-24 rounded-md" />
        <Skeleton className="h-9 w-20 rounded-md" />
      </div>
    </div>
  );
}

/** Map a model id (e.g. `claude-opus-4-8[1m]`) to a short badge label. */
function modelLabel(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku')) return 'Haiku';
  return model;
}
