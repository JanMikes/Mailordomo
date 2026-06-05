import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * Proves the STRUCTURAL NO-SEND GUARD (Golden rule #1 / PLAN.md §4.6) actually trips, including
 * the bypasses a naive `no-restricted-imports`-only rule would miss: dynamic `import()` and barrel
 * re-exports. We lint in-memory source as if it lived at a given path under the backend, using the
 * repo's real `eslint.config.js`. No violating file is committed to disk.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// here = <repo>/packages/backend/src  ->  three levels up is the repo root.
const repoRoot = path.resolve(here, '../../..');

async function lintAsFile(relPathFromRepoRoot: string, code: string) {
  const eslint = new ESLint({ cwd: repoRoot });
  const filePath = path.join(repoRoot, relPathFromRepoRoot);
  const [result] = await eslint.lintText(code, { filePath });
  if (!result) throw new Error('ESLint returned no result');
  return result;
}

/** Violations from either guard rule (static imports or dynamic import/require syntax). */
function guardViolations(result: { messages: { ruleId: string | null }[] }) {
  return result.messages.filter(
    (m) => m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-syntax',
  );
}

const DAEMON_FILE = 'packages/backend/src/daemon/__guard_fixture__.ts';
const SMTP_FILE = 'packages/backend/src/smtp/__guard_fixture__.ts';

describe('structural no-send guard (Golden rule #1 / PLAN.md §4.6)', () => {
  it('FAILS when daemon code statically imports the SMTP send path', async () => {
    const result = await lintAsFile(
      DAEMON_FILE,
      `import { assertManualSendOnly } from '../smtp/send';\nexport const x = assertManualSendOnly;\n`,
    );
    expect(guardViolations(result).length).toBeGreaterThan(0);
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it('FAILS when daemon code DYNAMICALLY imports the SMTP send path', async () => {
    const result = await lintAsFile(
      DAEMON_FILE,
      `export async function load() {\n  return import('../smtp/send');\n}\n`,
    );
    expect(guardViolations(result).length).toBeGreaterThan(0);
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it('FAILS when daemon code imports the SMTP barrel (re-export hole)', async () => {
    const result = await lintAsFile(
      DAEMON_FILE,
      `import * as smtp from '../smtp';\nexport const x = smtp;\n`,
    );
    expect(guardViolations(result).length).toBeGreaterThan(0);
    expect(result.errorCount).toBeGreaterThan(0);
  });

  // Phase 7b (D31): the manual send endpoint lives in `api/app.ts`, which imports `smtp/send`, so the
  // whole `api/` subtree — and the root barrel that re-exports it — is now a TRANSITIVE route to the
  // transmit code. The specifier-based SMTP guard cannot see that; these prove the api/barrel guard does.
  it('FAILS when daemon code imports the HTTP api layer (transitive smtp via api/app)', async () => {
    const result = await lintAsFile(
      DAEMON_FILE,
      `import { createBackendApi } from '../api/app';\nexport const x = createBackendApi;\n`,
    );
    expect(guardViolations(result).length).toBeGreaterThan(0);
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it('FAILS when daemon code imports the api barrel (transitive smtp)', async () => {
    const result = await lintAsFile(
      DAEMON_FILE,
      `import * as api from '../api';\nexport const x = api;\n`,
    );
    expect(guardViolations(result).length).toBeGreaterThan(0);
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it('FAILS when daemon code imports the backend root barrel by self-name (transitive smtp)', async () => {
    const result = await lintAsFile(
      DAEMON_FILE,
      `import { createBackendApi } from '@mailordomo/backend';\nexport const x = createBackendApi;\n`,
    );
    expect(guardViolations(result).length).toBeGreaterThan(0);
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it('ALLOWS the daemon to import a sibling engine module directly (guard is not over-broad)', async () => {
    const result = await lintAsFile(
      'packages/backend/src/daemon/__guard_fixture_ok3__.ts',
      `import { buildThreads } from '../threading';\nexport const x = buildThreads;\n`,
    );
    expect(guardViolations(result).length).toBe(0);
  });

  it('FAILS when the SMTP module statically imports the daemon', async () => {
    const result = await lintAsFile(
      SMTP_FILE,
      `import { DAEMON_NAME } from '../daemon/index';\nexport const y = DAEMON_NAME;\n`,
    );
    expect(guardViolations(result).length).toBeGreaterThan(0);
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it('FAILS when the SMTP module DYNAMICALLY imports the daemon', async () => {
    const result = await lintAsFile(
      SMTP_FILE,
      `export async function load() {\n  return import('../daemon/index');\n}\n`,
    );
    expect(guardViolations(result).length).toBeGreaterThan(0);
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it('ALLOWS daemon code that does not touch the SMTP module', async () => {
    const result = await lintAsFile(
      'packages/backend/src/daemon/__guard_fixture_ok__.ts',
      `export const ok = true as const;\n`,
    );
    expect(guardViolations(result).length).toBe(0);
  });

  it('ALLOWS the daemon to dynamically import an unrelated module (guard is not over-broad)', async () => {
    const result = await lintAsFile(
      'packages/backend/src/daemon/__guard_fixture_ok2__.ts',
      `export async function load() {\n  return import('node:fs');\n}\n`,
    );
    expect(guardViolations(result).length).toBe(0);
  });
});
