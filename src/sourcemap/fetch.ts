import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FetchText } from './resolve.js';

/** How long one script or map fetch may take. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetches scripts and source maps the way the page would: through the browser context's request
 * API, so cookies and HTTP credentials apply. `file:` URLs are read from disk.
 */
export function pageFetcher(page: Page): FetchText {
  return async (url) => {
    if (url.startsWith('file:')) return { text: await readFile(fileURLToPath(url), 'utf8') };
    const response = await page.context().request.get(url, { timeout: FETCH_TIMEOUT_MS });
    if (!response.ok()) throw new Error(`HTTP ${response.status()} for ${url}`);
    const headers = response.headers();
    const header = headers['sourcemap'] ?? headers['x-sourcemap'];
    return { text: await response.text(), ...(header ? { sourceMapHeader: header } : {}) };
  };
}
