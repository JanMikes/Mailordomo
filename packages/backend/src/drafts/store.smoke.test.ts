/**
 * Smoke tests for the LOCAL {@link DraftStore} (Phase 7b, D31) — the file-backed impl + the in-memory
 * fake share the same version-bump + transcript semantics. The exhaustive suite is the separate
 * test-author's job; this just proves the store wires and round-trips.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryDraftStore } from './fake';
import { createFileDraftStore } from './store';
import type { DraftStore, RefineTurn } from './types';

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mailordomo-drafts-'));
  dirs.push(dir);
  return join(dir, 'drafts.db');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const transcript: RefineTurn[] = [
  { role: 'user', content: 'be brief' },
  { role: 'assistant', content: 'Sure — here is a brief reply.' },
];

function sharedContract(makeStore: () => DraftStore, label: string): void {
  describe(`DraftStore contract — ${label}`, () => {
    it('returns undefined for an unknown thread', () => {
      expect(makeStore().getDraft('nope')).toBeUndefined();
    });

    it('saves, round-trips the transcript, and bumps version on each save', () => {
      const store = makeStore();
      const v1 = store.saveDraft('t1', {
        body: 'draft one',
        model: 'opus',
        author: 'claude',
        transcript,
        createdAt: '2026-06-05T10:00:00.000Z',
      });
      expect(v1.version).toBe(1);
      expect(v1.body).toBe('draft one');
      expect(v1.transcript).toEqual(transcript);
      expect(store.getDraft('t1')).toEqual(v1);

      const v2 = store.saveDraft('t1', {
        body: 'draft two',
        model: 'opus',
        author: 'claude',
        transcript: [...transcript, { role: 'user', content: 'shorter' }],
      });
      expect(v2.version).toBe(2);
      expect(store.getDraft('t1')?.body).toBe('draft two');
      expect(store.getDraft('t1')?.transcript).toHaveLength(3);
    });

    it('clears a draft', () => {
      const store = makeStore();
      store.saveDraft('t1', { body: 'x', model: 'opus', author: 'claude', transcript: [] });
      store.clearDraft('t1');
      expect(store.getDraft('t1')).toBeUndefined();
      store.clearDraft('t1'); // idempotent
    });
  });
}

sharedContract(() => createMemoryDraftStore(), 'in-memory fake');
sharedContract(() => createFileDraftStore(':memory:'), 'file-backed (:memory:)');

describe('createFileDraftStore — persists across reopen', () => {
  it('reads back a saved draft from a fresh handle on the same file', () => {
    const path = tempDb();
    const a = createFileDraftStore(path);
    a.saveDraft('t1', { body: 'persisted', model: 'opus', author: 'claude', transcript });
    const b = createFileDraftStore(path);
    const got = b.getDraft('t1');
    expect(got?.body).toBe('persisted');
    expect(got?.version).toBe(1);
    expect(got?.transcript).toEqual(transcript);
  });
});
