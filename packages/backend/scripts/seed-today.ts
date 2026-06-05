/**
 * seed-today — a DEV-ONLY script that populates the metadata service so the Today UI renders for the
 * Phase 7a CHECKPOINT-2 review (PLAN.md D29). The daemon's live poll→triage→extract→write loop is
 * still a Phase 9 stub, so a fresh metadata service is EMPTY; this overlays realistic tasks/promises/
 * drafts onto real cached threads (so the user sees real subjects/senders) — or a few synthetic
 * threads when the cache is empty.
 *
 * It exercises EVERY metric card (all three promise directions) and BOTH ranker tiers (an overdue
 * my-promise + a they-asked request), plus a couple of drafts (so `hasDraftReady` shows). It is
 * idempotent-ish: a thread that already has a task / promise / draft is left alone, so re-running
 * does not pile up duplicates.
 *
 * NOT part of `npm run verify`. Run it against a running metadata service:
 *   METADATA_PROJECT_ID=… METADATA_TOKEN=… [METADATA_BASE_URL=…] [CACHE_DB_PATH=…] npm run seed:today
 */
import { existsSync } from 'node:fs';
import type {
  CreatePromiseRequest,
  Importance,
  ModelAlias,
  PromiseDirection,
  TaskState,
} from '@mailordomo/shared';
import { MessageCache } from '../src/cache';
import { listCachedThreads } from '../src/api/threads-view';
import { MetadataClient } from '../src/metadata-client';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

/** A thread to seed: the sanctioned shared fields + an optional last-activity time. */
interface SeedThread {
  readonly rootMessageId: string;
  readonly subject: string;
  readonly snippet: string;
  readonly sender: string;
  readonly mailbox: string;
  readonly lastMessageAt: string | null;
}

const FALLBACK_MAILBOX = 'seed@mailordomo.local';

/** A few synthetic threads used only when the local cache has nothing real to show. */
const SYNTHETIC: readonly SeedThread[] = [
  {
    rootMessageId: '<seed-1@mailordomo.local>',
    subject: 'Onboarding – architektura projektu',
    snippet: 'Could you walk me through the repo layout before Friday?',
    sender: 'Petr <petr@fontai.cz>',
    mailbox: 'jan@fontai.cz',
    lastMessageAt: iso(-2 * DAY),
  },
  {
    rootMessageId: '<seed-2@mailordomo.local>',
    subject: 'Invoice for Q2',
    snippet: 'Please send the signed invoice when you get a moment.',
    sender: 'Lumír <lumir@fontai.cz>',
    mailbox: 'jan@fontai.cz',
    lastMessageAt: iso(-4 * DAY),
  },
  {
    rootMessageId: '<seed-3@mailordomo.local>',
    subject: 'Code review – modul plateb',
    snippet: 'I will get back to you with the review comments.',
    sender: 'Simona <simona@fontai.cz>',
    mailbox: 'jan@fontai.cz',
    lastMessageAt: iso(-1 * DAY),
  },
  {
    rootMessageId: '<seed-4@mailordomo.local>',
    subject: 'Sync – plánování sprintu',
    snippet: 'Thanks, nothing further needed from your side.',
    sender: 'Petr <petr@fontai.cz>',
    mailbox: 'jan@fontai.cz',
    lastMessageAt: iso(-6 * DAY),
  },
];

/** Read up to `limit` real threads from the local cache, if a cache DB exists; else `[]`. */
function readCacheThreads(dbPath: string, limit: number): SeedThread[] {
  if (!existsSync(dbPath)) return [];
  let cache: MessageCache;
  try {
    cache = MessageCache.open({ dbPath });
  } catch {
    return [];
  }
  try {
    const mailbox = cache.allFolders()[0]?.mailbox_address ?? FALLBACK_MAILBOX;
    return listCachedThreads(cache, limit).map((t) => ({
      rootMessageId: t.threadKey,
      subject: t.subject ?? '(no subject)',
      snippet: (t.snippet ?? '').slice(0, 200),
      sender: t.sender && t.sender.length > 0 ? t.sender : 'Unknown <unknown@example.com>',
      mailbox,
      lastMessageAt: t.lastMessageAt,
    }));
  } finally {
    cache.close();
  }
}

const STATES: readonly TaskState[] = ['needs-reply', 'drafted', 'waiting', 'follow-up', 'done'];
const IMPORTANCES: readonly Importance[] = ['high', 'normal', 'low'];

