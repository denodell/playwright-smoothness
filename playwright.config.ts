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
    command: 'node test-pages/server.mjs',
    url: `http://localhost:${PORT}`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    // Pure logic, no browser.
    { name: 'unit', testDir: './tests/unit' },

    // Raw Playwright reproductions of the spike's findings. New headless, as the library defaults to.
    {
      name: 'detection',
      testDir: './tests/detection',
      testIgnore: /headless-mode\.spec\.ts/,
      use: { browserName: 'chromium', channel: 'chromium', headless: true },
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
