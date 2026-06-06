/**
 * The `.env`-file fallback {@link CredentialStore} (PLAN.md §7 Phase 8, D33) — a per-account
 * `{account}.env` under the config dir, for dev / non-macOS where the Keychain isn't used.
 *
 * SECURITY (Golden rule #4): these files are GITIGNORED (`*.env`, see `.gitignore`) so they never get
 * committed, and are written with owner-only permissions (`0o600`). The secret is NEVER logged. This
 * is a documented FALLBACK; the Keychain store is the default (D22). One file per account keeps a
 * mailbox's secrets isolated and mirrors the `{mailboxName}.env` shape in PROJECT.md §10.
 *
 * Format: plain `KEY=value` lines (the standard `.env` shape Mailordomo already documents). The store
 * UPSERTS just its one key per `kind` and PRESERVES every other line (comments + unrelated keys), so a
 * hand-edited dev `.env` survives a programmatic write.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertSafeAccount, type CredentialKind, type CredentialStore } from './types';

/** Map a credential kind to the `.env` KEY it occupies (mirrors `.env.example`). */
const ENV_KEY_BY_KIND: Readonly<Record<CredentialKind, string>> = {
  imap: 'IMAP_PASSWORD',
  smtp: 'SMTP_PASSWORD',
  'metadata-token': 'METADATA_PROJECT_TOKEN',
  'repo-pat': 'REPO_PAT',
};

/** The per-account file path: `<configDir>/<account>.env`. */
export function credentialEnvFilePath(configDir: string, account: string): string {
  assertSafeAccount(account);
  return join(configDir, `${account}.env`);
}

/** Read a `.env` file into `KEY → value` (first `=` splits; value kept verbatim). Missing file → {}. */
function readEnvFile(path: string): Map<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return new Map();
  }
  const out = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  return out;
}

/**
 * Upsert or remove a single KEY in the file, preserving all other lines. Atomic (temp + rename) and
 * `0o600`. `value === undefined` removes the key.
 */
function writeEnvKey(path: string, key: string, value: string | undefined): void {
  let existing: string;
  try {
    existing = readFileSync(path, 'utf8');
  } catch {
    existing = '';
  }
  const lines = existing === '' ? [] : existing.split('\n');
  // Drop a trailing empty line from the split so we don't accumulate blank lines on each write.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let replaced = false;
  const kept: string[] = [];
  for (const line of lines) {
    const eq = line.indexOf('=');
    const lineKey = eq > 0 ? line.slice(0, eq).trim() : '';
    if (lineKey === key) {
      if (value !== undefined && !replaced) {
        kept.push(`${key}=${value}`);
        replaced = true;
      }
      // else: drop this line (removal, or a duplicate after we've already written one)
      continue;
    }
    kept.push(line);
  }
  if (value !== undefined && !replaced) kept.push(`${key}=${value}`);

  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, kept.length === 0 ? '' : `${kept.join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(tmp, path);
  // Ensure perms even if the file pre-existed with looser bits.
  chmodSync(path, 0o600);
}

/**
 * A `.env`-file-backed {@link CredentialStore} rooted at `configDir`. Each account gets its own
 * `{account}.env`. The runnable entry resolves `configDir` via `resolveConfigDir`; tests pass a temp
 * dir (but CI should prefer {@link createMemoryCredentialStore} to avoid any file IO).
 */
export function createEnvFileCredentialStore(configDir: string): CredentialStore {
  function pathFor(account: string): string {
    return credentialEnvFilePath(configDir, account);
  }
  return {
    get: (account, kind) => {
      assertSafeAccount(account);
      return Promise.resolve(readEnvFile(pathFor(account)).get(ENV_KEY_BY_KIND[kind]));
    },
    set: (account, kind, secret) => {
      assertSafeAccount(account);
      writeEnvKey(pathFor(account), ENV_KEY_BY_KIND[kind], secret);
      return Promise.resolve();
    },
    delete: (account, kind) => {
      assertSafeAccount(account);
      writeEnvKey(pathFor(account), ENV_KEY_BY_KIND[kind], undefined);
      return Promise.resolve();
    },
  };
}
