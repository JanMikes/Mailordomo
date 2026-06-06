/**
 * SMOKE (implementer) — the wizard stepper (Phase 8 / D33). Proves the stepper ADVANCES: create a
 * project, then Continue lands on the mailbox step. The per-step behavior is covered by the step tests;
 * the exhaustive suite is the separate test-author's.
 */
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PROVIDER_PRESETS } from '@mailordomo/shared';

import { mockFetch } from '@/test/fetch-mock';
import { SetupWizard } from './setup-wizard';

function renderWith(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('SetupWizard (smoke)', () => {
  it('advances from the project step to the mailbox step after creating a project', async () => {
    const user = userEvent.setup();
    mockFetch([
      { method: 'GET', url: '/wizard/projects', json: { projects: [] } },
      { method: 'POST', url: '/wizard/projects', status: 201, json: { id: 'p1', name: 'Fontai' } },
      { method: 'GET', url: '/wizard/presets', json: { presets: PROVIDER_PRESETS } },
    ]);
    renderWith(<SetupWizard />);

    // Step 1 — create a project.
    expect(screen.getByRole('heading', { name: 'Name your project' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Project name'), 'Fontai');
    await user.click(screen.getByRole('button', { name: /Create/ }));

    // The selection confirms, enabling Continue.
    expect(await screen.findByText('Project "Fontai" is selected.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // Step 2 — the mailbox step is now showing.
    expect(await screen.findByRole('heading', { name: 'Add a mailbox' })).toBeInTheDocument();
  });
});
