/**
 * LIGHT smoke (Implementer). The exhaustive board suite is the separate test-author's; here we only
 * prove the page renders the project section, GROUPS threads by state under labelled headings in the
 * canonical order, and opens the 7b work surface when a thread card is clicked (so no board thread is
 * unreachable — Golden rule for the "never trapped" escape hatch / D32).
 */
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  TASK_STATES,
  type BoardCounts,
  type BoardGroups,
  type BoardThreadCard,
  type ProjectsBoard,
} from '@mailordomo/shared';

import { NavContext, type NavController } from '@/lib/navigation';
import { mockFetch } from '@/test/fetch-mock';

// The board subscribes to the same live-update socket as Today; stub it (no real WebSocket in jsdom).
vi.mock('@/lib/useWs', () => ({ useWsToday: () => {} }));

import { ProjectsBoardPage } from './projects-board-page';

/** Every-state-key-present empty groups (the contract guarantees all keys; double-cast asserts that). */
function emptyGroups(): BoardGroups {
  return Object.fromEntries(TASK_STATES.map((s) => [s, []])) as unknown as BoardGroups;
}
function zeroCounts(): BoardCounts {
  return Object.fromEntries(TASK_STATES.map((s) => [s, 0])) as unknown as BoardCounts;
}

function card(threadId: string, subject: string): BoardThreadCard {
  return {
    threadId,
    subject,
    snippet: `snippet for ${subject}`,
    sender: 'Petr Novák <petr@acme.com>',
    state: 'needs-reply',
    importance: 'normal',
    deadline: null,
    followUpAt: null,
    lastActivityAt: '2026-06-05T08:00:00.000Z',
    hasDraftReady: false,
    promiseDirections: [],
  };
}

const BOARD: ProjectsBoard = {
  generatedAt: '2026-06-06T09:00:00.000Z',
  projects: [
    {
      projectId: 'acme',
      projectName: 'Acme',
      groups: {
        ...emptyGroups(),
        'needs-reply': [{ ...card('th-1', 'Quarterly report'), state: 'needs-reply' }],
        waiting: [{ ...card('th-2', 'Invoice follow-up'), state: 'waiting' }],
      },
      counts: { ...zeroCounts(), 'needs-reply': 1, waiting: 1 },
    },
  ],
};

function renderBoard(ui: ReactElement, nav?: Partial<NavController>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const controller: NavController = {
    view: 'all-projects',
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

describe('ProjectsBoardPage (smoke)', () => {
  it('renders the project section with threads grouped by state under state headings', async () => {
    mockFetch([{ url: '/api/projects-board', json: BOARD }]);
    renderBoard(<ProjectsBoardPage />);

    // The resolved project name heads the section (not the raw id).
    expect(await screen.findByRole('heading', { name: 'Acme' })).toBeInTheDocument();
    // Non-empty state groups appear as labelled columns; empty ones are omitted.
    expect(screen.getByText('Needs reply')).toBeInTheDocument();
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    expect(screen.queryByText('Drafted')).not.toBeInTheDocument();
    // The threads render under their groups.
    expect(screen.getByText('Quarterly report')).toBeInTheDocument();
    expect(screen.getByText('Invoice follow-up')).toBeInTheDocument();
  });

  it('clicking a thread card opens the 7b work surface (board → work surface)', async () => {
    const openThread = vi.fn();
    const user = userEvent.setup();
    mockFetch([{ url: '/api/projects-board', json: BOARD }]);
    renderBoard(<ProjectsBoardPage />, { openThread });

    await user.click(await screen.findByText('Quarterly report'));
    expect(openThread).toHaveBeenCalledWith('th-1');
  });
});
