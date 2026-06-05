import { describe, expect, it } from 'vitest';
import { buildThreads, normalizeMessageId, parseMessageIds } from './jwz';
import type { ThreadableMessage, ThreadNode } from './jwz';

/**
 * Load-bearing suite for JWZ threading, derived from PROJECT.md §4 (replies thread via In-Reply-To
 * + References) and §12 (own JWZ, RFC 5256-style). The header sets are crafted here to exercise the
 * degenerate cases real mail produces: missing/duplicate Message-IDs, garbage References,
 * referenced-but-absent parents, self-reference and reference loops, and chronological ordering.
 */

type Node = ThreadNode<ThreadableMessage>;

function rootIds(nodes: readonly Node[]): string[] {
  return nodes.map((n) => n.id);
}

function childIds(node: Node | undefined): string[] {
  return (node?.children ?? []).map((c) => c.id);
}

function findNode(nodes: readonly Node[], id: string): Node | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const inChild = findNode(node.children, id);
    if (inChild) return inChild;
  }
  return undefined;
}

function countNodes(nodes: readonly Node[]): number {
  let total = 0;
  for (const node of nodes) total += 1 + countNodes(node.children);
  return total;
}

describe('parseMessageIds / normalizeMessageId — tolerant token extraction', () => {
  it('extracts bracketed ids in order and ignores surrounding garbage', () => {
    expect(parseMessageIds('<a@x>  not-an-id  <b@y>')).toEqual(['<a@x>', '<b@y>']);
    expect(parseMessageIds(['<a@x>', '<a@x>', '<b@y>'])).toEqual(['<a@x>', '<b@y>']); // de-duped
  });

  it('returns nothing for empty / whitespace / multi-word junk and null-ish input', () => {
    expect(parseMessageIds('')).toEqual([]);
    expect(parseMessageIds('   ')).toEqual([]);
    expect(parseMessageIds('garbage with spaces')).toEqual([]);
    expect(parseMessageIds(null)).toEqual([]);
    expect(parseMessageIds(undefined)).toEqual([]);
  });

  it('leniently wraps a single bare token from a sloppy server', () => {
    expect(parseMessageIds('lone@host')).toEqual(['<lone@host>']);
    expect(normalizeMessageId('a@b')).toBe('<a@b>');
    expect(normalizeMessageId('  <a@b>  ')).toBe('<a@b>');
    expect(normalizeMessageId('')).toBe('');
  });
});

describe('buildThreads — well-formed reply chains', () => {
  it('threads a linear References chain root → r1 → r2', () => {
    const msgs: ThreadableMessage[] = [
      { messageId: '<root@x>', date: '2026-01-01T00:00:00Z' },
      { messageId: '<r1@x>', inReplyTo: '<root@x>', references: ['<root@x>'], date: '2026-01-02' },
      {
        messageId: '<r2@x>',
        inReplyTo: '<r1@x>',
        references: ['<root@x>', '<r1@x>'],
        date: '2026-01-03',
      },
    ];
    const roots = buildThreads(msgs);
    expect(rootIds(roots)).toEqual(['<root@x>']);
    expect(childIds(findNode(roots, '<root@x>'))).toEqual(['<r1@x>']);
    expect(childIds(findNode(roots, '<r1@x>'))).toEqual(['<r2@x>']);
  });

  it('threads on In-Reply-To alone when References is absent', () => {
    const msgs: ThreadableMessage[] = [
      { messageId: '<root@x>', date: '2026-08-01' },
      { messageId: '<reply@x>', inReplyTo: '<root@x>', date: '2026-08-02' },
    ];
    const roots = buildThreads(msgs);
    expect(rootIds(roots)).toEqual(['<root@x>']);
    expect(childIds(findNode(roots, '<root@x>'))).toEqual(['<reply@x>']);
  });

  it('sorts sibling replies oldest-first within their parent', () => {
    const msgs: ThreadableMessage[] = [
      { messageId: '<root@x>', date: '2026-02-01' },
      {
        messageId: '<later@x>',
        inReplyTo: '<root@x>',
        references: ['<root@x>'],
        date: '2026-02-03',
      },
      {
        messageId: '<sooner@x>',
        inReplyTo: '<root@x>',
        references: ['<root@x>'],
        date: '2026-02-02',
      },
    ];
    const roots = buildThreads(msgs);
    expect(childIds(findNode(roots, '<root@x>'))).toEqual(['<sooner@x>', '<later@x>']);
  });
});

