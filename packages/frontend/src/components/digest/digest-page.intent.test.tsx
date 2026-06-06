/**
 * DigestPage INTENT coverage (separate test-author, fresh context — PLAN.md §4.4). Derived from
 * PROJECT.md §9 + Golden rules #3 (body-free) and #1 (no send path in the digest) FIRST:
 *
 *   - the view renders the locally-synthesized PROSE narrative + ALL FOUR metadata sections from a
 *     mocked `/api/digest`;
 *   - an EMPTY section degrades to a single quiet line (it does not vanish);
 *   - a thread ROW escalates to the 7b work surface (`nav.openThread(threadId)`) — read-only, no send;
 *   - the sidebar "Digest" NAV item switches the top-level view.
 *
 * RTL: async assertions are `await`ed via `findBy*` / `waitFor` (never read the instant an element
 * mounts). ADDITIVE to `digest-page.test.tsx`.
 */
import type { ReactElement } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AppSettings, DigestMetadata } from '@mailordomo/shared';

import { NavContext, type NavController } from '@/lib/navigation';
import { mockFetch, type MockRoute } from '@/test/fetch-mock';

import { DigestPage } from './digest-page';

function meta(overrides: Partial<DigestMetadata> = {}): DigestMetadata {
  return {
    project_id: 'acme',
    generated_at: '2026-06-06T07:30:00.000Z',
    window_start: '2026-06-05T07:30:00.000Z',
    window_end: '2026-06-06T07:30:00.000Z',
    needs_you: [
      {
        thread_id: 'th-needs',
        project_id: 'acme',
        subject: 'Quarterly report',
        snippet: 'Please send the quarterly report',
        sender: 'Petr Novák <petr@acme.com>',
        state: 'needs-reply',
        importance: 'high',
        deadline: '2026-06-06T16:00:00.000Z',
      },
    ],
    promises_due: [
      {
        promise_id: 'pr-1',
        thread_id: 'th-promise',
        subject: 'Invoice',
        direction: 'my-promise',
        text: 'Send the signed invoice',
        due_at: '2026-06-06T12:00:00.000Z',
        status: 'open',
      },
    ],
    handled: [
      {
        task_id: 'tk-1',
        thread_id: 'th-handled',
        subject: 'Newsletter cleanup',
        from: 'needs-reply',
        to: 'done',
        actor: 'simona',
        at: '2026-06-06T06:00:00.000Z',
      },
    ],
    drafted: [
      {
        thread_id: 'th-draft',
        subject: 'Re: Pricing question',
        model: 'opus',
        author: 'claude',
        at: '2026-06-06T05:30:00.000Z',
      },
    ],
    ...overrides,
  };
}

function digestPayload(
  overrides: Partial<DigestMetadata> = {},
  prose = 'Good morning, Jan.\n\nTwo threads need you today.',
) {
  return { metadata: meta(overrides), prose };
}

function renderPage(ui: ReactElement, nav?: Partial<NavController>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const controller: NavController = {
    view: 'digest',
    selectedThreadId: null,
    draftOnOpen: false,
    openThread: vi.fn(),
    closeThread: vi.fn(),
    goTo: vi.fn(),
    ...nav,
  };
  return render(
    <QueryClientProvider client={client}>
      <NavContext.Provider value={controller}>{ui}</NavContext.Provider>
    </QueryClientProvider>,
  );
}

describe('DigestPage (intent) — renders prose + four sections from /api/digest', () => {
  it('renders the prose paragraphs and every section header + a representative row', async () => {
    mockFetch([{ url: '/api/digest', json: digestPayload() }]);
    renderPage(<DigestPage />);

    // Prose: blank-line-split paragraphs become readable text (await the first to resolve the fetch).
    expect(await screen.findByText('Good morning, Jan.')).toBeInTheDocument();
    expect(screen.getByText('Two threads need you today.')).toBeInTheDocument();

    // All four sections, each surfacing its body-free entry (subject/sender/model/actor — never a body).
    expect(screen.getByRole('heading', { name: 'What needs you today' })).toBeInTheDocument();
    expect(screen.getByText('Quarterly report')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Promises due' })).toBeInTheDocument();
    expect(screen.getByText('Send the signed invoice')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What Simona handled' })).toBeInTheDocument();
    expect(screen.getByText('Simona')).toBeInTheDocument(); // actor attribution
    expect(screen.getByRole('heading', { name: 'What Claude drafted' })).toBeInTheDocument();
    expect(screen.getByText('Re: Pricing question')).toBeInTheDocument();
    expect(screen.getByText('opus')).toBeInTheDocument(); // model badge = metadata only
  });

  it('an empty section degrades to one quiet line (it does not vanish), and empty prose notes itself', async () => {
    mockFetch([
      {
        url: '/api/digest',
        json: digestPayload({ needs_you: [], promises_due: [], handled: [], drafted: [] }, ''),
      },
    ]);
    renderPage(<DigestPage />);

    expect(
      await screen.findByText('No written summary this morning — the highlights are below.'),
    ).toBeInTheDocument();
    // Headings still render; each section shows its quiet empty line rather than disappearing.
    expect(screen.getByRole('heading', { name: 'What needs you today' })).toBeInTheDocument();
    expect(screen.getByText('Nothing needs you right now.')).toBeInTheDocument();
    expect(screen.getByText('No promises due.')).toBeInTheDocument();
    expect(screen.getByText('Nothing was handled while you were away.')).toBeInTheDocument();
    expect(screen.getByText('No new drafts.')).toBeInTheDocument();
  });

  it('clicking a thread row escalates to the 7b work surface with that thread id (read-only)', async () => {
    const openThread = vi.fn();
    const user = userEvent.setup();
    mockFetch([{ url: '/api/digest', json: digestPayload() }]);
    renderPage(<DigestPage />, { openThread });

    // The needs-you row's subject is a clean standalone node — clicking it opens that thread.
    await user.click(await screen.findByText('Quarterly report'));
    expect(openThread).toHaveBeenCalledWith('th-needs');
    expect(openThread).toHaveBeenCalledTimes(1);
  });
});

/* ---- nav: the sidebar "Digest" item switches the top-level view (App-level) ---- */

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

// Today + the board subscribe to the live-update socket; stub it (no real WebSocket in jsdom).
vi.mock('@/lib/useWs', () => ({ useWsToday: () => {} }));

function settings(): AppSettings {
  return {
    waitingStaleDays: 3,
    needsReplyStaleDays: 2,
    lockTimeoutMinutes: 30,
    colorScheme: 'system',
    defaultView: 'today',
  };
}

describe('Digest nav (intent) — the sidebar item switches the view', () => {
  it('clicking "Digest" mounts the digest view (its sections appear)', async () => {
    const user = userEvent.setup();
    const routes: MockRoute[] = [
      { url: '/api/settings', json: settings() },
      { url: '/api/today', status: 503, json: { error: 'x' } },
      { url: '/api/digest', json: digestPayload() },
    ];
    mockFetch(routes);

    const { App } = await import('@/App');
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <App />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'Digest' }));

    // waitFor the digest view to mount (don't read the instant the nav click fires).
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'What needs you today' })).toBeInTheDocument(),
    );
    expect(screen.getByText('Re: Pricing question')).toBeInTheDocument();
  });
});
