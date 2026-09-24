import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'test-pages/frameworks/', 'node_modules/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.mjs', 'test-pages/server.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
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
        URL: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    // work.js is where those globals are defined.
    files: ['test-pages/lib/work.js'],
    rules: { 'no-redeclare': 'off' },
  },
);
