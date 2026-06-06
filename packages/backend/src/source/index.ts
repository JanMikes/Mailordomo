/**
 * @mailordomo/backend · source — the LIVE daemon message source (PLAN.md D35).
 *
 * Bridges the Phase 3 transport (resilient IMAP connection + `MailboxSync`), the disposable cache, the
 * JWZ threading engine, and the metadata service into the {@link DaemonSource} the Phase 9 daemon
 * consumes: IMAP poll → cache → enumerate new arrivals (already upserted as metadata threads). It is a
 * COMPOSITION module injected into the daemon from the api/server composition root — it lives OUTSIDE
 * `daemon/**` so the orchestrator stays decoupled from transport (it only sees the `DaemonSource`
 * interface) and structurally send-proof. Bodies are read LOCALLY; only sanctioned thread metadata
 * crosses the privacy boundary (golden rules #1/#2/#3).
 */
export * from './cache-source';
