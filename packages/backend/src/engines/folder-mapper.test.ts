import { describe, expect, it } from 'vitest';
import { TASK_STATES } from '@mailordomo/shared';
import {
  COARSE_TASK_STATES,
  coarseStateToFolder,
  folderToCoarseState,
  resolveSpecialUseFolders,
  taskStateToFolder,
  toCoarseState,
} from './folder-mapper';
import type { CoarseFolderMap, FolderLike } from './folder-mapper';

/**
 * Load-bearing suite for the IMAP folder mapper, derived from PROJECT.md §6 (coarse task state
 * mirrored to real IMAP folders: done / not-done, optionally waiting) and §4 (resolve Sent/Drafts/
 * Trash/Junk by SPECIAL-USE flag — NEVER by English folder name). Authored against intent.
 */

describe('toCoarseState — §6 projection of the 5-state machine onto folder buckets', () => {
  it('maps not-done work to active, ball-in-their-court to waiting, closed to done', () => {
    expect(toCoarseState('needs-reply')).toBe('active');
    expect(toCoarseState('drafted')).toBe('active');
    expect(toCoarseState('waiting')).toBe('waiting');
    expect(toCoarseState('follow-up')).toBe('waiting');
    expect(toCoarseState('done')).toBe('done');
  });

  it('is total over every task state (no state falls through)', () => {
    for (const state of TASK_STATES) {
      expect(COARSE_TASK_STATES).toContain(toCoarseState(state));
    }
  });
});

describe('folder mapping — both directions round-trip at the coarse grain', () => {
  const map: CoarseFolderMap = {
    active: 'INBOX',
    waiting: 'Mailordomo/Waiting',
    done: 'Mailordomo/Done',
  };

  it('coarse → folder → coarse is the identity for every coarse bucket', () => {
    for (const coarse of COARSE_TASK_STATES) {
      expect(folderToCoarseState(coarseStateToFolder(coarse, map), map)).toBe(coarse);
    }
  });

  it('routes each fine task state to the folder its coarse bucket maps to', () => {
    expect(taskStateToFolder('needs-reply', map)).toBe('INBOX');
    expect(taskStateToFolder('drafted', map)).toBe('INBOX');
    expect(taskStateToFolder('waiting', map)).toBe('Mailordomo/Waiting');
    expect(taskStateToFolder('follow-up', map)).toBe('Mailordomo/Waiting');
    expect(taskStateToFolder('done', map)).toBe('Mailordomo/Done');
  });

  it('returns undefined for a folder outside the three mapped buckets', () => {
    expect(folderToCoarseState('Spam', map)).toBeUndefined();
    expect(folderToCoarseState('Some/Personal/Folder', map)).toBeUndefined();
  });
});

describe('folder mapping — INBOX is case-insensitive, other folders are exact', () => {
  const map: CoarseFolderMap = { active: 'INBOX', done: 'Archive' };

  it('treats INBOX case-insensitively (RFC 3501)', () => {
    expect(folderToCoarseState('inbox', map)).toBe('active');
    expect(folderToCoarseState('InBoX', map)).toBe('active');
    expect(folderToCoarseState('INBOX', map)).toBe('active');
  });

  it('compares non-INBOX folder names exactly (case-sensitive)', () => {
    // 'archive' !== 'Archive' for a non-INBOX folder ⇒ not recognised as the done bucket.
    expect(folderToCoarseState('archive', map)).toBeUndefined();
    expect(folderToCoarseState('Archive', map)).toBe('done');
  });
});

describe('folder mapping — unconfigured waiting falls back to active (§6 "optionally waiting")', () => {
  const noWaiting: CoarseFolderMap = { active: 'INBOX', done: 'Archive' };

  it('waiting items stay in the active folder when no waiting folder is configured', () => {
    expect(coarseStateToFolder('waiting', noWaiting)).toBe('INBOX');
    expect(taskStateToFolder('waiting', noWaiting)).toBe('INBOX');
    expect(taskStateToFolder('follow-up', noWaiting)).toBe('INBOX');
  });

  it('the active folder still reverse-maps to active (waiting is not separately addressable)', () => {
    expect(folderToCoarseState('INBOX', noWaiting)).toBe('active');
  });
});

describe('resolveSpecialUseFolders — picks by RFC 6154 flag, NEVER by English name', () => {
  it('chooses the flagged folder even when its display name is localized or contradictory', () => {
    // A DECOY named "Sent" with NO special-use flag is listed FIRST; the real Sent is the
    // localized "Gesendet" carrying \Sent. A name-based resolver would wrongly pick the decoy.
    const folders: FolderLike[] = [
      { path: 'Sent', flags: new Set<string>() }, // decoy: English name, no flag
      { path: 'INBOX', flags: new Set(['\\Inbox']) },
      { path: 'Gesendet', specialUse: '\\Sent' }, // localized "Sent", correctly flagged
      { path: 'Vorlagen', specialUse: '\\Drafts' }, // localized "Drafts"
      { path: 'Papierkorb', flags: new Set(['\\Trash']) }, // localized "Trash" (flag in flag-set)
      { path: 'Spam-Ordner', specialUse: '\\Junk' }, // localized "Junk"
      { path: 'Alle Nachrichten', specialUse: '\\Archive' }, // localized "Archive"
    ];

    const resolved = resolveSpecialUseFolders(folders);

    expect(resolved.sent).toBe('Gesendet'); // by \Sent flag, NOT the name-matching decoy
    expect(resolved.drafts).toBe('Vorlagen');
    expect(resolved.trash).toBe('Papierkorb');
    expect(resolved.junk).toBe('Spam-Ordner');
    expect(resolved.archive).toBe('Alle Nachrichten');
    expect(resolved.inbox).toBe('INBOX');
  });

  it('matches the flag token case-insensitively, from specialUse or the flag set', () => {
    expect(resolveSpecialUseFolders([{ path: 'X', specialUse: '\\sent' }]).sent).toBe('X');
    expect(resolveSpecialUseFolders([{ path: 'Y', flags: new Set(['\\DRAFTS']) }]).drafts).toBe(
      'Y',
    );
  });

  it('keeps the first match per key (stable over the list order)', () => {
    const dup: FolderLike[] = [
      { path: 'Sent-A', specialUse: '\\Sent' },
      { path: 'Sent-B', specialUse: '\\Sent' },
    ];
    expect(resolveSpecialUseFolders(dup).sent).toBe('Sent-A');
  });

  it('returns no keys for folders that advertise no special use', () => {
    expect(resolveSpecialUseFolders([{ path: 'Random', flags: new Set<string>() }])).toEqual({});
    expect(resolveSpecialUseFolders([{ path: 'Plain' }])).toEqual({});
  });
});
