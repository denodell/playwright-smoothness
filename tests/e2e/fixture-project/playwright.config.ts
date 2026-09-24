// A small user project, run in a child process by tests/e2e/acceptance.spec.ts.
import { defineConfig } from '@playwright/test';

const PORT = 4174;

export default defineConfig({
  testDir: '.',
  outputDir: process.env.SMOOTHNESS_E2E_OUT,
  snapshotDir: process.env.SMOOTHNESS_E2E_SNAPSHOTS,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://localhost:${PORT}`, browserName: 'chromium', channel: 'chromium', headless: true },
  webServer: {
    command: 'node ../../../test-pages/server.mjs',
    url: `http://localhost:${PORT}`,
    env: { PORT: String(PORT) },
    reuseExistingServer: true,
  },
});
