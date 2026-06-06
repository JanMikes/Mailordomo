/**
 * INTENT (separate test-author) — two Phase 9 backend routes (PLAN.md D35):
 *
 *   1. DELETE /api/wizard/mailboxes/:id — remove a mailbox's NON-secret config entry AND BOTH of its
 *      credential slots (imap + smtp). 200 `{ id, removed: true }` and the mailbox is gone from the
 *      list; 404 on an unknown id. GOLDEN RULE #4: the response body carries no secret.
 *
 *   2. POST /api/sync — trigger the running daemon's immediate poll→triage cycle through the injected
 *      `syncControl.runCycleNow` box. 503 when the box / `runCycleNow` is absent (daemon off); 202 +
 *      `runCycleNow` called exactly once when present. GOLDEN RULE #1: a sync NEVER sends — nothing on
 *      the `sendDeps` transmission path is touched; only the injected `runCycleNow` fires.
 *
 * Built like `app.smoke.test.ts` / `wizard.smoke.test.ts`: the real {@link createBackendApi} with an
 * in-memory cache + in-memory settings + the FAKE credential store + a temp-file config store and
 * mocked seams (no socket, no `security`, no live IMAP/SMTP, no `claude`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppSettings, MailboxConfigResponse, WsMessage } from '@mailordomo/shared';
import { AppSettingsSchema, DEFAULT_APP_SETTINGS } from '@mailordomo/shared';
import { MessageCache } from '../cache';
import { CONFIG_FILE_NAME, createFileConfigStore } from '../config';
import { createMemoryCredentialStore } from '../credentials';
import type { CredentialKind, CredentialStore, MemoryCredentialStore } from '../credentials';
import { MetadataClient } from '../metadata-client';
import type { SendDeps } from '../smtp/send';
import { createBackendApi } from './app';

const SECRET = 'super-secret-app-password-DO-NOT-LEAK';

/** The ad-hoc body the DELETE route returns (no shared DTO — it's a backend-local control shape). */
interface DeleteMailboxResult {
  readonly id: string;
  readonly removed: boolean;
}

let cache: MessageCache;
let dir: string;
let creds: MemoryCredentialStore;

beforeEach(() => {
  cache = MessageCache.open({ dbPath: ':memory:' });
  dir = mkdtempSync(join(tmpdir(), 'mailordomo-sync-delete-'));
  creds = createMemoryCredentialStore();
});

