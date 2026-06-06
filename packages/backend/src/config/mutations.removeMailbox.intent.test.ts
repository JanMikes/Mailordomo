/**
 * INTENT (separate test-author) — the pure `removeMailbox` config mutation (PLAN.md §7 Phase 8, D33).
 * Mirrors the `config.smoke.test.ts` style for the sibling helpers (`addMailbox`/`updateMailbox`): a
 * small, side-effect-free function over a {@link MailordomoConfig}.
 *
 * The intended contract:
 *   - removes the mailbox with the given id, leaving every other mailbox (and the rest of the config)
 *     untouched;
 *   - throws a typed {@link ConfigError} with code `'not_found'` when the id is absent;
 *   - is PURE — it never mutates its input (returns a new config) and carries NO secret (Golden rule
 *     #4: the config shape has no password field by construction; credentials are the handler's job).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAILORDOMO_CONFIG } from '@mailordomo/shared';
import type { MailboxConfig, MailordomoConfig, ProjectConfig } from '@mailordomo/shared';
import { addMailbox, addProject, ConfigError, removeMailbox } from './index';

const PROJECT: ProjectConfig = { id: 'p1', name: 'Acme' };

function mailbox(id: string, address: string): MailboxConfig {
  return {
    id,
    projectId: 'p1',
    address,
    imap: { host: 'imap.mail.me.com', port: 993, secure: true, user: address },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, user: address },
  };
}

const M1 = mailbox('m1', 'one@me.com');
const M2 = mailbox('m2', 'two@me.com');

/** A config with one project + two mailboxes, built via the sibling pure helpers. */
function seeded(): MailordomoConfig {
  return addMailbox(addMailbox(addProject(DEFAULT_MAILORDOMO_CONFIG, PROJECT), M1), M2);
}

describe('removeMailbox — the pure config mutation', () => {
  it('removes the target mailbox and leaves the others in place', () => {
    const next = removeMailbox(seeded(), 'm1');
    expect(next.mailboxes).toEqual([M2]);
    // The rest of the config is carried through unchanged.
    expect(next.projects).toEqual([PROJECT]);
    expect(next.repoPointers).toEqual([]);
    expect(next.repos).toEqual([]);
  });

  it('removing the last remaining mailbox yields an empty list', () => {
    const single = addMailbox(addProject(DEFAULT_MAILORDOMO_CONFIG, PROJECT), M1);
    expect(removeMailbox(single, 'm1').mailboxes).toEqual([]);
  });

  it('throws ConfigError(not_found) for an unknown id', () => {
    const base = seeded();
    expect(() => removeMailbox(base, 'nope')).toThrow(ConfigError);
    expect(() => removeMailbox(base, 'nope')).toThrow(/unknown mailbox/);
    // The typed code drives the API's 404 mapping.
    try {
      removeMailbox(base, 'nope');
      expect.unreachable('removeMailbox should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe('not_found');
    }
  });

  it('throws not_found on an empty config (no mailboxes to remove)', () => {
    expect(() => removeMailbox(DEFAULT_MAILORDOMO_CONFIG, 'm1')).toThrow(ConfigError);
  });

  it('is PURE — the input config (and its mailbox array) is not mutated', () => {
    const base = seeded();
    const snapshot = structuredClone(base);
    const next = removeMailbox(base, 'm1');

    // Input is byte-for-byte unchanged …
    expect(base).toEqual(snapshot);
    expect(base.mailboxes).toHaveLength(2);
    // … and a NEW array/object is returned (not the same reference).
    expect(next).not.toBe(base);
    expect(next.mailboxes).not.toBe(base.mailboxes);
  });

  it('removes only the matching id even when two mailboxes share an address-prefix', () => {
    // Guards against a substring/`startsWith` bug: ids are matched by equality, not prefix.
    const m1b = mailbox('m1b', 'oneb@me.com');
    const cfg = addMailbox(seeded(), m1b);
    const next = removeMailbox(cfg, 'm1');
    expect(next.mailboxes.map((m) => m.id)).toEqual(['m2', 'm1b']);
  });
});
