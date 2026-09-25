// An existing Playwright project, copied to a temp folder and run by tests/e2e/auto.spec.ts.
import { defineConfig } from '@playwright/test';

const PORT = 4175;

export default defineConfig({
  testDir: '.',
  outputDir: 'test-results',
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://localhost:${PORT}`, browserName: 'chromium', channel: 'chromium', headless: true },
  webServer: {
    command: `node ${process.env.SMOOTHNESS_TEST_PAGES}/server.mjs`,
    url: `http://localhost:${PORT}`,
    env: { PORT: String(PORT) },
    reuseExistingServer: true,
  },
});
