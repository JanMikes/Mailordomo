/**
 * INTENT (separate test-author) — the file-backed settings store (PLAN.md D27/D29). ADDITIVE to
 * `store.smoke.test.ts`: it pins the robustness contracts the smoke does not, derived from the spec
 * intent ("the app is always usable; a bad write never corrupts the config"):
 *  - defaults on a MISSING DIRECTORY (not just a missing file), never throwing;
 *  - a write CREATES the missing dir tree and persists;
 *  - validate-BEFORE-disk: a rejected write (`-1`, bad colorScheme) leaves the last good file intact;
 *  - a stored file with an UNKNOWN key falls back to defaults (strict schema, no throw);
 *  - a partial patch deep-merges over the CURRENT on-disk value (not over defaults).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppSettings } from '@mailordomo/shared';
import { DEFAULT_APP_SETTINGS } from '@mailordomo/shared';
import { createFileSettingsStore, SETTINGS_FILE_NAME } from './store';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'mailordomo-settings-intent-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

/** A settings.json path nested under directories that DO NOT yet exist. */
function missingDirFile(): string {
  return join(baseDir, 'does', 'not', 'exist', SETTINGS_FILE_NAME);
}

describe('createFileSettingsStore — robustness on a missing config tree', () => {
  it('read() returns defaults when the parent DIRECTORY is absent (never throws)', () => {
    const store = createFileSettingsStore(missingDirFile());
    expect(() => store.read()).not.toThrow();
    expect(store.read()).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('write() creates the missing directory tree, persists, and a fresh store reads it back', () => {
    const file = missingDirFile();
    const store = createFileSettingsStore(file);
    const updated = store.write({ lockTimeoutMinutes: 42 });

    expect(existsSync(file)).toBe(true);
    expect(updated).toEqual({ ...DEFAULT_APP_SETTINGS, lockTimeoutMinutes: 42 });
    expect(createFileSettingsStore(file).read()).toEqual(updated); // persisted, not just in-memory
  });
});

describe('createFileSettingsStore — validate before disk (a bad write never corrupts)', () => {
  it('rejects waitingStaleDays = -1 AND leaves the previously-persisted file intact', () => {
    const file = join(baseDir, SETTINGS_FILE_NAME);
    const store = createFileSettingsStore(file);
    store.write({ waitingStaleDays: 8 }); // a good value lands first

    expect(() => store.write({ waitingStaleDays: -1 })).toThrow();
    // The rejected write must not have touched disk: the last good value survives.
    expect(store.read().waitingStaleDays).toBe(8);
    expect(createFileSettingsStore(file).read().waitingStaleDays).toBe(8);
  });

  it('rejects an out-of-vocabulary colorScheme', () => {
    const store = createFileSettingsStore(join(baseDir, SETTINGS_FILE_NAME));
    expect(() =>
      store.write({ colorScheme: 'aquamarine' as AppSettings['colorScheme'] }),
    ).toThrow();
  });
});

describe('createFileSettingsStore — strict schema + deep merge', () => {
  it('a stored file carrying an UNKNOWN key falls back to defaults (strict, no throw)', () => {
    const file = join(baseDir, SETTINGS_FILE_NAME);
    writeFileSync(file, JSON.stringify({ ...DEFAULT_APP_SETTINGS, surpriseKey: true }), 'utf8');
    const store = createFileSettingsStore(file);
    expect(() => store.read()).not.toThrow();
    expect(store.read()).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('a partial patch merges over the CURRENT on-disk value, not over defaults', () => {
    const file = join(baseDir, SETTINGS_FILE_NAME);
    const store = createFileSettingsStore(file);
    store.write({ waitingStaleDays: 9 });
    store.write({ colorScheme: 'dark' }); // a SECOND, disjoint patch

    expect(store.read()).toEqual({
      ...DEFAULT_APP_SETTINGS,
      waitingStaleDays: 9, // preserved from the first write
      colorScheme: 'dark', // applied by the second
    });
    // And the on-disk JSON is exactly the merged object (round-trips through the schema).
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(store.read());
  });
});
