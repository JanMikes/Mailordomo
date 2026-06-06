/**
 * INTENT (separate test-author) — `MailboxList` (Phase 9 / D35), the manage-half of setup. Drives the
 * REAL `useMailboxes` + `useDeleteMailbox` hooks → the REAL api client → a mocked `fetch`, so the
 * render, the confirm-then-DELETE flow, and the secret-free presentation are all exercised end-to-end.
 *
 * The intended contract:
 *   - a connected mailbox renders its address, IMAP/SMTP host, and credential PRESENCE ticks (never a
 *     secret — Golden rule #4: there is no secret to render, only booleans);
 *   - Remove is a TWO-STEP action: the first click only ARMS a confirm; DELETE fires only on confirm;
 *   - the empty state shows the "No mailboxes connected yet" copy.
 */
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MailboxConfigResponse } from '@mailordomo/shared';

import { findCall, mockFetch } from '@/test/fetch-mock';
import { MailboxList } from './mailbox-list';

const MAILBOX: MailboxConfigResponse = {
  mailbox: {
    id: 'mb1',
    projectId: 'p1',
    address: 'jan@me.com',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true, user: 'jan@me.com' },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, user: 'jan@me.com' },
  },
  credentials: { imap: true, smtp: false },
};

function renderWith(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function listRoute(mailboxes: MailboxConfigResponse[]) {
  return { method: 'GET', url: '/wizard/mailboxes', json: { mailboxes } } as const;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MailboxList — rendering a connected mailbox', () => {
  it('shows the address, the IMAP/SMTP host, and the credential presence ticks', async () => {
    mockFetch([listRoute([MAILBOX])]);
    renderWith(<MailboxList />);

    expect(await screen.findByText('jan@me.com')).toBeInTheDocument();
    // The transport endpoints are surfaced (host shown for both IMAP + SMTP).
    expect(screen.getByText(/imap\.mail\.me\.com/)).toBeInTheDocument();
    expect(screen.getByText(/smtp\.mail\.me\.com/)).toBeInTheDocument();
    // Presence is shown as ticks (Golden rule #4 — booleans, never the secret):
    // imap present → "set", smtp absent → "not set".
    expect(screen.getByText('IMAP password set')).toBeInTheDocument();
    expect(screen.getByText('SMTP password not set')).toBeInTheDocument();
  });
});

describe('MailboxList — Remove requires a confirm before it DELETEs', () => {
  it('the first Remove click only arms the confirm; DELETE fires on "Confirm remove"', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      listRoute([MAILBOX]),
      {
        method: 'DELETE',
        url: '/wizard/mailboxes/mb1',
        status: 200,
        json: { id: 'mb1', removed: true },
      },
    ]);
    renderWith(<MailboxList />);

    await screen.findByText('jan@me.com');

    // First click: ARM only — no DELETE yet.
    await user.click(screen.getByRole('button', { name: /^Remove$/ }));
    expect(findCall(calls, 'DELETE', '/wizard/mailboxes/mb1')).toBeUndefined();
    // A confirm affordance appears.
    expect(screen.getByRole('button', { name: /Confirm remove/ })).toBeInTheDocument();

    // Confirm: NOW the DELETE fires.
    await user.click(screen.getByRole('button', { name: /Confirm remove/ }));
    await waitFor(() => {
      expect(findCall(calls, 'DELETE', '/wizard/mailboxes/mb1')).toBeDefined();
    });
    // Exactly one DELETE for the confirmed removal.
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('Cancel backs out of the confirm WITHOUT deleting', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      listRoute([MAILBOX]),
      {
        method: 'DELETE',
        url: '/wizard/mailboxes/mb1',
        status: 200,
        json: { id: 'mb1', removed: true },
      },
    ]);
    renderWith(<MailboxList />);

    await screen.findByText('jan@me.com');
    await user.click(screen.getByRole('button', { name: /^Remove$/ }));
    await user.click(screen.getByRole('button', { name: /Cancel/ }));

    // Back to the un-armed state, and nothing was deleted.
    expect(screen.queryByRole('button', { name: /Confirm remove/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Remove$/ })).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('MailboxList — empty state', () => {
  it('shows the "No mailboxes connected yet" copy when none are configured', async () => {
    mockFetch([listRoute([])]);
    renderWith(<MailboxList />);

    expect(await screen.findByText(/No mailboxes connected yet/i)).toBeInTheDocument();
    // No mailbox rows / Remove buttons in the empty state.
    expect(screen.queryByRole('button', { name: /^Remove$/ })).not.toBeInTheDocument();
  });
});
