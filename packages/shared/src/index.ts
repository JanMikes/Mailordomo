/**
 * @mailordomo/shared — the single source of truth for cross-boundary contracts.
 *
 * Phase 1 fills this with zod schemas + inferred types for task state & transitions,
 * 3-way promises, deadlines, notes, repo pointers, draft metadata, locks, digest metadata,
 * tone-file sync, the learning changelog, the metadata API request/response shapes, and the
 * fixed model-routing constants. For Phase 0 it carries only the package marker so the
 * verify pipeline has something real to typecheck and test.
 */
export const MAILORDOMO = 'mailordomo' as const;
