/**
 * SMTP send path (nodemailer) — the ONLY place mail is transmitted, and ONLY ever as the result
 * of an explicit user action (Golden rule #1: sending is always manual).
 *
 * STRUCTURAL NO-SEND GUARD (PLAN.md §4.6): this module must NOT import anything under
 * `../daemon/**`. Keeping the daemon and the send path in separate modules with no import path
 * between them makes an accidental autonomous-send wiring a lint failure, not just a test failure.
 *
 * Phase 0 is the marker + a documented placeholder; the real send (set In-Reply-To/References,
 * append to Sent/Drafts via SPECIAL-USE folder resolution) lands in Phase 3.
 */
export const SEND_MODULE = 'mailordomo-smtp-send' as const;

/**
 * Placeholder for the real send entrypoint. Documents the invariant that a send only ever happens
 * downstream of an explicit user action — never from the daemon.
 */
export function assertManualSendOnly(): typeof SEND_MODULE {
  return SEND_MODULE;
}
