import { defineConfig } from '@playwright/test';
import type { SmoothnessTestOptions } from 'playwright-smoothness';

export default defineConfig<SmoothnessTestOptions>({
  testDir: 'tests',
  // The smoothness summary (test-results/smoothness/summary.md, and the GitHub job summary).
  reporter: [['list'], ['playwright-smoothness/reporter']],
  // A measurement is a warm-up plus several reloaded runs; a traced list fling takes a while.
  timeout: 120_000,
  // Timing tests shouldn't compete with each other for the CPU.
  workers: 1,
  use: {
    baseURL: 'http://localhost:4180',
    browserName: 'chromium',
    channel: 'chromium', // new headless: closer to real Chrome than the headless shell
    smoothnessOptions: {
      // Baselines downloaded from main (see ../../docs/ci.md); unset locally.
      baselineDir: process.env.SMOOTHNESS_BASELINE_DIR,
      enforce: process.env.SMOOTHNESS_ENFORCE === 'fail' ? 'fail' : 'warn',
    },
  },
  webServer: {
    command: 'node server.mjs',
    url: 'http://localhost:4180',
    reuseExistingServer: !process.env.CI,
  },
});
