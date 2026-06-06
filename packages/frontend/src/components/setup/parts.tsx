/**
 * Small shared building blocks for the setup wizard (Phase 8 / D33), kept here so the step files stay
 * focused on flow. None of these ever render a secret — `PresenceTick` shows a credential's PRESENCE
 * (a tick / "Not set"), never its value (Golden rule #4). The segmented control + checkbox are plain
 * buttons/native inputs (no new Radix dep).
 */
import { type ComponentProps, type ReactNode, useId } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleAlert, type LucideIcon, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/* --------------------------------- step frame -------------------------------- */

/** The shared layout for one wizard step: a title + optional description, the body, and a footer row. */
export function StepFrame({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
      <div className="space-y-4">{children}</div>
      {footer && <div className="flex items-center justify-between gap-3 pt-1">{footer}</div>}
    </div>
  );
}

/**
 * The standard footer: a left Back button (omitted on the first step) and a right primary action, with
 * an optional secondary (e.g. "Skip") beside it. Keeps every step's navigation consistent.
 */
export function WizardFooter({
  onBack,
  onNext,
  nextLabel = 'Continue',
  nextDisabled,
  nextPending,
  secondary,
}: {
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  nextPending?: boolean;
  secondary?: ReactNode;
}) {
  return (
    <>
      <div>
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
            <ArrowLeft className="size-4" aria-hidden />
            Back
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2">
        {secondary}
        {onNext && (
          <Button
            size="sm"
            onClick={onNext}
            disabled={nextDisabled || nextPending}
            className="gap-1.5"
          >
            {nextLabel}
            {!nextPending && <ArrowRight className="size-4" aria-hidden />}
          </Button>
        )}
      </div>
    </>
  );
}

/* ------------------------------ segmented control ----------------------------- */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  Icon?: LucideIcon;
}

/**
 * An accessible single-choice segmented control (a `radiogroup` of buttons) — the same pattern the
 * settings "Landing view" knob uses, generalized. Used for the provider preset, the repo mode, and the
 * page's guided/advanced switch — so the wizard needs no `select` primitive.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  className,
}: {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('bg-muted/70 inline-flex flex-wrap gap-0.5 rounded-lg p-0.5', className)}
    >
      {options.map(({ value: option, label: optionLabel, Icon }) => {
        const active = value === option;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(option)}
            className={cn(
              'focus-visible:ring-ring/60 inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 disabled:opacity-60',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {Icon && <Icon className="size-3.5" aria-hidden />}
            {optionLabel}
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------- checkbox ---------------------------------- */

/** A labeled native checkbox (no Radix dep). The label is clickable via the shared id. */
export function WizardCheckbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="border-input text-primary focus-visible:ring-ring/50 size-4 rounded border outline-none focus-visible:ring-2 disabled:opacity-50"
      />
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
    </div>
  );
}

/* ------------------------------- labeled input ------------------------------- */

/** A label + input row with an optional hint and aria-invalid styling. */
export function LabeledInput({
  label,
  hint,
  invalid,
  className,
  ...inputProps
}: {
  label: string;
  hint?: ReactNode;
  invalid?: boolean;
} & ComponentProps<typeof Input>) {
  const id = useId();
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <Input id={id} aria-invalid={invalid} {...inputProps} />
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

/* ------------------------------- presence tick ------------------------------- */

/**
 * A credential PRESENCE indicator (Golden rule #4): a green tick + "{label} set" when the backend
 * reports the slot is populated, a muted "{label} not set" otherwise. It is fed by the
 * presence boolean — there is deliberately no way to render the secret itself.
 */
export function PresenceTick({ label, present }: { label: string; present: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs font-medium',
        present ? 'text-promise-deliver' : 'text-muted-foreground',
      )}
    >
      {present ? (
        <Check className="size-3.5" aria-hidden />
      ) : (
        <X className="size-3.5" aria-hidden />
      )}
      {`${label} ${present ? 'set' : 'not set'}`}
    </span>
  );
}

/* -------------------------------- result banner ------------------------------ */

/** A green (ok) / red (fail) inline result — used for test-connection, repo pull, and health. */
export function ResultBanner({ ok, message }: { ok: boolean; message: string }) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
        ok
          ? 'border-promise-deliver/30 bg-promise-deliver/10 text-promise-deliver'
          : 'border-destructive/30 bg-destructive/10 text-destructive',
      )}
    >
      {ok ? (
        <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
      ) : (
        <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      )}
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}

/** A short error line (e.g. a failed mutation), muted and unobtrusive. */
export function ErrorLine({ message }: { message: string }) {
  return (
    <p className="text-destructive flex items-center gap-1.5 text-xs">
      <CircleAlert className="size-3.5 shrink-0" aria-hidden />
      {message}
    </p>
  );
}
