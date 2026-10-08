import type { HeadlessMode } from './types.js';

export interface BrowserEnvironment {
  browserName: string;
  browserVersion: string;
  headlessMode: HeadlessMode;
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
