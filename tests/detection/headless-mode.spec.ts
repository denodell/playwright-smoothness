// Records every candidate signal for telling the headless shell apart from new headless
// and headed Chrome. Run by the three mode-* projects and by the headless-matrix workflow
// across Playwright versions. detectHeadlessMode in src/environment.ts is based on these
// results (docs/measurements.md, Headless-mode detection).
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { save } from './helpers.js';

const playwrightVersion = (
  createRequire(import.meta.url)('@playwright/test/package.json') as { version: string }
).version;

test('record headless-mode signals', async ({ page, browser, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Chromium only');
  const cdp = await browser.newBrowserCDPSession();
  const version = (await cdp.send('Browser.getVersion')) as Record<string, string>;
  await cdp.detach();
  await page.goto('/raf.html');
  const pageSignals = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    uaDataBrands: (
      navigator as unknown as { userAgentData?: { brands: { brand: string }[] } }
    ).userAgentData?.brands.map((b) => b.brand),
    webdriver: navigator.webdriver,
    pluginsLength: navigator.plugins.length,
    outerHeight: window.outerHeight,
    innerHeight: window.innerHeight,
  }));
  // Recorded to document that it does NOT identify the running binary: it reports the
  // browser type's default executable, even when the headless shell was launched.
  let executablePath: string;
  try {
    executablePath = browser.browserType().executablePath();
  } catch (err) {
    executablePath = `error: ${String(err)}`;
  }
  const use = testInfo.project.use as { channel?: string; headless?: boolean };
  const record = {
    project: testInfo.project.name,
    playwrightVersion,
    projectUse: { channel: use.channel ?? null, headless: use.headless ?? null },
    browserVersion: browser.version(),
    executablePath,
    cdpProduct: version.product,
    cdpUserAgent: version.userAgent,
    ...pageSignals,
  };
  save('headless-mode', record);
  expect(record.cdpProduct).toBeTruthy();
});
