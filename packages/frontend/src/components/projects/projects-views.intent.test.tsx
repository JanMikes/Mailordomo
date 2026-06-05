/**
 * INTENT (separate test-author) — the Phase 7c (D32) board + 3-pane RENDER behaviour, derived from
 * PROJECT.md §11 (all-projects/per-project = threads GROUPED BY state in the canonical order; the
 * classic 3-pane fallback so the user is NEVER trapped — a thread on the board must be reachable in the
 * fallback) + golden rule #3 (the only body fetch is the LOCAL `…/messages/:id/body` hop). ADDITIVE to
 * the implementer smokes (`projects-board-page.test.tsx`, `three-pane-page.test.tsx`).
 *
 * Mocked fetch + a stubbed nav controller; deterministic.
 */
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  TASK_STATES,
  type BoardThreadCard,
  type ProjectsBoard,
  type ThreadDetail,
} from '@mailordomo/shared';

import { NavContext, type NavController } from '@/lib/navigation';
import { findCall, mockFetch } from '@/test/fetch-mock';

// The board + 3-pane subscribe to the live-update socket; stub it (no real WebSocket in jsdom).
vi.mock('@/lib/useWs', () => ({ useWsToday: () => {} }));

import { ProjectsBoardPage } from './projects-board-page';
import { ThreePanePage } from '../three-pane/three-pane-page';

function groupsWith(
  overrides: Partial<Record<string, BoardThreadCard[]>>,
): Record<string, BoardThreadCard[]> {
  const out: Record<string, BoardThreadCard[]> = {};
  for (const s of TASK_STATES) out[s] = overrides[s] ?? [];
  return out;
}
function countsFrom(groups: Record<string, BoardThreadCard[]>): Record<string, number> {
  return Object.fromEntries(TASK_STATES.map((s) => [s, groups[s]?.length ?? 0]));
}

function card(threadId: string, subject: string, state: BoardThreadCard['state']): BoardThreadCard {
  return {
    threadId,
    subject,
    snippet: `snippet for ${subject}`,
    sender: 'Petr Novák <petr@acme.com>',
    state,
    importance: 'normal',
    deadline: null,
    followUpAt: null,
    lastActivityAt: '2026-06-05T08:00:00.000Z',
    hasDraftReady: false,
    promiseDirections: [],
  };
}

// A board with threads in THREE different states, declared out of canonical order on purpose.
const NEED = card('th-need', 'Needs reply thread', 'needs-reply');
const WAIT = card('th-wait', 'Waiting thread', 'waiting');
const DONE = card('th-done', 'Done thread', 'done');
const GROUPS = groupsWith({ waiting: [WAIT], done: [DONE], 'needs-reply': [NEED] });

const BOARD: ProjectsBoard = {
  generatedAt: '2026-06-06T09:00:00.000Z',
  projects: [
    {
      projectId: 'acme',
      projectName: 'Acme',
      groups: GROUPS,
      counts: countsFrom(GROUPS),
    } as ProjectsBoard['projects'][number],
  ],
};

