/**
 * SMOKE (implementer) — the Claude health step (Phase 8 / D33). Proves the health probe renders both a
 * green (ok) and a red (not ok) result. The exhaustive suite is the separate test-author's.
 */
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { mockFetch } from '@/test/fetch-mock';
import { HealthStep } from './health-step';
import type { WizardData } from '../types';

const DATA: WizardData = { project: null, mailbox: null, repo: null };

function renderWith(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function renderHealth() {
  return renderWith(<HealthStep data={DATA} patch={() => {}} next={() => {}} back={() => {}} />);
}

describe('HealthStep (smoke)', () => {
  it('renders a healthy Claude binary', async () => {
    mockFetch([
      { method: 'GET', url: '/wizard/health', json: { ok: true, detail: 'claude 2.1.165 (PATH)' } },
    ]);
    renderHealth();
    expect(await screen.findByText('claude 2.1.165 (PATH)')).toBeInTheDocument();
  });

  it('renders a red result with guidance when Claude is missing', async () => {
    mockFetch([
      {
        method: 'GET',
        url: '/wizard/health',
        json: { ok: false, detail: 'claude not found; set CLAUDE_BIN' },
      },
    ]);
    renderHealth();
    expect(await screen.findByText('claude not found; set CLAUDE_BIN')).toBeInTheDocument();
    expect(screen.getByText(/drafting just won/)).toBeInTheDocument();
  });
});
