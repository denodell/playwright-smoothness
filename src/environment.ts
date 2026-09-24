import type { Browser } from '@playwright/test';
import type { HeadlessMode } from './types.js';

export interface BrowserEnvironment {
  browserName: string;
  browserVersion: string;
  headlessMode: HeadlessMode;
  /** Why headlessMode is 'unknown', when it is. */
  headlessModeReason?: string;
}

/**
 * Identifies the headless mode from CDP Browser.getVersion. Page user-agent overrides (such
 * as Playwright's device descriptors) don't affect these fields. Verified on Playwright 1.49,
 * 1.56, 1.57 and 1.63 by the headless-matrix workflow; see docs/measurements.md.
 */
export function detectHeadlessMode(version: { product?: string; userAgent?: string }): HeadlessMode {
  const product = version.product ?? '';
  const ua = version.userAgent ?? '';
  if (product.startsWith('HeadlessChrome/')) return 'headless-shell';
  if (!product.startsWith('Chrome/')) return 'unknown';
  if (/HeadlessChrome\//.test(ua)) return 'new-headless';
  if (/Chrome\//.test(ua)) return 'headed';
  return 'unknown';
}

const cache = new WeakMap<Browser, Promise<BrowserEnvironment>>();

/** Reads the browser's name, version and headless mode once per browser. */
export function browserEnvironment(browser: Browser | null): Promise<BrowserEnvironment> {
  if (!browser) {
    return Promise.resolve({
      browserName: 'unknown',
      browserVersion: 'unknown',
      headlessMode: 'unknown',
      headlessModeReason: 'no Browser object (persistent context?)',
    });
  }
  let env = cache.get(browser);
  if (!env) {
    env = readEnvironment(browser);
    cache.set(browser, env);
  }
  return env;
}

async function readEnvironment(browser: Browser): Promise<BrowserEnvironment> {
  const browserName = browser.browserType().name();
  const browserVersion = browser.version();
  if (browserName !== 'chromium')
    return { browserName, browserVersion, headlessMode: 'unknown', headlessModeReason: 'not Chromium' };
  try {
    const cdp = await browser.newBrowserCDPSession();
    try {
      const version = await cdp.send('Browser.getVersion');
      const headlessMode = detectHeadlessMode(version);
      return {
        browserName,
        browserVersion,
        headlessMode,
        ...(headlessMode === 'unknown'
          ? { headlessModeReason: `unrecognised product '${version.product}'` }
          : {}),
      };
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  } catch (err) {
    return {
      browserName,
      browserVersion,
      headlessMode: 'unknown',
      headlessModeReason: `Browser.getVersion failed: ${String(err)}`,
    };
  }
}
