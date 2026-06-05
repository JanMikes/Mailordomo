/**
 * The three-layer wiring/health check that backs `GET /api/wiring` (PLAN.md §7 Phase 4.5: "a thin
 * health/wiring screen or endpoint shows all three layers green"). Each layer reports a boolean
 * `ok` + a short human `detail`. NOTHING here throws: a failing layer is reported as `ok:false`
 * with the reason, so the wiring screen can show red-not-crash.
 *
 * The three layers (PROJECT.md §3):
 *  - metadataService — reachable + the project token is accepted (default: `MetadataClient.pair()`).
 *  - cache           — the disposable local `MessageCache` opens and answers a trivial query.
 *  - claude          — the `claude` binary resolves (cheap: `CLAUDE_BIN` env, else `which claude`).
 */
import { spawn } from 'node:child_process';
import type { MessageCache } from '../cache';
import type { MetadataClient } from '../metadata-client';

/** One layer's health: a boolean plus a short reason string for the UI. */
export interface WiringStatus {
  readonly ok: boolean;
  readonly detail: string;
}

/** The whole three-layer wiring snapshot returned by `GET /api/wiring`. */
export interface WiringReport {
  readonly metadataService: WiringStatus;
  readonly cache: WiringStatus;
  readonly claude: WiringStatus;
}

function errMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * metadataService layer: verify the configured token against the service via `pair()`. A success
 * proves transport + auth + project scoping all wire together. Any failure (network, 401, contract)
 * is reported as `ok:false` with the error message — never thrown.
 */
export async function checkMetadata(metadata: MetadataClient): Promise<WiringStatus> {
  try {
    const project = await metadata.pair();
    return { ok: true, detail: `paired with project "${project.name}"` };
  } catch (cause) {
    return { ok: false, detail: `pair failed: ${errMessage(cause)}` };
  }
}

/**
 * cache layer: confirm the injected {@link MessageCache} is open and answering. `allFolders()` is a
 * cheap read that touches the schema; if it throws, the cache is unusable and we report why.
 */
export function checkCache(cache: MessageCache): WiringStatus {
  try {
    const folderCount = cache.allFolders().length;
    return { ok: true, detail: `cache open (${folderCount} folder(s) indexed)` };
  } catch (cause) {
    return { ok: false, detail: `cache unavailable: ${errMessage(cause)}` };
  }
}

/**
 * claude layer: a CHEAP resolve check, not a model call. Prefers an explicit `CLAUDE_BIN`; otherwise
 * runs `which <bin>` with a short timeout. Resolving the binary is enough to call the layer green —
 * the Phase 4 runner owns real invocation. Never throws; a missing binary is `ok:false`.
 */
export async function checkClaude(
  timeoutMs = 2000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WiringStatus> {
  const bin = env['CLAUDE_BIN'];
  if (bin && bin.trim() !== '') {
    return { ok: true, detail: `CLAUDE_BIN set (${bin})` };
  }
  return new Promise<WiringStatus>((resolve) => {
    let settled = false;
    const done = (status: WiringStatus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    };
    const child = spawn('which', ['claude'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, detail: `claude resolve timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on('error', (cause) => {
      done({ ok: false, detail: `could not resolve claude: ${errMessage(cause)}` });
    });
    child.on('close', (code) => {
      const path = out.trim();
      if (code === 0 && path !== '') {
        done({ ok: true, detail: `claude on PATH (${path})` });
      } else {
        done({ ok: false, detail: 'claude not found on PATH (set CLAUDE_BIN to override)' });
      }
    });
  });
}
