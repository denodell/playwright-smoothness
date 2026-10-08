import { defineConfig } from '@playwright/test';
import type { ButterTestOptions } from 'playwright-butter';

// Run from the repository root after `npm run build`:
//   APP_VARIANT=good npx playwright test -c demos   (records baselines)
//   APP_VARIANT=bad npx playwright test -c demos    (compares the slow versions with them)
export default defineConfig<ButterTestOptions>({
  testDir: 'tests',
  outputDir: 'results',
  timeout: 600_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4300', channel: 'chromium', viewport: { width: 1000, height: 700 } },
  webServer: {
    command: 'node server.mjs',
    url: 'http://localhost:4300/invoices/',
    reuseExistingServer: true,
  },
});
