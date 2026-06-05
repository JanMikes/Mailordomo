/**
 * Subscription guard (PROJECT.md §4 "Subscription guard"; PLAN.md D24).
 *
 * Mailordomo runs the `claude` binary under the user's Claude SUBSCRIPTION (a shared rolling usage
 * window + weekly cap), NOT pay-per-token API billing. If `ANTHROPIC_API_KEY` is set in the
 * environment, the `claude` binary will SILENTLY bill the PAID API per token instead of consuming the
 * subscription — an unwanted, easy-to-miss diversion. At startup of any claude-using path we therefore
 * WARN about it (we deliberately do NOT auto-strip the key — the user asked for a warning, not silent
 * handling, and they may have set it intentionally for some other tool).
 */

/** Minimal logger seam — `console` satisfies it; tests pass a capturing fake. */
export interface SubscriptionWarnLogger {
  warn(...args: unknown[]): void;
}

export interface WarnIfAnthropicApiKeySetOptions {
  /** Environment to inspect. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Where the warning goes. Defaults to `console`. */
  readonly logger?: SubscriptionWarnLogger;
}

/** The prominent warning text emitted when `ANTHROPIC_API_KEY` is set. */
export const ANTHROPIC_API_KEY_WARNING =
  '⚠️  ANTHROPIC_API_KEY is set — `claude` jobs will bill the PAID API per token instead of ' +
  'consuming your Claude subscription. Unset ANTHROPIC_API_KEY to use the subscription.';

/**
 * If `ANTHROPIC_API_KEY` is set and non-empty, log a prominent warning that `claude` will bill the
 * paid API per token instead of consuming the subscription. Returns `true` iff it warned (for tests
 * and for the warn-once guards in the callers). Pure aside from the injected logger — no side effects
 * beyond the single log line; it never mutates the environment.
 */
export function warnIfAnthropicApiKeySet({
  env = process.env,
  logger = console,
}: WarnIfAnthropicApiKeySetOptions = {}): boolean {
  const key = env.ANTHROPIC_API_KEY;
  if (key === undefined || key.trim() === '') {
    return false;
  }
  logger.warn(ANTHROPIC_API_KEY_WARNING);
  return true;
}

/**
 * Process-wide latch so the warning fires AT MOST ONCE per process even though several claude-using
 * entry points (the queue, the real runner) each call the guard at startup. Tests that need to assert
 * the warning should call {@link warnIfAnthropicApiKeySet} directly (with injected env/logger), not
 * this latched variant.
 */
let warnedThisProcess = false;

/**
 * The warn-once wrapper the constructors call. Invokes {@link warnIfAnthropicApiKeySet} the first time
 * any claude-using path starts up this process; subsequent calls are no-ops. Returns `true` iff it
 * emitted the warning on THIS call.
 */
export function warnIfAnthropicApiKeySetOnce(
  options: WarnIfAnthropicApiKeySetOptions = {},
): boolean {
  if (warnedThisProcess) {
    return false;
  }
  warnedThisProcess = true;
  return warnIfAnthropicApiKeySet(options);
}
