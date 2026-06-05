/**
 * THE PRIVACY BOUNDARY (Golden rule #3 / PROJECT.md §5): "Email bodies never leave the local
 * machine. Only metadata + subject + snippet + sender go to the server."
 *
 * These tests are load-bearing. For EVERY strict entity + server-bound request DTO they assert,
 * exhaustively (iterating the registry, not a hand-picked subset), that:
 *   - the canonical valid payload parses;
 *   - injecting ANY representative body/attachment leak key makes parse throw;
 *   - a bare `body` key is rejected everywhere EXCEPT the sanctioned Note schemas;
 *   - a bare `content` key is rejected everywhere EXCEPT the sanctioned ToneFile schemas;
 *   - no schema even DECLARES a leak field in its shape.
 * Plus the two sanctioned exceptions are proven to still work, and DraftMeta is proven body-free.
 */
import { describe, expect, it } from 'vitest';
import {
  CreateNoteRequestSchema,
  DraftMetaSchema,
  FORBIDDEN_SERVER_PAYLOAD_KEYS,
  NoteSchema,
  PutToneFileRequestSchema,
  ToneFileSchema,
} from './index';
import { STRICT_CONTRACTS } from './contract-samples';

const FORBIDDEN_KEYS = [...FORBIDDEN_SERVER_PAYLOAD_KEYS];

describe('forbidden-key rejection matrix (every strict contract × every leak key)', () => {
  describe.each(STRICT_CONTRACTS)('$name', (dto) => {
    it('accepts its canonical valid payload', () => {
      expect(() => dto.schema.parse(dto.valid)).not.toThrow();
    });

    it.each(FORBIDDEN_KEYS)('rejects an injected "%s" key', (key) => {
      // The valid base parses (above); base + one forbidden key must NOT — proving the key, not a
      // missing field, is what's rejected. Strict objects make this structural, not by allow-list.
      expect(() =>
        dto.schema.parse({ ...dto.valid, [key]: 'leaked raw email body text' }),
      ).toThrow();
    });
  });
});

describe('the forbidden-key list is the documented leak surface, minus the sanctioned fields', () => {
  it('does NOT list bare body/content (those are legitimate on Note/ToneFile)', () => {
    expect(FORBIDDEN_KEYS).not.toContain('body');
    expect(FORBIDDEN_KEYS).not.toContain('content');
  });

  it('lists the representative raw-email / draft-body / attachment leak vectors', () => {
    for (const key of ['emlContent', 'rawMessage', 'emailBody', 'draftBody', 'attachments']) {
      expect(FORBIDDEN_KEYS).toContain(key);
    }
  });
});

describe('bare `body` is rejected everywhere except the sanctioned Note schemas', () => {
  it('rejects `body` on every non-Note strict contract', () => {
    for (const dto of STRICT_CONTRACTS.filter((c) => !c.allowsBody)) {
      expect(() => dto.schema.parse({ ...dto.valid, body: 'raw email body' })).toThrow();
    }
  });

  it('accepts the sanctioned `body` on NoteSchema and CreateNoteRequest (user notes)', () => {
    expect(() =>
      NoteSchema.parse({
        id: 'n1',
        thread_id: 'th1',
        author: 'jan',
        body: 'A user-written note.',
        at: '2026-06-05T09:15:23Z',
      }),
    ).not.toThrow();
    expect(() =>
      CreateNoteRequestSchema.parse({ thread_id: 'th1', author: 'jan', body: 'A user note.' }),
    ).not.toThrow();
  });
});

describe('bare `content` is rejected everywhere except the sanctioned ToneFile schemas', () => {
  it('rejects `content` on every non-ToneFile strict contract', () => {
    for (const dto of STRICT_CONTRACTS.filter((c) => !c.allowsContent)) {
      expect(() => dto.schema.parse({ ...dto.valid, content: 'smuggled body' })).toThrow();
    }
  });

  it('accepts the sanctioned `content` on ToneFileSchema and PutToneFileRequest (tone memory)', () => {
    expect(() =>
      ToneFileSchema.parse({
        project_id: 'p1',
        scope: 'project',
        path: 'project/acme.md',
        content: 'Keep it short.',
        version_hash: 'vh-1',
        updated_by: 'jan',
        updated_at: '2026-06-05T09:15:23Z',
      }),
    ).not.toThrow();
    expect(() =>
      PutToneFileRequestSchema.parse({
        project_id: 'p1',
        scope: 'contact',
        path: 'contact/x.md',
        content: 'Warmer tone.',
        version_hash: 'vh-2',
        updated_by: 'jan',
        updated_at: '2026-06-05T09:15:23Z',
      }),
    ).not.toThrow();
  });
});

describe('no strict contract DECLARES a leak field in its shape (structural privacy)', () => {
  it('declares neither body (except Note) nor content (except ToneFile) nor any forbidden key', () => {
    for (const dto of STRICT_CONTRACTS) {
      if (!dto.allowsBody) {
        expect(dto.shapeKeys).not.toContain('body');
      }
      if (!dto.allowsContent) {
        expect(dto.shapeKeys).not.toContain('content');
      }
      for (const key of FORBIDDEN_KEYS) {
        expect(dto.shapeKeys).not.toContain(key);
      }
    }
  });
});

describe('DraftMetaSchema carries metadata only — never a draft body', () => {
  const validDraftMeta = {
    id: 'd1',
    thread_id: 'th1',
    version: 1,
    model: 'opus',
    author: 'jan',
    at: '2026-06-05T09:15:23Z',
  };

  it('accepts valid draft metadata', () => {
    expect(() => DraftMetaSchema.parse(validDraftMeta)).not.toThrow();
  });

  it('rejects injected body / draftBody / content', () => {
    expect(() => DraftMetaSchema.parse({ ...validDraftMeta, body: 'the draft' })).toThrow();
    expect(() => DraftMetaSchema.parse({ ...validDraftMeta, draftBody: 'the draft' })).toThrow();
    expect(() => DraftMetaSchema.parse({ ...validDraftMeta, content: 'the draft' })).toThrow();
  });

  it('declares no body-like field in its shape', () => {
    const keys = Object.keys(DraftMetaSchema.shape);
    expect(keys).not.toContain('body');
    expect(keys).not.toContain('draftBody');
    expect(keys).not.toContain('content');
  });
});
