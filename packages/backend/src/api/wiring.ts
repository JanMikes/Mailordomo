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
 * claude layer: a CHEAP resolve check, not a model call. Resolves the effective binary
 * (`CLAUDE_BIN` if set, else `claude`) via `which`, which validates BOTH a bare PATH command and an
 * absolute path — so a `CLAUDE_BIN` pointing at a non-existent file reports red, not a false green.
 * Resolving the binary is enough to call the layer green — the Phase 4 runner owns real invocation.
 * Never throws; a missing binary is `ok:false`.
 */
export async function checkClaude(
  timeoutMs = 2000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WiringStatus> {
  const configured = env['CLAUDE_BIN']?.trim();
  const bin = configured ? configured : 'claude';
  const label = configured ? `CLAUDE_BIN "${bin}"` : `"${bin}" on PATH`;
  return new Promise<WiringStatus>((resolve) => {
    let settled = false;
    const done = (status: WiringStatus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    };
    const child = spawn('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] });
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
      const resolved = out.trim();
      if (code === 0 && resolved !== '') {
        done({ ok: true, detail: `claude resolved (${label} → ${resolved})` });
      } else {
        done({ ok: false, detail: `claude not found (${label}); set CLAUDE_BIN to a valid path` });
      }
    });
  });
}

/**
 * A slightly deeper Claude probe for the setup wizard (PLAN.md §7 Phase 8, D33): run `<bin>
 * --version`. This both RESOLVES the binary (spawn fails with ENOENT if it's missing) AND confirms it
 * actually executes, surfacing the version for the wizard's health step. It is still a CHEAP probe —
 * `--version` makes NO model call and consumes none of the subscription window. Never throws; a
 * missing/broken binary is `ok:false`. (The lighter `checkClaude` resolve-only check still backs the
 * three-layer `/api/wiring` report.)
 */
export function checkClaudeVersion(
  timeoutMs = 4000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WiringStatus> {
  const configured = env['CLAUDE_BIN']?.trim();
  const bin = configured ? configured : 'claude';
  const label = configured ? `CLAUDE_BIN "${bin}"` : `"${bin}" on PATH`;
  return new Promise<WiringStatus>((resolve) => {
    let settled = false;
    const done = (status: WiringStatus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    };
    const child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, detail: `claude --version timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on('error', (cause) => {
      done({ ok: false, detail: `claude not runnable (${label}): ${errMessage(cause)}` });
    });
    child.on('close', (code) => {
      const version = out.trim();
      if (code === 0 && version !== '') {
        done({ ok: true, detail: `claude ${version} (${label})` });
      } else {
        done({
          ok: false,
          detail: `claude --version failed (${label}); set CLAUDE_BIN to a valid path`,
        });
      }
    });
  });
}
