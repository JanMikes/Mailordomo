import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * Proves the STRUCTURAL NO-SEND GUARD (Golden rule #1 / PLAN.md §4.6) actually trips.
 *
 * We lint in-memory source as if it lived at a given path under the backend, using the repo's
 * real `eslint.config.js`. No violating file is committed to disk; `lintText` applies the
 * file-pattern overrides by the provided `filePath`, so the daemon/send-path rules engage.
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

function restrictedImportMessages(result: { messages: { ruleId: string | null }[] }) {
  return result.messages.filter((m) => m.ruleId === 'no-restricted-imports');
}

describe('structural no-send guard (Golden rule #1 / PLAN.md §4.6)', () => {
  it('FAILS lint when daemon code imports the SMTP send path', async () => {
    const result = await lintAsFile(
      'packages/backend/src/daemon/__guard_fixture__.ts',
      `import { assertManualSendOnly } from '../smtp/send';\nexport const x = assertManualSendOnly;\n`,
    );
    expect(restrictedImportMessages(result).length).toBeGreaterThan(0);
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it('FAILS lint when the SMTP send path imports the daemon', async () => {
    const result = await lintAsFile(
      'packages/backend/src/smtp/send.ts',
      `import { DAEMON_NAME } from '../daemon/index';\nexport const y = DAEMON_NAME;\n`,
    );
    expect(restrictedImportMessages(result).length).toBeGreaterThan(0);
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it('ALLOWS daemon code that does not import the send path', async () => {
    const result = await lintAsFile(
      'packages/backend/src/daemon/__guard_fixture_ok__.ts',
      `export const ok = true as const;\n`,
    );
    expect(restrictedImportMessages(result).length).toBe(0);
  });
});
