/**
 * macOS Keychain {@link CredentialStore} via the `security` CLI (PLAN.md §7 Phase 8, D33/D22) — the
 * Keychain-first default, with NO native dependency.
 *
 * SECURITY (Golden rule #4):
 *   - Spawned with `execFile`-style `spawn` (args ARRAY, NEVER a shell string) so the secret is not
 *     subject to shell interpretation/injection.
 *   - The secret is NEVER logged and NEVER placed in a thrown error. We use `spawn` (not the
 *     promisified `execFile`) specifically because `execFile`'s rejection embeds the full argv —
 *     including `-w <secret>` — in `error.cmd`; `spawn` does not, so a leaked/logged error can't carry
 *     the secret.
 *   - KNOWN, ACCEPTED TRADEOFF: `security add-generic-password … -w <secret>` passes the secret in
 *     argv, which is briefly visible to the LOCAL user via `ps`. This is inherent to the no-native-dep
 *     `security` choice; the `.env` fallback has the same class of local-user exposure. Documented and
 *     accepted for v1 (the alternative is a native Keychain binding).
 *
 * Item identity: `account` = the entity id; service = `mailordomo:<account>:<kind>`. `find`/`delete`
 * match on (`-a account`, `-s service`). `add -U` upserts.
 */
import { spawn } from 'node:child_process';
import { assertSafeAccount, type CredentialKind, type CredentialStore } from './types';

/** The Keychain *service* attribute for a credential slot — `mailordomo:<account>:<kind>`. */
export function keychainServiceName(account: string, kind: CredentialKind): string {
  return `mailordomo:${account}:${kind}`;
}

/**
 * Build the EXACT `security` argv (excluding the leading `security` program name) for one operation —
 * PURE, so a test can assert correctness WITHOUT spawning anything. For `set`, the secret is the LAST
 * arg (`-w <secret>`); callers that log argv MUST drop it (this module never logs argv).
 */
export function buildSecurityArgs(
  op: 'set' | 'get' | 'delete',
  account: string,
  kind: CredentialKind,
  secret?: string,
): string[] {
  const service = keychainServiceName(account, kind);
  switch (op) {
    case 'set':
      // -U updates an existing item instead of erroring; -w <secret> sets the password.
      return ['add-generic-password', '-U', '-a', account, '-s', service, '-w', secret ?? ''];
    case 'get':
      // -w prints ONLY the password to stdout (no attributes), which keeps parsing trivial.
      return ['find-generic-password', '-a', account, '-s', service, '-w'];
    case 'delete':
      return ['delete-generic-password', '-a', account, '-s', service];
  }
}

/** `security` exit code for "item not found" — both find and delete use it. */
const ERR_ITEM_NOT_FOUND = 44;

interface SecurityResult {
  readonly code: number | null;
  readonly stdout: string;
}

/**
 * Spawn `security` with an args array. NEVER throws on a non-zero exit (returns the code so callers
 * can distinguish "not found" from real failure); rejects ONLY when the binary can't be spawned at
 * all (e.g. not macOS). No error here ever contains the argv/secret.
 */
function runSecurity(args: readonly string[]): Promise<SecurityResult> {
  return new Promise<SecurityResult>((resolve, reject) => {
    const child = spawn('security', args as string[], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', (cause) => {
      // ENOENT etc. — `security` unavailable. Message names only the binary, never the args/secret.
      reject(new Error(`could not run the macOS "security" CLI: ${cause.message}`));
    });
    child.on('close', (code) => {
      resolve({ code, stdout });
    });
  });
}

/**
 * A Keychain-backed {@link CredentialStore}. Construct only on macOS (where `security` exists); the
 * factory in `index.ts` falls back to `.env` elsewhere.
 */
export function createKeychainCredentialStore(): CredentialStore {
  async function set(account: string, kind: CredentialKind, secret: string): Promise<void> {
    assertSafeAccount(account);
    const { code } = await runSecurity(buildSecurityArgs('set', account, kind, secret));
    if (code !== 0) {
      // No argv/secret in the message — only the slot it targeted.
      throw new Error(`keychain set failed for (${account}, ${kind}) — exit ${code}`);
    }
  }

  async function get(account: string, kind: CredentialKind): Promise<string | undefined> {
    assertSafeAccount(account);
    const { code, stdout } = await runSecurity(buildSecurityArgs('get', account, kind));
    if (code === ERR_ITEM_NOT_FOUND) return undefined;
    if (code !== 0) {
      throw new Error(`keychain get failed for (${account}, ${kind}) — exit ${code}`);
    }
    // `-w` prints the password followed by a single trailing newline; strip exactly that.
    return stdout.replace(/\n$/, '');
  }

  async function del(account: string, kind: CredentialKind): Promise<void> {
    assertSafeAccount(account);
    const { code } = await runSecurity(buildSecurityArgs('delete', account, kind));
    // Idempotent: deleting an absent item (44) is a no-op, not an error.
    if (code !== 0 && code !== ERR_ITEM_NOT_FOUND) {
      throw new Error(`keychain delete failed for (${account}, ${kind}) — exit ${code}`);
    }
  }

  return { get, set, delete: del };
}
