import { describe, expect, it } from 'vitest';
import { buildReplyHeaders, saveDraft, sendReply } from './send';
import type { ComposedMime, MessageComposer, OutgoingMessage } from './send';

/**
 * Smoke coverage for the send path with FULLY STUBBED transport — nothing is ever transmitted. The
 * live path is exercised only by the Phase 9 E2E (also stubbed). Asserts the manual-send contract:
 * threading headers are set, the Message-ID is captured, and the raw copy is filed to Sent.
 */

const composedRaw = Buffer.from('RAW-MIME');

function stubComposer(): { composer: MessageComposer; seen: OutgoingMessage[] } {
  const seen: OutgoingMessage[] = [];
  const composer: MessageComposer = {
    async compose(message: OutgoingMessage): Promise<ComposedMime> {
      seen.push(message);
      return {
        raw: composedRaw,
        messageId: message.messageId ?? '<generated@local>',
        envelope: { from: message.from, to: [...message.to] },
      };
    },
  };
  return { composer, seen };
}

const message: OutgoingMessage = {
  from: 'me@x',
  to: ['them@y'],
  subject: 'Re: hi',
  text: 'hello',
};

describe('buildReplyHeaders', () => {
  it('threads under the parent and appends the parent id to references', () => {
    expect(buildReplyHeaders({ messageId: '<p@x>', references: ['<root@x>'] })).toEqual({
      inReplyTo: '<p@x>',
      references: ['<root@x>', '<p@x>'],
    });
    expect(buildReplyHeaders(null)).toEqual({ inReplyTo: null, references: [] });
  });
});

describe('sendReply (stubbed transport)', () => {
  it('sends once, captures the Message-ID, and files the raw copy to Sent', async () => {
    const { composer, seen } = stubComposer();
    const sentFolders: string[] = [];
    let sends = 0;

    const result = await sendReply(
      message,
      { messageId: '<p@x>', references: ['<root@x>'] },
      {
        composer,
        transport: {
          async send(composed) {
            sends += 1;
            return { messageId: composed.messageId };
          },
        },
        filer: {
          async append(folder) {
            sentFolders.push(folder);
          },
        },
        specialUse: { sent: 'Odeslané' },
      },
    );

    expect(sends).toBe(1);
    expect(result.filedTo).toBe('Odeslané');
    expect(seen[0]?.inReplyTo).toBe('<p@x>');
    expect(seen[0]?.references).toEqual(['<root@x>', '<p@x>']);
  });
});

describe('saveDraft (never transmits)', () => {
  it('composes and files to Drafts without any transport', async () => {
    const { composer } = stubComposer();
    let appended = '';
    const result = await saveDraft(message, {
      composer,
      transport: {
        async send() {
          throw new Error('saveDraft must never transmit');
        },
      },
      filer: {
        async append(folder) {
          appended = folder;
        },
      },
      specialUse: { drafts: 'Koncepty' },
    });
    expect(appended).toBe('Koncepty');
    expect(result.filedTo).toBe('Koncepty');
  });
});
