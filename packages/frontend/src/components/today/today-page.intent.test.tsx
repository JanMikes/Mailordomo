/**
 * INTENT (separate test-author) — `TodayPage` (PROJECT.md §11 / D29). Pins that, given a loaded
 * `TodayReadModel`, the page renders the 3-way metrics + done/remaining counts + the ranked do-next
 * cards (in array/rank order), and that the LOADING state shows skeletons rather than an error. The
 * data + socket hooks are mocked — a component test must not hit a real backend.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DoNextCard, TodayReadModel } from '@mailordomo/shared';

const tp = vi.hoisted(() => ({
  query: { data: undefined, isError: false, error: null, refetch: vi.fn() } as {
    data: TodayReadModel | undefined;
    isError: boolean;
    error: unknown;
    refetch: () => void;
  },
}));

vi.mock('@/lib/today-hooks', () => ({
  useTodayQuery: () => tp.query,
  useSettingsQuery: () => ({ data: undefined }),
  useUpdateSettings: () => ({ mutate: vi.fn(), isPending: false }),
  useMarkDone: () => ({ mutate: vi.fn(), isPending: false }),
  useSnooze: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/lib/useWs', () => ({ useWsToday: () => {} }));

import { TodayPage } from './today-page';

const NOW = '2026-06-05T12:00:00.000Z';

function card(threadId: string, subject: string): DoNextCard {
  return {
    threadId,
    subject,
    snippet: `snippet ${threadId}`,
    sender: `Petr <petr+${threadId}@acme.com>`,
    projectId: 'proj',
    projectName: 'Proj',
    state: 'needs-reply',
    importance: 'normal',
    deadline: null,
    followUpAt: null,
    lastActivityAt: NOW,
    promiseDirections: [],
    myPromiseUrgency: null,
    theyAskedUrgency: null,
    hasDraftReady: false,
    staleReason: null,
    ageMs: 0,
  };
}

const model: TodayReadModel = {
  generatedAt: NOW,
  projectId: 'proj',
  promiseMetrics: {
    myPromises: { total: 4, openCount: 2, overdueCount: 1 },
    theyAsked: { total: 3, openCount: 1, overdueCount: 0 },
    awaitingThem: { total: 2, openCount: 2, overdueCount: 1 },
  },
  taskCounts: { remaining: 6, done: 4 },
  doNext: [
    card('th-1', 'Alpha report'),
    card('th-2', 'Bravo invoice'),
    card('th-3', 'Charlie sync'),
    card('th-4', 'Delta review'),
  ],
};

function renderPage(): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <TodayPage />
    </QueryClientProvider>
  );
  return render(ui);
}

describe('TodayPage — loaded model', () => {
  it('renders the 3-way metrics, the counts, and one card per do-next entry in order', () => {
    tp.query = { data: model, isError: false, error: null, refetch: vi.fn() };
    const { container } = renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeInTheDocument();

    expect(screen.getByText('My promises')).toBeInTheDocument();
    expect(screen.getByText('They asked')).toBeInTheDocument();
    expect(screen.getByText('Awaiting them')).toBeInTheDocument();

    expect(container.textContent).toMatch(/6\s*remaining/);
    expect(container.textContent).toMatch(/4\s*done/);

    // One <h3> subject per card, in rank (array) order.
    const subjects = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(subjects).toEqual(['Alpha report', 'Bravo invoice', 'Charlie sync', 'Delta review']);
  });
});

describe('TodayPage — loading', () => {
  it('shows skeletons, not an error, while the query has no data yet', () => {
    tp.query = { data: undefined, isError: false, error: null, refetch: vi.fn() };
    const { container } = renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeInTheDocument();
    // Loading ≠ error, and content is not yet rendered.
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByText('My promises')).not.toBeInTheDocument();
    // Skeleton placeholders are present.
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });
});
