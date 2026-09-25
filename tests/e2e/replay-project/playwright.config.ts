// Run in a child process by tests/e2e/replay.spec.ts.
import { defineConfig } from '@playwright/test';

const PORT = 4176;

export default defineConfig({
  testDir: '.',
  outputDir: process.env.SMOOTHNESS_E2E_OUT,
  snapshotDir: process.env.SMOOTHNESS_E2E_SNAPSHOTS,
  workers: 1,
  timeout: 120_000,
  reporter: [['list'], [process.env.SMOOTHNESS_REPORTER!]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: 'chromium',
    channel: 'chromium',
    headless: true,
    viewport: { width: 600, height: 600 },
  },
  webServer: {
    command: 'node ../../../test-pages/server.mjs',
    url: `http://localhost:${PORT}`,
    env: { PORT: String(PORT) },
    reuseExistingServer: true,
  },
});