describe('buildThreads — missing Message-IDs synthesize stable, non-merged ids', () => {
  it('keeps two id-less messages separate, each as its own non-null synthetic root', () => {
    const roots = buildThreads([{ subject: 'orphan one' }, { subject: 'orphan two' }]);
    expect(roots).toHaveLength(2);
    expect(roots.every((r) => r.synthetic)).toBe(true);
    expect(roots.every((r) => r.message !== null)).toBe(true);
    expect(new Set(rootIds(roots)).size).toBe(2); // distinct ids — not merged
  });

  it('produces the same synthetic ids on repeated runs (stable)', () => {
    const input: ThreadableMessage[] = [{ subject: 'o1' }, { subject: 'o2' }];
    expect(rootIds(buildThreads(input))).toEqual(rootIds(buildThreads(input)));
  });
});

describe('buildThreads — duplicate Message-IDs are never merged', () => {
  it('keeps both messages (one under the real id, one synthesized)', () => {
    const roots = buildThreads([
      { messageId: '<dup@x>', subject: 'first', date: '2026-03-01' },
      { messageId: '<dup@x>', subject: 'second', date: '2026-03-02' },
    ]);
    expect(countNodes(roots)).toBe(2);
    const subjects = roots
      .map((r) => r.message?.subject)
      .filter((s): s is string => typeof s === 'string')
      .sort();
    expect(subjects).toEqual(['first', 'second']);
  });
});

describe('buildThreads — garbage and empty References are tolerated', () => {
  it('does not crash and leaves messages with no valid references as independent roots', () => {
    const roots = buildThreads([
      { messageId: '<g@x>', references: 'this is not a header', subject: 'g' },
      { messageId: '<h@x>', references: '', inReplyTo: '', subject: 'h' },
      { messageId: '<i@x>', references: ['<<<malformed', 'also bad'], subject: 'i' },
    ]);
    expect(rootIds(roots).sort()).toEqual(['<g@x>', '<h@x>', '<i@x>']);
  });
});

describe('buildThreads — referenced-but-absent parents are pruned / kept correctly', () => {
  it('prunes a single absent ancestor and surfaces the lone reply as the root', () => {
    const roots = buildThreads([
      {
        messageId: '<reply@x>',
        inReplyTo: '<never-fetched@x>',
        references: ['<never-fetched@x>'],
        subject: 'Re: gone',
      },
    ]);
    expect(rootIds(roots)).toEqual(['<reply@x>']);
    expect(findNode(roots, '<reply@x>')?.message?.subject).toBe('Re: gone');
  });

  it('keeps a shared absent ancestor as an empty grouping root over its real children', () => {
    const roots = buildThreads([
      { messageId: '<x@m>', references: ['<ghost@m>'], date: '2026-04-02' },
      { messageId: '<y@m>', references: ['<ghost@m>'], date: '2026-04-01' },
    ]);
    expect(rootIds(roots)).toEqual(['<ghost@m>']);
    const ghost = findNode(roots, '<ghost@m>');
    expect(ghost?.message).toBeNull(); // a surviving gap container
    expect(childIds(ghost)).toEqual(['<y@m>', '<x@m>']); // grouped + oldest-first
  });
});

describe('buildThreads — self-reference and loops do not crash or duplicate', () => {
  it('tolerates a message that references itself', () => {
    const roots = buildThreads([
      { messageId: '<self@x>', inReplyTo: '<self@x>', references: ['<self@x>'], subject: 's' },
    ]);
    expect(rootIds(roots)).toEqual(['<self@x>']);
    expect(childIds(findNode(roots, '<self@x>'))).toEqual([]);
  });

  it('breaks a 2-cycle (a↔b) into an acyclic tree keeping both messages exactly once', () => {
    const roots = buildThreads([
      { messageId: '<a@x>', inReplyTo: '<b@x>', references: ['<b@x>'], date: '2026-05-01' },
      { messageId: '<b@x>', inReplyTo: '<a@x>', references: ['<a@x>'], date: '2026-05-02' },
    ]);
    expect(countNodes(roots)).toBe(2);
    expect(findNode(roots, '<a@x>')?.message).not.toBeNull();
    expect(findNode(roots, '<b@x>')?.message).not.toBeNull();
  });
});

describe('buildThreads — chronological ordering of root threads', () => {
  it('orders roots by the earliest message in each subtree, oldest-first', () => {
    const roots = buildThreads([
      { messageId: '<newer@x>', date: '2026-07-10' },
      { messageId: '<older@x>', date: '2026-07-01' },
      { messageId: '<older-reply@x>', references: ['<older@x>'], date: '2026-07-02' },
    ]);
    // The <older@x> thread (earliest Jul 1) precedes the standalone <newer@x> (Jul 10).
    expect(rootIds(roots)).toEqual(['<older@x>', '<newer@x>']);
  });
});
