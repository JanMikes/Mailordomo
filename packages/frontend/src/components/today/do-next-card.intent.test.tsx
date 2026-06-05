/**
 * INTENT (separate test-author) — `DoNextCard` (PROJECT.md §8/§11 + Golden rule #1 + D29). ADDITIVE to
 * `do-next-card.test.tsx`. Pins the INLINE-ACTION WIRING and the send-proof surface:
 *  - "Mark done" fires the mark-done mutation with the thread id (a metadata transition);
 *  - "Snooze" fires the snooze mutation with the thread id;
 *  - the "Draft" control opens the 7b work surface with a draft request — it never sends from a card
 *    (Golden rule #1: sending is only ever an explicit click inside the work surface);
 *  - the card renders only metadata (subject/sender/state/draft-ready), never a message body.
 *
 * The card consumes the React Query mutation hooks internally (not callback props), so we mock
 * `@/lib/today-hooks` and assert the mutation `mutate` calls — i.e. the real action wiring. Navigation
 * goes through `NavContext`, so we provide a spy controller and assert `openThread`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DoNextCard as DoNextCardModel } from '@mailordomo/shared';

import { NavContext, type NavController } from '@/lib/navigation';

const hooks = vi.hoisted(() => ({
  markDone: vi.fn(),
  snooze: vi.fn(),
}));

vi.mock('@/lib/today-hooks', () => ({
  useMarkDone: () => ({ mutate: hooks.markDone, isPending: false }),
  useSnooze: () => ({ mutate: hooks.snooze, isPending: false }),
}));

import { DoNextCard } from './do-next-card';

const navSpy = vi.hoisted(() => ({ openThread: vi.fn() }));

function withNav(ui: React.ReactElement) {
  const controller: NavController = {
    view: 'today',
    selectedThreadId: null,
    draftOnOpen: false,
    openThread: navSpy.openThread,
    closeThread: vi.fn(),
    goTo: vi.fn(),
  };
  return <NavContext.Provider value={controller}>{ui}</NavContext.Provider>;
}

const card: DoNextCardModel = {
  threadId: 'th-42',
  subject: 'Quarterly report',
  snippet: 'SENSITIVE-BODY-LIKE-SNIPPET-do-not-render',
  sender: 'Petr Novák <petr@acme.com>',
  projectId: 'acme',
  projectName: 'Acme',
  state: 'needs-reply',
  importance: 'high',
  deadline: '2026-06-10T00:00:00.000Z',
  followUpAt: null,
  lastActivityAt: '2026-06-05T08:00:00.000Z',
  promiseDirections: ['my-promise', 'they-asked'],
  myPromiseUrgency: 'due-soon',
  theyAskedUrgency: 'dated',
  hasDraftReady: true,
  staleReason: null,
  ageMs: 3_600_000,
};

beforeEach(() => {
  hooks.markDone.mockReset();
  hooks.snooze.mockReset();
  navSpy.openThread.mockReset();
});

describe('DoNextCard — metadata surface (no body)', () => {
  it('renders subject/sender/state/draft-ready and never the snippet/body text', () => {
    render(<DoNextCard card={card} />);
    expect(screen.getByText('Quarterly report')).toBeInTheDocument();
    expect(screen.getByText('Petr Novák')).toBeInTheDocument();
    expect(screen.getByText('Needs reply')).toBeInTheDocument();
    expect(screen.getByText('Draft ready')).toBeInTheDocument();
    // The card is a do-next surface: it shows metadata, not message content.
    expect(screen.queryByText(card.snippet)).not.toBeInTheDocument();
  });
});

describe('DoNextCard — inline actions are metadata-only (Golden rule #1)', () => {
  it('"Mark done" fires the mark-done mutation with the thread id', async () => {
    const user = userEvent.setup();
    render(<DoNextCard card={card} />);
    await user.click(screen.getByRole('button', { name: 'Mark done' }));
    expect(hooks.markDone).toHaveBeenCalledTimes(1);
    expect(hooks.markDone).toHaveBeenCalledWith('th-42');
  });

  it('"Snooze" fires the snooze mutation with the thread id', async () => {
    const user = userEvent.setup();
    render(<DoNextCard card={card} />);
    await user.click(screen.getByRole('button', { name: 'Snooze' }));
    expect(hooks.snooze).toHaveBeenCalledTimes(1);
    expect(hooks.snooze).toHaveBeenCalledWith({ threadId: 'th-42' });
  });

  it('the "Draft" control opens the work surface with a draft request — and never sends', async () => {
    const user = userEvent.setup();
    render(withNav(<DoNextCard card={card} />));

    const draft = screen.getByRole('button', { name: 'Draft' });
    expect(draft).toBeEnabled();
    await user.click(draft);
    // Opening + requesting a draft is the ONLY effect — no metadata mutation, no send path.
    expect(navSpy.openThread).toHaveBeenCalledWith('th-42', { draft: true });
    expect(hooks.markDone).not.toHaveBeenCalled();
    expect(hooks.snooze).not.toHaveBeenCalled();

    expect(screen.getByRole('button', { name: 'Mark done' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Snooze' })).toBeEnabled();
  });
});
