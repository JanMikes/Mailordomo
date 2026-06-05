/**
 * INTENT (separate test-author) — the Memory / learning changelog revert UI (PROJECT.md §6 "review and
 * revert"; PLAN.md D28). ADDITIVE to `memory-page.test.tsx` (the implementer's smoke). Hardens:
 *  - the alert-dialog CONFIRM (not the trigger) is what POSTs to `…/learning/:id/revert`;
 *  - a 409 LIFO refusal renders a CALM guiding message, NOT an alarming error;
 *  - an already-reverted entry shows as reverted and offers NO revert action;
 *  - cancelling the dialog posts nothing.
 */
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { mockFetch, type RecordedCall } from '@/test/fetch-mock';
import { MemoryPage } from './memory-page';

const APPLIED = {
  id: 'l1',
  project_id: 'p1',
  scope: 'contact',
  summary: 'Sign off with “Cheers, Jan”.',
  applied_at: '2026-06-04T09:00:00.000Z',
  reverted_at: null,
};

const REVERTED = {
  id: 'l0',
  project_id: 'p1',
  scope: 'mailbox',
  summary: 'An older lesson that was already undone.',
  applied_at: '2026-06-02T09:00:00.000Z',
  reverted_at: '2026-06-03T09:00:00.000Z',
};

function renderPage(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function revertCalls(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === 'POST' && c.url.includes('/learning/l1/revert'));
}

describe('MemoryPage — revert is confirmed behind the alert dialog', () => {
  it('confirming the dialog POSTs to …/learning/:id/revert (the trigger alone does not)', async () => {
    const { calls } = mockFetch([
      { method: 'GET', url: '/learning', json: [APPLIED] },
      {
        method: 'POST',
        url: '/learning/l1/revert',
        json: { ...APPLIED, reverted_at: '2026-06-06T10:00:00.000Z' },
      },
    ]);
    const user = userEvent.setup();
    renderPage(<MemoryPage />);

    await screen.findByText(APPLIED.summary);
    // Opening the dialog does NOT post yet.
    await user.click(screen.getByRole('button', { name: 'Revert' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(revertCalls(calls)).toHaveLength(0);

    // Confirming inside the dialog is what fires the revert.
    await user.click(within(dialog).getByRole('button', { name: 'Revert' }));
    await waitFor(() => expect(revertCalls(calls)).toHaveLength(1));
    expect(revertCalls(calls)[0]?.body).toEqual({});
  });

  it('cancelling the dialog posts nothing', async () => {
    const { calls } = mockFetch([{ method: 'GET', url: '/learning', json: [APPLIED] }]);
    const user = userEvent.setup();
    renderPage(<MemoryPage />);

    await screen.findByText(APPLIED.summary);
    await user.click(screen.getByRole('button', { name: 'Revert' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(revertCalls(calls)).toHaveLength(0);
  });
});

describe('MemoryPage — a 409 LIFO refusal is calm guidance, not an error', () => {
  it('renders the "revert the most recent change first" message on 409', async () => {
    mockFetch([
      { method: 'GET', url: '/learning', json: [APPLIED] },
      {
        method: 'POST',
        url: '/learning/l1/revert',
        status: 409,
        json: { error: 'LIFO: revert the most recently applied lesson first', code: 'conflict' },
      },
    ]);
    const user = userEvent.setup();
    renderPage(<MemoryPage />);

    await screen.findByText(APPLIED.summary);
    await user.click(screen.getByRole('button', { name: 'Revert' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Revert' }));

    // The calm, guiding message — NOT the raw server error string.
    expect(
      await screen.findByText('Revert the most recent change to this file first.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('LIFO: revert the most recently applied lesson first'),
    ).not.toBeInTheDocument();
  });
});

describe('MemoryPage — already-reverted entries offer no revert', () => {
  it('shows a reverted badge and no Revert button for a reverted entry', async () => {
    mockFetch([{ method: 'GET', url: '/learning', json: [REVERTED] }]);
    renderPage(<MemoryPage />);

    expect(await screen.findByText(REVERTED.summary)).toBeInTheDocument();
    expect(screen.getByText(/^Reverted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revert' })).not.toBeInTheDocument();
  });
});
