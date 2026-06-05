/**
 * IMAP sync engine (imapflow): one connection per watched mailbox, OWN reconnect/backoff, IDLE hot
 * folders + poll cold ones, incremental UID/modseq sync with uidValidity invalidation.
 *
 * The seam (`types.ts`) and the pure delta logic (`sync-plan.ts` / `backoff.ts`) are what make the
 * whole engine testable against a FAKE client with no live server; `imapflow-client.ts` is the only
 * real-IO piece.
 */
export * from './types';
export * from './backoff';
export * from './sync-plan';
export * from './mailbox-sync';
export * from './connection';
export * from './watcher';
export * from './imapflow-client';
