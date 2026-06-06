/**
 * SMOKE — the CredentialStore boundary (Golden rule #4; PLAN.md §7 Phase 8, D33).
 *
 * Proves: the in-memory FAKE round-trips and isolates `(account, kind)`; the Keychain impl builds the
 * EXACT `security` argv WITHOUT any real call (no `security` spawn in CI); the `.env` fallback writes a
 * gitignored `{account}.env`, preserves unrelated keys, and round-trips; and `assertSafeAccount`
 * blocks path-traversal account ids. CI never invokes `security` or touches a real Keychain.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSafeAccount,
  buildSecurityArgs,
  createEnvFileCredentialStore,
  createMemoryCredentialStore,
  credentialEnvFilePath,
  keychainServiceName,
} from './index';

describe('createMemoryCredentialStore (the test fake)', () => {
  it('round-trips set → get → delete, keyed by (account, kind)', async () => {
    const store = createMemoryCredentialStore();
    expect(await store.get('mbx1', 'imap')).toBeUndefined();

    await store.set('mbx1', 'imap', 'imap-secret');
    await store.set('mbx1', 'smtp', 'smtp-secret');
    expect(await store.get('mbx1', 'imap')).toBe('imap-secret');
    expect(await store.get('mbx1', 'smtp')).toBe('smtp-secret');
    // Different account is isolated.
    expect(await store.get('mbx2', 'imap')).toBeUndefined();

    await store.set('mbx1', 'imap', 'rotated'); // upsert
    expect(await store.get('mbx1', 'imap')).toBe('rotated');

    await store.delete('mbx1', 'imap');
    expect(await store.get('mbx1', 'imap')).toBeUndefined();
    await store.delete('mbx1', 'imap'); // idempotent
    // smtp untouched by the imap delete.
    expect(await store.get('mbx1', 'smtp')).toBe('smtp-secret');
  });
});

describe('Keychain argv (built, never spawned)', () => {
  it('keychainServiceName namespaces by account + kind', () => {
    expect(keychainServiceName('mbx1', 'imap')).toBe('mailordomo:mbx1:imap');
    expect(keychainServiceName('proj1', 'metadata-token')).toBe('mailordomo:proj1:metadata-token');
  });

  it('set/get/delete build the exact `security` argv', () => {
    expect(buildSecurityArgs('set', 'mbx1', 'imap', 's3cret')).toEqual([
      'add-generic-password',
      '-U',
      '-a',
      'mbx1',
      '-s',
      'mailordomo:mbx1:imap',
      '-w',
      's3cret',
    ]);
    expect(buildSecurityArgs('get', 'mbx1', 'imap')).toEqual([
      'find-generic-password',
      '-a',
      'mbx1',
      '-s',
      'mailordomo:mbx1:imap',
      '-w',
    ]);
    expect(buildSecurityArgs('delete', 'mbx1', 'imap')).toEqual([
      'delete-generic-password',
      '-a',
      'mbx1',
      '-s',
      'mailordomo:mbx1:imap',
    ]);
  });

  it('only the set argv carries the secret (get/delete never do)', () => {
    expect(buildSecurityArgs('get', 'mbx1', 'imap')).not.toContain('s3cret');
    expect(buildSecurityArgs('delete', 'mbx1', 'imap')).not.toContain('s3cret');
  });
});

describe('createEnvFileCredentialStore (the .env fallback)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mailordomo-creds-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a gitignored {account}.env, round-trips, and preserves other keys', async () => {
    const file = credentialEnvFilePath(dir, 'mbx1');
    expect(file.endsWith('mbx1.env')).toBe(true); // matched by the `*.env` gitignore rule

    // A pre-existing hand-edited line must survive a programmatic write.
    writeFileSync(file, '# my mailbox\nIMAP_USER=you@me.com\n', 'utf8');

    const store = createEnvFileCredentialStore(dir);
    await store.set('mbx1', 'imap', 'app-specific-password');
    expect(await store.get('mbx1', 'imap')).toBe('app-specific-password');

    const contents = readFileSync(file, 'utf8');
    expect(contents).toContain('IMAP_USER=you@me.com'); // preserved
    expect(contents).toContain('IMAP_PASSWORD=app-specific-password');

    await store.delete('mbx1', 'imap');
    expect(await store.get('mbx1', 'imap')).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toContain('IMAP_USER=you@me.com'); // still preserved
  });
});

describe('assertSafeAccount (path-traversal guard)', () => {
  it('accepts ids + email local parts, rejects separators/traversal', () => {
    expect(() => assertSafeAccount('mbx_1')).not.toThrow();
    expect(() => assertSafeAccount('you@me.com')).not.toThrow();
    expect(() => assertSafeAccount('../etc/passwd')).toThrow();
    expect(() => assertSafeAccount('a/b')).toThrow();
    expect(() => assertSafeAccount('')).toThrow();
  });
});
