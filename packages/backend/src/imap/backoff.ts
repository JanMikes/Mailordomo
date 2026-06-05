/**
 * Exponential backoff with jitter — PURE (no timers, no IO). The reconnect loop
 * (`connection.ts`) owns the actual waiting; this just computes how long to wait, given an attempt
 * number, so the policy is unit-testable with an injected RNG and no clock.
 *
 * ImapFlow does NOT auto-reconnect (PROJECT.md §4), so this policy is load-bearing: it must avoid
 * hammering a provider (iCloud's connection caps are tight) while still recovering promptly.
 */
export interface BackoffOptions {
  /** Delay for attempt 0, before exponential growth. Default 1000 ms. */
  readonly baseMs?: number;
  /** Growth factor per attempt. Default 2. */
  readonly factor?: number;
  /** Hard ceiling on the (pre-jitter) delay. Default 60000 ms. */
  readonly maxMs?: number;
  /** Jitter fraction in [0, 1]: the portion of the delay that is randomized. Default 0.5. */
  readonly jitter?: number;
}

const DEFAULTS = {
  baseMs: 1_000,
  factor: 2,
  maxMs: 60_000,
  jitter: 0.5,
} as const;

/**
 * Compute the backoff delay (ms) for a zero-based `attempt`. The deterministic part is
 * `min(maxMs, baseMs * factor^attempt)`; a `jitter` fraction of that is then randomized via `rng`
 * (injected for deterministic tests; defaults to `Math.random`). The result is always in
 * `[cap*(1-jitter), cap]` and never negative.
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = {},
  rng: () => number = Math.random,
): number {
  const baseMs = options.baseMs ?? DEFAULTS.baseMs;
  const factor = options.factor ?? DEFAULTS.factor;
  const maxMs = options.maxMs ?? DEFAULTS.maxMs;
  const jitter = Math.min(1, Math.max(0, options.jitter ?? DEFAULTS.jitter));

  const safeAttempt = Math.max(0, Math.floor(attempt));
  const raw = baseMs * Math.pow(factor, safeAttempt);
  const cap = Math.min(maxMs, Number.isFinite(raw) ? raw : maxMs);
  const fixed = cap * (1 - jitter);
  const random = cap * jitter * clamp01(rng());
  return Math.max(0, fixed + random);
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
