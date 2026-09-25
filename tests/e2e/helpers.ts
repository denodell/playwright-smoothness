import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Every file under dir, at any depth, whose name ends with suffix. Missing dir: none. */
export function files(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p, suffix) : p.endsWith(suffix) ? [p] : [];
  });
}