/** Build the promise(s) to attach to thread `i` so all three directions + urgency bands appear. */
function promisesFor(i: number, threadId: string): CreatePromiseRequest[] {
  const direction: PromiseDirection = (['my-promise', 'they-asked', 'awaiting-them'] as const)[
    i % 3
  ]!;
  const base: CreatePromiseRequest =
    direction === 'my-promise'
      ? {
          thread_id: threadId,
          direction,
          text: 'I will send the requested document',
          due_at: iso(-2 * DAY), // overdue → exercises the my-promise top tier + overdue metric
          status: 'overdue',
          actor: 'me',
        }
      : direction === 'they-asked'
        ? {
            thread_id: threadId,
            direction,
            text: 'They asked for the invoice',
            due_at: iso(1 * DAY), // due soon → exercises the they-asked second tier
            status: 'open',
            actor: 'them',
          }
        : {
            thread_id: threadId,
            direction,
            text: 'They promised to confirm receipt',
            due_at: null, // undated → exercises the awaiting-them (chase) metric
            status: 'open',
            actor: 'them',
          };
  // On the first thread, add an extra UNDATED my-promise so the my-promise card shows >1.
  if (i === 0) {
    return [
      base,
      {
        thread_id: threadId,
        direction: 'my-promise',
        text: 'I will follow up with a summary',
        due_at: null,
        status: 'open',
        actor: 'me',
      },
    ];
  }
  return [base];
}

async function main(): Promise<void> {
  const baseUrl = process.env['METADATA_BASE_URL'] ?? 'http://127.0.0.1:8787';
  const projectId = process.env['METADATA_PROJECT_ID'] ?? '';
  const token = process.env['METADATA_TOKEN'] ?? '';
  const cacheDbPath = process.env['CACHE_DB_PATH'] ?? '.mailordomo-cache.sqlite';

  if (projectId === '' || token === '') {
    console.error(
      'seed-today: set METADATA_PROJECT_ID and METADATA_TOKEN (and run the metadata service first).',
    );
    process.exitCode = 1;
    return;
  }

  const client = new MetadataClient({ baseUrl, projectId, token });
  // Fail fast with a clear message if the creds/service are wrong.
  await client.pair();

  const cached = readCacheThreads(cacheDbPath, 8);
  const source = cached.length > 0 ? cached : SYNTHETIC;
  console.log(
    `seed-today: seeding ${source.length} thread(s) from ${cached.length > 0 ? 'the local cache' : 'synthetic data'}…`,
  );

  let tasksMade = 0;
  let promisesMade = 0;
  let draftsMade = 0;

  for (let i = 0; i < source.length; i += 1) {
    const st = source[i]!;
    const thread = await client.upsertThread({
      project_id: projectId,
      mailbox_address: st.mailbox,
      root_message_id: st.rootMessageId,
      subject: st.subject,
      snippet: st.snippet,
      sender: st.sender,
      last_message_at: st.lastMessageAt,
    });

    // Task (idempotent-ish): only if the thread has none yet.
    if ((await client.listTasks(thread.id)).length === 0) {
      const state = STATES[i % STATES.length]!;
      const followUp = state === 'waiting' || state === 'follow-up' ? iso(-1 * DAY) : null;
      await client.createTask({
        thread_id: thread.id,
        state,
        importance: IMPORTANCES[i % IMPORTANCES.length]!,
        deadline: null,
        follow_up_at: followUp,
      });
      tasksMade += 1;
    }

    // Promises (idempotent-ish): only if the thread has none yet.
    if ((await client.listPromises(thread.id)).length === 0) {
      for (const req of promisesFor(i, thread.id)) {
        await client.createPromise(req);
        promisesMade += 1;
      }
    }

    // Drafts on the first couple of threads (so `hasDraftReady` shows), idempotent-ish.
    if (i < 2 && (await client.listDraftMeta(thread.id)).length === 0) {
      await client.createDraftMeta({
        thread_id: thread.id,
        version: 1,
        model: 'opus' satisfies ModelAlias,
        author: 'claude',
      });
      draftsMade += 1;
    }
  }

  console.log(
    `seed-today: done — ${tasksMade} task(s), ${promisesMade} promise(s), ${draftsMade} draft(s) created (existing rows left untouched).`,
  );
}

try {
  await main();
} catch (error) {
  console.error('seed-today failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
