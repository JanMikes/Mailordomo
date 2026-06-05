/**
 * The app shell: a left sidebar (wordmark + primary nav + theme toggle) and the scrollable main
 * surface. "Today" is the live view; "All projects" and "3-pane" are visible-but-disabled
 * placeholders for 7c — the 3-pane is the deliberate "never trap the user in the opinionated view"
 * slot (CLAUDE.md / PROJECT.md §11), shown now so the escape hatch is always discoverable.
 */
import type { ReactNode } from 'react';
import { Columns3, Folders, ListTodo, Mailbox, type LucideIcon } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ThemeToggle } from './theme-toggle';

interface NavItem {
  label: string;
  Icon: LucideIcon;
  active?: boolean;
  disabled?: boolean;
  hint?: string;
}

const NAV: readonly NavItem[] = [
  { label: 'Today', Icon: ListTodo, active: true },
  {
    label: 'All projects',
    Icon: Folders,
    disabled: true,
    hint: 'Per-project views land in a later phase',
  },
  {
    label: '3-pane',
    Icon: Columns3,
    disabled: true,
    hint: 'The classic fallback lands in a later phase',
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background text-foreground flex h-svh">
      <aside className="bg-muted/30 flex w-60 shrink-0 flex-col border-r p-3">
        <div className="flex items-center gap-2 px-1.5 py-1.5">
          <span className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg">
            <Mailbox className="size-4" aria-hidden />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Mailordomo</span>
        </div>

        <nav className="flex flex-col gap-0.5 pt-3">
          {NAV.map((item) => (
            <NavRow key={item.label} item={item} />
          ))}
        </nav>

        <div className="mt-auto flex items-center justify-between gap-2 px-1.5 pt-3">
          <span className="text-muted-foreground/70 text-xs">Local-first</span>
          <ThemeToggle />
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

function NavRow({ item }: { item: NavItem }) {
  const base =
    'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors';

  if (item.disabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            aria-disabled="true"
            className={cn(base, 'text-muted-foreground/50 cursor-not-allowed outline-none')}
          >
            <item.Icon className="size-4" aria-hidden />
            {item.label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">{item.hint}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <span
      aria-current={item.active ? 'page' : undefined}
      className={cn(
        base,
        item.active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
      )}
    >
      <item.Icon className="size-4" aria-hidden />
      {item.label}
    </span>
  );
}
