/**
 * The app shell: a left sidebar (wordmark + primary nav + theme toggle) and the scrollable main
 * surface. All four primary views — "Today", "Memory", "All projects" (the projects board), and
 * "3-pane" (the classic fallback) — are LIVE, switched through `NavContext` (D32). The 3-pane is the
 * deliberate "never trap the user in the opinionated view" escape hatch (CLAUDE.md / PROJECT.md §11).
 */
import type { ReactNode } from 'react';
import {
  Columns3,
  Folders,
  History,
  ListTodo,
  Mailbox,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useNav } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { ThemeToggle } from './theme-toggle';

interface NavItem {
  label: string;
  Icon: LucideIcon;
  active?: boolean;
  disabled?: boolean;
  hint?: string;
  onClick?: () => void;
}

export function AppShell({ children }: { children: ReactNode }) {
  const nav = useNav();
  const onThread = nav.selectedThreadId !== null;

  const items: readonly NavItem[] = [
    {
      label: 'Today',
      Icon: ListTodo,
      active: !onThread && nav.view === 'today',
      onClick: () => nav.goTo('today'),
    },
    {
      label: 'Memory',
      Icon: History,
      active: !onThread && nav.view === 'memory',
      onClick: () => nav.goTo('memory'),
    },
    {
      label: 'All projects',
      Icon: Folders,
      active: !onThread && nav.view === 'all-projects',
      onClick: () => nav.goTo('all-projects'),
    },
    {
      label: '3-pane',
      Icon: Columns3,
      active: !onThread && nav.view === 'three-pane',
      onClick: () => nav.goTo('three-pane'),
    },
    {
      label: 'Setup',
      Icon: Wrench,
      active: !onThread && nav.view === 'setup',
      onClick: () => nav.goTo('setup'),
    },
  ];

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
          {items.map((item) => (
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
    <button
      type="button"
      onClick={item.onClick}
      aria-current={item.active ? 'page' : undefined}
      className={cn(
        base,
        'w-full text-left outline-none',
        item.active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
      )}
    >
      <item.Icon className="size-4" aria-hidden />
      {item.label}
    </button>
  );
}
