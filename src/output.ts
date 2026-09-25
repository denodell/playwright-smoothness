import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SmoothnessResult } from './types.js';
import { labelSlug, slug } from './baseline/key.js';

/** Where each result's JSON was written, so toBeSmooth() can rewrite it with the comparison. */
const written = new WeakMap<SmoothnessResult, string>();

interface OutputInfo {
  testId: string;
  titlePath: string[];
  retry: number;
  project: { outputDir: string };
}

/**
 * `test-results/smoothness/<test title>-<id>[-retryN]/<label>.json`. The test id keeps two tests
 * with the same title apart; the retry suffix keeps a retry from overwriting the first attempt.
 */
export function resultPath(info: OutputInfo, label: string): string {
  const title = slug(info.titlePath.slice(1).join(' '), 80);
  const id = createHash('sha256').update(info.testId).digest('hex').slice(0, 8);
  const retry = info.retry ? `-retry${info.retry}` : '';
  return join(info.project.outputDir, 'smoothness', `${title}-${id}${retry}`, `${labelSlug(label)}.json`);
}

/** Writes JSON to a temporary file, then renames it, so a reader never sees half a file. */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}

export function writeResult(result: SmoothnessResult, path: string): void {
  writeJsonAtomic(path, result);
  written.set(result, path);
}

export function writtenPath(result: SmoothnessResult): string | undefined {
  return written.get(result);
}
