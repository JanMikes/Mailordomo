/**
 * LIGHT smoke (Implementer). The exhaustive 3-pane suite is the separate test-author's; here we only
 * prove the fallback's core flow (D32): the left column lists task states with counts, selecting a
 * state lists its threads in the middle, clicking a thread reads it in the right pane REUSING the 7b
 * ThreadPane + the per-message LOCAL `…/body` hop (golden rule #3 — the only body fetch), and the
 * "Open in work surface" action escalates to the 7b work surface (so drafting still flows through 7b
 * and no thread is unreachable).
 */
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  TASK_STATES,
  type BoardCounts,
  type BoardGroups,
  type BoardThreadCard,
  type ProjectsBoard,
  type ThreadDetail,
} from '@mailordomo/shared';

import { NavContext, type NavController } from '@/lib/navigation';
import { findCall, mockFetch } from '@/test/fetch-mock';

// The 3-pane subscribes to the live-update socket; stub it (no real WebSocket in jsdom).
vi.mock('@/lib/useWs', () => ({ useWsToday: () => {} }));

import { ThreePanePage } from './three-pane-page';

/** Every-state-key-present empty groups (the contract guarantees all keys; double-cast asserts that). */
function emptyGroups(): BoardGroups {
  return Object.fromEntries(TASK_STATES.map((s) => [s, []])) as unknown as BoardGroups;
}
function zeroCounts(): BoardCounts {
  return Object.fromEntries(TASK_STATES.map((s) => [s, 0])) as unknown as BoardCounts;
}

const THREAD: BoardThreadCard = {
  threadId: 'th-1',
  subject: 'Quarterly report',
  snippet: 'Please send the quarterly report by Friday',
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
    },
  ],
};

const DETAIL: ThreadDetail = {
  threadId: 'th-1',
  projectName: 'Acme',
  subject: 'Quarterly report',
  sender: 'Petr Novák <petr@acme.com>',
  snippet: 'Please send the quarterly report by Friday',
  lastActivityAt: '2026-06-05T08:00:00.000Z',
  messages: [
    {
      messageId: 'msg-1',
      sender: 'Petr Novák <petr@acme.com>',
      date: '2026-06-05T08:00:00.000Z',
      subject: 'Quarterly report',
      snippet: 'Please send the quarterly report by Friday',
    },
  ],
  pinnedSummary: 'Petr is asking for the Q2 report.',
  repoFreshness: null,
  lock: null,
};

function renderPane(ui: ReactElement, nav?: Partial<NavController>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const controller: NavController = {
    view: 'three-pane',
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

describe('ThreePanePage (smoke)', () => {
  it('lists states with counts, lists threads for the selected state, and reads a thread via the local body hop', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { url: '/api/projects-board', json: BOARD },
      { url: '/api/threads/th-1/messages/msg-1/body', json: { body: 'Hi, the report please.' } },
      { url: '/api/threads/th-1', json: DETAIL },
    ]);
    renderPane(<ThreePanePage />);

    // LEFT: the state list shows the states; the non-empty one is selectable with its count.
    const needsReply = await screen.findByRole('button', { name: /Needs reply\s*1/ });
    expect(needsReply).toBeEnabled();

    // MIDDLE: the selected state's thread is listed (subject + sender).
    expect(await screen.findByText('Quarterly report')).toBeInTheDocument();

    // Click the thread → RIGHT reading pane shows the pinned 7b summary…
    await user.click(screen.getByText('Quarterly report'));
    expect(await screen.findByText('Petr is asking for the Q2 report.')).toBeInTheDocument();

    // …and the rendered body arrives via the LOCAL per-message body hop (the only body fetch).
    await waitFor(() => expect(screen.getByText('Hi, the report please.')).toBeInTheDocument());
    expect(findCall(calls, 'GET', '/threads/th-1/messages/msg-1/body')).toBeDefined();
  });

  it('"Open in work surface" escalates the selected thread to the 7b work surface', async () => {
    const openThread = vi.fn();
    const user = userEvent.setup();
    mockFetch([
      { url: '/api/projects-board', json: BOARD },
      { url: '/api/threads/th-1/messages/msg-1/body', json: { body: 'body' } },
      { url: '/api/threads/th-1', json: DETAIL },
    ]);
    renderPane(<ThreePanePage />, { openThread });

    await user.click(await screen.findByText('Quarterly report'));
    await user.click(await screen.findByRole('button', { name: 'Open in work surface' }));
    expect(openThread).toHaveBeenCalledWith('th-1');
  });
});
