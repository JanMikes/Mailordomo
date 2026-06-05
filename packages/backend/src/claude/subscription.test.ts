/**
 * LOAD-BEARING — Subscription guard (PROJECT.md §4 "Subscription guard" + PLAN.md D24).
 *
 * §4 intent: Mailordomo runs `claude` under the user's SUBSCRIPTION, not the paid API. If
 * `ANTHROPIC_API_KEY` is set, the binary would SILENTLY bill the paid API per token — so the app
 * WARNS at startup (it deliberately does NOT strip the key). Derived assertions:
 *   - `warnIfAnthropicApiKeySet` warns iff the key is set & non-empty (set / unset / whitespace);
 *   - it returns the right boolean, emits the EXACT warning text, and NEVER mutates the env;
 *   - the warn-once latch (`warnIfAnthropicApiKeySetOnce`) fires at most once per process — tested
 *     in ISOLATION with `vi.resetModules()` + dynamic import, because the queue/runner constructors
 *     trip the module-level singleton elsewhere in the suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_API_KEY_WARNING, warnIfAnthropicApiKeySet } from './subscription';

interface CapturingLogger {
  warn: (...args: unknown[]) => void;
  readonly calls: unknown[][];
}
function capturing(): CapturingLogger {
  const calls: unknown[][] = [];
  return { warn: (...args: unknown[]) => calls.push(args), calls };
}

describe('warnIfAnthropicApiKeySet — warns iff the key is set & non-empty', () => {
  it('WARNS (returns true) when ANTHROPIC_API_KEY is a non-empty value', () => {
    const logger = capturing();
    expect(warnIfAnthropicApiKeySet({ env: { ANTHROPIC_API_KEY: 'sk-ant-abc123' }, logger })).toBe(
      true,
    );
    expect(logger.calls).toHaveLength(1);
  });

  it('STAYS QUIET (returns false) when the key is unset', () => {
    const logger = capturing();
    expect(warnIfAnthropicApiKeySet({ env: {}, logger })).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it('STAYS QUIET when the key is empty or whitespace-only', () => {
    const logger = capturing();
    expect(warnIfAnthropicApiKeySet({ env: { ANTHROPIC_API_KEY: '' }, logger })).toBe(false);
    expect(warnIfAnthropicApiKeySet({ env: { ANTHROPIC_API_KEY: '   ' }, logger })).toBe(false);
    expect(warnIfAnthropicApiKeySet({ env: { ANTHROPIC_API_KEY: '\t\n ' }, logger })).toBe(false);
    expect(logger.calls).toHaveLength(0);
  });

  it('emits the EXACT warning text', () => {
    const logger = capturing();
    warnIfAnthropicApiKeySet({ env: { ANTHROPIC_API_KEY: 'x' }, logger });
    expect(logger.calls[0]).toEqual([ANTHROPIC_API_KEY_WARNING]);
    expect(ANTHROPIC_API_KEY_WARNING).toContain('ANTHROPIC_API_KEY is set');
    expect(ANTHROPIC_API_KEY_WARNING).toContain('PAID API');
  });

  it('NEVER mutates the passed-in environment', () => {
    const env = { ANTHROPIC_API_KEY: 'keep-me', OTHER: 'untouched' };
    const before = { ...env };
    warnIfAnthropicApiKeySet({ env, logger: capturing() });
    expect(env).toEqual(before); // key still present, nothing stripped/added
  });

  it('defaults the logger to console.warn (smoke — does not throw)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(warnIfAnthropicApiKeySet({ env: { ANTHROPIC_API_KEY: 'x' } })).toBe(true);
    expect(spy).toHaveBeenCalledWith(ANTHROPIC_API_KEY_WARNING);
    spy.mockRestore();
  });
});

/**
 * The warn-once latch is MODULE-LEVEL state. Other test files construct the queue/runner, which
 * call `warnIfAnthropicApiKeySetOnce()` and would trip the shared singleton. So each latch assertion
 * loads a PRISTINE module instance via `vi.resetModules()` + dynamic import, isolating the latch.
 */
describe('warnIfAnthropicApiKeySetOnce — fires at most once per process (isolated module)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  async function freshOnce(): Promise<
    typeof import('./subscription').warnIfAnthropicApiKeySetOnce
  > {
    const mod = await import('./subscription');
    return mod.warnIfAnthropicApiKeySetOnce;
  }

  it('warns on the FIRST call and is a no-op (returns false) thereafter', async () => {
    const once = await freshOnce();
    const logger = capturing();
    const env = { ANTHROPIC_API_KEY: 'set' };
    expect(once({ env, logger })).toBe(true); // first call warns
    expect(once({ env, logger })).toBe(false); // latched
    expect(once({ env, logger })).toBe(false);
    expect(logger.calls).toHaveLength(1); // only ONE warning the whole process
  });

  it('does NOT latch on an unset key, so a key set later still warns (Phase 8 .env load)', async () => {
    const once = await freshOnce();
    const logger = capturing();
    // A startup call while the key is UNSET must not latch — it never warned.
    expect(once({ env: {}, logger })).toBe(false);
    expect(logger.calls).toHaveLength(0);
    // A later call WITH the key set still surfaces the warning, exactly once.
    expect(once({ env: { ANTHROPIC_API_KEY: 'now-set' }, logger })).toBe(true);
    expect(once({ env: { ANTHROPIC_API_KEY: 'now-set' }, logger })).toBe(false); // now latched
    expect(logger.calls).toHaveLength(1);
  });

  it('a freshly reset module starts unlatched again (proves the isolation works)', async () => {
    const once = await freshOnce();
    const logger = capturing();
    expect(once({ env: { ANTHROPIC_API_KEY: 'x' }, logger })).toBe(true);
    expect(logger.calls).toHaveLength(1);
  });
});
