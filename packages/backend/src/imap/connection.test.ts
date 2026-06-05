import { describe, expect, it } from 'vitest';
import { backoffDelay } from './backoff';
import { ResilientImapConnection } from './connection';
import type { DropKind, TimerApi, TimerHandle } from './connection';
import type { ImapClient, ImapFetchedMessage, ImapMailboxState } from './types';

/**
 * Load-bearing suite for OWN reconnection (PROJECT.md §4: "ImapFlow does NOT auto-reconnect … the
 * sync engine owns reconnection — exponential backoff + jitter on close/error — re-validates
 * uidValidity on (re)connect"). The client factory, timers and RNG are all injected, so reconnect/
 * backoff is asserted with a fake client and a fake clock — no live server, no real waiting.
 */

const SERVER_STATE: ImapMailboxState = {
  path: 'INBOX',
  uidValidity: 100n,
  uidNext: 1,
  highestModseq: undefined,
  exists: 0,
  readOnly: true,
};

/** Drains queued microtasks (async connect/onReady chains) using the REAL clock. */
async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

class FakeConnClient implements ImapClient {
  public connectImpl: () => Promise<void> = async () => {};
  public closed = false;
  private closeListeners: Array<() => void> = [];
  private errorListeners: Array<(error: Error) => void> = [];

  async connect(): Promise<void> {
    await this.connectImpl();
  }
  async logout(): Promise<void> {}
  close(): void {
    this.closed = true;
  }
  async list(): Promise<readonly never[]> {
    return [];
  }
  async openMailbox(): Promise<ImapMailboxState> {
    return SERVER_STATE;
  }
  async *fetchByUid(): AsyncIterable<ImapFetchedMessage> {
    for (const message of [] as ImapFetchedMessage[]) yield message;
  }
  onClose(listener: () => void): () => void {
    this.closeListeners.push(listener);
    return () => {
      this.closeListeners = this.closeListeners.filter((l) => l !== listener);
    };
  }
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.push(listener);
    return () => {
      this.errorListeners = this.errorListeners.filter((l) => l !== listener);
    };
  }
  onExists(): () => void {
    return () => undefined;
  }
  emitClose(): void {
    for (const listener of [...this.closeListeners]) listener();
  }
  emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error);
  }
}

/** A controllable timer surface that records scheduled delays without ever really waiting. */
class FakeTimers implements TimerApi {
  public readonly scheduled: Array<{ callback: () => void; ms: number; cancelled: boolean }> = [];

  setTimeout(callback: () => void, ms: number): TimerHandle {
    this.scheduled.push({ callback, ms, cancelled: false });
    return this.scheduled.length - 1;
  }
  clearTimeout(handle: TimerHandle): void {
    const entry = this.scheduled[handle as number];
    if (entry) entry.cancelled = true;
  }
  /** Fire the most recently scheduled, not-yet-cancelled timer. */
  pendingMs(): number | undefined {
    return this.scheduled.filter((s) => !s.cancelled).at(-1)?.ms;
  }
  async fireLatest(): Promise<void> {
    const entry = this.scheduled.filter((s) => !s.cancelled).at(-1);
    entry?.callback();
    await tick();
  }
}

interface Harness {
  readonly connection: ResilientImapConnection;
  readonly built: FakeConnClient[];
  readonly ready: FakeConnClient[];
  readonly drops: DropKind[];
  readonly timers: FakeTimers;
  readonly logs: string[];
}

function harness(opts: {
  behaviors?: ReadonlyArray<'ok' | 'fail'>;
  onReadyThrowsOnce?: boolean;
  maxAttempts?: number;
  baseMs?: number;
  factor?: number;
}): Harness {
  const built: FakeConnClient[] = [];
  const ready: FakeConnClient[] = [];
  const drops: DropKind[] = [];
  const logs: string[] = [];
  const timers = new FakeTimers();
  let readyCalls = 0;

  const connection = new ResilientImapConnection({
    clientFactory: () => {
      const client = new FakeConnClient();
      if (opts.behaviors?.[built.length] === 'fail') {
        client.connectImpl = async () => {
          throw new Error('connect failed');
        };
      }
      built.push(client);
      return client;
    },
    timers,
    rng: () => 0,
    backoff: { baseMs: opts.baseMs ?? 50, factor: opts.factor ?? 2, jitter: 0, maxMs: 60_000 },
    maxAttempts: opts.maxAttempts,
    onDrop: (kind) => drops.push(kind),
    logger: (message) => logs.push(message),
    onReady: (client) => {
      readyCalls += 1;
      if (opts.onReadyThrowsOnce && readyCalls === 1)
        throw new Error('uidValidity re-check failed');
      ready.push(client as FakeConnClient);
    },
  });

  return { connection, built, ready, drops, timers, logs };
}

describe('ResilientImapConnection — re-validates on (re)connect', () => {
  it('invokes onReady with the live client after the initial connect', async () => {
    const h = harness({});
    await h.connection.start();
    expect(h.built).toHaveLength(1);
    expect(h.ready).toEqual([h.built[0]]);
    h.connection.stop();
  });
});

