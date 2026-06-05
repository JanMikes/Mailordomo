import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Flat ESLint config for the Mailordomo monorepo.
 *
 * The load-bearing rule here is the STRUCTURAL NO-SEND GUARD (Golden rule #1 / PLAN.md §4.6):
 * the background daemon must have NO import path to the SMTP module, and the SMTP module must not
 * import the daemon. A violation fails `lint` and therefore the pre-commit/pre-push gate before
 * tests even run. The guard covers BOTH static imports (`no-restricted-imports`) and dynamic
 * `import()` / `require()` (`no-restricted-syntax`), since the former only sees static imports —
 * a daemon doing `await import('../smtp/send')` would otherwise slip past.
 *
 * The daemon has no legitimate reason to touch anything under `smtp/`, so the whole `smtp/` subtree
 * is forbidden (not just `send`/`transport`) — that also closes barrel re-export holes
 * (`import '../smtp'` resolving to a `smtp/index.ts` that re-exports `send`).
 */

// Import-source patterns reaching the SMTP module from anywhere in the tree.
const SMTP_PATTERNS = [
  '**/smtp',
  '**/smtp/**',
  '../smtp',
  '../smtp/**',
  '../../smtp',
  '../../smtp/**',
  '@mailordomo/backend/smtp',
  '@mailordomo/backend/smtp/*',
];

// Import-source patterns reaching the daemon from anywhere in the tree.
const DAEMON_PATTERNS = [
  '**/daemon',
  '**/daemon/**',
  '../daemon',
  '../daemon/**',
  '../../daemon',
  '../../daemon/**',
  '@mailordomo/backend/daemon',
  '@mailordomo/backend/daemon/*',
];

const NO_SEND_FROM_DAEMON =
  'Golden rule #1: the daemon must never import the SMTP send path (static, dynamic, or via barrel). Sending is ALWAYS manual. (PLAN.md §4.6)';
const NO_DAEMON_FROM_SMTP =
  'Golden rule #1: the SMTP send path must never import the daemon. Keep the modules separate. (PLAN.md §4.6)';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.config.{js,ts,mjs,cjs}',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Frontend runs in the browser.
  {
    files: ['packages/frontend/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  // STRUCTURAL NO-SEND GUARD — the daemon may never reach the SMTP module.
  {
    files: ['packages/backend/src/daemon/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: SMTP_PATTERNS, message: NO_SEND_FROM_DAEMON }] },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression > Literal[value=/(^|\\/)smtp(\\/|$)/]',
          message: NO_SEND_FROM_DAEMON,
        },
        {
          selector: "CallExpression[callee.name='require'] > Literal[value=/(^|\\/)smtp(\\/|$)/]",
          message: NO_SEND_FROM_DAEMON,
        },
      ],
    },
  },
  // Reverse guard — the entire SMTP module may never import the daemon.
  {
    files: ['packages/backend/src/smtp/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: DAEMON_PATTERNS, message: NO_DAEMON_FROM_SMTP }] },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression > Literal[value=/(^|\\/)daemon(\\/|$)/]',
          message: NO_DAEMON_FROM_SMTP,
        },
        {
          selector: "CallExpression[callee.name='require'] > Literal[value=/(^|\\/)daemon(\\/|$)/]",
          message: NO_DAEMON_FROM_SMTP,
        },
      ],
    },
  },
  // Test files and fixtures may use dev-only patterns.
  {
    files: ['**/*.test.{ts,tsx}', '**/__fixtures__/**'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  prettierConfig,
);
