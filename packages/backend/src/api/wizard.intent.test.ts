/**
 * INTENT (separate test-author) — the setup-wizard API as the SECRET BOUNDARY (Golden rule #4;
 * PROJECT.md §10 + CLAUDE.md #4; PLAN.md D33). Derived from intent BEFORE trusting the impl: a secret
 * given to the system must be reachable ONLY through the CredentialStore — NEVER in the config JSON,
 * NEVER echoed by any API response, NEVER in a log line. Credential reads return PRESENCE only.
 *
 * These go beyond `wizard.smoke.test.ts` (which proves POST /mailboxes + PUT /credentials don't echo):
 * a deep RECURSIVE scan (keys + string leaves + raw bytes) across POST/PATCH/PUT/GET, the PATCH path
 * the smoke omits, a NON-VACUOUS control proving the scanner actually catches a planted secret, a
 * proof that a rejected mailbox never leaves an orphan secret, the GET /config scan, and an
 * error-PATH probe that a CredentialStore failure can't push the secret into `console.error`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CredentialPresence,
  MailboxConfigResponse,
  TestConnectionResult,
} from '@mailordomo/shared';
import { MessageCache } from '../cache';
import { CONFIG_FILE_NAME, createFileConfigStore } from '../config';
import { createMemoryCredentialStore } from '../credentials';
import type { CredentialStore, MemoryCredentialStore } from '../credentials';
import { createFakeGitRunner } from '../repos';
import { MetadataClient } from '../metadata-client';
import type { ImapConnectionTester, ImapTestParams } from './test-connection';
import { createBackendApi } from './app';

/** A sentinel password that should never appear anywhere but the CredentialStore. */
const SENTINEL = 'S3NTINEL-pw-9c1f4a2b-DO-NOT-LEAK';

/* --------------------------- deep secret scanners ---------------------------- */

/**
 * Recursively scan ANY JSON value for `needle` — string leaves AND object keys (a secret smuggled as a
 * key would still be a leak). This is the adversarial generalization of the smoke's
 * `JSON.stringify(body).not.toContain`.
 */
function deepContains(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some((v) => deepContains(v, needle));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([k, v]) => k.includes(needle) || deepContains(v, needle),
    );
  }
  return false;
}

/**
 * Assert a response body carries the sentinel NOWHERE (deep) and ALSO not in raw bytes. Reads only
 * CLONES, so the caller's original `res` body stays consumable.
 */
async function expectNoSecret(res: Response): Promise<void> {
  const raw = await res.clone().text();
  expect(raw).not.toContain(SENTINEL);
  const body: unknown = await res.clone().json();
  expect(deepContains(body, SENTINEL)).toBe(false);
}

/* -------------------------------- app harness -------------------------------- */

let cache: MessageCache;
let dir: string;
let creds: MemoryCredentialStore;
let lastImapParams: ImapTestParams | undefined;

beforeEach(() => {
  cache = MessageCache.open({ dbPath: ':memory:' });
  dir = mkdtempSync(join(tmpdir(), 'mailordomo-wizard-intent-'));
  creds = createMemoryCredentialStore();
  lastImapParams = undefined;
});

afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fakeTester(result: TestConnectionResult): ImapConnectionTester {
  return {
    test: (params) => {
      lastImapParams = params;
      return Promise.resolve(result);
    },
  };
}

function makeApp(opts: { tester?: ImapConnectionTester; credentialStore?: CredentialStore } = {}) {
  return createBackendApi({
    metadata: new MetadataClient({ baseUrl: 'http://unused.local', projectId: 'p', token: 't' }),
    cache,
    settingsStore: {
      read: () => ({
        waitingStaleDays: 3,
        needsReplyStaleDays: 2,
        lockTimeoutMinutes: 30,
        colorScheme: 'system',
        defaultView: 'today',
      }),
      write: (p) => ({
        waitingStaleDays: 3,
        needsReplyStaleDays: 2,
        lockTimeoutMinutes: 30,
        colorScheme: 'system',
        defaultView: 'today',
        ...p,
      }),
    },
    configStore: createFileConfigStore(join(dir, CONFIG_FILE_NAME)),
    credentialStore: opts.credentialStore ?? creds,
    imapTester: opts.tester ?? fakeTester({ ok: true, reason: 'ok' }),
    gitRunner: createFakeGitRunner(),
    checkClaudeVersion: () => Promise.resolve({ ok: true, detail: 'claude 2.1.165' }),
  });
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function addProject(app: ReturnType<typeof createBackendApi>, id = 'p1'): Promise<void> {
  const res = await app.request('/api/wizard/projects', json({ id, name: 'Acme' }));
  expect(res.status).toBe(201);
}

const ENDPOINTS = {
  imap: { host: 'imap.mail.me.com', port: 993, secure: true, user: 'you@me.com' },
  smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, user: 'you@me.com' },
};

