/**
 * The refine chat (PROJECT.md §11): the replayed transcript (golden rule #5 — the backend owns the
 * history and replays it into a fresh Opus call each turn) with the instruction textarea PINNED at the
 * bottom. Submitting an instruction refines the current draft; it never sends.
 */
import { useEffect, useRef } from 'react';
import { MessageSquare } from 'lucide-react';
import type { RefineTurn } from '@/lib/api';

import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { InstructionInput } from './instruction-input';

interface RefineChatProps {
  transcript: readonly RefineTurn[];
  onRefine: (instruction: string) => void;
  pending: boolean;
  /** False when another actor holds the lock — the input goes read-only. */
  canWrite: boolean;
}

export function RefineChat({ transcript, onRefine, pending, canWrite }: RefineChatProps) {
  const endRef = useRef<HTMLDivElement>(null);

  // Keep the latest turn in view as the conversation grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [transcript.length, pending]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="text-muted-foreground flex items-center gap-1.5 px-4 pt-3 pb-1 text-xs font-medium">
        <MessageSquare className="size-3.5" aria-hidden />
        Refine chat
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 px-4 py-2">
          {transcript.length === 0 ? (
            <p className="text-muted-foreground/80 py-2 text-xs">
              Ask Claude to adjust the draft — tone, length, a point to add. Each turn replays the
              full history.
            </p>
          ) : (
            transcript.map((turn, i) => <Turn key={i} turn={turn} />)
          )}
          <div ref={endRef} />
        </div>
      </ScrollArea>

      <div className="border-t p-3">
        <InstructionInput
          placeholder="Tell Claude how to adjust the draft…"
          submitLabel="Refine"
          onSubmit={onRefine}
          pending={pending}
          disabled={!canWrite}
          requireText
        />
      </div>
    </div>
  );
}

function Turn({ turn }: { turn: RefineTurn }) {
  const isUser = turn.role === 'user';
  return (
    <div className={cn('flex flex-col gap-0.5', isUser ? 'items-end' : 'items-start')}>
      <span className="text-muted-foreground/70 px-1 text-[11px]">{isUser ? 'You' : 'Claude'}</span>
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
        )}
      >
        {turn.content}
      </div>
    </div>
  );
}
