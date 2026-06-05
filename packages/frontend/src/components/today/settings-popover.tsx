/**
 * The settings knobs surfaced on the Today header (D27/D29/D32). User-adjustable values:
 *  - the persisted LANDING VIEW (`defaultView`: the opinionated Today, or the classic 3-pane fallback)
 *    — the real "never trapped" knob (D32); written immediately on select, like the theme toggle;
 *  - the two stale-day thresholds (→ `detectStale`) and the lock timeout in minutes (→ `ttl_seconds`),
 *    saved together via the Save button.
 *
 * Reads `GET /api/settings` and writes a partial patch via `PUT /api/settings` (strict — only changed,
 * valid fields are sent). Persisted in AppSettings, NOT localStorage. The theme lives in the sidebar
 * toggle, not here.
 */
import { useEffect, useState } from 'react';
import { LayoutGrid, Settings2, type LucideIcon, Columns3 } from 'lucide-react';
import type { DefaultView, UpdateSettingsRequest } from '@mailordomo/shared';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSettingsQuery, useUpdateSettings } from '@/lib/today-hooks';
import { cn } from '@/lib/utils';

interface FormState {
  waitingStaleDays: string;
  needsReplyStaleDays: string;
  lockTimeoutMinutes: string;
}

/** Parse a positive-integer field; `null` when blank/invalid (the schema requires int > 0). */
function toPositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function SettingsPopover() {
  const settings = useSettingsQuery();
  const update = useUpdateSettings();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);

  // Seed the form from the live settings whenever the popover opens (and if data arrives after).
  useEffect(() => {
    if (open && settings.data) {
      setForm({
        waitingStaleDays: String(settings.data.waitingStaleDays),
        needsReplyStaleDays: String(settings.data.needsReplyStaleDays),
        lockTimeoutMinutes: String(settings.data.lockTimeoutMinutes),
      });
    }
  }, [open, settings.data]);

  function buildPatch(): UpdateSettingsRequest | null {
    if (!form || !settings.data) return null;
    const patch: UpdateSettingsRequest = {};
    const fields = [
      ['waitingStaleDays', form.waitingStaleDays],
      ['needsReplyStaleDays', form.needsReplyStaleDays],
      ['lockTimeoutMinutes', form.lockTimeoutMinutes],
    ] as const;
    for (const [key, raw] of fields) {
      const parsed = toPositiveInt(raw);
      if (parsed === null) return null; // an invalid field blocks the whole save
      if (parsed !== settings.data[key]) patch[key] = parsed;
    }
    return patch;
  }

  const patch = buildPatch();
  const canSave = patch !== null && Object.keys(patch).length > 0 && !update.isPending;

  function handleSave() {
    if (patch === null || Object.keys(patch).length === 0) return;
    update.mutate(patch, { onSuccess: () => setOpen(false) });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Settings2 className="size-4" aria-hidden />
          Settings
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="space-y-1">
          <p className="text-sm font-medium">Settings</p>
          <p className="text-muted-foreground text-xs">
            Your landing view + triage thresholds. Defaults are sensible — tune if needed.
          </p>
        </div>
        <Separator className="my-3" />
        <DefaultViewControl
          value={settings.data?.defaultView ?? null}
          onChange={(next) => update.mutate({ defaultView: next })}
          disabled={update.isPending}
        />
        <Separator className="my-3" />
        {form === null ? (
          <p className="text-muted-foreground py-4 text-sm">Loading…</p>
        ) : (
          <div className="space-y-3">
            <Field
              id="waiting-stale"
              label="Waiting goes stale after"
              unit="days"
              value={form.waitingStaleDays}
              onChange={(v) => setForm({ ...form, waitingStaleDays: v })}
            />
            <Field
              id="needs-reply-stale"
              label="Needs-reply goes stale after"
              unit="days"
              value={form.needsReplyStaleDays}
              onChange={(v) => setForm({ ...form, needsReplyStaleDays: v })}
            />
            <Field
              id="lock-timeout"
              label="Thread lock timeout"
              unit="min"
              value={form.lockTimeoutMinutes}
              onChange={(v) => setForm({ ...form, lockTimeoutMinutes: v })}
            />
            <div className="flex justify-end pt-1">
              <Button size="sm" onClick={handleSave} disabled={!canSave}>
                {update.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

interface FieldProps {
  id: string;
  label: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
}

function Field({ id, label, unit, value, onChange }: FieldProps) {
  const invalid = toPositiveInt(value) === null;
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={value}
          aria-invalid={invalid}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-16 text-right"
        />
        <span className="text-muted-foreground w-8 text-xs">{unit}</span>
      </div>
    </div>
  );
}

const VIEW_OPTIONS: { value: DefaultView; label: string; Icon: LucideIcon }[] = [
  { value: 'today', label: 'Today', Icon: LayoutGrid },
  { value: 'three-pane', label: '3-pane', Icon: Columns3 },
];

/**
 * The persisted landing-surface control (D32) — the real "never trapped" knob. A segmented control
 * (like the theme toggle) that writes `defaultView` to AppSettings immediately on select, so the user
 * can make the classic 3-pane their landing view. Persisted server-side-free in the local config, NOT
 * localStorage. `null` value = settings still loading (nothing selected yet).
 */
function DefaultViewControl({
  value,
  onChange,
  disabled,
}: {
  value: DefaultView | null;
  onChange: (next: DefaultView) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">Landing view</p>
        <p className="text-muted-foreground text-xs">Which view opens when you launch the app.</p>
      </div>
      <div
        role="radiogroup"
        aria-label="Landing view"
        className="bg-muted/70 grid grid-cols-2 gap-0.5 rounded-lg p-0.5"
      >
        {VIEW_OPTIONS.map(({ value: option, label, Icon }) => {
          const active = value === option;
          return (
            <Tooltip key={option}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={disabled}
                  onClick={() => onChange(option)}
                  className={cn(
                    'focus-visible:ring-ring/60 inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 disabled:opacity-60',
                    active
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="size-3.5" aria-hidden />
                  {label}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {option === 'today'
                  ? 'The opinionated command center'
                  : 'The classic 3-pane fallback'}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
