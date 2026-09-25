import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.PORT || 4173);

// Timing-sensitive suites run one test at a time so tests don't steal CPU from each other.
export default defineConfig({
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    command: 'node scripts/build-test-pages.mjs && node test-pages/server.mjs',
    url: `http://localhost:${PORT}`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    // Pure logic, no browser.
    // Snapshots here are text (failure messages), identical on every platform.
    {
      name: 'unit',
      testDir: './tests/unit',
      snapshotPathTemplate: '{testDir}/__snapshots__/{testFileName}/{arg}{ext}',
    },

    // Raw Playwright reproductions of the spike's findings. New headless, as the library defaults to.
    {
      name: 'detection',
      testDir: './tests/detection',
      testIgnore: /headless-mode\.spec\.ts/,
      use: { browserName: 'chromium', channel: 'chromium', headless: true },
    },

    // The library, end to end, in new headless (its default).
    {
      name: 'integration',
      testDir: './tests/integration',
      testIgnore: /non-chromium\.spec\.ts/,
      use: { browserName: 'chromium', channel: 'chromium', headless: true },
      // Baselines written by toBeSmooth() in these tests belong to the run, not the repository.
      snapshotPathTemplate:
        'test-results/integration-snapshots/{testFilePath}/{arg}{-projectName}{-snapshotSuffix}{ext}',
    },
    // Acceptance tests that run a user project in a child Playwright process.
    { name: 'e2e', testDir: './tests/e2e', testIgnore: /(fixture|auto|replay)-project/ },
    // Principle 7: other browsers are skipped visibly, never passed silently.
    {
      name: 'integration-firefox',
      testDir: './tests/integration',
      testMatch: /non-chromium\.spec\.ts/,
      use: { browserName: 'firefox' },
    },

    // Records which signals identify each headless mode (see docs/measurements.md).
    {
      name: 'mode-headless-shell',
      testDir: './tests/detection',
      testMatch: /headless-mode\.spec\.ts/,
      use: { browserName: 'chromium', headless: true },
    },
    {
      name: 'mode-new-headless',
      testDir: './tests/detection',
      testMatch: /headless-mode\.spec\.ts/,
      use: { browserName: 'chromium', channel: 'chromium', headless: true },
    },
    {
      name: 'mode-headed',
      testDir: './tests/detection',
      testMatch: /headless-mode\.spec\.ts/,
      use: { browserName: 'chromium', channel: 'chromium', headless: false },
    },
  ],
});
