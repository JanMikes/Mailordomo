/**
 * An in-memory {@link DraftStore} for tests — same version-bumping semantics as the file-backed impl
 * ({@link createFileDraftStore}) but with no DB/IO, so endpoint smoke tests can inject it directly.
 */
import type { DraftStore, LocalDraft, SaveDraftInput } from './types';

/** A trivial `Map`-backed {@link DraftStore}. Not persistent — for tests only. */
export function createMemoryDraftStore(): DraftStore {
  const byThread = new Map<string, LocalDraft>();
  return {
    getDraft: (threadId) => byThread.get(threadId),
    saveDraft: (threadId, input: SaveDraftInput) => {
      const current = byThread.get(threadId);
      const draft: LocalDraft = {
        threadId,
        body: input.body,
        version: (current?.version ?? 0) + 1,
        model: input.model,
        author: input.author,
        createdAt: input.createdAt ?? new Date().toISOString(),
        transcript: [...input.transcript],
      };
      byThread.set(threadId, draft);
      return draft;
    },
    clearDraft: (threadId) => {
      byThread.delete(threadId);
    },
  };
}