describe('ResilientImapConnection — reconnects on close / error', () => {
  it('reconnects after a close, using the injected backoff delay, and re-validates again', async () => {
    const h = harness({ baseMs: 50, factor: 2 });
    await h.connection.start();

    h.built[0]?.emitClose(); // ImapFlow emits 'close' and does NOT auto-reconnect
    expect(h.drops).toEqual(['close']);
    expect(h.timers.pendingMs()).toBe(
      backoffDelay(0, { baseMs: 50, factor: 2, jitter: 0 }, () => 0),
    );

    await h.timers.fireLatest();
    expect(h.built).toHaveLength(2); // a fresh client was created
    expect(h.ready.at(-1)).toBe(h.built[1]); // re-validated on the reconnect
    h.connection.stop();
  });

  it('reconnects after an error event too', async () => {
    const h = harness({});
    await h.connection.start();

    h.built[0]?.emitError(new Error('socket boom'));
    expect(h.drops).toEqual(['error']);
    expect(h.timers.pendingMs()).toBeDefined();

    await h.timers.fireLatest();
    expect(h.built).toHaveLength(2);
    h.connection.stop();
  });

  it('treats a failing onReady (uidValidity re-check) as a drop and reconnects', async () => {
    const h = harness({ onReadyThrowsOnce: true });
    await h.connection.start();

    // The first onReady threw ⇒ the connection tears down and schedules a reconnect.
    expect(h.drops).toEqual(['error']);
    await h.timers.fireLatest();
    expect(h.built).toHaveLength(2);
    expect(h.ready).toEqual([h.built[1]]); // second onReady succeeded
    h.connection.stop();
  });
});

describe('ResilientImapConnection — backoff grows on consecutive failures and resets on success', () => {
  it('schedules base, base*factor, then base again after a clean reconnect', async () => {
    // built[0] ok, built[1] fails to connect, built[2] ok.
    const h = harness({ behaviors: ['ok', 'fail', 'ok'], baseMs: 50, factor: 2 });
    await h.connection.start();

    h.built[0]?.emitClose();
    expect(h.timers.pendingMs()).toBe(50); // attempt 0

    await h.timers.fireLatest(); // built[1] connect fails → connect-error → reschedule
    expect(h.drops.at(-1)).toBe('connect-error');
    expect(h.timers.pendingMs()).toBe(100); // attempt 1 (grown)

    await h.timers.fireLatest(); // built[2] connects cleanly → attempt resets
    expect(h.built).toHaveLength(3);
    expect(h.ready.at(-1)).toBe(h.built[2]);

    h.built[2]?.emitClose();
    expect(h.timers.pendingMs()).toBe(50); // back to base after a clean connect
    h.connection.stop();
  });
});

describe('ResilientImapConnection — give-up and teardown', () => {
  it('stops scheduling after maxAttempts consecutive failures', async () => {
    const h = harness({ behaviors: ['fail', 'fail', 'fail', 'fail'], maxAttempts: 2 });
    await h.connection.start(); // built[0] connect fails → schedule (attempt→1)
    expect(h.built).toHaveLength(1);
    expect(h.timers.scheduled.filter((s) => !s.cancelled)).toHaveLength(1);

    await h.timers.fireLatest(); // built[1] fails → schedule (attempt→2)
    await h.timers.fireLatest(); // built[2] fails → attempt(2) >= 2 → GIVE UP, no schedule

    expect(h.built).toHaveLength(3);
    expect(h.timers.scheduled.filter((s) => !s.cancelled)).toHaveLength(2);
    expect(h.logs.some((l) => l.includes('giving up'))).toBe(true);
  });

  it('stop() cancels a pending reconnect and tears the client down', async () => {
    const h = harness({});
    await h.connection.start();
    h.built[0]?.emitClose();
    expect(h.timers.pendingMs()).toBeDefined();

    h.connection.stop();
    expect(h.timers.scheduled.every((s) => s.cancelled)).toBe(true);
    expect(h.built[0]?.closed).toBe(true);
    expect(h.connection.client).toBeNull();

    await h.timers.fireLatest(); // firing the (cancelled) timer must not resurrect a client
    expect(h.built).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// backoffDelay — the pure policy (PROJECT.md §4: avoid hammering iCloud's tight caps)
// ---------------------------------------------------------------------------------------------

describe('backoffDelay — deterministic growth, cap, jitter band, and guards', () => {
  const opts = { baseMs: 100, factor: 2, maxMs: 1000, jitter: 0 } as const;

  it('grows by the factor each attempt and caps at maxMs', () => {
    expect(backoffDelay(0, opts, () => 0)).toBe(100);
    expect(backoffDelay(1, opts, () => 0)).toBe(200);
    expect(backoffDelay(3, opts, () => 0)).toBe(800);
    expect(backoffDelay(10, opts, () => 0)).toBe(1000); // capped
  });

  it('keeps the result inside [cap*(1-jitter), cap] for any RNG value', () => {
    const jittered = { baseMs: 100, factor: 2, maxMs: 1000, jitter: 0.5 } as const;
    expect(backoffDelay(0, jittered, () => 0)).toBe(50); // floor of the band
    expect(backoffDelay(0, jittered, () => 1)).toBe(100); // ceiling (== cap)
    expect(backoffDelay(0, jittered, () => 0.5)).toBe(75); // midpoint
  });

  it('floors fractional / negative attempts and never returns a negative delay', () => {
    expect(backoffDelay(1.9, opts, () => 0)).toBe(200); // floor(1.9) = 1
    expect(backoffDelay(-5, opts, () => 0)).toBe(100); // clamped to attempt 0
  });

  it('falls back to maxMs when the growth overflows to a non-finite number', () => {
    expect(backoffDelay(5, { baseMs: 1e308, factor: 10, maxMs: 60_000, jitter: 0 })).toBe(60_000);
  });

  it('treats a NaN RNG as zero jitter (defensive)', () => {
    expect(backoffDelay(0, { baseMs: 100, jitter: 0.5, maxMs: 1000 }, () => NaN)).toBe(50);
  });
});
