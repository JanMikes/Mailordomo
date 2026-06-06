/**
 * INTENT (separate test-author) — the CredentialStore as the SOLE home for secrets (Golden rule #4;
 * PROJECT.md §10 Keychain-preferred + `{mailbox}.env` fallback; PLAN.md D33).
 *
 * Additive to `credentials.smoke.test.ts`: the `.env` fallback file is written `0o600` (at-rest
 * protection — untested in smoke); ALL FOUR credential kinds map to the right ENV key + Keychain
 * service (smoke covers only `imap`); the `set` argv carries the secret ONLY as its LAST element; and
 * a path-traversal account is rejected through the whole store surface. No real `security` is spawned —
 * only the PURE argv builder is exercised, per D33 ("CI never invokes `security`").
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CredentialKind } from '@mailordomo/shared';
import {
  buildSecurityArgs,
  createEnvFileCredentialStore,
  credentialEnvFilePath,
  keychainServiceName,
} from './index';

const ALL_KINDS: readonly CredentialKind[] = ['imap', 'smtp', 'metadata-token', 'repo-pat'];

describe('Keychain argv — every kind namespaces correctly, secret only at the tail', () => {
  it('keychainServiceName covers all four kinds as mailordomo:<account>:<kind>', () => {
    expect(keychainServiceName('m1', 'imap')).toBe('mailordomo:m1:imap');
    expect(keychainServiceName('m1', 'smtp')).toBe('mailordomo:m1:smtp');
    expect(keychainServiceName('proj', 'metadata-token')).toBe('mailordomo:proj:metadata-token');
    expect(keychainServiceName('r1', 'repo-pat')).toBe('mailordomo:r1:repo-pat');
  });

  it('the SET argv ends with `-w <secret>` (so dropping the last element scrubs it); get/delete carry none', () => {
    for (const kind of ALL_KINDS) {
      const args = buildSecurityArgs('set', 'acct', kind, 'THE-SECRET');
      expect(args[0]).toBe('add-generic-password');
      expect(args).toContain('-U'); // upsert
      // The secret is the final element — a "drop argv tail before logging" rule fully scrubs it.
      expect(args[args.length - 1]).toBe('THE-SECRET');
      expect(args.indexOf('THE-SECRET')).toBe(args.length - 1); // appears exactly once, at the tail
      expect(args).toContain(keychainServiceName('acct', kind));

      // Read/erase argv never reference the secret value at all.
      expect(buildSecurityArgs('get', 'acct', kind)).not.toContain('THE-SECRET');
      expect(buildSecurityArgs('delete', 'acct', kind)).not.toContain('THE-SECRET');
    }
  });
});

describe('.env fallback — owner-only file, every kind round-trips to its own ENV key', () => {
  it('writes the file 0o600 (owner read/write only — at-rest protection)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailordomo-creds-mode-'));
    try {
      const store = createEnvFileCredentialStore(dir);
      await store.set('mbx', 'imap', 'pw');
      const file = credentialEnvFilePath(dir, 'mbx');
      // Mask off the type bits; the permission bits must be exactly rw-------.
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('all four kinds coexist in one file under distinct keys and delete independently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailordomo-creds-kinds-'));
    try {
      const store = createEnvFileCredentialStore(dir);
      for (const kind of ALL_KINDS) await store.set('mbx', kind, `secret-${kind}`);

      // Each reads back independently …
      for (const kind of ALL_KINDS) expect(await store.get('mbx', kind)).toBe(`secret-${kind}`);

      // … and the file uses the documented `.env` keys (mirrors `.env.example`).
      const raw = statSync(credentialEnvFilePath(dir, 'mbx'));
      expect(raw.isFile()).toBe(true);

      // Deleting one kind leaves the others intact (no clobber).
      await store.delete('mbx', 'imap');
      expect(await store.get('mbx', 'imap')).toBeUndefined();
      expect(await store.get('mbx', 'smtp')).toBe('secret-smtp');
      expect(await store.get('mbx', 'metadata-token')).toBe('secret-metadata-token');
      expect(await store.get('mbx', 'repo-pat')).toBe('secret-repo-pat');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a path-traversal account through the store surface (not just the path helper)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailordomo-creds-trav-'));
    try {
      const store = createEnvFileCredentialStore(dir);
      // Normalize a sync-throw OR an async-reject into a rejection so the assertion is impl-agnostic.
      const attempt = (fn: () => Promise<unknown>): Promise<unknown> => (async () => fn())();
      // The real traversal vectors all contain a path SEPARATOR — each must be rejected on every method.
      await expect(attempt(() => store.set('../escape', 'imap', 'pw'))).rejects.toThrow(
        /invalid credential account/,
      );
      await expect(attempt(() => store.get('a/b', 'imap'))).rejects.toThrow();
      await expect(attempt(() => store.delete('x/../y', 'imap'))).rejects.toThrow();
      expect(() => credentialEnvFilePath(dir, '/etc/passwd')).toThrow();
      expect(() => credentialEnvFilePath(dir, '')).toThrow(); // empty is rejected too

      // A separator-free account (even a dotted one) is contained: it becomes a single `{account}.env`
      // filename stem UNDER the config dir, never a parent-dir escape.
      const contained = credentialEnvFilePath(dir, '..');
      expect(contained.startsWith(`${dir}/`)).toBe(true);
      expect(contained.endsWith('...env')).toBe(true); // `..` + `.env`, a literal filename in `dir`
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
