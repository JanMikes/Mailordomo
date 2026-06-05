/**
 * OWN reconnection for a single watched mailbox. ImapFlow does NOT auto-reconnect (PROJECT.md §4),
 * so this owns the lifecycle: on `'close'`/`'error'` it tears the client down and reconnects with
 * exponential backoff + jitter ({@link backoffDelay}); on each successful (re)connect it invokes
 * `onReady`, which is where the sync engine re-opens the mailbox, re-validates `uidValidity`, and
 * resyncs from the last-seen UID/modseq.
 *
 * The client FACTORY and the timer API are injected, so the test author can simulate drops and
 * assert reconnect/backoff behavior with a fake client and a fake clock — no live server, no real
 * waiting.
 */
import { backoffDelay } from './backoff';
import type { BackoffOptions } from './backoff';
import type { ImapClient, Unsubscribe } from './types';

export type TimerHandle = unknown;

export interface TimerApi {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const realTimers: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type DropKind = 'close' | 'error' | 'connect-error';

export interface ImapConnectionOptions {
  /** Builds a fresh client for each connect attempt (real imapflow adapter, or a fake in tests). */
  readonly clientFactory: () => ImapClient;
  readonly backoff?: BackoffOptions;
  /** Give up after this many consecutive failed attempts. Default: never give up. */
  readonly maxAttempts?: number;
  readonly timers?: TimerApi;
  readonly rng?: () => number;
  readonly logger?: (message: string, meta?: unknown) => void;
  /** Run after every successful (re)connect: re-open mailbox, re-validate uidValidity, resync. */
  readonly onReady?: (client: ImapClient) => Promise<void> | void;
  /** Observe drops (for tests / metrics). Does not affect reconnection. */
  readonly onDrop?: (kind: DropKind, error?: Error) => void;
}

export class ResilientImapConnection {
  private readonly options: ImapConnectionOptions;
  private readonly timers: TimerApi;
  private current: ImapClient | null = null;
  private unsubscribers: Unsubscribe[] = [];
  private attempt = 0;
  private stopped = true;
  private reconnectTimer: TimerHandle | null = null;

  constructor(options: ImapConnectionOptions) {
    this.options = options;
    this.timers = options.timers ?? realTimers;
  }

  /** The live client, or `null` while disconnected / between reconnect attempts. */
  get client(): ImapClient | null {
    return this.current;
  }

  /** Connect (and keep reconnecting until {@link stop}). */
  async start(): Promise<void> {
    this.stopped = false;
    this.attempt = 0;
    await this.openOnce();
  }

  /** Stop reconnecting and tear down the current client. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownCurrent();
  }

  private async openOnce(): Promise<void> {
    if (this.stopped) return;
    const client = this.options.clientFactory();
    this.current = client;
    // Subscribe BEFORE connect so an immediate failure is observed.
    this.unsubscribers.push(client.onClose(() => this.handleDrop(client, 'close')));
    this.unsubscribers.push(client.onError((error) => this.handleDrop(client, 'error', error)));

    try {
      await client.connect();
    } catch (error) {
      this.handleDrop(client, 'connect-error', error as Error);
      return;
    }

    if (this.stopped) {
      this.teardownCurrent();
      return;
    }
    this.attempt = 0; // a clean connect resets the backoff
    try {
      await this.options.onReady?.(client);
    } catch (error) {
      this.options.logger?.('onReady failed', error);
      this.handleDrop(client, 'error', error as Error);
    }
  }

  private handleDrop(client: ImapClient, kind: DropKind, error?: Error): void {
    if (this.stopped) return;
    if (this.current !== client) return; // stale event from a client we already replaced
    this.options.logger?.(`imap connection dropped: ${kind}`, error);
    this.options.onDrop?.(kind, error);
    this.teardownCurrent();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const maxAttempts = this.options.maxAttempts ?? Number.POSITIVE_INFINITY;
    if (this.attempt >= maxAttempts) {
      this.options.logger?.(`giving up after ${this.attempt} attempts`);
      return;
    }
    const delay = backoffDelay(this.attempt, this.options.backoff, this.options.rng);
    this.attempt += 1;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      void this.openOnce();
    }, delay);
  }

  private teardownCurrent(): void {
    // Unsubscribe FIRST so our own close() does not re-trigger handleDrop.
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch {
        /* listener removal is best-effort */
      }
    }
    this.unsubscribers = [];
    if (this.current) {
      try {
        this.current.close();
      } catch {
        /* closing a dead socket is best-effort */
      }
      this.current = null;
    }
  }
}
