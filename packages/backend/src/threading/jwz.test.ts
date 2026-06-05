import { describe, expect, it } from 'vitest';
import { buildThreads, parseMessageIds } from './jwz';

/** Smoke coverage for JWZ threading; the separate author owns the broken-header torture suite. */

describe('jwz threading (smoke)', () => {
  it('parses message-id tokens and ignores garbage', () => {
    expect(parseMessageIds('<a@x>  garbage <b@y>')).toEqual(['<a@x>', '<b@y>']);
    expect(parseMessageIds(['<a@x>', '<a@x>'])).toEqual(['<a@x>']);
  });

  it('builds a linear reply chain from References', () => {
    const roots = buildThreads([
      { messageId: '<root@x>', subject: 'Hi', date: '2026-01-01T00:00:00Z' },
      {
        messageId: '<reply@x>',
        inReplyTo: '<root@x>',
        references: ['<root@x>'],
        subject: 'Re: Hi',
        date: '2026-01-02T00:00:00Z',
      },
    ]);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.id).toBe('<root@x>');
    expect(roots[0]?.children[0]?.id).toBe('<reply@x>');
  });

  it('threads a reply even when the referenced root was never fetched', () => {
    const roots = buildThreads([
      { messageId: '<reply@x>', references: ['<missing@x>'], subject: 'Re: gone' },
    ]);
    // The absent root is pruned; the reply surfaces as the (single) root.
    expect(roots).toHaveLength(1);
    expect(roots[0]?.id).toBe('<reply@x>');
  });

  it('synthesizes an id for a message with no Message-ID', () => {
    const roots = buildThreads([{ subject: 'orphan' }]);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.synthetic).toBe(true);
    expect(roots[0]?.message).not.toBeNull();
  });
});
