import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'packages/*/dist/',
      '.tmp-e2e/',
      'test-pages/frameworks/',
      'node_modules/',
      'coverage/',
      'test-results/',
      'playwright-report/',
      'examples/**/node_modules/',
      'examples/**/test-results/',
      'examples/**/playwright-report/',
      'examples/**/smoothness-baselines/',
      'examples/react-list/public/app.js',
      'demos/apps/kanban/dist/',
      'demos/results/',
    ],
  },
  {
    files: ['examples/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        document: 'readonly',
        location: 'readonly',
        performance: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['demos/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        atob: 'readonly',
        Blob: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        document: 'readonly',
        location: 'readonly',
        performance: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
  },
  {
    files: ['scripts/**/*.mjs', 'test-pages/server.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
  {
    // smoothness-core talks to the browser only through its driver interfaces, so any automation
    // library can drive it. Playwright belongs in playwright-smoothness.
    files: ['packages/smoothness-core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@playwright/*', 'playwright', 'playwright-core', 'playwright-core/*'],
              message: 'smoothness-core must not depend on Playwright; use the interfaces in its driver.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Trace events and PerformanceEntry subclasses are loosely typed; tests read them defensively.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['test-pages/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        // Defined by test-pages/lib/work.js, which every page loads first.
        busyWait: 'readonly',
        self: 'readonly',
        Worker: 'readonly',
        doWork: 'readonly',
        param: 'readonly',
        window: 'readonly',
        document: 'readonly',
        performance: 'readonly',
        location: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        addEventListener: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
  },
  {
    // work.js is where those globals are defined.
    files: ['test-pages/lib/work.js'],
    rules: { 'no-redeclare': 'off' },
  },
);
