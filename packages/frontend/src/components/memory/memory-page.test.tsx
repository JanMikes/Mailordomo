/**
 * SMOKE (implementer) — `MemoryPage` revert wiring (PROJECT.md §6; PLAN.md D28). Proves an applied
 * learning entry can be reverted behind the alert-dialog confirmation (which POSTs to
 * `…/learning/:id/revert`), and that the server-enforced LIFO refusal (409) surfaces as a calm,
 * guiding message rather than an error. The exhaustive suite is the separate test-author's.
 */
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { mockFetch } from '@/test/fetch-mock';
import { MemoryPage } from './memory-page';

const ENTRY = {
  id: 'l1',
  project_id: 'p1',
  scope: 'contact',
  summary: 'Sign off with “Cheers, Jan”.',
  applied_at: '2026-06-04T09:00:00.000Z',
  reverted_at: null,
};

function renderPage(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

async function openConfirmAndRevert(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Revert' }));
  const dialog = await screen.findByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: 'Revert' }));
}

describe('MemoryPage (smoke)', () => {
  it('confirming a revert posts to …/learning/:id/revert', async () => {
    const { calls } = mockFetch([
      { method: 'GET', url: '/learning', json: [ENTRY] },
      {
        method: 'POST',
        url: '/learning/l1/revert',
        json: { ...ENTRY, reverted_at: '2026-06-06T10:00:00.000Z' },
      },
    ]);
    const user = userEvent.setup();
    renderPage(<MemoryPage />);

    expect(await screen.findByText(ENTRY.summary)).toBeInTheDocument();
    await openConfirmAndRevert(user);

    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.includes('/learning/l1/revert')),
      ).toBeDefined(),
    );
  });

  it('a 409 LIFO refusal shows a calm guiding message', async () => {
    mockFetch([
      { method: 'GET', url: '/learning', json: [ENTRY] },
      {
        method: 'POST',
        url: '/learning/l1/revert',
        status: 409,
        json: { error: 'LIFO', code: 'conflict' },
      },
    ]);
    const user = userEvent.setup();
    renderPage(<MemoryPage />);

    await screen.findByText(ENTRY.summary);
    await openConfirmAndRevert(user);

    expect(
      await screen.findByText('Revert the most recent change to this file first.'),
    ).toBeInTheDocument();
  });
});
