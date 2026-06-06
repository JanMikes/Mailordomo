/**
 * LIGHT smoke (Implementer). The exhaustive digest suite is the separate test-author's; here we only
 * prove the morning digest view (PROJECT.md §9 / D34) renders the locally-synthesized PROSE + the four
 * metadata sections, that an empty section degrades to a quiet line, that a thread row escalates to the
 * 7b work surface (`nav.openThread` — no digest item is a dead end), and that the sidebar "Digest" item
 * switches the view. Body-free throughout (Golden rule #3): only subject/snippet/sender + metadata.
 */
import type { ReactElement } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

describe('DigestPage (smoke)', () => {
  it('renders the prose narrative, the window phrase, and all four metadata sections', async () => {
    mockFetch([{ url: '/api/digest', json: digestPayload() }]);
    renderPage(<DigestPage />);

    // Prose: blank-line-separated paragraphs render as readable text.
    expect(await screen.findByText('Good morning, Jan.')).toBeInTheDocument();
    expect(screen.getByText('Two threads need you today.')).toBeInTheDocument();

    // The window phrase is derived from window_start vs generated_at (deterministic — 1 day apart).
    expect(screen.getByText(/since yesterday morning/)).toBeInTheDocument();

    // The four labelled sections, each with its representative entry from the metadata.
    expect(screen.getByRole('heading', { name: 'What needs you today' })).toBeInTheDocument();
    expect(screen.getByText('Quarterly report')).toBeInTheDocument();

    expect(screen.getByRole('heading', { name: 'Promises due' })).toBeInTheDocument();
    expect(screen.getByText('Send the signed invoice')).toBeInTheDocument();

    expect(screen.getByRole('heading', { name: 'What Simona handled' })).toBeInTheDocument();
    expect(screen.getByText('Simona')).toBeInTheDocument(); // actor-attributed transition

    expect(screen.getByRole('heading', { name: 'What Claude drafted' })).toBeInTheDocument();
    expect(screen.getByText('Re: Pricing question')).toBeInTheDocument();
    expect(screen.getByText('opus')).toBeInTheDocument(); // draft model badge (metadata only)
  });

  it('degrades each empty section to a quiet line and notes the missing prose', async () => {
    mockFetch([
      {
        url: '/api/digest',
        json: digestPayload({ needs_you: [], promises_due: [], handled: [], drafted: [] }, ''),
      },
    ]);
    renderPage(<DigestPage />);

    // Empty prose → a calm note, not a blank space.
    expect(
      await screen.findByText('No written summary this morning — the highlights are below.'),
    ).toBeInTheDocument();

    // Each section still renders its heading + a single quiet empty line.
    expect(screen.getByText('Nothing needs you right now.')).toBeInTheDocument();
    expect(screen.getByText('No promises due.')).toBeInTheDocument();
    expect(screen.getByText('Nothing was handled while you were away.')).toBeInTheDocument();
    expect(screen.getByText('No new drafts.')).toBeInTheDocument();
  });

  it('clicking a thread row escalates to the 7b work surface (nav.openThread)', async () => {
    const openThread = vi.fn();
    const user = userEvent.setup();
    mockFetch([{ url: '/api/digest', json: digestPayload() }]);
    renderPage(<DigestPage />, { openThread });

    await user.click(await screen.findByText('Quarterly report'));
    expect(openThread).toHaveBeenCalledWith('th-needs');
  });
});

/* ---- nav: the sidebar "Digest" item switches the top-level view (App-level smoke) ---- */

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

describe('Digest nav (App-level smoke)', () => {
  it('switches to the digest view when the sidebar Digest item is clicked', async () => {
    const user = userEvent.setup();
    const routes: MockRoute[] = [
      { url: '/api/settings', json: settings() },
      { url: '/api/today', status: 503, json: { error: 'x' } },
      { url: '/api/digest', json: digestPayload() },
    ];
    mockFetch(routes);

    // Imported lazily so the module-level useWs mock + matchMedia polyfill are installed first.
    const { App } = await import('@/App');
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <App />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'Digest' }));

    // The digest view mounts: its sections + a representative entry appear.
    expect(
      await screen.findByRole('heading', { name: 'What needs you today' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Re: Pricing question')).toBeInTheDocument();
  });
});
