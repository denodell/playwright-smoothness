// The Playwright adapter: a PageDriver for a Playwright Page and an ElementTarget for a Locator.
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  detectHeadlessMode,
  type BrowserEnvironment,
  type CdpSession,
  type ElementTarget,
  type Evaluate,
  type PageDriver,
  type ScratchPage,
  type FetchText,
} from 'butter-core';

/** How long one script or source map fetch may take. */
const FETCH_TIMEOUT_MS = 10_000;

/** The origin a secure scratch page is served from. Playwright answers it itself (page.route). */
const SCRATCH_URL = 'http://localhost/__playwright-butter-scratch';

const environments = new WeakMap<Browser, Promise<BrowserEnvironment>>();

/** The browser's name, version and headless mode, read once per browser. */
export function browserEnvironment(browser: Browser | null): Promise<BrowserEnvironment> {
  if (!browser) {
    return Promise.resolve({ browserName: 'unknown', browserVersion: 'unknown', headlessMode: 'unknown' });
  }
  let env = environments.get(browser);
  if (!env) {
    env = readEnvironment(browser);
    environments.set(browser, env);
  }
  return env;
}

async function readEnvironment(browser: Browser): Promise<BrowserEnvironment> {
  const browserName = browser.browserType().name();
  const browserVersion = browser.version();
  if (browserName !== 'chromium') return { browserName, browserVersion, headlessMode: 'unknown' };
  try {
    const cdp = await browser.newBrowserCDPSession();
    try {
      const version = await cdp.send('Browser.getVersion');
      return { browserName, browserVersion, headlessMode: detectHeadlessMode(version) };
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  } catch {
    return { browserName, browserVersion, headlessMode: 'unknown' };
  }
}

// Playwright's evaluate types are richer than the engine needs; the engine only passes
// serializable arguments.
const evaluateOn =
  (page: Page): Evaluate =>
  (fn, arg) =>
    page.evaluate(fn as never, arg as never);

/**
 * Fetches scripts and source maps the way the page would: through the browser context's request
 * API, so cookies and HTTP credentials apply. `file:` URLs are read from disk.
 */
export function contextFetcher(context: BrowserContext): FetchText {
  return async (url) => {
    if (url.startsWith('file:')) return { text: await readFile(fileURLToPath(url), 'utf8') };
    const response = await context.request.get(url, { timeout: FETCH_TIMEOUT_MS });
    if (!response.ok()) throw new Error(`HTTP ${response.status()} for ${url}`);
    const headers = response.headers();
    const header = headers['sourcemap'] ?? headers['x-sourcemap'];
    return { text: await response.text(), ...(header ? { sourceMapHeader: header } : {}) };
  };
}

export function playwrightDriver(page: Page): PageDriver {
  const browser = () => page.context().browser();
  return {
    native: page,
    environment: () => browserEnvironment(browser()),
    evaluate: evaluateOn(page),
    addInitScript: async (fn, arg) => {
      await page.addInitScript(fn as never, arg as never);
    },
    reload: async () => {
      await page.reload({ waitUntil: 'load' });
    },
    viewport: () => page.viewportSize(),
    screenshot: (clip) => page.screenshot({ clip, type: 'png', scale: 'css' }),
    click: (x, y) => page.mouse.click(x, y),
    press: (key) => page.keyboard.press(key),
    cdp: async (): Promise<CdpSession> => {
      const session = await page.context().newCDPSession(page);
      return {
        send: (method, params) => session.send(method as never, params as never),
        on: (event, handler) => session.on(event as never, handler),
        off: (event, handler) => session.off(event as never, handler),
        detach: () => session.detach(),
      };
    },
    // Through the browser context's request API, so cookies and HTTP credentials apply. `file:`
    // URLs are read from disk.
    fetchText: contextFetcher(page.context()),
    // A persistent context has no Browser, and Browser.startTracing is Playwright's only tracer.
    tracer: () => {
      const b = browser();
      if (!b) return null;
      return {
        start: (categories, { screenshots }) => b.startTracing(page, { categories, screenshots }),
        stop: () => b.stopTracing(),
      };
    },
    openScratchPage: ({ secure }) => {
      const b = browser();
      return b ? openScratch(b, secure) : null;
    },
  };
}

async function openScratch(browser: Browser, secure: boolean): Promise<ScratchPage> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    if (secure) {
      await page.route(SCRATCH_URL, (r) =>
        r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>scratch</title>' }),
      );
      await page.goto(SCRATCH_URL);
    }
    return { evaluate: evaluateOn(page), close: () => context.close() };
  } catch (err) {
    await context.close().catch(() => undefined);
    throw err;
  }
}

export function locatorTarget(locator: Locator): ElementTarget {
  return {
    description: String(locator),
    evaluate: (fn, arg) => locator.evaluate(fn as never, arg as never),
    scrollIntoView: () => locator.scrollIntoViewIfNeeded(),
    focus: () => locator.focus(),
  };
}
