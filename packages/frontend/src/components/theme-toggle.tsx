/**
 * Light / dark / system toggle (PROJECT.md §11). A 3-way segmented control whose source of truth is
 * `AppSettings.colorScheme` (backend config, NOT localStorage); selecting an option PUTs the new
 * scheme. `useColorScheme` also applies the resolved theme by toggling `.dark` on <html>.
 */
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import type { ColorScheme } from '@mailordomo/shared';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useColorScheme } from '@/lib/useColorScheme';
import { cn } from '@/lib/utils';

const OPTIONS: { value: ColorScheme; label: string; Icon: LucideIcon }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
];

export function ThemeToggle() {
  const { scheme, setScheme } = useColorScheme();

  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className="bg-muted/70 inline-flex items-center gap-0.5 rounded-lg p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = scheme === value;
        return (
          <Tooltip key={value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={label}
                onClick={() => setScheme(value)}
                className={cn(
                  'focus-visible:ring-ring/60 inline-flex size-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2',
                  active
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
