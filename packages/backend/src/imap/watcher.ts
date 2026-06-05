/**
 * Per-folder watch strategy (PLAN.md open Q #25): IDLE the hot folders (INBOX, maybe Sent) and POLL
 * the cold ones on an interval (default 5 min). In `idle` mode the connection stays open and
 * imapflow auto-IDLEs; a server `'exists'` push triggers a debounced {@link MailboxSync.syncOnce}.
 * In `poll` mode a timer drives periodic syncs. Timers are injected so the test author can advance a
 * fake clock instead of waiting.
 *
 * `maxIdleTime` (so IDLE self-renews under the ~29-min RFC ceiling) is a CONNECTION concern set in
 * `imapflow-client.ts`; this watcher only reacts to the pushes that result.
 */
import type { MailboxSync } from './mailbox-sync';
import type { ImapClient, Unsubscribe } from './types';

export type IntervalHandle = unknown;
export type TimeoutHandle = unknown;

export interface WatchTimerApi {
  setInterval(callback: () => void, ms: number): IntervalHandle;
  clearInterval(handle: IntervalHandle): void;
  setTimeout(callback: () => void, ms: number): TimeoutHandle;
  clearTimeout(handle: TimeoutHandle): void;
}

const realWatchTimers: WatchTimerApi = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Default cold-folder poll cadence (open Q #25). */
export const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
/** Coalesce a burst of `'exists'` pushes into a single sync. */
export const DEFAULT_IDLE_DEBOUNCE_MS = 1_000;

export interface MailboxWatchOptions {
  readonly mode: 'idle' | 'poll';
  readonly pollIntervalMs?: number;
  readonly debounceMs?: number;
  readonly timers?: WatchTimerApi;
  readonly onError?: (error: unknown) => void;
}

export class MailboxWatcher {
  private readonly sync: MailboxSync;
  private readonly client: ImapClient;
  private readonly options: MailboxWatchOptions;
  private readonly timers: WatchTimerApi;
  private unsubscribe: Unsubscribe | null = null;
  private intervalHandle: IntervalHandle | null = null;
  private debounceHandle: TimeoutHandle | null = null;
  private running = false;

  constructor(sync: MailboxSync, client: ImapClient, options: MailboxWatchOptions) {
    this.sync = sync;
    this.client = client;
    this.options = options;
    this.timers = options.timers ?? realWatchTimers;
  }

  /** Run an initial sync, then start watching according to the configured mode. */
  async start(): Promise<void> {
    this.running = true;
    await this.runSync();
    if (this.options.mode === 'idle') {
      this.unsubscribe = this.client.onExists(() => this.scheduleDebouncedSync());
    } else {
      const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      this.intervalHandle = this.timers.setInterval(() => void this.runSync(), interval);
    }
  }

  /** Stop watching. Idempotent. Does not close the connection (that is the connection's job). */
  stop(): void {
    this.running = false;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.intervalHandle !== null) {
      this.timers.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.debounceHandle !== null) {
      this.timers.clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
  }

  private scheduleDebouncedSync(): void {
    if (this.debounceHandle !== null) {
      this.timers.clearTimeout(this.debounceHandle);
    }
    const debounce = this.options.debounceMs ?? DEFAULT_IDLE_DEBOUNCE_MS;
    this.debounceHandle = this.timers.setTimeout(() => {
      this.debounceHandle = null;
      void this.runSync();
    }, debounce);
  }

  private async runSync(): Promise<void> {
    if (!this.running) return;
    try {
      await this.sync.syncOnce();
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
