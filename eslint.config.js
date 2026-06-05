import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Flat ESLint config for the Mailordomo monorepo.
 *
 * The load-bearing rule here is the STRUCTURAL NO-SEND GUARD (Golden rule #1 / PLAN.md §4.6):
 * the background daemon must have no import path to the SMTP send module, and vice-versa.
 * A violation fails `lint` and therefore the pre-commit/pre-push gate before tests even run.
 */

// Import-source patterns that reach the SMTP send path from anywhere in the tree.
const SEND_PATH_PATTERNS = [
  '**/smtp/send',
  '**/smtp/send.*',
  '**/smtp/transport',
  '**/smtp/transport.*',
  '../smtp/send',
  '../smtp/transport',
  '@mailordomo/backend/smtp/send',
  '@mailordomo/backend/smtp/send.*',
  '@mailordomo/backend/smtp/transport',
];

// Import-source patterns that reach the daemon from anywhere in the tree.
const DAEMON_PATTERNS = [
  '**/daemon',
  '**/daemon/**',
  '../daemon',
  '../daemon/**',
  '@mailordomo/backend/daemon',
  '@mailordomo/backend/daemon/*',
];

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
  // STRUCTURAL NO-SEND GUARD — the daemon may never import the SMTP send path.
  {
    files: ['packages/backend/src/daemon/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: SEND_PATH_PATTERNS,
              message:
                'Golden rule #1: the daemon must never import the SMTP send path. Sending is ALWAYS manual. (PLAN.md §4.6)',
            },
          ],
        },
      ],
    },
  },
  // Reverse guard — the SMTP send path may never import the daemon.
  {
    files: [
      'packages/backend/src/smtp/send.{ts,tsx}',
      'packages/backend/src/smtp/transport.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: DAEMON_PATTERNS,
              message:
                'Golden rule #1: the SMTP send path must never import the daemon. Keep the modules separate. (PLAN.md §4.6)',
            },
          ],
        },
      ],
    },
  },
  // Test files may use dev-only patterns.
  {
    files: ['**/*.test.{ts,tsx}', '**/__fixtures__/**'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  prettierConfig,
);
