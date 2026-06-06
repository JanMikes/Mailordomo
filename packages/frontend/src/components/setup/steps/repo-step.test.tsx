/**
 * SMOKE (implementer) — the repo step (Phase 8 / D33, two modes per PROJECT.md §10). Proves both modes
 * POST correctly: LOCAL PATH sends `local_path` (and `active_pull:false`); GIT URL omits `local_path`
 * and sends the "actively pull" flag. The exhaustive suite is the separate test-author's.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProjectConfig, RepoConfigResponse } from '@mailordomo/shared';

import { findCall, mockFetch } from '@/test/fetch-mock';
import { RepoStep } from './repo-step';
import type { WizardData } from '../types';

const PROJECT: ProjectConfig = { id: 'p1', name: 'Fontai' };

function response(localPath: string, activePull: boolean): RepoConfigResponse {
  return {
    pointer: { id: 'r1', project_id: 'p1', name: 'api', git_url: 'git@github.com:org/api.git' },
    local: { repo_pointer_id: 'r1', local_path: localPath, active_pull: activePull },
  };
}

function Harness() {
  const [data, setData] = useState<WizardData>({ project: PROJECT, mailbox: null, repo: null });
  return (
    <RepoStep
      data={data}
      patch={(next) => setData((d) => ({ ...d, ...next }))}
      next={() => {}}
      back={() => {}}
    />
  );
}

function renderWith(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('RepoStep (smoke)', () => {
  it('local-path mode POSTs local_path (and active_pull false)', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { method: 'POST', url: '/wizard/repos', status: 201, json: response('/code/api', false) },
    ]);
    renderWith(<Harness />);

    await user.type(screen.getByLabelText('Name'), 'api');
    await user.type(screen.getByLabelText('Git URL'), 'git@github.com:org/api.git');
    await user.type(screen.getByLabelText('Local path'), '/code/api');
    await user.click(screen.getByRole('button', { name: /Link repo/ }));

    await waitFor(() => expect(findCall(calls, 'POST', '/wizard/repos')).toBeDefined());
    const body = findCall(calls, 'POST', '/wizard/repos')?.body as {
      project_id?: string;
      local_path?: string;
      active_pull?: boolean;
    };
    expect(body.project_id).toBe('p1');
    expect(body.local_path).toBe('/code/api');
    expect(body.active_pull).toBe(false);
  });

  it('git-URL mode omits local_path and sends the active-pull flag', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      { method: 'POST', url: '/wizard/repos', status: 201, json: response('/mirror/r1', true) },
    ]);
    renderWith(<Harness />);

    // Switch to git-URL mode (the local-path field disappears, the pull checkbox appears).
    await user.click(screen.getByRole('radio', { name: 'Git URL + pull' }));
    await user.type(screen.getByLabelText('Name'), 'api');
    await user.type(screen.getByLabelText('Git URL'), 'git@github.com:org/api.git');
    await user.click(screen.getByRole('button', { name: /Link repo/ }));

    await waitFor(() => expect(findCall(calls, 'POST', '/wizard/repos')).toBeDefined());
    const body = findCall(calls, 'POST', '/wizard/repos')?.body as {
      local_path?: string;
      active_pull?: boolean;
    };
    expect(body.local_path).toBeUndefined(); // mirror mode — no machine-local path sent
    expect(body.active_pull).toBe(true); // checkbox defaults on
  });
});
