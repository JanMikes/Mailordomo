/**
 * LIGHT smoke tests for the Phase 6 tone module — proving the modules WIRE + EXPORT and that the
 * seams behave at a glance. The LOAD-BEARING intent-derived suite (layer precedence, the full LWW
 * matrix, sync conflict resolution) is the SEPARATE test-author's job (PLAN.md §4.4). These exist so
 * this commit is meaningful and `verify` exercises the new code.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT_A, startInProcessServer } from '../integration/harness';
import type { InProcessServer } from '../integration/harness';
import { orderToneLayers, resolveToneMemory } from './resolve';
import { decideLww } from './lww';
import { ToneStore, resolveToneDir, toneVersionHash } from './store';
import { syncToneFiles } from './sync';

const tmpDirs: string[] = [];
const servers: InProcessServer[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveToneMemory — layered project → mailbox → contact (contact overrides)', () => {
  it('orders layers project → mailbox → contact regardless of input order', () => {
    const ordered = orderToneLayers([
      { scope: 'contact', content: 'C' },
      { scope: 'project', content: 'P' },
      { scope: 'mailbox', content: 'M' },
    ]);
    expect(ordered.map((l) => l.scope)).toEqual(['project', 'mailbox', 'contact']);
  });

  it('composes contact LAST so it is the most-specific guidance read', () => {
    const doc = resolveToneMemory([
      { scope: 'contact', content: 'contact voice' },
      { scope: 'project', content: 'project voice' },
    ]);
    expect(doc.indexOf('project voice')).toBeLessThan(doc.indexOf('contact voice'));
    expect(doc).toContain('project scope');
    expect(doc).toContain('contact scope');
  });

  it('skips empty layers and yields the empty string when all are absent', () => {
    expect(resolveToneMemory([{ scope: 'project', content: '   ' }])).toBe('');
    expect(resolveToneMemory([])).toBe('');
  });
});

describe('decideLww — push / pull / noop mirroring the server rule', () => {
  it('handles absent sides', () => {
    expect(decideLww(undefined, undefined)).toBe('noop');
    expect(decideLww({ version_hash: 'a', updated_at: '2026-06-05T10:00:00Z' }, undefined)).toBe(
      'push',
    );
    expect(decideLww(undefined, { version_hash: 'a', updated_at: '2026-06-05T10:00:00Z' })).toBe(
      'pull',
    );
  });

  it('newer updated_at wins; ties break on the strictly-greater hash; identical = noop', () => {
    const older = { version_hash: 'h1', updated_at: '2026-06-05T10:00:00Z' };
    const newer = { version_hash: 'h1', updated_at: '2026-06-05T11:00:00Z' };
    expect(decideLww(newer, older)).toBe('push');
    expect(decideLww(older, newer)).toBe('pull');
    // updated_at tie → strictly-greater hash STRING wins ('z9' > 'h1' > 'a0').
    expect(decideLww({ version_hash: 'z9', updated_at: older.updated_at }, older)).toBe('push');
    expect(decideLww({ version_hash: 'a0', updated_at: older.updated_at }, older)).toBe('pull');
    expect(decideLww(older, { ...older })).toBe('noop');
  });
});

describe('ToneStore — local persistence (separate from the disposable cache)', () => {
  it('writes/reads a file with a deterministic content version_hash and adopts a server file', () => {
    const store = ToneStore.open({ dir: tmpDir('mo-tone-'), projectId: PROJECT_A.id });
    const file = store.write({
      scope: 'contact',
      path: 'contact/jan@acme.com.md',
      content: 'Prefer short sign-offs.',
      updated_by: 'jan',
      updated_at: '2026-06-05T10:00:00Z',
    });
    expect(file.version_hash).toBe(toneVersionHash('Prefer short sign-offs.'));
    expect(store.read('contact/jan@acme.com.md')?.content).toBe('Prefer short sign-offs.');

    // adopt = whole-file replacement with the server's verbatim metadata (LWW pull).
    store.adopt({
      project_id: PROJECT_A.id,
      scope: 'contact',
      path: 'contact/jan@acme.com.md',
      content: 'server voice',
      version_hash: 'server-hash',
      updated_by: 'simona',
      updated_at: '2026-06-06T10:00:00Z',
    });
    expect(store.read('contact/jan@acme.com.md')?.content).toBe('server voice');
    expect(store.meta('contact/jan@acme.com.md')?.version_hash).toBe('server-hash');
  });

  it('rejects a path that escapes the tone dir', () => {
    const store = ToneStore.open({ dir: tmpDir('mo-tone-'), projectId: PROJECT_A.id });
    expect(() =>
      store.write({
        scope: 'project',
        path: '../escape.md',
        content: 'x',
        updated_by: 'jan',
        updated_at: '2026-06-05T10:00:00Z',
      }),
    ).toThrow(/escapes/);
  });

  it('resolveToneDir honors TONE_DIR and defaults otherwise', () => {
    expect(resolveToneDir({ TONE_DIR: '/custom/tone' })).toBe('/custom/tone');
    expect(resolveToneDir({})).toBe('.mailordomo-tone');
  });
});

describe('syncToneFiles — push then cross-machine pull against the REAL in-process server', () => {
  it('pushes a local file, and a second (empty) store pulls it back identically', async () => {
    const server = startInProcessServer(PROJECT_A);
    servers.push(server);
    const client = server.client(PROJECT_A);

    const storeA = ToneStore.open({ dir: tmpDir('mo-tone-a-'), projectId: PROJECT_A.id });
    storeA.write({
      scope: 'contact',
      path: 'contact/jan@acme.com.md',
      content: 'voice A',
      updated_by: 'jan',
      updated_at: '2026-06-05T10:00:00Z',
    });

    const pushReport = await syncToneFiles(client, storeA);
    expect(pushReport.pushed).toContain('contact/jan@acme.com.md');

    // A "second machine": a fresh empty store pulls the server's file wholesale.
    const storeB = ToneStore.open({ dir: tmpDir('mo-tone-b-'), projectId: PROJECT_A.id });
    const pullReport = await syncToneFiles(client, storeB);
    expect(pullReport.pulled).toContain('contact/jan@acme.com.md');
    expect(storeB.read('contact/jan@acme.com.md')?.content).toBe('voice A');
    expect(storeB.read('contact/jan@acme.com.md')?.version_hash).toBe(toneVersionHash('voice A'));
  });
});
