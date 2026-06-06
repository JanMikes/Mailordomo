/**
 * SMOKE (implementer) — the mailbox step (Phase 8 / D33). Proves the load-bearing behaviors: a preset
 * AUTO-FILLS the IMAP/SMTP host+port; saving POSTs the password as the WRITE-ONLY `imapPassword` inbound
 * field; the saved view then shows credential PRESENCE ticks (NOT the secret) and the password input is
 * gone; and test-connection renders its result. GOLDEN RULE #4 is the point of this file. The
 * exhaustive suite is the separate test-author's.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  PROVIDER_PRESETS,
  type MailboxConfigResponse,
  type ProjectConfig,
} from '@mailordomo/shared';

import { findCall, mockFetch } from '@/test/fetch-mock';
import { MailboxStep } from './mailbox-step';
import type { WizardData } from '../types';

const PROJECT: ProjectConfig = { id: 'p1', name: 'Fontai' };

const SAVED: MailboxConfigResponse = {
  mailbox: {
    id: 'mb1',
    projectId: 'p1',
    address: 'jan@me.com',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true, user: 'jan@me.com' },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, user: 'jan@me.com' },
  },
  credentials: { imap: true, smtp: true },
};

/** A stateful harness mimicking the wizard: `patch` updates `data`, so saving flips to the saved view. */
function Harness() {
  const [data, setData] = useState<WizardData>({ project: PROJECT, mailbox: null, repo: null });
  return (
    <MailboxStep
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

function presetRoute() {
  return { method: 'GET', url: '/wizard/presets', json: { presets: PROVIDER_PRESETS } } as const;
}

describe('MailboxStep (smoke)', () => {
  it('a provider preset auto-fills the IMAP/SMTP host and port', async () => {
    const user = userEvent.setup();
    mockFetch([presetRoute()]);
    renderWith(<Harness />);

    // Switch to the Gmail preset…
    await user.click(await screen.findByRole('radio', { name: 'Gmail' }));

    // …and both endpoints are filled from it (IMAP first in DOM order, SMTP second).
    const hosts = screen.getAllByLabelText('Host') as HTMLInputElement[];
    const ports = screen.getAllByLabelText('Port') as HTMLInputElement[];
    expect(hosts[0]).toHaveValue('imap.gmail.com');
    expect(ports[0]).toHaveValue(993);
    expect(hosts[1]).toHaveValue('smtp.gmail.com');
    expect(ports[1]).toHaveValue(465);
  });

  it('saves with the password as a write-only field, shows presence ticks (not the secret), and tests the connection', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      presetRoute(),
      // More-specific POST first (substring ordering): test-connection precedes the generic add.
      {
        method: 'POST',
        url: '/wizard/mailboxes/mb1/test-connection',
        json: { ok: true, reason: 'IMAP login succeeded' },
      },
      { method: 'POST', url: '/wizard/mailboxes', status: 201, json: SAVED },
    ]);
    renderWith(<Harness />);

    await user.type(await screen.findByLabelText('Email address'), 'jan@me.com');
    await user.type(screen.getByLabelText('Password'), 'app-specific-pass');
    await user.click(screen.getByRole('button', { name: /Save mailbox/ }));

    // The saved view appears…
    expect(await screen.findByRole('heading', { name: 'Mailbox saved' })).toBeInTheDocument();

    // GOLDEN RULE #4: the POST carried the password as the inbound write-only field…
    const add = findCall(calls, 'POST', '/wizard/mailboxes');
    const body = add?.body as { imapPassword?: string; smtpPassword?: string; address?: string };
    expect(body.imapPassword).toBe('app-specific-pass');
    expect(body.smtpPassword).toBe('app-specific-pass'); // "same as IMAP" default
    expect(body.address).toBe('jan@me.com');

    // …the secret is gone from the UI (no password input on the saved view)…
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    // …and the UI shows PRESENCE, never the value.
    expect(screen.getByText('IMAP password set')).toBeInTheDocument();
    expect(screen.getByText('SMTP password set')).toBeInTheDocument();
    expect(screen.queryByText('app-specific-pass')).not.toBeInTheDocument();

    // Test connection renders its result (no credential in the response).
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('IMAP login succeeded')).toBeInTheDocument();
  });
});
