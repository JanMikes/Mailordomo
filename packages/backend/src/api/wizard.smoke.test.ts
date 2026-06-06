/**
 * SMOKE — the setup-wizard API (PLAN.md §7 Phase 8, D33). Constructs the real {@link createBackendApi}
 * with an in-memory cache + the FAKE credential store + a temp file config store + mocked IMAP/git/
 * health seams (no `security`, no live IMAP, no real `git`, no `claude` spawn). The load-bearing focus:
 *
 *   GOLDEN RULE #4 — a password enters ONLY as an inbound field and is NEVER echoed or stored in
 *   config. The "no secret echoed" assertion is the centerpiece.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CredentialPresence,
  MailboxConfigResponse,
  ProjectConfig,
  TestConnectionResult,
} from '@mailordomo/shared';
import { MessageCache } from '../cache';
import { createFileConfigStore, CONFIG_FILE_NAME } from '../config';
import { createMemoryCredentialStore } from '../credentials';
import type { MemoryCredentialStore } from '../credentials';
import { createFakeGitRunner } from '../repos';
import { MetadataClient } from '../metadata-client';
import type { ImapConnectionTester, ImapTestParams } from './test-connection';
import { createBackendApi } from './app';

const SECRET = 'super-secret-app-password';

let cache: MessageCache;
let dir: string;
let creds: MemoryCredentialStore;
let lastImapParams: ImapTestParams | undefined;

beforeEach(() => {
  cache = MessageCache.open({ dbPath: ':memory:' });
  dir = mkdtempSync(join(tmpdir(), 'mailordomo-wizard-'));
  creds = createMemoryCredentialStore();
  lastImapParams = undefined;
});

afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A mocked read-only IMAP tester that records the params and returns a canned result. */
function fakeTester(result: TestConnectionResult): ImapConnectionTester {
  return {
    test: (params) => {
      lastImapParams = params;
      return Promise.resolve(result);
    },
  };
}

function makeApp(opts: { tester?: ImapConnectionTester } = {}) {
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
    credentialStore: creds,
    imapTester: opts.tester ?? fakeTester({ ok: true, reason: 'ok' }),
    gitRunner: createFakeGitRunner(),
    checkClaudeVersion: () => Promise.resolve({ ok: true, detail: 'claude 2.1.165' }),
  });
}

/** Create a project + mailbox (with passwords) and return the mailbox id. */
async function seedMailbox(app: ReturnType<typeof createBackendApi>): Promise<string> {
  const projRes = await app.request('/api/wizard/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'p1', name: 'Acme' }),
  });
  expect(projRes.status).toBe(201);

  const mbxRes = await app.request('/api/wizard/mailboxes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'm1',
      projectId: 'p1',
      address: 'you@me.com',
      imap: { host: 'imap.mail.me.com', port: 993, secure: true, user: 'you@me.com' },
      smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, user: 'you@me.com' },
      imapPassword: SECRET,
      smtpPassword: SECRET,
    }),
  });
  expect(mbxRes.status).toBe(201);
  const body = (await mbxRes.json()) as MailboxConfigResponse;
  expect(body.mailbox.id).toBe('m1');
  // PRESENCE booleans only.
  expect(body.credentials).toEqual({ imap: true, smtp: true });
  // ⚠️ THE KEY ASSERTION: the secret is nowhere in the response.
  expect(JSON.stringify(body)).not.toContain(SECRET);
  return body.mailbox.id;
}

describe('wizard — presets + health', () => {
  it('GET /api/wizard/presets returns the provider presets', async () => {
    const res = await makeApp().request('/api/wizard/presets');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { presets: { id: string }[] };
    expect(body.presets.map((p) => p.id)).toEqual(['icloud', 'gmail', 'custom']);
  });

  it('GET /api/wizard/health returns the Claude health status', async () => {
    const res = await makeApp().request('/api/wizard/health');
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true, detail: 'claude 2.1.165' });
  });
});

