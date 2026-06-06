/**
 * The read-only IMAP `test-connection` seam (PLAN.md §7 Phase 8, D33). The wizard verifies a mailbox
 * by attempting a STRICTLY READ-ONLY login (the Phase 3 `verify-mailbox` pattern) and reporting
 * `{ ok, reason }` — NEVER any credential.
 *
 * GOLDEN RULES: #1 — this LOGS IN and LOGS OUT only; it issues no STORE/APPEND/MOVE and never sends.
 * #3 — it reads no message bodies (it opens INBOX read-only purely to confirm access, then closes).
 * #4 — the password is used transiently for the login and is NEVER placed in the returned `reason`.
 *
 * The tester is an INJECTABLE interface so tests pass a FAKE — CI performs no live login. The real
 * impl ({@link createImapConnectionTester}) constructs an `ImapFlow` exactly like `verify-mailbox.ts`.
 */
import { ImapFlow } from 'imapflow';
import type { TestConnectionResult } from '@mailordomo/shared';

/** The connection parameters for a read-only login. `pass` is used transiently, never returned. */
export interface ImapTestParams {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly pass: string;
}

/** Attempt a read-only IMAP login and report the outcome (no credential in the result). */
export interface ImapConnectionTester {
  test(params: ImapTestParams): Promise<TestConnectionResult>;
}

/**
 * The real {@link ImapConnectionTester} — a live read-only login via `imapflow`. Connects, opens
 * INBOX read-only to confirm access, then logs out. Any failure (bad host, auth rejected, TLS) is
 * returned as `{ ok:false, reason }` with the provider's message — which carries no password.
 */
export function createImapConnectionTester(): ImapConnectionTester {
  return {
    async test(params): Promise<TestConnectionResult> {
      const client = new ImapFlow({
        host: params.host,
        port: params.port,
        secure: params.secure,
        auth: { user: params.user, pass: params.pass },
        logger: false,
      });
      try {
        await client.connect();
        // Open INBOX read-only purely to confirm mailbox access; we read no message content.
        await client.mailboxOpen('INBOX', { readOnly: true });
        return { ok: true, reason: 'connected and opened INBOX read-only' };
      } catch (cause) {
        return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
      } finally {
        // Best-effort clean logout; never let a logout error mask the real result.
        try {
          await client.logout();
        } catch {
          client.close();
        }
      }
    },
  };
}
