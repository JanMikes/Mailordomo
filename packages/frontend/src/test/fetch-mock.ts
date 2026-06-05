/**
 * A tiny `fetch` router for component smoke tests. Routes are matched by (optional) method + a URL
 * substring or regex; the first match wins. Every call is recorded so a test can assert that a hook
 * fired the right request (URL, method, parsed JSON body) — e.g. that Send POSTed to `…/send`.
 *
 * Unstubbed automatically by the shared `afterEach` (`vi.unstubAllGlobals()`).
 */
import { vi } from 'vitest';

export interface MockRoute {
  /** HTTP method to match (case-insensitive); any method when omitted. */
  method?: string;
  /** Substring or regex tested against the request URL. */
  url: string | RegExp;
  /** Response status (default 200). */
  status?: number;
  /** JSON body returned by `res.json()` (default `{}`). */
  json?: unknown;
}

export interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function matches(pattern: string | RegExp, url: string): boolean {
  return typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url);
}

/** Install a `fetch` stub from `routes`; returns the recorded calls (live array) + the mock fn. */
export function mockFetch(routes: MockRoute[]): {
  calls: RecordedCall[];
  fn: ReturnType<typeof vi.fn>;
} {
  const calls: RecordedCall[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body });

    const route = routes.find(
      (r) => (r.method ? r.method.toUpperCase() === method : true) && matches(r.url, url),
    );
    const status = route?.status ?? (route ? 200 : 404);
    const json = route?.json ?? {};
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(json),
    } as Response);
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

/** Find the recorded call matching method + URL substring (the assertion helper). */
export function findCall(
  calls: readonly RecordedCall[],
  method: string,
  urlSubstring: string,
): RecordedCall | undefined {
  return calls.find((c) => c.method === method.toUpperCase() && c.url.includes(urlSubstring));
}
