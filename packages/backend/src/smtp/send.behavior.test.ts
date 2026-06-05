import { describe, expect, it } from 'vitest';
import { buildReplyHeaders, saveDraft, sendReply } from './send';
import type { ComposedMime, MessageComposer, OutgoingMessage, SentFiler } from './send';

/**
 * Load-bearing suite for the send path — Golden rule #1 (sending is ALWAYS manual). Everything is
 * stubbed; nothing transmits. Asserts §4 transport intent: replies set In-Reply-To + References,
 * the Message-ID is captured, the raw copy is filed to the SPECIAL-USE Sent folder AFTER a single
 * send — and that `saveDraft` (used for the on-signal draft AND the sanctioned overdue-nudge) NEVER
 * reaches a transport.
 */

const RAW = Buffer.from('RAW-MIME-BYTES');

const message: OutgoingMessage = {
  from: 'me@x',
  to: ['them@y'],
  subject: 'Re: hi',
  text: 'hello',
};

/** Records what it was asked to compose and echoes a Message-ID (generated when absent). */
function stubComposer(): { composer: MessageComposer; seen: OutgoingMessage[] } {
  const seen: OutgoingMessage[] = [];
  const composer: MessageComposer = {
    async compose(input: OutgoingMessage): Promise<ComposedMime> {
      seen.push(input);
      return {
        raw: RAW,
        messageId: input.messageId ?? '<generated@local>',
        envelope: { from: input.from, to: [...input.to] },
      };
    },
  };
  return { composer, seen };
}

describe('buildReplyHeaders — In-Reply-To + References per PROJECT.md §4', () => {
  it('threads under the parent and ends References with the parent id', () => {
    expect(buildReplyHeaders({ messageId: '<p@x>', references: ['<root@x>', '<mid@x>'] })).toEqual({
      inReplyTo: '<p@x>',
      references: ['<root@x>', '<mid@x>', '<p@x>'],
    });
  });

  it('de-duplicates the parent id and any repeats in the chain, order-preserving', () => {
    expect(buildReplyHeaders({ messageId: '<p@x>', references: ['<root@x>', '<p@x>'] })).toEqual({
      inReplyTo: '<p@x>',
      references: ['<root@x>', '<p@x>'], // parent id not appended twice
    });
    expect(
      buildReplyHeaders({ messageId: '<p@x>', references: ['<a@x>', '<a@x>', '<b@x>'] }),
    ).toEqual({ inReplyTo: '<p@x>', references: ['<a@x>', '<b@x>', '<p@x>'] });
  });

  it('handles a parent with no prior chain, and no parent at all', () => {
    expect(buildReplyHeaders({ messageId: '<p@x>' })).toEqual({
      inReplyTo: '<p@x>',
      references: ['<p@x>'],
    });
    expect(buildReplyHeaders(null)).toEqual({ inReplyTo: null, references: [] });
    expect(buildReplyHeaders(undefined)).toEqual({ inReplyTo: null, references: [] });
  });
});

describe('sendReply — sends exactly once, then files to the resolved Sent folder', () => {
  it('threads, captures the Message-ID, and appends the raw copy to Sent (send before file)', async () => {
    const { composer, seen } = stubComposer();
    const events: string[] = [];
    let sends = 0;
    const filerCalls: Array<{ folder: string; raw: Buffer; flags?: readonly string[] }> = [];
    const filer: SentFiler = {
      async append(folder, raw, flags) {
        events.push('append');
        filerCalls.push({ folder, raw, flags });
      },
    };

    const result = await sendReply(
      message,
      { messageId: '<p@x>', references: ['<root@x>'] },
      {
        composer,
        transport: {
          async send(composed) {
            events.push('send');
            sends += 1;
            return { messageId: composed.messageId };
          },
        },
        filer,
        specialUse: { sent: 'Gesendet' }, // resolved by \Sent flag upstream — not an English literal
      },
    );

    expect(sends).toBe(1);
    expect(events).toEqual(['send', 'append']); // sent, THEN filed
    expect(result.filedTo).toBe('Gesendet');
    expect(filerCalls).toHaveLength(1);
    expect(filerCalls[0]?.folder).toBe('Gesendet');
    expect(filerCalls[0]?.raw).toBe(RAW);
    expect(filerCalls[0]?.flags).toEqual(['\\Seen']);
    // Threading headers were composed from the parent.
    expect(seen[0]?.inReplyTo).toBe('<p@x>');
    expect(seen[0]?.references).toEqual(['<root@x>', '<p@x>']);
  });

  it('still sends exactly once but files nothing when no Sent folder is resolved', async () => {
    const { composer } = stubComposer();
    let sends = 0;
    let appends = 0;

    const result = await sendReply(
      message,
      { messageId: '<p@x>' },
      {
        composer,
        transport: {
          async send(composed) {
            sends += 1;
            return { messageId: composed.messageId };
          },
        },
        filer: {
          async append() {
            appends += 1;
          },
        },
        // specialUse omitted ⇒ no Sent folder to file into.
      },
    );

    expect(sends).toBe(1);
    expect(appends).toBe(0);
    expect(result.filedTo).toBeNull();
  });

  it('lets an explicit In-Reply-To on the message override the parent-derived header', async () => {
    const { composer, seen } = stubComposer();
    await sendReply(
      { ...message, inReplyTo: '<explicit@x>' },
      { messageId: '<p@x>' },
      {
        composer,
        transport: {
          async send(c) {
            return { messageId: c.messageId };
          },
        },
      },
    );
    expect(seen[0]?.inReplyTo).toBe('<explicit@x>');
  });
});

describe('saveDraft — Golden rule #1: NEVER transmits', () => {
  it('composes and files to Drafts with no transport.send call', async () => {
    const { composer } = stubComposer();
    let sends = 0;
    let appended = '';
    let appendFlags: readonly string[] | undefined;

    const result = await saveDraft(message, {
      composer,
      transport: {
        async send() {
          sends += 1; // must remain 0
          return { messageId: 'should-never-happen' };
        },
      },
      filer: {
        async append(folder, _raw, flags) {
          appended = folder;
          appendFlags = flags;
        },
      },
      specialUse: { drafts: 'Koncepty' }, // resolved by \Drafts flag upstream
    });

    expect(sends).toBe(0); // the daemon's nudge drafts here — and never sends
    expect(appended).toBe('Koncepty');
    expect(appendFlags).toEqual(['\\Draft']);
    expect(result.filedTo).toBe('Koncepty');
    expect(result.messageId).toBe('<generated@local>');
  });

  it('throws nothing and sends nothing even when a throwing transport is supplied', async () => {
    const { composer } = stubComposer();
    const result = await saveDraft(message, {
      composer,
      transport: {
        async send() {
          throw new Error('saveDraft must never transmit');
        },
      },
      // no filer / no Drafts folder ⇒ compose-only, still no send.
    });
    expect(result.filedTo).toBeNull();
    expect(result.messageId).toBe('<generated@local>');
  });
});
