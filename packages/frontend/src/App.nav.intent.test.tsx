/**
 * INTENT (separate test-author) — the Phase 7c (D32) APP-LEVEL navigation: the sidebar view toggle
 * (Today ↔ Memory ↔ All projects ↔ 3-pane), opening a thread from the board mounts the 7b work
 * surface, and the FLICKER-FREE `defaultView` landing (the view is null until settings resolve, so the
 * user who chose the 3-pane never sees a Today→3-pane snap). ADDITIVE to `App.landing.test.tsx`.
 *
 * Derived from PROJECT.md §11 ("the classic 3-pane fallback so the user is NEVER trapped"; the views
 * switch; opening a thread from any view works) + D32 (the persisted landing preference; the board/
 * 3-pane open threads via the existing 7b work surface). Bodies stay local — this asserts routing only.
 */
import type { ReactElement } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  AppSettings,
  BoardThreadCard,
  DefaultView,
  ProjectsBoard,
  ThreadDetail,
} from '@mailordomo/shared';
import { TASK_STATES } from '@mailordomo/shared';

import { mockFetch, type MockRoute } from '@/test/fetch-mock';

// Stub the live-update socket (Today + the board both subscribe; no real WebSocket in jsdom).
vi.mock('@/lib/useWs', () => ({ useWsToday: () => {} }));

// The shell renders ThemeToggle → useColorScheme → matchMedia (absent in jsdom).
beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }
});

import { App } from './App';

function settings(defaultView: DefaultView = 'today'): AppSettings {
  return {
    waitingStaleDays: 3,
    needsReplyStaleDays: 2,
    lockTimeoutMinutes: 30,
    colorScheme: 'system',
    defaultView,
  };
}

function emptyGroups(): Record<string, BoardThreadCard[]> {
  const out: Record<string, BoardThreadCard[]> = {};
  for (const s of TASK_STATES) out[s] = [];
  return out;
}
function zeroCounts(): Record<string, number> {
  return Object.fromEntries(TASK_STATES.map((s) => [s, 0]));
}

const THREAD: BoardThreadCard = {
  threadId: 'th-1',
  subject: 'Quarterly report',
  snippet: 'Please send the quarterly report',
  sender: 'Petr Novák <petr@acme.com>',
  state: 'needs-reply',
  importance: 'high',
  deadline: null,
  followUpAt: null,
  lastActivityAt: '2026-06-05T08:00:00.000Z',
  hasDraftReady: false,
  promiseDirections: ['my-promise'],
};

const BOARD: ProjectsBoard = {
  generatedAt: '2026-06-06T09:00:00.000Z',
  projects: [
    {
      projectId: 'acme',
      projectName: 'Acme',
      groups: { ...emptyGroups(), 'needs-reply': [THREAD] },
      counts: { ...zeroCounts(), 'needs-reply': 1 },
    } as ProjectsBoard['projects'][number],
  ],
};

const DETAIL: ThreadDetail = {
  threadId: 'th-1',
  projectName: 'Acme',
  subject: 'Quarterly report',
  sender: 'Petr Novák <petr@acme.com>',
  snippet: 'Please send the quarterly report',
  lastActivityAt: '2026-06-05T08:00:00.000Z',
  messages: [],
  pinnedSummary: null,
  repoFreshness: null,
  lock: null,
};

/** Routes covering every view + the 7b work-surface mount (detail/draft/lock). */
function routes(s: AppSettings): MockRoute[] {
  return [
    { url: '/api/settings', json: s },
    { url: '/api/today', status: 503, json: { error: 'x' } },
    { url: '/api/projects-board', json: BOARD },
    { url: '/api/learning', json: [] },
    { url: '/api/threads/th-1/draft', status: 404, json: { error: 'none' } },
    { method: 'POST', url: '/api/threads/th-1/lock/acquire', json: { acquired: true, lock: null } },
    { url: '/api/threads/th-1', json: DETAIL },
  ];
}

function renderApp(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('App view toggle (PROJECT.md §11 — never trapped; D32)', () => {
  it('switches Today → All projects → 3-pane → Memory → back to Today via the sidebar', async () => {
    const user = userEvent.setup();
    mockFetch(routes(settings('today')));
    renderApp(<App />);

    // Lands on Today.
    expect(await screen.findByText('What needs you, ranked by what you owe.')).toBeInTheDocument();

    // → All projects board (the resolved project name heads its section).
    await user.click(screen.getByRole('button', { name: 'All projects' }));
    expect(await screen.findByRole('heading', { name: 'Acme' })).toBeInTheDocument();

    // → 3-pane fallback (its reading-pane empty state is unique to the fallback).
    await user.click(screen.getByRole('button', { name: '3-pane' }));
    expect(await screen.findByText('Select a thread to read it here.')).toBeInTheDocument();

    // → Memory changelog.
    await user.click(screen.getByRole('button', { name: 'Memory' }));
    expect(await screen.findByRole('heading', { name: 'Memory' })).toBeInTheDocument();

    // → back to Today.
    await user.click(screen.getByRole('button', { name: 'Today' }));
    expect(await screen.findByText('What needs you, ranked by what you owe.')).toBeInTheDocument();
  });

  it('opening a thread from the board mounts the 7b work surface (no thread is unreachable)', async () => {
    const user = userEvent.setup();
    mockFetch(routes(settings('today')));
    renderApp(<App />);

    await user.click(screen.getByRole('button', { name: 'All projects' }));
    await user.click(await screen.findByText('Quarterly report'));

    // The 7b work surface is identified by its "Back to today" affordance (only it renders that).
    expect(await screen.findByRole('button', { name: /Back to today/ })).toBeInTheDocument();
  });
});

describe('App landing — flicker-free defaultView (D32)', () => {
  it('lands directly on the 3-pane when defaultView is "three-pane" without flashing Today first', async () => {
    mockFetch(routes(settings('three-pane')));
    renderApp(<App />);

    // The 3-pane reading-pane empty state appears…
    expect(await screen.findByText('Select a thread to read it here.')).toBeInTheDocument();
    // …and the Today header copy was NEVER rendered (no default→stored snap).
    expect(screen.queryByText('What needs you, ranked by what you owe.')).not.toBeInTheDocument();
  });

  it('does not render any main view until settings resolve (view is null first)', async () => {
    // Settings never resolve (pending) → the landing placeholder holds; no concrete view mounts.
    const pending = new Promise<never>(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/settings')) return pending; // hangs
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
        } as Response);
      }),
    );
    renderApp(<App />);

    // Neither the Today nor the 3-pane surface is shown while the landing view is unresolved.
    await waitFor(() => {
      expect(screen.queryByText('What needs you, ranked by what you owe.')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Select a thread to read it here.')).not.toBeInTheDocument();
  });
});
