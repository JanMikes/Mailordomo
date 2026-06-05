/**
 * SMOKE (implementer) — `DraftPane` request wiring (PLAN.md §7 Phase 7b / D31). Proves the draft
 * hooks fire the RIGHT local-backend requests against a mocked fetch:
 *  - an existing draft renders editable + Send POSTs the (edited) body to `…/send` (manual send,
 *    golden rule #1) and then confirms;
 *  - a refine instruction POSTs to `…/draft/refine`;
 *  - with no draft yet, "Draft reply" POSTs to `…/draft`.
 * The exhaustive behavior suite is the separate test-author's.
 */
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { mockFetch, type RecordedCall } from '@/test/fetch-mock';
import { DraftPane } from './draft-pane';

const DRAFT = {
  body: 'Hi there, thanks for the note.',
  model: 'claude-opus-4-8[1m]',
  version: 1,
  transcript: [
    { role: 'user', content: 'Draft a reply' },
    { role: 'assistant', content: 'Hi there, thanks for the note.' },
  ],
};

function renderPane(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function postEndingWith(calls: readonly RecordedCall[], suffix: string): RecordedCall | undefined {
  return calls.find((c) => c.method === 'POST' && c.url.endsWith(suffix));
}

describe('DraftPane (smoke)', () => {
  it('renders the editable draft + model badge and Send posts the body to …/send', async () => {
    const { calls } = mockFetch([
      { method: 'GET', url: '/threads/t1/draft', json: DRAFT },
      {
        method: 'POST',
        url: '/threads/t1/send',
        json: { messageId: '<sent@x>', filedTo: 'Sent', state: 'waiting' },
      },
    ]);
    const user = userEvent.setup();
    renderPane(<DraftPane threadId="t1" canWrite autoDraft={false} onClose={() => {}} />);

    expect(await screen.findByDisplayValue(DRAFT.body)).toBeInTheDocument();
    expect(screen.getByText('Draft · Opus')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Send$/ }));

    await waitFor(() => expect(postEndingWith(calls, '/threads/t1/send')).toBeDefined());
    expect(postEndingWith(calls, '/threads/t1/send')?.body).toEqual({ body: DRAFT.body });
    expect(await screen.findByText('Sent')).toBeInTheDocument();
  });

  it('a refine instruction posts to …/draft/refine', async () => {
    const { calls } = mockFetch([
      { method: 'GET', url: '/threads/t1/draft', json: DRAFT },
      { method: 'POST', url: '/threads/t1/draft/refine', json: { ...DRAFT, version: 2 } },
    ]);
    const user = userEvent.setup();
    renderPane(<DraftPane threadId="t1" canWrite autoDraft={false} onClose={() => {}} />);

    await screen.findByDisplayValue(DRAFT.body);
    await user.type(screen.getByLabelText('Refine'), 'make it shorter');
    await user.click(screen.getByRole('button', { name: 'Refine' }));

    await waitFor(() => expect(postEndingWith(calls, '/threads/t1/draft/refine')).toBeDefined());
    expect(postEndingWith(calls, '/threads/t1/draft/refine')?.body).toEqual({
      instruction: 'make it shorter',
    });
  });

  it('with no draft yet, "Draft reply" posts to …/draft', async () => {
    const { calls } = mockFetch([
      { method: 'GET', url: '/threads/t1/draft', status: 404, json: { error: 'no draft' } },
      { method: 'POST', url: '/threads/t1/draft', json: DRAFT },
    ]);
    const user = userEvent.setup();
    renderPane(<DraftPane threadId="t1" canWrite autoDraft={false} onClose={() => {}} />);

    await screen.findByText('Draft a reply');
    await user.click(screen.getByRole('button', { name: 'Draft reply' }));

    await waitFor(() => expect(postEndingWith(calls, '/threads/t1/draft')).toBeDefined());
  });
});
