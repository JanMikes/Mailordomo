/**
 * Process-environment configuration for the runnable server. Sensible defaults make the container
 * immediately usable; the optional `METADATA_PROJECT_*` trio seeds the shared project on boot so a
 * fresh deployment can be paired (see `seed.ts`).
 */

export interface ServerEnv {
  /** Listen port (default 8787). */
  port: number;
  /** Bind host (default `0.0.0.0` so the container is reachable). */
  host: string;
  /** SQLite database file path (lives on a mounted volume in Docker). */
  dbPath: string;
  /** Optional boot-seed: id / name / plaintext token for the shared project. */
  seedProjectId?: string;
  seedProjectName?: string;
  seedProjectToken?: string;
}

const DEFAULT_PORT = 8787;

export function readEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const parsedPort = source.METADATA_PORT
    ? Number.parseInt(source.METADATA_PORT, 10)
    : DEFAULT_PORT;
  return {
    port: Number.isFinite(parsedPort) ? parsedPort : DEFAULT_PORT,
    host: source.METADATA_HOST ?? '0.0.0.0',
    dbPath: source.METADATA_DB_PATH ?? './data/metadata.db',
    seedProjectId: source.METADATA_PROJECT_ID,
    seedProjectName: source.METADATA_PROJECT_NAME,
    seedProjectToken: source.METADATA_PROJECT_TOKEN,
  };
}
