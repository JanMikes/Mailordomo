/**
 * A STUB {@link MailTransport} (PLAN.md §7 Phase 7b / decision D30; matches the Phase 9 stubbed-SMTP
 * E2E). It NEVER opens a socket and NEVER transmits — it records each composed message it was asked to
 * "send" and echoes back the message's own Message-ID. The manual-send endpoint wires this in until
 * Phase 8 supplies real credentials + swaps in `createNodemailerTransport`.
 *
 * This lives under `smtp/**` (so the reverse no-send guard applies — it must not import the daemon)
 * and is imported ONLY by the API layer's explicit send endpoint (Golden rule #1: sending is always
 * manual; the daemon has no path here).
 */
import type { ComposedMime, MailTransport } from './send';

/** A {@link MailTransport} that records calls instead of transmitting. */
export interface StubMailTransport extends MailTransport {
  /** Every message the transport was asked to send, in order (for inspection / tests). */
  readonly sent: ComposedMime[];
}

/** Create a {@link StubMailTransport}. `response` lets a caller/test stamp the echoed `response`. */
export function createStubMailTransport(
  response = 'stubbed: no SMTP transport configured',
): StubMailTransport {
  const sent: ComposedMime[] = [];
  return {
    sent,
    send(composed: ComposedMime) {
      sent.push(composed);
      // Echo the Message-ID the composer set; never touch the network.
      return Promise.resolve({ messageId: composed.messageId, response });
    },
  };
}
