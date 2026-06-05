/**
 * A tiny, dependency-free migrator (PLAN.md open Q #29: "server = plain SQL migration files").
 *
 * Versioned `migrations/*.sql` files are applied in filename order, each inside a transaction, and
 * recorded in a `schema_migrations` table so re-running on startup is idempotent. No ORM, no
 * migration framework — the schema is small and the SQL is the source of truth.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './open';

interface MigrationRow {
  version: string;
}

/**
 * Locate the migrations directory. Honors `MIGRATIONS_DIR` (set explicitly in the Docker image),
 * otherwise searches upward from this module for a `migrations/` dir containing `*.sql`. The upward
 * search works both in dev (`src/db` → `../../migrations`) and from a bundled `dist` build.
 */
export function resolveMigrationsDir(): string {
  const override = process.env.MIGRATIONS_DIR;
  if (override !== undefined && override !== '' && existsSync(override)) {
    return override;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'migrations');
    if (existsSync(candidate) && readdirSync(candidate).some((f) => f.endsWith('.sql'))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate the migrations directory (set MIGRATIONS_DIR)');
}

/** Apply every not-yet-applied migration in `migrationsDir`, in filename order, idempotently. */
export function runMigrations(db: Db, migrationsDir: string = resolveMigrationsDir()): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as MigrationRow[];
  const applied = new Set(appliedRows.map((row) => row.version));
  const insert = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      insert.run(version, new Date().toISOString());
    })();
  }
}
