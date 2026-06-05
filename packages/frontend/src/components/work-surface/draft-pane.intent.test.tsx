/**
 * INTENT (separate test-author) — the RIGHT pane: draft + refine chat + Send (PROJECT.md §11 + golden
 * rules #1/#5; PLAN.md D31). ADDITIVE to `draft-pane.test.tsx` (the implementer's smoke). Hardens the
 * load-bearing wiring the smoke only touches:
 *  - Send (PRIMARY action) posts the EDITED body to `…/send` — the user's edit, NOT the original
 *    draft (this is exactly what gets sent + what feeds draft-vs-sent learning).
 *  - the refine instruction posts to `…/draft/refine` and the instruction textarea ROUND-TRIPS: the
 *    typed text reaches the request, then the textarea CLEARS.
 *  - with no draft yet, "Draft reply" posts to `…/draft`; an optional instruction is carried.
 *  - the surface NEVER posts to `…/send` on its own — only the explicit Send click does (golden #1).
 */
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { mockFetch, findCall, type RecordedCall } from '@/test/fetch-mock';
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

function sendCalls(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === 'POST' && c.url.endsWith('/send'));
}

describe('DraftPane — Send posts the EDITED body (golden rule #1, manual send)', () => {
  it('sends exactly the user-edited text, not the original draft body', async () => {
    const { calls } = mockFetch([
      { method: 'GET', url: '/threads/t1/draft', json: DRAFT },
      {
        method: 'POST',
        url: '/threads/t1/send',
        json: { messageId: '<sent@x>', filedTo: null, state: 'waiting' },
      },
    ]);
    const user = userEvent.setup();
    renderPane(<DraftPane threadId="t1" canWrite autoDraft={false} onClose={() => {}} />);

    const editor = (await screen.findByLabelText('Draft reply')) as HTMLTextAreaElement;
    expect(editor.value).toBe(DRAFT.body);

    // The user edits the draft before sending.
    await user.clear(editor);
    await user.type(editor, 'My own edited reply.');

    // Nothing has been sent yet — Send is the only path and it has not been clicked.
    expect(sendCalls(calls)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /^Send$/ }));

    await waitFor(() => expect(sendCalls(calls)).toHaveLength(1));
    // The request carries the EDIT, not the original draft body.
    expect(sendCalls(calls)[0]?.body).toEqual({ body: 'My own edited reply.' });
    expect(findCall(calls, 'POST', '/threads/t1/send')?.body).not.toEqual({ body: DRAFT.body });
  });

  it('Send is disabled when the edited body is emptied (cannot send an empty reply)', async () => {
    mockFetch([{ method: 'GET', url: '/threads/t1/draft', json: DRAFT }]);
    const user = userEvent.setup();
    renderPane(<DraftPane threadId="t1" canWrite autoDraft={false} onClose={() => {}} />);

    const editor = await screen.findByLabelText('Draft reply');
    await user.clear(editor);
    expect(screen.getByRole('button', { name: /^Send$/ })).toBeDisabled();
  });
});

describe('DraftPane — refine instruction round-trips through the textarea', () => {
  it('posts the typed instruction to …/draft/refine and CLEARS the textarea after', async () => {
    const { calls } = mockFetch([
      { method: 'GET', url: '/threads/t1/draft', json: DRAFT },
      { method: 'POST', url: '/threads/t1/draft/refine', json: { ...DRAFT, version: 2 } },
    ]);
    const user = userEvent.setup();
    renderPane(<DraftPane threadId="t1" canWrite autoDraft={false} onClose={() => {}} />);

    await screen.findByLabelText('Draft reply');
    const refineInput = screen.getByLabelText('Refine') as HTMLTextAreaElement;
    await user.type(refineInput, 'make it shorter');
    await user.click(screen.getByRole('button', { name: 'Refine' }));

    await waitFor(() => expect(findCall(calls, 'POST', '/threads/t1/draft/refine')).toBeDefined());
    // The typed text reached the request (round-trip in)...
    expect(findCall(calls, 'POST', '/threads/t1/draft/refine')?.body).toEqual({
      instruction: 'make it shorter',
    });
    // ...and the textarea cleared (round-trip out).
    await waitFor(() => expect(refineInput.value).toBe(''));
    // Refining is not sending.
    expect(sendCalls(calls)).toHaveLength(0);
  });
});

describe('DraftPane — first draft (on-signal)', () => {
  it('with no draft yet, "Draft reply" posts to …/draft (drafting on-signal, never a send)', async () => {
    const { calls } = mockFetch([
      { method: 'GET', url: '/threads/t1/draft', status: 404, json: { error: 'no draft' } },
      { method: 'POST', url: '/threads/t1/draft', json: DRAFT },
    ]);
    const user = userEvent.setup();
    renderPane(<DraftPane threadId="t1" canWrite autoDraft={false} onClose={() => {}} />);

    await screen.findByText('Draft a reply');
    await user.click(screen.getByRole('button', { name: 'Draft reply' }));

    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.endsWith('/threads/t1/draft')),
      ).toBeDefined(),
    );
    expect(sendCalls(calls)).toHaveLength(0);
  });
});
