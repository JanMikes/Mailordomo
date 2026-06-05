/**
 * LIGHT smoke (Implementer). The load-bearing do-next-card suite — every metadata field, the
 * urgency/stale rendering — is the separate test-author's. Here we only prove the card renders its
 * core fields and that the Open thread / Draft actions open the 7b split work surface via the nav
 * controller (Draft also kicks off a draft). Sending is never reachable from a card (Golden rule #1).
 */
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DoNextCard as DoNextCardModel } from '@mailordomo/shared';

import { NavContext, type NavController } from '@/lib/navigation';
import { DoNextCard } from './do-next-card';

const sampleCard: DoNextCardModel = {
  threadId: 'th-1',
  subject: 'Quarterly report',
  snippet: 'Please send the quarterly report by Friday',
  sender: 'Petr Novák <petr@acme.com>',
  projectId: 'acme',
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

function renderCard(ui: ReactElement, nav?: Partial<NavController>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const controller: NavController = {
    view: 'today',
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

describe('DoNextCard (smoke)', () => {
  it('renders without crashing and shows its core metadata fields', () => {
    renderCard(<DoNextCard card={sampleCard} />);
    expect(screen.getByText('Quarterly report')).toBeInTheDocument();
    expect(screen.getByText('Petr Novák')).toBeInTheDocument();
    expect(screen.getByText('acme')).toBeInTheDocument();
    expect(screen.getByText('Needs reply')).toBeInTheDocument();
    expect(screen.getByText('Draft ready')).toBeInTheDocument();
  });

  it('Open thread / Draft open the work surface (Draft kicks off a draft); other actions stay active', async () => {
    const openThread = vi.fn();
    const user = userEvent.setup();
    renderCard(<DoNextCard card={sampleCard} />, { openThread });

    await user.click(screen.getByRole('button', { name: 'Open thread' }));
    expect(openThread).toHaveBeenCalledWith('th-1');

    await user.click(screen.getByRole('button', { name: 'Draft' }));
    expect(openThread).toHaveBeenCalledWith('th-1', { draft: true });

    expect(screen.getByRole('button', { name: 'Mark done' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Snooze' })).toBeEnabled();
  });
});
