/**
 * INTENT (separate test-author) — the split work surface (PROJECT.md §11 + §6; PLAN.md D27/D31).
 * ADDITIVE to `work-surface.test.tsx` (the implementer's smoke). Hardens the load-bearing behavior:
 *  - SUMMARY PINNING: Claude's pinned summary renders at the top of the LEFT pane; a null summary is
 *    graceful (no crash).
 *  - LOCK LIFECYCLE (presence, D27): acquire on open; a CONTENDED lock (`acquired:false`) shows the
 *    holder in a read-only presence banner AND disables Send; release on unmount.
 *  - Sending is never auto-fired on open — the surface posts to `…/send` only on an explicit click.
 */
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { mockFetch, type RecordedCall } from '@/test/fetch-mock';
import { WorkSurface } from './work-surface';

const SETTINGS = {
  waitingStaleDays: 3,
  needsReplyStaleDays: 2,
  lockTimeoutMinutes: 30,
  colorScheme: 'system',
};

function detail(overrides: Record<string, unknown> = {}) {
  return {
    threadId: 't1',
    projectName: null,
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
    ...overrides,
  };
}

const ACQUIRED = {
  acquired: true,
  lock: {
    thread_id: 't1',
    locked_by: 'me',
    locked_at: '2026-06-05T08:00:00.000Z',
    expires_at: '2026-06-05T08:30:00.000Z',
  },
};

/** Another actor (Simona) already holds the lock — acquire returns acquired:false + the holder. */
const CONTENDED = {
  acquired: false,
  lock: {
    thread_id: 't1',
    locked_by: 'simona',
    locked_at: '2026-06-05T08:00:00.000Z',
    expires_at: '2026-06-05T09:00:00.000Z',
  },
};

function routes(opts: { detail?: Record<string, unknown>; acquire?: unknown }) {
  // Order matters: the more-specific GET (…/draft) precedes the generic GET (…/t1).
  return [
    { method: 'GET', url: '/threads/t1/draft', status: 404, json: { error: 'no draft' } },
    { method: 'GET', url: '/threads/t1', json: detail(opts.detail) },
    { method: 'POST', url: '/lock/acquire', json: opts.acquire ?? ACQUIRED },
    { method: 'POST', url: '/lock/release', json: { released: true } },
    { method: 'GET', url: '/settings', json: SETTINGS },
  ];
}

function renderSurface(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function sendCalls(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === 'POST' && c.url.endsWith('/send'));
}

describe('WorkSurface — summary pinning (left pane)', () => {
  it("renders Claude's pinned summary at the top", async () => {
    mockFetch([...routes({})]);
    renderSurface(<WorkSurface threadId="t1" autoDraft={false} onClose={() => {}} />);
    expect(await screen.findByText('Petr is asking about the invoice.')).toBeInTheDocument();
    // It is labeled as the summary block.
    expect(screen.getByText('Summary')).toBeInTheDocument();
  });

  it('a null pinned summary degrades gracefully (no crash, an unavailable note)', async () => {
    mockFetch([...routes({ detail: { pinnedSummary: null } })]);
    renderSurface(<WorkSurface threadId="t1" autoDraft={false} onClose={() => {}} />);
    // The thread still renders; the summary slot shows the graceful fallback.
    expect(await screen.findByRole('heading', { name: 'Re: invoice' })).toBeInTheDocument();
    expect(screen.getByText('Summary unavailable.')).toBeInTheDocument();
  });
});

describe('WorkSurface — lock lifecycle (presence, D27)', () => {
  it('acquires the thread lock on open', async () => {
    const { calls } = mockFetch([...routes({})]);
    renderSurface(<WorkSurface threadId="t1" autoDraft={false} onClose={() => {}} />);
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.includes('/lock/acquire')),
      ).toBeDefined(),
    );
  });

  it('a CONTENDED lock shows the holder in a presence banner and DISABLES Send', async () => {
    mockFetch([...routes({ acquire: CONTENDED })]);
    renderSurface(<WorkSurface threadId="t1" autoDraft={false} onClose={() => {}} />);

    // The read-only presence banner names the holder.
    expect(await screen.findByText(/Editing and sending are paused/)).toBeInTheDocument();
    expect(screen.getByText('simona')).toBeInTheDocument();

    // With no draft yet, the on-signal "Draft reply" control is disabled (cannot write while contended).
    const draftBtn = await screen.findByRole('button', { name: 'Draft reply' });
    expect(draftBtn).toBeDisabled();
    expect(screen.getByText('Another person holds this thread right now.')).toBeInTheDocument();
  });

  it('releases the lock on unmount (the held lock is freed)', async () => {
    const { calls } = mockFetch([...routes({})]);
    const { unmount } = renderSurface(
      <WorkSurface threadId="t1" autoDraft={false} onClose={() => {}} />,
    );
    // Wait until we actually HOLD the lock (otherwise unmount has nothing to release).
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.includes('/lock/acquire')),
      ).toBeDefined(),
    );

    unmount();

    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.includes('/lock/release')),
      ).toBeDefined(),
    );
    // The surface never auto-sent anything.
    expect(sendCalls(calls)).toHaveLength(0);
  });

  it('a CONTENDED open never releases a lock it does not hold (no spurious release)', async () => {
    const { calls } = mockFetch([...routes({ acquire: CONTENDED })]);
    const { unmount } = renderSurface(
      <WorkSurface threadId="t1" autoDraft={false} onClose={() => {}} />,
    );
    await screen.findByText(/Editing and sending are paused/);
    unmount();
    // We did not hold the lock, so we must not POST release (that would steal Simona's lock).
    await vi.waitFor(() => {
      expect(
        calls.find((c) => c.method === 'POST' && c.url.includes('/lock/release')),
      ).toBeUndefined();
    });
  });
});
