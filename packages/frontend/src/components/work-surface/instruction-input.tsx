/**
 * The instruction textarea (PROJECT.md §6 — "the reusable primitive that appears at draft time and in
 * the refine chat"). One control: optional "context for Claude" when first drafting; the refine
 * instruction when iterating. Submits on the button or ⌘/Ctrl+Enter, then clears.
 *
 * It only ever calls `onSubmit` (which drafts/refines) — it has NO path to send (golden rule #1).
 */
import { useState, type KeyboardEvent } from 'react';
import { ArrowUp, LoaderCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface InstructionInputProps {
  placeholder: string;
  /** Accessible label / button text (e.g. "Draft reply", "Refine"). */
  submitLabel: string;
  onSubmit: (text: string) => void;
  pending: boolean;
  /** When true (another actor holds the lock) the control is read-only. */
  disabled?: boolean;
  /** When true an empty submission is blocked (refine needs text; a first draft does not). */
  requireText?: boolean;
  className?: string;
}

export function InstructionInput({
  placeholder,
  submitLabel,
  onSubmit,
  pending,
  disabled = false,
  requireText = false,
  className,
}: InstructionInputProps) {
  const [text, setText] = useState('');
  const trimmed = text.trim();
  const canSubmit = !pending && !disabled && (!requireText || trimmed.length > 0);

  function submit() {
    if (!canSubmit) return;
    onSubmit(trimmed);
    setText('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className={cn('flex items-end gap-2', className)}>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={2}
        className="max-h-40 min-h-10 flex-1 resize-none"
        aria-label={submitLabel}
      />
      <Button type="button" size="sm" onClick={submit} disabled={!canSubmit} className="gap-1.5">
        {pending ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
        ) : (
          <ArrowUp className="size-4" aria-hidden />
        )}
        {submitLabel}
      </Button>
    </div>
  );
}
