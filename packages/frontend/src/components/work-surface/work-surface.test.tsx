/**
 * SMOKE (implementer) — `WorkSurface` mount (PROJECT.md §11; PLAN.md §7 Phase 7b / D31). Proves the
 * surface mounts, ACQUIRES THE THREAD LOCK on open (presence — D27), renders Claude's pinned summary
 * on the left, and that the back action returns to Today. The exhaustive suite is the test-author's.
 */
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { mockFetch } from '@/test/fetch-mock';
import { WorkSurface } from './work-surface';

const SETTINGS = {
  waitingStaleDays: 3,
  needsReplyStaleDays: 2,
  lockTimeoutMinutes: 30,
  colorScheme: 'system',
};

const DETAIL = {
  threadId: 't1',
  subject: 'Re: invoice',
  sender: 'Petr Novák <petr@acme.com>',
  snippet: 'about the invoice',
  lastActivityAt: '2026-06-05T08:00:00.000Z',
  messages: [
    {
      messageId: '<m1@acme.com>',
      sender: 'Petr Novák <petr@acme.com>',
      date: '2026-06-05T08:00:00.000Z',
      subject: 'Re: invoice',
      snippet: 'about the invoice',
    },
  ],
  pinnedSummary: 'Petr is asking about the invoice.',
  repoFreshness: null,
  lock: null,
};

const ACQUIRED = {
  acquired: true,
  lock: {
    thread_id: 't1',
    locked_by: 'me',
    locked_at: '2026-06-05T08:00:00.000Z',
    expires_at: '2026-06-05T08:30:00.000Z',
  },
};

function routes() {
  // Order matters: the more-specific GET (…/draft) precedes the generic GET (…/t1).
  return [
    { method: 'GET', url: '/threads/t1/draft', status: 404, json: { error: 'no draft' } },
    { method: 'GET', url: '/threads/t1', json: DETAIL },
    { method: 'POST', url: '/lock/acquire', json: ACQUIRED },
    { method: 'POST', url: '/lock/release', json: { released: true } },
    { method: 'GET', url: '/settings', json: SETTINGS },
  ] as const;
}

function renderSurface(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('WorkSurface (smoke)', () => {
  it('mounts, acquires the lock, and shows the pinned summary', async () => {
    const { calls } = mockFetch([...routes()]);
    renderSurface(<WorkSurface threadId="t1" autoDraft={false} onClose={() => {}} />);

    expect(await screen.findByText('Petr is asking about the invoice.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Re: invoice' })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.includes('/lock/acquire')),
      ).toBeDefined(),
    );
  });

  it('the back action returns to Today', async () => {
    mockFetch([...routes()]);
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderSurface(<WorkSurface threadId="t1" autoDraft={false} onClose={onClose} />);

    await user.click(await screen.findByRole('button', { name: 'Back to today' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
