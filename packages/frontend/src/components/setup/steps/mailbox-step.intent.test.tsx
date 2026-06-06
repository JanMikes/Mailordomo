/**
 * INTENT (separate test-author) — the mailbox step as the FRONT DOOR for a secret (Golden rule #4;
 * PROJECT.md §10; CLAUDE.md "no localStorage as a source of truth"; D33).
 *
 * Derived from intent before trusting the impl. Additive to `mailbox-step.test.tsx` (which proves a
 * Gmail preset auto-fills + the saved view shows presence): here we prove the iCloud DEFAULT preset
 * pre-fills correctly, the "same password" toggle OFF sends a DISTINCT SMTP secret, the password NEVER
 * reaches localStorage/sessionStorage, the secret is wiped from the DOM after save (non-vacuously — it
 * was present in the input first), and the update-password flow on the saved view is write-only too.
 */
import { useState } from 'react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
const SECRET = 'icloud-app-pw-2f8a';
const SMTP_SECRET = 'distinct-smtp-pw-77b3';

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

/** Records every Web Storage write so we can prove no secret is ever persisted. */
let storageWrites: Array<{ key: string; value: string }>;
beforeEach(() => {
  storageWrites = [];
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
    storageWrites.push({ key, value });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('MailboxStep — provider presets pre-fill the transport endpoints', () => {
  it('the DEFAULT (iCloud) preset auto-fills IMAP 993/TLS + SMTP 587/STARTTLS on load', async () => {
    mockFetch([presetRoute()]);
    renderWith(<Harness />);

    // The default preset seeds both endpoints without any user interaction. The presets are fetched
    // async (GET /wizard/presets), so wait for the auto-fill to LAND rather than reading the inputs
    // the instant they mount (still empty) — that read-too-early was the flaky race.
    await screen.findAllByLabelText('Host');
    await waitFor(() => {
      const hosts = screen.getAllByLabelText('Host') as HTMLInputElement[];
      const ports = screen.getAllByLabelText('Port') as HTMLInputElement[];
      expect(hosts[0]).toHaveValue('imap.mail.me.com');
      expect(ports[0]).toHaveValue(993);
      expect(hosts[1]).toHaveValue('smtp.mail.me.com');
      expect(ports[1]).toHaveValue(587);
      // The iCloud guidance (app-specific password) is surfaced.
      expect(screen.getByText(/app-specific password/i)).toBeInTheDocument();
    });
  });

  it('switching to Custom clears the host so the user must enter it', async () => {
    const user = userEvent.setup();
    mockFetch([presetRoute()]);
    renderWith(<Harness />);

    await user.click(await screen.findByRole('radio', { name: 'Custom' }));
    const hosts = screen.getAllByLabelText('Host') as HTMLInputElement[];
    expect(hosts[0]).toHaveValue('');
    expect(hosts[1]).toHaveValue('');
  });
});

describe('MailboxStep — Golden rule #4: the password is write-only and never persisted', () => {
  it('the secret is in the input before save, then wiped from the DOM (and never in storage)', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      presetRoute(),
      { method: 'POST', url: '/wizard/mailboxes', status: 201, json: SAVED },
    ]);
    renderWith(<Harness />);

    await user.type(await screen.findByLabelText('Email address'), 'jan@me.com');
    const passwordInput = screen.getByLabelText('Password') as HTMLInputElement;
    await user.type(passwordInput, SECRET);

    // NON-VACUOUS control: the secret really is in the DOM (the input value) right now …
    expect(passwordInput).toHaveValue(SECRET);
    expect(passwordInput.type).toBe('password'); // masked input

    await user.click(screen.getByRole('button', { name: /Save mailbox/ }));
    expect(await screen.findByRole('heading', { name: 'Mailbox saved' })).toBeInTheDocument();

    // The POST carried the password as the write-only inbound field …
    const body = findCall(calls, 'POST', '/wizard/mailboxes')?.body as { imapPassword?: string };
    expect(body.imapPassword).toBe(SECRET);

    // … and afterwards the secret exists NOWHERE in the rendered DOM (no input, no text node) …
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain(SECRET);
    for (const input of Array.from(document.querySelectorAll('input'))) {
      expect((input as HTMLInputElement).value).not.toContain(SECRET);
    }
    // … and was NEVER written to localStorage/sessionStorage.
    expect(storageWrites.some((w) => w.value.includes(SECRET) || w.key.includes(SECRET))).toBe(
      false,
    );
  });

  it('with "same password for SMTP" unchecked, a DISTINCT SMTP secret is sent (both write-only)', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch([
      presetRoute(),
      { method: 'POST', url: '/wizard/mailboxes', status: 201, json: SAVED },
    ]);
    renderWith(<Harness />);

    await user.type(await screen.findByLabelText('Email address'), 'jan@me.com');
    await user.type(screen.getByLabelText('Password'), SECRET);
    // Uncheck "use the same password for SMTP" → a second password field appears.
    await user.click(screen.getByLabelText(/Use the same password for SMTP/));
    await user.type(screen.getByLabelText('SMTP password'), SMTP_SECRET);
    await user.click(screen.getByRole('button', { name: /Save mailbox/ }));

    await screen.findByRole('heading', { name: 'Mailbox saved' });
    const body = findCall(calls, 'POST', '/wizard/mailboxes')?.body as {
      imapPassword?: string;
      smtpPassword?: string;
    };
    expect(body.imapPassword).toBe(SECRET);
    expect(body.smtpPassword).toBe(SMTP_SECRET); // NOT mirrored from IMAP
    expect(storageWrites.some((w) => w.value.includes(SMTP_SECRET))).toBe(false);
  });
});

describe('MailboxStep saved view — update password is write-only + presence ticks', () => {
  function SavedHarness() {
    const [data, setData] = useState<WizardData>({ project: PROJECT, mailbox: SAVED, repo: null });
    return (
      <MailboxStep
        data={data}
        patch={(next) => setData((d) => ({ ...d, ...next }))}
        next={() => {}}
        back={() => {}}
      />
    );
  }

  it('shows presence ticks (never the secret) and rotates the password write-only', async () => {
    const user = userEvent.setup();
    const NEW_PW = 'rotated-pw-9a1c';
    const { calls } = mockFetch([
      { method: 'PATCH', url: '/wizard/mailboxes/mb1', status: 200, json: SAVED },
    ]);
    renderWith(<SavedHarness />);

    // Presence is shown as ticks, the value is unreadable.
    expect(screen.getByText('IMAP password set')).toBeInTheDocument();
    expect(screen.getByText('SMTP password set')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Update password/ }));
    await user.type(screen.getByLabelText('New password'), NEW_PW);
    await user.click(screen.getByRole('button', { name: /Save password/ }));

    // The PATCH carried the new secret as a write-only field …
    const patch = findCall(calls, 'PATCH', '/wizard/mailboxes/mb1')?.body as {
      imapPassword?: string;
      smtpPassword?: string;
    };
    expect(patch.imapPassword).toBe(NEW_PW);
    expect(patch.smtpPassword).toBe(NEW_PW); // "same" default on

    // … the editor closes, the secret is gone from the DOM, and storage never saw it.
    expect(await screen.findByRole('button', { name: /Update password/ })).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain(NEW_PW);
    expect(storageWrites.some((w) => w.value.includes(NEW_PW))).toBe(false);
    // The presence ticks remain.
    const card = screen.getByText('IMAP password set');
    expect(within(card.closest('div') as HTMLElement).getByText('IMAP password set')).toBeTruthy();
  });
});
