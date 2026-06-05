/**
 * The LOCAL silent-learning log (PROJECT.md §6 "writing a changelog the user can review and revert").
 *
 * PRIVACY (Golden rule #3): this log holds the BEFORE / AFTER tone-file content SNAPSHOTS needed to
 * revert a learned change. Those snapshots are tone-memory text (sanctioned), but the REVERT capability
 * is a purely LOCAL concern — the snapshots NEVER cross the privacy boundary. Only the one-line
 * `summary` of each entry is sent to the server (via `MetadataClient.createLearningEntry`). So the
 * snapshots live here, on disk, in `<dir>/.learning-log.json`, OUTSIDE the disposable cache (a
 * learned-and-applied lesson must survive a cache wipe, just like the tone files it edited).
 *
 * Each record is keyed by the SERVER-assigned `LearningEntry.id`, so a single id addresses both the
 * shared changelog entry and the local snapshot needed to undo it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectId, ToneScope } from '@mailordomo/shared';

/** Default learning-log directory when `LEARNING_DIR` is unset. Kept separate from the disposable cache. */
export const DEFAULT_LEARNING_DIR = '.mailordomo-learning';

/** The learning-log filename inside the learning dir. */
export const LEARNING_LOG_FILE = '.learning-log.json';

/**
 * Resolve the learning-log directory from the environment (mirrors the cache/tone env conventions).
 * `LEARNING_DIR` wins; otherwise the default.
 */
export function resolveLearningDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['LEARNING_DIR'];
  return dir !== undefined && dir.trim() !== '' ? dir : DEFAULT_LEARNING_DIR;
}

/**
 * One local learning record: the shared changelog fields PLUS the LOCAL-ONLY before/after snapshots and
 * the tone-file `path` they apply to (so revert can restore the exact prior content).
 */
export interface LocalLearningRecord {
  /** The server-assigned `LearningEntry.id` — the shared key for this learned change. */
  readonly id: string;
  readonly project_id: ProjectId;
  readonly scope: ToneScope;
  /** The tone-file path this lesson edited (e.g. `contact/jan@acme.com.md`). */
  readonly path: string;
  /** The one-line changelog summary (also sent to the server — the ONLY field that crosses). */
  readonly summary: string;
  /** LOCAL ONLY: the tone-file content BEFORE this lesson was applied (the revert target). */
  readonly before_content: string;
  /** LOCAL ONLY: the tone-file content AFTER this lesson was applied. */
  readonly after_content: string;
  readonly applied_at: string;
  /** Null while applied; set to the revert instant once reverted. */
  readonly reverted_at: string | null;
}

interface LearningLogFile {
  readonly version: 1;
  readonly entries: LocalLearningRecord[];
}

export interface LearningLogOptions {
  /** The learning-log directory (resolve with {@link resolveLearningDir}). */
  readonly dir: string;
}

/** Local persistence for the silent-learning changelog + revert snapshots. IO edge; append-mostly. */
export class LearningLog {
  readonly dir: string;

  private constructor(options: LearningLogOptions) {
    this.dir = options.dir;
  }

  /** Open (and create) a learning log rooted at `dir`. */
  static open(options: LearningLogOptions): LearningLog {
    const log = new LearningLog(options);
    log.init();
    return log;
  }

  /** Ensure the learning dir exists. Idempotent. */
  init(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  private filePath(): string {
    return path.join(this.dir, LEARNING_LOG_FILE);
  }

  private read(): LearningLogFile {
    const file = this.filePath();
    if (!existsSync(file)) {
      return { version: 1, entries: [] };
    }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as LearningLogFile;
    return { version: 1, entries: raw.entries ?? [] };
  }

  private write(data: LearningLogFile): void {
    writeFileSync(this.filePath(), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  /** All local records, in insertion order (oldest first). */
  list(): LocalLearningRecord[] {
    return this.read().entries;
  }

  /** One record by its (server) id, or `undefined`. */
  get(id: string): LocalLearningRecord | undefined {
    return this.read().entries.find((entry) => entry.id === id);
  }

  /** Append a new applied record. Throws if the id is already present (ids are server-unique). */
  append(record: LocalLearningRecord): void {
    const data = this.read();
    if (data.entries.some((entry) => entry.id === record.id)) {
      throw new Error(`learning record already exists: ${record.id}`);
    }
    this.write({ version: 1, entries: [...data.entries, record] });
  }

  /** Mark a record reverted (set `reverted_at`). No-op if the id is absent. Idempotent on re-revert. */
  markReverted(id: string, revertedAt: string): void {
    const data = this.read();
    const entries = data.entries.map((entry) =>
      entry.id === id ? { ...entry, reverted_at: revertedAt } : entry,
    );
    this.write({ version: 1, entries });
  }

  /** Remove the entire learning dir (test hygiene / a full local reset). */
  destroy(): void {
    if (existsSync(this.dir)) {
      rmSync(this.dir, { recursive: true, force: true });
    }
  }
}