afterEach(() => {
  cache.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A trivial in-memory settings store (the file store is covered elsewhere). */
function memStore(initial: AppSettings = { ...DEFAULT_APP_SETTINGS }): {
  read: () => AppSettings;
  write: (patch: Partial<AppSettings>) => AppSettings;
} {
  let current = initial;
  return {
    read: () => current,
    write: (patch) => {
      current = AppSettingsSchema.parse({ ...current, ...patch });
      return current;
    },
  };
}

/** A client pointed at a dead URL — every metadata call rejects (graceful degradation, never a hang). */
function deadClient(): MetadataClient {
  return new MetadataClient({ baseUrl: 'http://unused.local', projectId: 'p', token: 't' });
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/* ============================ DELETE /api/wizard/mailboxes/:id ============================ */

/** A CredentialStore that records every `delete(account, kind)` call, delegating to the real fake. */
function spyingCredentialStore(inner: CredentialStore): {
  store: CredentialStore;
  deletes: Array<[string, CredentialKind]>;
} {
  const deletes: Array<[string, CredentialKind]> = [];
  return {
    deletes,
    store: {
      get: (a, k) => inner.get(a, k),
      set: (a, k, s) => inner.set(a, k, s),
      delete: (a, k) => {
        deletes.push([a, k]);
        return inner.delete(a, k);
      },
    },
  };
}

function makeWizardApp(opts: {
  credentialStore?: CredentialStore;
  broadcast?: (m: WsMessage) => void;
}) {
  return createBackendApi({
    metadata: deadClient(),
    cache,
    settingsStore: memStore(),
    ...(opts.broadcast ? { broadcast: opts.broadcast } : {}),
    configStore: createFileConfigStore(join(dir, CONFIG_FILE_NAME)),
    credentialStore: opts.credentialStore ?? creds,
    checkClaudeVersion: () => Promise.resolve({ ok: true, detail: 'claude 2.1.165' }),
  });
}

/** Seed a project + a mailbox (id `m1`) WITH both passwords; returns the app. */
async function seedMailbox(app: ReturnType<typeof createBackendApi>, id = 'm1'): Promise<void> {
  const proj = await app.request('/api/wizard/projects', json('POST', { id: 'p1', name: 'Acme' }));
  // 201 the first time; a 409 (dup id) is expected + fine when seeding a SECOND mailbox in the same test.
  expect([201, 409]).toContain(proj.status);
  const res = await app.request(
    '/api/wizard/mailboxes',
    json('POST', {
      id,
      projectId: 'p1',
      address: `${id}@me.com`,
      imap: { host: 'imap.mail.me.com', port: 993, secure: true, user: `${id}@me.com` },
      smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, user: `${id}@me.com` },
      imapPassword: SECRET,
      smtpPassword: SECRET,
    }),
  );
  expect(res.status).toBe(201);
}

describe('DELETE /api/wizard/mailboxes/:id — drops the config entry AND both credential slots', () => {
  it('200 { id, removed: true }; the mailbox vanishes from GET /api/wizard/mailboxes', async () => {
    const app = makeWizardApp({});
    await seedMailbox(app, 'm1');

    const before = (await (await app.request('/api/wizard/mailboxes')).json()) as {
      mailboxes: MailboxConfigResponse[];
    };
    expect(before.mailboxes.map((m) => m.mailbox.id)).toEqual(['m1']);

    const res = await app.request('/api/wizard/mailboxes/m1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json()) as DeleteMailboxResult).toEqual({ id: 'm1', removed: true });

    const after = (await (await app.request('/api/wizard/mailboxes')).json()) as {
      mailboxes: MailboxConfigResponse[];
    };
    expect(after.mailboxes).toEqual([]);
  });

  it('deletes BOTH credential slots (imap + smtp) for the removed mailbox', async () => {
    const spy = spyingCredentialStore(creds);
    const app = makeWizardApp({ credentialStore: spy.store });
    await seedMailbox(app, 'm1');

    // Sanity: the secrets are present before removal.
    expect(await spy.store.get('m1', 'imap')).toBe(SECRET);
    expect(await spy.store.get('m1', 'smtp')).toBe(SECRET);

    const res = await app.request('/api/wizard/mailboxes/m1', { method: 'DELETE' });
    expect(res.status).toBe(200);

    // Both slots were explicitly deleted (the central contract of this route) …
    expect(spy.deletes).toContainEqual(['m1', 'imap']);
    expect(spy.deletes).toContainEqual(['m1', 'smtp']);
    // … and the underlying store no longer holds either secret.
    expect(await spy.store.get('m1', 'imap')).toBeUndefined();
    expect(await spy.store.get('m1', 'smtp')).toBeUndefined();
    expect(creds.entries()).toHaveLength(0);
  });

  it('leaves OTHER mailboxes (and their secrets) intact', async () => {
    const spy = spyingCredentialStore(creds);
    const app = makeWizardApp({ credentialStore: spy.store });
    await seedMailbox(app, 'm1');
    await seedMailbox(app, 'm2');

    await app.request('/api/wizard/mailboxes/m1', { method: 'DELETE' });

    const after = (await (await app.request('/api/wizard/mailboxes')).json()) as {
      mailboxes: MailboxConfigResponse[];
    };
    expect(after.mailboxes.map((m) => m.mailbox.id)).toEqual(['m2']);
    // m2's credentials survive; only m1's slots were deleted.
    expect(await spy.store.get('m2', 'imap')).toBe(SECRET);
    expect(await spy.store.get('m2', 'smtp')).toBe(SECRET);
    expect(spy.deletes).not.toContainEqual(['m2', 'imap']);
    expect(spy.deletes).not.toContainEqual(['m2', 'smtp']);
  });

  it('404 { code: not_found } for an unknown id (and no spurious credential deletes)', async () => {
    const spy = spyingCredentialStore(creds);
    const app = makeWizardApp({ credentialStore: spy.store });
    await seedMailbox(app, 'm1');

    const res = await app.request('/api/wizard/mailboxes/ghost', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'not_found' });

    // The unknown-id path aborts on the config error BEFORE touching the credential store.
    expect(spy.deletes).toHaveLength(0);
    // The real mailbox + its secrets are untouched.
    expect(await creds.get('m1', 'imap')).toBe(SECRET);
  });

  it('GOLDEN RULE #4: the success response body carries no secret', async () => {
    const app = makeWizardApp({});
    await seedMailbox(app, 'm1');
    const res = await app.request('/api/wizard/mailboxes/m1', { method: 'DELETE' });
    const raw = await res.text();
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain('"removed":true');
  });

  it('broadcasts nothing on the wire that leaks a secret (and returns the slim control shape)', async () => {
    // The route does not broadcast today:changed (the daemon rebinds on restart), but if a future
    // change adds one it must still be secret-free — pin the shape that DOES cross.
    const app = makeWizardApp({});
    await seedMailbox(app, 'm1');
    const body = (await (
      await app.request('/api/wizard/mailboxes/m1', { method: 'DELETE' })
    ).json()) as DeleteMailboxResult;
    expect(Object.keys(body).sort()).toEqual(['id', 'removed']);
  });
});

/* ===================== PATCH /api/wizard/mailboxes/:id (edit) ====================== */

// Reviewer follow-up (N3): the management UI's edit form sends FULL endpoints + OPTIONAL passwords
// (blank = keep current). These pin the write-only contract: omitting a password preserves the stored
// secret; supplying one rotates only that slot; no response echoes a secret (Golden rule #4).
describe('PATCH /api/wizard/mailboxes/:id — editing endpoints preserves stored passwords', () => {
  it('omitting the password fields leaves BOTH stored credentials untouched', async () => {
    const app = makeWizardApp({});
    await seedMailbox(app, 'm1');
    expect(await creds.get('m1', 'imap')).toBe(SECRET);

    const res = await app.request(
      '/api/wizard/mailboxes/m1',
      json('PATCH', {
        imap: { host: 'imap.changed.example', port: 993, secure: true, user: 'm1@me.com' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as MailboxConfigResponse;
    expect(body.mailbox.imap.host).toBe('imap.changed.example'); // endpoint changed …
    expect(await creds.get('m1', 'imap')).toBe(SECRET); // … secrets NOT blanked …
    expect(await creds.get('m1', 'smtp')).toBe(SECRET);
    expect(body.credentials).toEqual({ imap: true, smtp: true }); // … presence still true
  });

  it('supplying a new password rotates ONLY that slot', async () => {
    const app = makeWizardApp({});
    await seedMailbox(app, 'm1');
    const NEW = 'rotated-imap-password';
    const res = await app.request('/api/wizard/mailboxes/m1', json('PATCH', { imapPassword: NEW }));
    expect(res.status).toBe(200);
    expect(await creds.get('m1', 'imap')).toBe(NEW); // rotated
    expect(await creds.get('m1', 'smtp')).toBe(SECRET); // untouched
  });

  it('GOLDEN RULE #4: the PATCH response echoes no secret', async () => {
    const app = makeWizardApp({});
    await seedMailbox(app, 'm1');
    const res = await app.request(
      '/api/wizard/mailboxes/m1',
      json('PATCH', { imapPassword: 'another-secret-value' }),
    );
    const raw = await res.text();
    expect(raw).not.toContain('another-secret-value');
    expect(raw).not.toContain(SECRET);
  });
});

/* ==================================== POST /api/sync ==================================== */

/**
 * A {@link SendDeps} whose composer + transport are SPYIES that must NEVER be called from `/api/sync`
 * (Golden rule #1: a sync only polls + drafts). If either fires, the test fails loudly.
 */
function tripwireSendDeps(): {
  sendDeps: SendDeps;
  compose: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const compose = vi.fn(() =>
    Promise.resolve({
      raw: Buffer.from(''),
      messageId: '<x@local>',
      envelope: { from: 'a@b', to: ['c@d'] },
    }),
  );
  const send = vi.fn(() => Promise.resolve({ messageId: '<x@local>' }));
  return {
    compose,
    send,
    sendDeps: {
      composer: { compose: compose as unknown as SendDeps['composer']['compose'] },
      transport: { send: send as unknown as SendDeps['transport']['send'] },
    },
  };
}

describe('POST /api/sync — triggers the daemon cycle (and NEVER sends)', () => {
  it('503 { ok: false } when syncControl is absent (daemon off)', async () => {
    const app = createBackendApi({ metadata: deadClient(), cache, settingsStore: memStore() });
    const res = await app.request('/api/sync', { method: 'POST' });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; reason?: string };
    expect(body.ok).toBe(false);
    expect(typeof body.reason).toBe('string'); // a human reason, not a bare boolean
  });

  it('503 when syncControl is present but runCycleNow is undefined (daemon idle)', async () => {
    const app = createBackendApi({
      metadata: deadClient(),
      cache,
      settingsStore: memStore(),
      syncControl: {}, // the mutable box exists but is not yet filled by the daemon
    });
    const res = await app.request('/api/sync', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('202 { ok: true } and runCycleNow is invoked EXACTLY once when present', async () => {
    const runCycleNow = vi.fn();
    const app = createBackendApi({
      metadata: deadClient(),
      cache,
      settingsStore: memStore(),
      syncControl: { runCycleNow },
    });
    const res = await app.request('/api/sync', { method: 'POST' });
    expect(res.status).toBe(202);
    expect((await res.json()) as { ok: boolean; status?: string }).toEqual({
      ok: true,
      status: 'sync triggered',
    });
    expect(runCycleNow).toHaveBeenCalledTimes(1);
    expect(runCycleNow).toHaveBeenCalledWith(); // fire-and-forget, no args
  });

  it('reads runCycleNow LIVE off the box each call (a daemon that starts later flips 503→202)', async () => {
    // The composition root fills the same mutable box once the daemon starts; the endpoint must read
    // it per-request, not capture it at construction time.
    const box: { runCycleNow?: () => void } = {};
    const app = createBackendApi({
      metadata: deadClient(),
      cache,
      settingsStore: memStore(),
      syncControl: box,
    });
    expect((await app.request('/api/sync', { method: 'POST' })).status).toBe(503);

    const runCycleNow = vi.fn();
    box.runCycleNow = runCycleNow; // daemon comes up
    expect((await app.request('/api/sync', { method: 'POST' })).status).toBe(202);
    expect(runCycleNow).toHaveBeenCalledTimes(1);
  });

  it('GOLDEN RULE #1: triggering a sync NEVER touches the send path (no compose, no transmit)', async () => {
    const runCycleNow = vi.fn();
    const tripwire = tripwireSendDeps();
    const app = createBackendApi({
      metadata: deadClient(),
      cache,
      settingsStore: memStore(),
      syncControl: { runCycleNow },
      sendDeps: tripwire.sendDeps, // wired in, but a sync must never reach it
    });
    const res = await app.request('/api/sync', { method: 'POST' });
    expect(res.status).toBe(202);

    // Only the injected cycle fired; the SMTP transmission path was never invoked.
    expect(runCycleNow).toHaveBeenCalledTimes(1);
    expect(tripwire.compose).not.toHaveBeenCalled();
    expect(tripwire.send).not.toHaveBeenCalled();
  });
});
