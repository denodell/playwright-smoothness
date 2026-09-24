import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://localhost:4173' },
  webServer: { command: 'node server.js', url: 'http://localhost:4173', reuseExistingServer: true },
  projects: [
    { name: 'headless-shell', use: { ...devices['Desktop Chrome'], headless: true } },
    { name: 'new-headless', use: { ...devices['Desktop Chrome'], channel: 'chromium', headless: true } },
    { name: 'headed', use: { ...devices['Desktop Chrome'], channel: 'chromium', headless: false } },
  ],
});
