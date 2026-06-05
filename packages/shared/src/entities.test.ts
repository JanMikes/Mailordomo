/**
 * Schema round-trips + rejection of invalid payloads (PLAN.md §7 Phase 1, derived from
 * PROJECT.md §5 intent — NOT from the implementation).
 *
 * The point of the rejection cases is to catch a schema that is TOO LOOSE: if §5 says a snippet is
 * bounded ~200 chars, an unbounded snippet schema must make a 201-char snippet test FAIL here.
 */
import { describe, expect, it } from 'vitest';
import {
  EmailAddressSchema,
  ImportanceSchema,
  IsoDateTimeSchema,
  ModelAliasSchema,
  ProjectSchema,
  PromiseDirectionSchema,
  PromiseSchema,
  PromiseStatusSchema,
  SNIPPET_MAX_LENGTH,
  SenderSchema,
  SnippetSchema,
  TaskSchema,
  TaskStateSchema,
  ThreadSchema,
  ToneScopeSchema,
} from './index';
import { STRICT_CONTRACTS } from './contract-samples';

describe('schema round-trips (every entity + request DTO)', () => {
  it.each(STRICT_CONTRACTS)('round-trips a canonical $name', (dto) => {
    const parsed = dto.schema.parse(dto.valid);
    // Canonical inputs have no defaults/transforms applied, so parse must deep-equal the input.
    expect(parsed).toEqual(dto.valid);
  });

  it('covers all 11 metadata-service entities from PROJECT.md §5', () => {
    const entityNames = STRICT_CONTRACTS.filter((c) => c.isEntity).map((c) => c.name);
    expect(entityNames).toEqual([
      'ProjectSchema',
      'ThreadSchema',
      'TaskSchema',
      'TaskTransitionSchema',
      'PromiseSchema',
      'NoteSchema',
      'RepoPointerSchema',
      'DraftMetaSchema',
      'LockSchema',
      'ToneFileSchema',
      'LearningEntrySchema',
    ]);
  });

  it('classifies LocalRepoConfig as machine-local, not a §5 server entity', () => {
    const local = STRICT_CONTRACTS.find((c) => c.name === 'LocalRepoConfigSchema');
    expect(local?.isEntity).toBe(false);
  });
});

describe('rejection: invalid enum values', () => {
  it('rejects an unknown task state', () => {
    expect(() => TaskStateSchema.parse('archived')).toThrow();
    expect(() => TaskSchema.parse({ ...sampleTask(), state: 'archived' })).toThrow();
  });

  it('rejects an unknown importance', () => {
    expect(() => ImportanceSchema.parse('urgent')).toThrow();
  });

  it('rejects an unknown model alias', () => {
    expect(() => ModelAliasSchema.parse('gpt-4')).toThrow();
  });

  it('rejects an unknown tone scope', () => {
    expect(() => ToneScopeSchema.parse('global')).toThrow();
  });
});

describe('rejection: missing required fields', () => {
  it('rejects a Project missing token_hash', () => {
    expect(() => ProjectSchema.parse({ id: 'p1', name: 'Acme' })).toThrow();
  });

  it('rejects a Task missing its state', () => {
    expect(() =>
      TaskSchema.parse({
        id: 't1',
        thread_id: 'th1',
        deadline: null,
        follow_up_at: null,
        importance: 'normal',
        updated_at: '2026-06-05T09:15:23Z',
      }),
    ).toThrow();
  });
});

describe('rejection: malformed ISO datetimes', () => {
  it('accepts a well-formed UTC datetime', () => {
    expect(() => IsoDateTimeSchema.parse('2026-06-05T09:15:23Z')).not.toThrow();
    expect(() => IsoDateTimeSchema.parse('2026-06-05T09:15:23+02:00')).not.toThrow();
  });

  it('rejects a date without a time component', () => {
    expect(() => IsoDateTimeSchema.parse('2026-06-05')).toThrow();
  });

  it('rejects free-text and a space-separated timestamp', () => {
    expect(() => IsoDateTimeSchema.parse('not-a-date')).toThrow();
    expect(() => IsoDateTimeSchema.parse('2026-06-05 09:15:23')).toThrow();
  });

  it('rejects a Task whose deadline is malformed', () => {
    expect(() => TaskSchema.parse({ ...sampleTask(), deadline: 'tomorrow' })).toThrow();
  });
});

describe('rejection: non-email addresses', () => {
  it('accepts a valid address but rejects a non-address', () => {
    expect(() => EmailAddressSchema.parse('jan@acme.com')).not.toThrow();
    expect(() => EmailAddressSchema.parse('not-an-email')).toThrow();
  });

  it('rejects a Thread with a non-email mailbox_address', () => {
    expect(() => ThreadSchema.parse({ ...sampleThread(), mailbox_address: 'nope' })).toThrow();
  });
});

describe('rejection: snippet bound (PROJECT.md §5 — bounded ~200 chars)', () => {
  it('declares the 200-char bound as a constant', () => {
    expect(SNIPPET_MAX_LENGTH).toBe(200);
  });

  it('accepts exactly 200 chars and rejects 201', () => {
    expect(() => SnippetSchema.parse('x'.repeat(SNIPPET_MAX_LENGTH))).not.toThrow();
    expect(() => SnippetSchema.parse('x'.repeat(SNIPPET_MAX_LENGTH + 1))).toThrow();
  });

  it('rejects a Thread whose snippet exceeds the bound (the privacy-relevant case)', () => {
    expect(() => ThreadSchema.parse({ ...sampleThread(), snippet: 'x'.repeat(201) })).toThrow();
  });

  it('bounds the sender too, so it cannot smuggle bulk text', () => {
    expect(() => SenderSchema.parse('')).toThrow();
    expect(() => SenderSchema.parse('x'.repeat(999))).toThrow();
  });
});

describe('rejection: bad promise direction / status', () => {
  it('rejects an unknown direction', () => {
    expect(() => PromiseDirectionSchema.parse('sideways')).toThrow();
    expect(() => PromiseSchema.parse({ ...samplePromise(), direction: 'sideways' })).toThrow();
  });

  it('rejects an unknown status', () => {
    expect(() => PromiseStatusSchema.parse('pending')).toThrow();
    expect(() => PromiseSchema.parse({ ...samplePromise(), status: 'pending' })).toThrow();
  });
});

// --- local canonical builders (fresh object each call so spreads never alias) -----------------

function sampleTask(): Record<string, unknown> {
  return {
    id: 't1',
    thread_id: 'th1',
    state: 'needs-reply',
    deadline: '2026-06-05T09:15:23Z',
    follow_up_at: null,
    importance: 'normal',
    updated_at: '2026-06-05T09:15:23Z',
  };
}

function sampleThread(): Record<string, unknown> {
  return {
    id: 'th1',
    project_id: 'p1',
    mailbox_address: 'jan@acme.com',
    root_message_id: '<root@acme.com>',
    subject: 'Subject',
    snippet: 'A short preview',
    sender: 'Jan <jan@acme.com>',
    last_message_at: '2026-06-05T09:15:23Z',
    updated_at: '2026-06-05T09:15:23Z',
  };
}

function samplePromise(): Record<string, unknown> {
  return {
    id: 'pr1',
    thread_id: 'th1',
    direction: 'my-promise',
    text: 'Deliver the report',
    due_at: '2026-06-05T09:15:23Z',
    due_raw: 'by Friday',
    status: 'open',
    actor: 'jan',
    created_at: '2026-06-05T09:15:23Z',
  };
}