async function addMailbox(
  app: ReturnType<typeof createBackendApi>,
  withSecret: boolean,
  id = 'm1',
): Promise<Response> {
  return app.request(
    '/api/wizard/mailboxes',
    json({
      id,
      projectId: 'p1',
      address: 'you@me.com',
      ...ENDPOINTS,
      ...(withSecret ? { imapPassword: SENTINEL, smtpPassword: SENTINEL } : {}),
    }),
  );
}

/* ----------------------------- the leak proofs ------------------------------- */

describe('Golden rule #4 — the deep-scan is non-vacuous (control)', () => {
  it('deepContains DOES find a planted sentinel (so a clean scan is meaningful)', () => {
    expect(deepContains({ a: { b: ['x', SENTINEL] } }, SENTINEL)).toBe(true);
    expect(deepContains([{ [SENTINEL]: 1 }], SENTINEL)).toBe(true); // even as a key
    expect(deepContains({ a: { b: ['x', 'y'] } }, SENTINEL)).toBe(false);
  });
});

describe('Golden rule #4 — a password reaches the CredentialStore and NOWHERE else', () => {
  it('POST /mailboxes: stored under the mailbox id, absent from the response (deep + raw)', async () => {
    const app = makeApp();
    await addProject(app);
    const res = await addMailbox(app, true);
    expect(res.status).toBe(201);

    // Reached the CredentialStore under (mailboxId, imap|smtp) …
    expect(await creds.get('m1', 'imap')).toBe(SENTINEL);
    expect(await creds.get('m1', 'smtp')).toBe(SENTINEL);

    // … and the response is presence-only, sentinel nowhere.
    const body = (await res.clone().json()) as MailboxConfigResponse;
    expect(body.credentials).toEqual({ imap: true, smtp: true });
    await expectNoSecret(res);
  });

  it('the persisted config.json contains the sentinel NOWHERE (non-vacuous: a real value WOULD show)', async () => {
    const app = makeApp();
    await addProject(app);
    await addMailbox(app, true);

    const file = join(dir, CONFIG_FILE_NAME);
    const rawAfterSecret = readFileSync(file, 'utf8');
    expect(rawAfterSecret).not.toContain(SENTINEL); // the password never hit disk
    expect(rawAfterSecret).toContain('imap.mail.me.com'); // but the NON-secret endpoint did

    // NON-VACUOUS control: a legitimate non-secret field carrying the sentinel string DOES land on
    // disk — proving the byte-scan above isn't passing because the writer/scan is broken.
    const probe = await app.request('/api/wizard/projects', json({ id: 'probe', name: SENTINEL }));
    expect(probe.status).toBe(201);
    expect(readFileSync(file, 'utf8')).toContain(SENTINEL); // a real config value is visible …
    // … yet the project-NAME response legitimately echoes it; the POINT is the password never does.
  });

  it('PATCH /mailboxes/:id rotates the password write-only (smoke omits PATCH)', async () => {
    const app = makeApp();
    await addProject(app);
    await addMailbox(app, false); // create WITHOUT a password
    expect(await creds.get('m1', 'imap')).toBeUndefined();

    const rotated = `${SENTINEL}-rotated`;
    const res = await app.request('/api/wizard/mailboxes/m1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imapPassword: rotated, smtpPassword: rotated }),
    });
    expect(res.status).toBe(200);
    // Stored …
    expect(await creds.get('m1', 'imap')).toBe(rotated);
    expect(await creds.get('m1', 'smtp')).toBe(rotated);
    // … never echoed (deep + raw), presence booleans flip to true.
    const body = (await res.clone().json()) as MailboxConfigResponse;
    expect(body.credentials).toEqual({ imap: true, smtp: true });
    const raw = await res.text();
    expect(raw).not.toContain(rotated);
    // The config file still has no secret after a PATCH.
    expect(readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8')).not.toContain(rotated);
  });

  it('PUT /credentials (metadata-token, repo-pat) is write-only; GET/DELETE return presence only', async () => {
    const app = makeApp();
    for (const kind of ['metadata-token', 'repo-pat'] as const) {
      const put = await app.request('/api/wizard/credentials', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: 'acct', kind, secret: SENTINEL }),
      });
      expect(put.status).toBe(200);
      expect((await put.clone().json()) as CredentialPresence).toEqual({
        account: 'acct',
        kind,
        present: true,
      });
      await expectNoSecret(put);
      expect(await creds.get('acct', kind)).toBe(SENTINEL);

      const get = await app.request(`/api/wizard/credentials/acct/${kind}`);
      expect((await get.clone().json()) as CredentialPresence).toEqual({
        account: 'acct',
        kind,
        present: true,
      });
      await expectNoSecret(get);

      const del = await app.request(`/api/wizard/credentials/acct/${kind}`, { method: 'DELETE' });
      expect((await del.json()) as CredentialPresence).toEqual({
        account: 'acct',
        kind,
        present: false,
      });
      expect(await creds.get('acct', kind)).toBeUndefined();
    }
  });

  it('GET /mailboxes and GET /config never carry a stored secret (deep + raw)', async () => {
    const app = makeApp();
    await addProject(app);
    await addMailbox(app, true);

    const list = await app.request('/api/wizard/mailboxes');
    await expectNoSecret(list);
    expect((await list.json()) as { mailboxes: unknown[] }).toBeTruthy();

    const config = await app.request('/api/wizard/config');
    await expectNoSecret(config);
  });
});

