import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Playwright's CLI script. Child runs start it with `node` (process.execPath): on Windows, Node
 * won't spawn node_modules/.bin/playwright.cmd without a shell.
 */
export const PLAYWRIGHT_CLI = resolve('node_modules', '@playwright', 'test', 'cli.js');

/** Every file under dir, at any depth, whose name ends with suffix. Missing dir: none. */
export function files(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p, suffix) : p.endsWith(suffix) ? [p] : [];
  });
}
