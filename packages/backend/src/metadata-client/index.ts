/**
 * @mailordomo/backend · metadata-client — the typed HTTP client for the metadata service
 * (PROJECT.md §3 Layer 2). Pushes METADATA ONLY (Golden rule #3) over bearer auth + `X-Project-Id`,
 * validates every response with the shared zod DTOs, and exposes an INJECTABLE `fetch` seam so tests
 * can route it at an in-process server. See `client.ts` for the privacy + test-seam contract.
 */
export * from './errors';
export * from './client';
