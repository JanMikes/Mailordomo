import { describe, expect, it } from 'vitest';
import { DraftMetaSchema, MAILORDOMO, MODEL_ROUTING, TASK_STATE_TRANSITIONS } from './index';

/**
 * Minimal smoke test only — the comprehensive behavioral suite (schema round-trips, privacy
 * rejection, routing/transition assertions from PROJECT.md intent) is authored by a separate
 * test-author subagent. This just proves the package is wired and one schema `parse()`s.
 */
describe('shared smoke', () => {
  it('exports the package marker', () => {
    expect(MAILORDOMO).toBe('mailordomo');
  });

  it('parses a valid DraftMeta and exposes the routing + transition tables', () => {
    const draft = DraftMetaSchema.parse({
      id: 'd1',
      thread_id: 't1',
      version: 1,
      model: 'opus',
      author: 'jan',
      at: '2026-06-05T09:15:23Z',
    });
    expect(draft.model).toBe('opus');
    // Golden rule #6 anchor + the transition table is present as data.
    expect(MODEL_ROUTING.draft).toBe('opus');
    expect(TASK_STATE_TRANSITIONS['needs-reply'].length).toBeGreaterThan(0);
  });
});
