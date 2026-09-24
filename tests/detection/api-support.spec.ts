// Section 3: the APIs exist and the page is visible in headless, so LoAF fires.
import { test, expect } from '@playwright/test';
import { save } from './helpers.js';

test('LoAF and Event Timing are supported and the page is visible', async ({ page, browser }) => {
  await page.goto('/raf.html');
  const env = await page.evaluate(() => ({
    entryTypes: PerformanceObserver.supportedEntryTypes,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency,
  }));
  save('environment', { browserVersion: browser.version(), ...env });
  expect(env.entryTypes).toContain('long-animation-frame');
  expect(env.entryTypes).toContain('event');
  expect(env.visibilityState).toBe('visible');
});
