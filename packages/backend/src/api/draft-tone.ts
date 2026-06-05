/**
 * Resolve the LAYERED tone-memory document to a temp file for a draft job's
 * `--append-system-prompt-file` (PROJECT.md §6; PLAN.md §7 Phase 7b, D31 — drafting is the first tone
 * consumer). Reads the applicable project/mailbox/contact tone files from the local {@link ToneStore},
 * composes them with the PURE `resolveToneMemory` resolver (project → mailbox → contact, contact wins),
 * writes the composed markdown to a temp file, and hands the path to the draft call — cleaning the temp
 * file up afterward.
 *
 * Best-effort + additive: tone files are user-curated and may not exist yet (Phase 6 built the store;
 * live tone files arrive with real use). When the store is absent or no layer is present, the draft
 * runs on `draft.md` alone (no append). The tone-file path convention here mirrors the
 * `contact/<addr>.md` example in `tone/store.ts`.
 */
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToneLayer, ToneStore } from '../tone';
import { resolveToneMemory } from '../tone';

/** Extract a bare email from a freeform sender ("Name <a@b>" → "a@b"; "a@b" → "a@b"; else null). */
export function extractEmail(sender: string | null | undefined): string | null {
  if (sender === null || sender === undefined) return null;
  const angle = sender.match(/<([^>]+)>/);
  const candidate = (angle?.[1] ?? sender).trim();
  return /^[^\s@]+@[^\s@]+$/.test(candidate) ? candidate.toLowerCase() : null;
}

/** Identifiers selecting which tone layers apply to a draft. */
export interface DraftToneKeys {
  readonly projectId: string;
  readonly mailboxAddress?: string | null;
  readonly contactEmail?: string | null;
}

/** Read the present tone layers for a draft context, in no particular order (the resolver orders them). */
function collectToneLayers(store: ToneStore, keys: DraftToneKeys): ToneLayer[] {
  const candidates: Array<string | null | undefined> = [
    'project.md',
    keys.mailboxAddress ? `mailbox/${keys.mailboxAddress}.md` : null,
    keys.contactEmail ? `contact/${keys.contactEmail}.md` : null,
  ];
  const layers: ToneLayer[] = [];
  for (const path of candidates) {
    if (!path) continue;
    const file = store.read(path);
    if (file !== undefined && file.content.trim() !== '') {
      layers.push({ scope: file.scope, content: file.content });
    }
  }
  return layers;
}

/**
 * Resolve the layered tone document to a temp file and invoke `fn` with its path (or `undefined` when
 * there is no tone guidance). The temp file is always removed afterward. Pure-ish: all IO is the temp
 * file lifecycle; the composition is the pure `resolveToneMemory`.
 */
export async function withDraftToneFile<T>(
  store: ToneStore | undefined,
  keys: DraftToneKeys,
  fn: (appendSystemPromptFile: string | undefined) => Promise<T>,
): Promise<T> {
  if (store === undefined) return fn(undefined);
  const composed = resolveToneMemory(collectToneLayers(store, keys));
  if (composed.trim() === '') return fn(undefined);

  const path = join(tmpdir(), `mailordomo-tone-${randomUUID()}.md`);
  await writeFile(path, composed, 'utf8');
  try {
    return await fn(path);
  } finally {
    await unlink(path).catch(() => {
      /* best-effort cleanup */
    });
  }
}