function renderWithNav(ui: ReactElement, nav?: Partial<NavController>) {
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

describe('ProjectsBoardPage — grouping by state in canonical order (PROJECT.md §11/§6)', () => {
  it('renders the present state groups under their headers in needs-reply→waiting→done order', async () => {
    mockFetch([{ url: '/api/projects-board', json: BOARD }]);
    renderWithNav(<ProjectsBoardPage />);

    await screen.findByRole('heading', { name: 'Acme' });
    // Each present state's label appears; an empty state (drafted/follow-up) is omitted.
    expect(screen.getByText('Needs reply')).toBeInTheDocument();
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument(); // done is a real, rendered group (§6)
    expect(screen.queryByText('Drafted')).not.toBeInTheDocument();

    // The state-group LABELS appear left-to-right in the canonical order (DOM order).
    const labels = screen
      .getAllByText(/^(Needs reply|Drafted|Waiting|Follow-up|Done)$/)
      .map((el) => el.textContent);
    expect(labels).toEqual(['Needs reply', 'Waiting', 'Done']);

    // Each thread renders inside its own state column (subject under the right header).
    expect(screen.getByText('Needs reply thread')).toBeInTheDocument();
    expect(screen.getByText('Waiting thread')).toBeInTheDocument();
    expect(screen.getByText('Done thread')).toBeInTheDocument();
  });

  it('clicking a board card opens the 7b work surface for THAT thread (never unreachable)', async () => {
    const openThread = vi.fn();
    const user = userEvent.setup();
    mockFetch([{ url: '/api/projects-board', json: BOARD }]);
    renderWithNav(<ProjectsBoardPage />, { openThread });

    await user.click(await screen.findByText('Waiting thread'));
    expect(openThread).toHaveBeenCalledWith('th-wait');
  });
});

const DETAIL: ThreadDetail = {
  threadId: 'th-done',
  projectName: 'Acme',
  subject: 'Done thread',
  sender: 'Petr Novák <petr@acme.com>',
  snippet: 'snippet for Done thread',
  lastActivityAt: '2026-06-05T08:00:00.000Z',
  messages: [
    {
      messageId: 'msg-done',
      sender: 'Petr Novák <petr@acme.com>',
      date: '2026-06-05T08:00:00.000Z',
      subject: 'Done thread',
      snippet: 'snippet for Done thread',
    },
  ],
  pinnedSummary: 'A wrapped-up thread.',
  repoFreshness: null,
  lock: null,
};

describe('ThreePanePage — fallback never loses a thread (PROJECT.md §11)', () => {
  it('a thread that lives in a non-default state group is still reachable + reads via the LOCAL body hop', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { url: '/api/projects-board', json: BOARD },
      {
        url: '/api/threads/th-done/messages/msg-done/body',
        json: { body: 'The wrapped-up reply.' },
      },
      { url: '/api/threads/th-done', json: DETAIL },
    ]);
    renderWithNav(<ThreePanePage />, { view: 'three-pane' });

    // The fallback defaults to the FIRST non-empty state (needs-reply); the `done` thread is NOT yet
    // listed — but the user can reach it by selecting the Done state (no thread is trapped).
    const doneState = await screen.findByRole('button', { name: /Done\s*1/ });
    expect(doneState).toBeEnabled();
    await user.click(doneState);

    // MIDDLE: the done thread now lists; selecting it reads it on the RIGHT.
    await user.click(await screen.findByText('Done thread'));
    expect(await screen.findByText('A wrapped-up thread.')).toBeInTheDocument();

    // The ONLY body fetch is the local per-message `…/body` hop (golden rule #3).
    await waitFor(() => expect(screen.getByText('The wrapped-up reply.')).toBeInTheDocument());
    expect(findCall(calls, 'GET', '/threads/th-done/messages/msg-done/body')).toBeDefined();
    // No call to anything resembling a remote body endpoint.
    expect(calls.every((c) => !/metadata|:8/.test(c.url))).toBe(true);
  });

  it('escalating from the reading pane opens the SAME thread in the 7b work surface', async () => {
    const openThread = vi.fn();
    const user = userEvent.setup();
    mockFetch([
      { url: '/api/projects-board', json: BOARD },
      { url: '/api/threads/th-need/messages/msg-1/body', json: { body: 'b' } },
      {
        url: '/api/threads/th-need',
        json: { ...DETAIL, threadId: 'th-need', subject: 'Needs reply thread', messages: [] },
      },
    ]);
    renderWithNav(<ThreePanePage />, { view: 'three-pane', openThread });

    // The default selection is the first non-empty state (needs-reply) → its thread is listed.
    await user.click(await screen.findByText('Needs reply thread'));
    await user.click(await screen.findByRole('button', { name: 'Open in work surface' }));
    expect(openThread).toHaveBeenCalledWith('th-need');
  });
});

describe('left state list reflects the board counts', () => {
  it('shows every state with its count; empty states are present but disabled', async () => {
    mockFetch([{ url: '/api/projects-board', json: BOARD }]);
    renderWithNav(<ThreePanePage />, { view: 'three-pane' });

    // Populated states are enabled with their count…
    const waiting = await screen.findByRole('button', { name: /Waiting\s*1/ });
    expect(waiting).toBeEnabled();
    // …empty states render but are not selectable (count 0).
    const drafted = screen.getByRole('button', { name: /Drafted\s*0/ });
    expect(drafted).toBeDisabled();
  });
});
