/**
 * SMOKE (implementer) — the Setup page (Phase 8 / D33). Proves the page renders the guided wizard by
 * default and that the "Advanced" raw-config view is reachable (never trap a dev) and shows where
 * credentials live. The exhaustive suite is the separate test-author's.
 */
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MailordomoConfig } from '@mailordomo/shared';

import { mockFetch } from '@/test/fetch-mock';
import { SetupPage } from './setup-page';

const CONFIG: MailordomoConfig = {
  projects: [{ id: 'p1', name: 'Fontai' }],
  mailboxes: [
    {
      id: 'mb1',
      projectId: 'p1',
      address: 'jan@me.com',
      imap: { host: 'imap.mail.me.com', port: 993, secure: true, user: 'jan@me.com' },
      smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, user: 'jan@me.com' },
    },
  ],
  repoPointers: [],
  repos: [],
};

function renderWith(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('SetupPage (smoke)', () => {
  it('shows the guided wizard by default and switches to the advanced raw-config view', async () => {
    const user = userEvent.setup();
    mockFetch([
      { method: 'GET', url: '/wizard/projects', json: { projects: [] } },
      { method: 'GET', url: '/wizard/config', json: CONFIG },
    ]);
    renderWith(<SetupPage />);

    // Guided is the default — the first wizard step is showing.
    expect(screen.getByRole('heading', { name: 'Name your project' })).toBeInTheDocument();

    // Switch to Advanced — the raw, secret-free config + the "where credentials live" note appear.
    await user.click(screen.getByRole('radio', { name: 'Advanced' }));
    expect(await screen.findByText('Where credentials live')).toBeInTheDocument();
    expect(screen.getByText('Current config')).toBeInTheDocument();
    // The advanced view never collects a secret (read-only) — no password input here.
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });
});