describe('Golden rule #4 — a REJECTED mailbox leaves no orphan secret, and errors never log it', () => {
  it('a dup-id conflict aborts BEFORE the secret is written (config persisted first)', async () => {
    const app = makeApp();
    await addProject(app);
    expect((await addMailbox(app, true, 'm1')).status).toBe(201);
    await creds.delete('m1', 'imap'); // clear so we can detect a NEW (wrong) write
    await creds.delete('m1', 'smtp');

    // Re-add the SAME id with a sentinel password → 409; the credential must NOT be (re)written.
    const dup = await addMailbox(app, true, 'm1');
    expect(dup.status).toBe(409);
    expect(await creds.get('m1', 'imap')).toBeUndefined();
    expect(await creds.get('m1', 'smtp')).toBeUndefined();
    expect(creds.entries()).toHaveLength(0);
  });

  it('a CredentialStore failure surfaces a 500 WITHOUT the secret reaching console.error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A store whose set() rejects with a message that (correctly) carries NO secret.
    const failing: CredentialStore = {
      get: () => Promise.resolve(undefined),
      set: () => Promise.reject(new Error('keychain unavailable')),
      delete: () => Promise.resolve(),
    };
    const app = makeApp({ credentialStore: failing });
    await addProject(app);

    const res = await addMailbox(app, true);
    expect(res.status).toBe(500); // onError fired

    // The error handler logged SOMETHING — but never the sentinel password.
    expect(errorSpy).toHaveBeenCalled();
    const loggedEverything = errorSpy.mock.calls
      .flat()
      .map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a)))
      .join('\n');
    expect(loggedEverything).not.toContain(SENTINEL);
    // And the response body never carries it either.
    await expectNoSecret(res);
  });
});

describe('read-only test-connection passes the stored secret to the tester but never returns it', () => {
  it('returns {ok, reason} with no credential; the tester got the password transiently', async () => {
    const app = makeApp({
      tester: fakeTester({ ok: true, reason: 'connected and opened INBOX read-only' }),
    });
    await addProject(app);
    await addMailbox(app, true);

    const res = await app.request('/api/wizard/mailboxes/m1/test-connection', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.clone().json()) as TestConnectionResult;
    expect(body).toEqual({ ok: true, reason: 'connected and opened INBOX read-only' });
    await expectNoSecret(res);
    // Wiring proof: the seam received the stored password — but it never crossed the API boundary.
    expect(lastImapParams?.pass).toBe(SENTINEL);
  });
});
