/**
 * INTENT (separate test-author) — `SyncNowButton` (Phase 9 / D35). Drives the REAL `useSyncNow` hook →
 * the REAL `triggerSync` api client → a mocked `fetch`, so the whole chain (component → hook → api →
 * the `/api/sync` POST + ApiError handling) is under test, not just a render.
 *
 * The intended contract:
 *   - clicking the button POSTs to `/api/sync`;
 *   - while the request is in flight the button reads "Syncing…" and is disabled (no double-fire);
 *   - a 503 (daemon off) is surfaced as a CALM message (not a raw error / not a thrown exception);
 *   - GOLDEN RULE #1: the call is a plain POST to /api/sync — there is no send/draft request.
 */
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { findCall, mockFetch } from '@/test/fetch-mock';
import { SyncNowButton } from './sync-now-button';

function renderWith(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SyncNowButton', () => {
  it('clicking POSTs to /api/sync (the only request — never a send/draft)', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      {
        method: 'POST',
        url: '/api/sync',
        status: 202,
        json: { ok: true, status: 'sync triggered' },
      },
    ]);
    renderWith(<SyncNowButton />);

    await user.click(screen.getByRole('button', { name: /Sync now/ }));

    await waitFor(() => {
      expect(findCall(calls, 'POST', '/api/sync')).toBeDefined();
    });
    // GOLDEN RULE #1: a sync is ONLY the /api/sync POST — no send/draft call escapes.
    expect(calls.every((c) => !/\/send|\/draft/.test(c.url))).toBe(true);
    // Exactly one request fired for one click.
    expect(calls.filter((c) => c.url.includes('/api/sync'))).toHaveLength(1);
  });

  it('shows "Syncing…" and disables the button while the request is in flight', async () => {
    const user = userEvent.setup();
    // A fetch we control: it stays pending until we resolve it, so we can observe the pending state.
    let resolveFetch: (r: Response) => void = () => {};
    const fetchFn = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchFn);
    renderWith(<SyncNowButton />);

    const button = screen.getByRole('button', { name: /Sync now/ });
    await user.click(button);

    // Pending: label flips to "Syncing…" and the button is disabled (guards against a double POST).
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Syncing/ })).toBeDisabled();
    });

    // Let the request finish (202) → the button returns to its idle label.
    resolveFetch({
      ok: true,
      status: 202,
      json: () => Promise.resolve({ ok: true, status: 'sync triggered' }),
    } as Response);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Sync now/ })).not.toBeDisabled();
    });
  });

  it('surfaces a CALM daemon-off message on a 503 (not a raw throw)', async () => {
    const user = userEvent.setup();
    mockFetch([
      {
        method: 'POST',
        url: '/api/sync',
        status: 503,
        json: {
          ok: false,
          reason: 'daemon not running — set MAILORDOMO_DAEMON=on …',
          code: 'unavailable',
        },
      },
    ]);
    renderWith(<SyncNowButton />);

    await user.click(screen.getByRole('button', { name: /Sync now/ }));

    // The component maps a 503 ApiError to a reassuring line — not the raw backend error string.
    expect(await screen.findByText(/Daemon is off/i)).toBeInTheDocument();
    // The button recovers (re-enabled) so the user can retry.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Sync now/ })).not.toBeDisabled();
    });
  });
});
