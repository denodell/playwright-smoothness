import { defineConfig } from '@playwright/test';
import type { ButterTestOptions } from 'playwright-butter';

export default defineConfig<ButterTestOptions>({
  testDir: 'tests',
  // A measurement is a warm-up plus several reloaded runs; a traced fast scroll through a list takes a while.
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:4181',
    browserName: 'chromium',
    channel: 'chromium',
    viewport: { width: 600, height: 600 },
    hasTouch: true, // the tests swipe with touch input
    butterOptions: { baselineDir: process.env.SMOOTHNESS_BASELINE_DIR },
  },
  webServer: {
    command: 'node build.mjs && node server.mjs',
    url: 'http://localhost:4181',
    reuseExistingServer: !process.env.CI,
  },
});
