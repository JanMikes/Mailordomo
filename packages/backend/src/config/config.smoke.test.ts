/**
 * SMOKE — the LOCAL ConfigStore + pure mutations (PLAN.md §7 Phase 8, D33).
 *
 * Proves: defaults on a missing/corrupt file (never throws), a persisted round-trip, atomic write +
 * schema validation, and the pure mutations (add project/mailbox, update, link repo) incl. their
 * conflict guards. NO secret ever appears in the config (Golden rule #4) — the schema has no password
 * field, so this is enforced by construction.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MAILORDOMO_CONFIG } from '@mailordomo/shared';
import type {
  LocalRepoConfig,
  MailboxConfig,
  ProjectConfig,
  RepoPointer,
} from '@mailordomo/shared';
import {
  addMailbox,
  addProject,
  ConfigError,
  CONFIG_FILE_NAME,
  createFileConfigStore,
  linkRepo,
  resolveConfigFilePath,
  updateMailbox,
} from './index';

const PROJECT: ProjectConfig = { id: 'p1', name: 'Acme' };
const MAILBOX: MailboxConfig = {
  id: 'm1',
  projectId: 'p1',
  address: 'you@me.com',
  imap: { host: 'imap.mail.me.com', port: 993, secure: true, user: 'you@me.com' },
  smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, user: 'you@me.com' },
};

describe('createFileConfigStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mailordomo-config-'));
    file = join(dir, CONFIG_FILE_NAME);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('read() returns the empty default when the file is missing or corrupt', () => {
    expect(createFileConfigStore(file).read()).toEqual(DEFAULT_MAILORDOMO_CONFIG);
    writeFileSync(file, 'not json', 'utf8');
    expect(createFileConfigStore(file).read()).toEqual(DEFAULT_MAILORDOMO_CONFIG);
  });

  it('update() persists and survives a fresh store; no password field exists', () => {
    const store = createFileConfigStore(file);
    store.update((c) => addProject(c, PROJECT));
    const after = store.update((c) => addMailbox(c, MAILBOX));
    expect(after.projects).toEqual([PROJECT]);
    expect(after.mailboxes).toEqual([MAILBOX]);

    // Survives a fresh store instance (read from disk).
    const reread = createFileConfigStore(file).read();
    expect(reread.mailboxes[0]).toEqual(MAILBOX);
    // The persisted JSON carries no secret (the mailbox shape has no password key by construction).
    expect(JSON.stringify(reread)).not.toMatch(/password|secret|token/i);
  });

  it('write() validates: a smuggled extra key is rejected before disk', () => {
    const store = createFileConfigStore(file);
    expect(() =>
      // @ts-expect-error — an undeclared key (e.g. a smuggled secret) must fail strict validation.
      store.write({ ...DEFAULT_MAILORDOMO_CONFIG, password: 'nope' }),
    ).toThrow();
  });

  it('resolveConfigFilePath honors $MAILORDOMO_CONFIG_DIR', () => {
    expect(resolveConfigFilePath({ MAILORDOMO_CONFIG_DIR: '/tmp/cfg' })).toBe(
      join('/tmp/cfg', CONFIG_FILE_NAME),
    );
  });
});

describe('pure config mutations', () => {
  it('addProject rejects a duplicate id', () => {
    const one = addProject(DEFAULT_MAILORDOMO_CONFIG, PROJECT);
    expect(() => addProject(one, PROJECT)).toThrow(ConfigError);
  });

  it('addMailbox requires a known project and rejects dup id / dup address', () => {
    expect(() => addMailbox(DEFAULT_MAILORDOMO_CONFIG, MAILBOX)).toThrow(/unknown project/);
    const withProject = addProject(DEFAULT_MAILORDOMO_CONFIG, PROJECT);
    const withMailbox = addMailbox(withProject, MAILBOX);
    expect(() => addMailbox(withMailbox, MAILBOX)).toThrow(/already exists/);
    expect(() => addMailbox(withMailbox, { ...MAILBOX, id: 'm2' })).toThrow(/already configured/);
  });

  it('updateMailbox patches non-secret endpoints by id', () => {
    const base = addMailbox(addProject(DEFAULT_MAILORDOMO_CONFIG, PROJECT), MAILBOX);
    const next = updateMailbox(base, 'm1', {
      imap: { host: 'imap.example.com', port: 993, secure: true, user: 'you@me.com' },
    });
    expect(next.mailboxes[0]?.imap.host).toBe('imap.example.com');
    expect(() => updateMailbox(base, 'nope', {})).toThrow(/unknown mailbox/);
  });

  it('linkRepo upserts identity + machine-local config; identity has no local path', () => {
    const pointer: RepoPointer = {
      id: 'r1',
      project_id: 'p1',
      name: 'app',
      git_url: 'https://x/app.git',
    };
    const local: LocalRepoConfig = {
      repo_pointer_id: 'r1',
      local_path: '/Users/me/app',
      active_pull: false,
    };
    const linked = linkRepo(addProject(DEFAULT_MAILORDOMO_CONFIG, PROJECT), pointer, local);
    expect(linked.repoPointers).toEqual([pointer]);
    expect(linked.repos).toEqual([local]);
    expect(JSON.stringify(linked.repoPointers)).not.toContain('/Users/me/app'); // path never in identity

    // Re-link replaces, not duplicates.
    const relinked = linkRepo(
      linked,
      { ...pointer, name: 'app2' },
      { ...local, active_pull: true },
    );
    expect(relinked.repoPointers).toHaveLength(1);
    expect(relinked.repoPointers[0]?.name).toBe('app2');
    expect(relinked.repos[0]?.active_pull).toBe(true);
  });
});