describe('wizard — mailbox creation routes secrets to the CredentialStore, never echoes them', () => {
  it('stores passwords in the credential store, NOT in config or the response', async () => {
    const app = makeApp();
    await seedMailbox(app);

    // The secret reached the CredentialStore under the mailbox id …
    expect(await creds.get('m1', 'imap')).toBe(SECRET);
    expect(await creds.get('m1', 'smtp')).toBe(SECRET);

    // … and is NOT in the persisted config file.
    const configRaw = readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8');
    expect(configRaw).not.toContain(SECRET);
    expect(configRaw).toMatch(/imap\.mail\.me\.com/); // the non-secret endpoint IS stored

    // GET /mailboxes returns presence booleans, never the value.
    const list = await app.request('/api/wizard/mailboxes');
    const listBody = await list.text();
    expect(listBody).not.toContain(SECRET);
    expect(listBody).toContain('"imap":true');
  });

  it('PUT /api/wizard/credentials is write-only (response is presence, never the secret)', async () => {
    const app = makeApp();
    const res = await app.request('/api/wizard/credentials', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'proj1', kind: 'metadata-token', secret: SECRET }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CredentialPresence;
    expect(body).toEqual({ account: 'proj1', kind: 'metadata-token', present: true });
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(await creds.get('proj1', 'metadata-token')).toBe(SECRET);

    // GET presence never reveals the value.
    const get = await app.request('/api/wizard/credentials/proj1/metadata-token');
    expect((await get.json()) as CredentialPresence).toEqual({
      account: 'proj1',
      kind: 'metadata-token',
      present: true,
    });
  });
});

describe('wizard — read-only test-connection (mocked IMAP, no creds in response)', () => {
  it('looks up the stored password, calls the tester read-only, returns ok without the secret', async () => {
    const app = makeApp({
      tester: fakeTester({ ok: true, reason: 'connected and opened INBOX read-only' }),
    });
    await seedMailbox(app);

    const res = await app.request('/api/wizard/mailboxes/m1/test-connection', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TestConnectionResult;
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    // The tester got the stored password transiently (proving the wiring) — but it never leaves via the API.
    expect(lastImapParams?.pass).toBe(SECRET);
    expect(lastImapParams?.host).toBe('imap.mail.me.com');
  });

  it('reports a clean failure when no password is stored (no throw, no secret)', async () => {
    const app = makeApp();
    // project + mailbox WITHOUT passwords
    await app.request('/api/wizard/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'p1', name: 'Acme' }),
    });
    await app.request('/api/wizard/mailboxes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'm1',
        projectId: 'p1',
        address: 'you@me.com',
        imap: { host: 'imap.mail.me.com', port: 993, secure: true, user: 'you@me.com' },
        smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, user: 'you@me.com' },
      }),
    });
    const res = await app.request('/api/wizard/mailboxes/m1/test-connection', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as TestConnectionResult).ok).toBe(false);
  });
});

describe('wizard — config CRUD validation', () => {
  it('rejects an invalid project body with 400 (field names only)', async () => {
    const res = await makeApp().request('/api/wizard/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('409 on a duplicate project id', async () => {
    const app = makeApp();
    const project: ProjectConfig = { id: 'p1', name: 'Acme' };
    const post = async (): Promise<Response> =>
      app.request('/api/wizard/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(project),
      });
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(409);
  });

  it('links a repo (identity + machine-local path), and pulls a mirror via the git seam', async () => {
    const app = makeApp();
    await app.request('/api/wizard/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'p1', name: 'Acme' }),
    });
    const link = await app.request('/api/wizard/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo_pointer_id: 'r1',
        project_id: 'p1',
        name: 'app',
        git_url: 'https://example.com/app.git',
        active_pull: true,
      }),
    });
    expect(link.status).toBe(201);

    // Mirror-mode pull goes through the (fake) git seam without throwing.
    const pull = await app.request('/api/wizard/repos/r1/pull', { method: 'POST' });
    expect(pull.status).toBe(200);
    expect(((await pull.json()) as { ok: boolean }).ok).toBe(true);
  });
});
