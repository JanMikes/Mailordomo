import { describe, expect, it } from 'vitest';
import {
  coarseStateToFolder,
  evaluateTransition,
  folderToCoarseState,
  resolveEvent,
  resolveSpecialUseFolders,
  taskStateToFolder,
  toCoarseState,
} from './index';

/**
 * Minimal smoke coverage for the pure engines (the separate test author owns the exhaustive suite).
 * These just prove the public seams work and are wired to the shared transition table.
 */

describe('folder-mapper (smoke)', () => {
  const map = { active: 'INBOX', waiting: 'Mailordomo/Waiting', done: 'Archive' };

  it('projects fine states onto coarse buckets and back through folders', () => {
    expect(toCoarseState('needs-reply')).toBe('active');
    expect(toCoarseState('follow-up')).toBe('waiting');
    expect(taskStateToFolder('done', map)).toBe('Archive');
    expect(coarseStateToFolder('waiting', map)).toBe('Mailordomo/Waiting');
    expect(folderToCoarseState('inbox', map)).toBe('active'); // INBOX is case-insensitive
    expect(folderToCoarseState('Spam', map)).toBeUndefined();
  });

  it('falls back to the active folder when no waiting folder is configured', () => {
    expect(coarseStateToFolder('waiting', { active: 'INBOX', done: 'Archive' })).toBe('INBOX');
  });

  it('resolves SPECIAL-USE folders by flag, never by English name', () => {
    const resolved = resolveSpecialUseFolders([
      { path: 'INBOX', flags: new Set(['\\Inbox']) },
      { path: 'Odeslané', specialUse: '\\Sent', flags: new Set(['\\Sent']) },
      { path: 'Koncepty', specialUse: '\\Drafts' },
      { path: 'Koš', flags: ['\\Trash'] },
    ]);
    expect(resolved.sent).toBe('Odeslané');
    expect(resolved.drafts).toBe('Koncepty');
    expect(resolved.trash).toBe('Koš');
  });
});

describe('state-machine (smoke)', () => {
  it('auto-applies the obvious transitions (§6)', () => {
    expect(resolveEvent('drafted', 'user-sent')).toMatchObject({ kind: 'apply', to: 'waiting' });
    expect(resolveEvent('needs-reply', 'inbound-thanks')).toMatchObject({
      kind: 'apply',
      to: 'done',
    });
  });

  it('proposes the ambiguous ones', () => {
    expect(resolveEvent('done', 'new-inbound')).toMatchObject({
      kind: 'propose',
      to: 'needs-reply',
    });
  });

  it('is a no-op when no legal edge exists from the current state', () => {
    expect(resolveEvent('needs-reply', 'user-sent')).toMatchObject({
      kind: 'noop',
      reason: 'no-legal-transition',
    });
  });

  it('validates a direct transition against the table', () => {
    expect(evaluateTransition('drafted', 'waiting')).toMatchObject({ allowed: true, auto: true });
    expect(evaluateTransition('needs-reply', 'follow-up')).toMatchObject({ allowed: false });
  });
});
