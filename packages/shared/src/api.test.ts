/**
 * API contract specifics beyond the privacy matrix (privacy.test.ts covers the exhaustive
 * forbidden-key rejection). Here: the auth/pairing boundary and a couple of aggregate responses.
 *
 * PROJECT.md §5 / Golden rule #4: a project's `token_hash` is a stored secret-derived hash and is
 * NEVER echoed to clients — the client-facing `AuthedProject` is identity only.
 */
import { describe, expect, it } from 'vitest';
import {
  AcquireLockResponseSchema,
  AuthedProjectSchema,
  PairRequestSchema,
  PutToneFileResponseSchema,
} from './index';

describe('auth / pairing boundary', () => {
  it('AuthedProject is identity only and rejects an echoed token_hash', () => {
    expect(() => AuthedProjectSchema.parse({ id: 'p1', name: 'Acme' })).not.toThrow();
    // The safely-echoed project must not carry the secret-derived hash.
    expect(() =>
      AuthedProjectSchema.parse({ id: 'p1', name: 'Acme', token_hash: 'hash-abc' }),
    ).toThrow();
  });

  it('PairRequest carries the plaintext token but rejects a smuggled token_hash', () => {
    expect(() => PairRequestSchema.parse({ project_id: 'p1', token: 'secret' })).not.toThrow();
    expect(() =>
      PairRequestSchema.parse({ project_id: 'p1', token: 'secret', token_hash: 'h' }),
    ).toThrow();
  });
});

describe('aggregate responses round-trip', () => {
  it('AcquireLockResponse (acquired flag + current holder lock)', () => {
    const res = {
      acquired: false,
      lock: {
        thread_id: 'th1',
        locked_by: 'simona',
        locked_at: '2026-06-05T09:15:23Z',
        expires_at: '2026-06-05T09:45:23Z',
      },
    };
    expect(AcquireLockResponseSchema.parse(res)).toEqual(res);
  });

  it('PutToneFileResponse (LWW accepted flag + authoritative file)', () => {
    const res = {
      accepted: true,
      file: {
        project_id: 'p1',
        scope: 'project',
        path: 'project/acme.md',
        content: 'Keep it short.',
        version_hash: 'vh-1',
        updated_by: 'jan',
        updated_at: '2026-06-05T09:15:23Z',
      },
    };
    expect(PutToneFileResponseSchema.parse(res)).toEqual(res);
  });
});
