/**
 * LIGHT smoke (Implementer B). The load-bearing do-next-card suite — action wiring, every metadata
 * field, the urgency/stale rendering — is the separate test-author's. Here we only prove the card
 * renders its core fields and that the Draft affordance is an inert, disabled stub (Golden rule #1:
 * no send path in 7a).
 */
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DoNextCard as DoNextCardModel } from '@mailordomo/shared';

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

function renderWithProviders(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('DoNextCard (smoke)', () => {
  it('renders without crashing and shows its core metadata fields', () => {
    renderWithProviders(<DoNextCard card={sampleCard} />);
    expect(screen.getByText('Quarterly report')).toBeInTheDocument();
    expect(screen.getByText('Petr Novák')).toBeInTheDocument();
    expect(screen.getByText('acme')).toBeInTheDocument();
    expect(screen.getByText('Needs reply')).toBeInTheDocument();
    expect(screen.getByText('Draft ready')).toBeInTheDocument();
  });

  it('renders Draft as a disabled stub while Mark done / Snooze stay active', () => {
    renderWithProviders(<DoNextCard card={sampleCard} />);
    expect(screen.getByRole('button', { name: 'Draft' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Snooze' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Open thread' })).toBeEnabled();
  });
});
