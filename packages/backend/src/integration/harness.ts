/**
 * Shared harness for the Phase 4.5 END-TO-END integration tests (PLAN.md §7 Phase 4.5).
 *
 * These tests exercise the REAL {@link MetadataClient} against an in-process REAL metadata server —
 * NOT the fake job runner and NOT a hand-rolled stub. The seam is the client's injectable `fetch`,
 * pointed at a fully-migrated Hono app's `app.fetch` (a real `(Request) => Promise<Response>`), so
 * every call traverses the actual request/response path: headers, bearer auth, project scoping, and
 * the strict shared-DTO validation on BOTH sides. The only thing missing versus production is the
 * socket. The server ships `makeApp`/`seedProject`/`PROJECT_A` for exactly this (it is a backend
 * devDependency); we reuse them rather than wiring a repo by hand.
 *
 * Not a `*.test.ts` file (Vitest only runs those), but it lives under `src` so it passes the same
 * strict typecheck / lint / format gate as production code.
 */
import type { Hono } from 'hono';
import type { AppEnv } from '../../../server/src/http';
import type { Repository } from '../../../server/src/repo/repository';
import { makeApp, seedProject } from '../../../server/src/test-helpers';
import type { TestProject } from '../../../server/src/test-helpers';
import { MetadataClient } from '../metadata-client';
import type { FetchLike } from '../metadata-client';

export { PROJECT_A, PROJECT_B } from '../../../server/src/test-helpers';
export type { TestProject } from '../../../server/src/test-helpers';

/** A live in-process server (real Hono app + repo) plus a tiny factory for REAL clients against it. */
export interface InProcessServer {
  readonly app: Hono<AppEnv>;
  readonly repo: Repository;
  /**
   * Build a REAL {@link MetadataClient} whose injected `fetch` routes to THIS in-process server.
   * Pass a custom `fetch` (e.g. a body-capturing wrapper) to observe/assert the outbound surface.
   */
  client(project: TestProject, fetchOverride?: FetchLike): MetadataClient;
  /** The raw seam: a `(input, init) => Promise<Response>` that hits the in-process server. */
  readonly fetch: FetchLike;
  close(): void;
}

/**
 * Spin up a fresh, fully-migrated in-process metadata server and seed the given projects (so their
 * tokens are accepted). Returns the app/repo plus a `client(project)` helper. Call `close()` in an
 * `afterEach`.
 *
 * `app.fetch` is typed `Response | Promise<Response>` (Hono's overloads); we wrap it in
 * `Promise.resolve(...)` so it satisfies the client's `FetchLike` (always-async) seam exactly.
 */
export function startInProcessServer(...projects: readonly TestProject[]): InProcessServer {
  const { app, repo } = makeApp();
  for (const project of projects) seedProject(repo, project);

  const fetch: FetchLike = (input, init) => Promise.resolve(app.fetch(new Request(input, init)));

  return {
    app,
    repo,
    fetch,
    client: (project, fetchOverride) =>
      new MetadataClient({
        // Any absolute base works; only the PATH is used by the in-process seam.
        baseUrl: 'http://metadata.local',
        projectId: project.id,
        token: project.token,
        fetch: fetchOverride ?? fetch,
      }),
    close: () => repo.close(),
  };
}

/** A single captured outbound request: method, path, and the parsed JSON body (if any). */
export interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  /** The JSON-parsed request body, or `undefined` for a body-less (e.g. GET) request. */
  readonly body: unknown;
  /** The raw request body string, or `undefined` when there was none. */
  readonly rawBody: string | undefined;
}

/** A `fetch` wrapper that records every outbound request, then delegates to `inner`. */
export interface CapturingFetch {
  readonly fetch: FetchLike;
  readonly captured: readonly CapturedRequest[];
}

/**
 * Wrap a {@link FetchLike} so every outbound request is recorded (method/path/body) BEFORE being
 * forwarded to `inner`. Used by the privacy test to assert the client's outbound surface never
 * carries an email/draft body — we inspect exactly the bytes that would cross the network.
 */
export function capturingFetch(inner: FetchLike): CapturingFetch {
  const captured: CapturedRequest[] = [];
  const fetch: FetchLike = (input, init) => {
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    let body: unknown;
    if (rawBody !== undefined) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    captured.push({
      method: init?.method ?? 'GET',
      path: new URL(input).pathname,
      body,
      rawBody,
    });
    return inner(input, init);
  };
  return { fetch, captured };
}
