import { defineConfig } from '@playwright/test';
import type { SmoothnessTestOptions } from 'playwright-smoothness';

export default defineConfig<SmoothnessTestOptions>({
  testDir: 'tests',
  workers: 1,
  use: {
    baseURL: 'http://localhost:4181',
    browserName: 'chromium',
    channel: 'chromium',
    viewport: { width: 600, height: 600 },
    hasTouch: true, // the tests fling with touch input
    smoothnessOptions: { baselineDir: process.env.SMOOTHNESS_BASELINE_DIR },
  },
  webServer: {
    command: 'node build.mjs && node server.mjs',
    url: 'http://localhost:4181',
    reuseExistingServer: !process.env.CI,
  },
});
