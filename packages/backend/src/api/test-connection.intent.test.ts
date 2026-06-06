/**
 * INTENT (separate test-author) — the REAL `createImapConnectionTester` is STRICTLY READ-ONLY
 * (Golden rules #1/#3) and LEAKS NO CREDENTIAL (#4). PROJECT.md §10 + Phase-3 `verify-mailbox`
 * pattern: a connection test must LOG IN, confirm access read-only, LOG OUT — and issue NO
 * STORE/APPEND/MOVE/COPY/DELETE and never send.
 *
 * The wizard smoke uses a hand-written fake tester (which can't prove the real impl is read-only). Here
 * we mock the `imapflow` module with a RECORDING client (a Proxy that captures EVERY method invoked),
 * exercise the real impl, and assert the called-method set is a subset of {connect, mailboxOpen,
 * logout, close}, that `mailboxOpen` was `readOnly:true`, and that the password is used for auth but
 * appears in NEITHER the result NOR (on failure) the reason. No live IMAP.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestConnectionResult } from '@mailordomo/shared';

/** Hoisted recorder shared with the `vi.mock` factory (which is itself hoisted). */
const h = vi.hoisted(() => ({
  instances: [] as Array<{ config: unknown; calls: Array<{ method: string; args: unknown[] }> }>,
  /** When set, the named method rejects (to exercise the failure branch). */
  rejectOn: null as string | null,
  rejectMessage: 'auth failed',
}));

vi.mock('imapflow', () => ({
  // A regular function (NOT an arrow) so `new ImapFlow(...)` constructs; returning the Proxy from the
  // constructor makes the Proxy the instance, so every method the impl calls is recorded.
  ImapFlow: vi.fn().mockImplementation(function (this: unknown, config: unknown) {
    const rec = { config, calls: [] as Array<{ method: string; args: unknown[] }> };
    h.instances.push(rec);
    return new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === '__rec') return rec;
          const name = String(prop);
          return (...args: unknown[]) => {
            rec.calls.push({ method: name, args });
            if (h.rejectOn === name) return Promise.reject(new Error(h.rejectMessage));
            return Promise.resolve({});
          };
        },
      },
    );
  }),
}));

// Imported AFTER the mock is registered (vi.mock is hoisted above this import anyway).
const { createImapConnectionTester } = await import('./test-connection');

const PASSWORD = 'app-specific-9f3c-secret';
const PARAMS = {
  host: 'imap.mail.me.com',
  port: 993,
  secure: true,
  user: 'you@me.com',
  pass: PASSWORD,
} as const;

/** IMAP operations that WRITE or SEND — none of these may ever be called by a connection test. */
const FORBIDDEN_OPS = [
  'append',
  'messageMove',
  'messageCopy',
  'messageDelete',
  'messageFlagsAdd',
  'messageFlagsRemove',
  'messageFlagsSet',
  'mailboxCreate',
  'mailboxDelete',
  'mailboxRename',
  'download',
  'fetch',
  'fetchOne',
  'idle',
];

afterEach(() => {
  h.instances.length = 0;
  h.rejectOn = null;
  vi.clearAllMocks();
});

describe('createImapConnectionTester — strictly read-only (golden rules #1/#3)', () => {
  it('connects, opens INBOX read-only, logs out — and issues NO write/STORE/APPEND/MOVE/send op', async () => {
    const result: TestConnectionResult = await createImapConnectionTester().test(PARAMS);

    expect(result).toEqual({ ok: true, reason: 'connected and opened INBOX read-only' });
    expect(h.instances).toHaveLength(1);
    const calls = h.instances[0]!.calls;
    const methods = calls.map((c) => c.method);

    // Exactly the read-only login lifecycle, nothing else.
    expect(methods).toContain('connect');
    expect(methods).toContain('logout');
    expect(new Set(methods)).toEqual(new Set(['connect', 'mailboxOpen', 'logout']));
    // The mailbox was opened READ-ONLY (a write/STARTTLS-less open would corrupt this).
    const open = calls.find((c) => c.method === 'mailboxOpen');
    expect(open?.args).toEqual(['INBOX', { readOnly: true }]);

    // No write/send op was invoked, ever.
    for (const op of FORBIDDEN_OPS) expect(methods).not.toContain(op);
  });

  it('passes the password to auth but returns it NOWHERE (deep scan of the result)', async () => {
    const result = await createImapConnectionTester().test(PARAMS);
    // The impl used the password for auth (wiring) …
    const config = h.instances[0]!.config as { auth?: { pass?: string }; logger?: unknown };
    expect(config.auth?.pass).toBe(PASSWORD);
    expect(config.logger).toBe(false); // logger disabled → imapflow can't log the password
    // … but it never appears in the returned result.
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it('on a login failure returns {ok:false, reason} with the provider message and NO password', async () => {
    h.rejectOn = 'connect';
    h.rejectMessage = 'Invalid credentials (Failure)';
    const result = await createImapConnectionTester().test(PARAMS);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('Invalid credentials (Failure)');
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    // Even on the failure path it still attempts a clean logout (best-effort) and writes nothing.
    const methods = h.instances[0]!.calls.map((c) => c.method);
    for (const op of FORBIDDEN_OPS) expect(methods).not.toContain(op);
  });
});
