// Automatic mode's baseline: a rolling history of recent passing runs on the main branch,
// compared by median. One file per test, project, platform, CPU model and throttling rate.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SmoothnessResult } from '../types.js';
import type { BaselineMetrics } from '../baseline/compare.js';
import { metricsOf } from '../baseline/compare.js';
import { machineSlug, slug } from '../baseline/key.js';
import { PACKAGE_NAME } from '../constants.js';

const HISTORY_KIND = `${PACKAGE_NAME}-history`;

export interface HistoryEntry {
  recordedAt: string;
  /** The commit, when CI says which (GITHUB_SHA, CI_COMMIT_SHA, …). */
  commit?: string;
  browserVersion: string;
  metrics: BaselineMetrics;
}

export interface HistoryFile {
  schemaVersion: 1;
  kind: typeof HISTORY_KIND;
  test: string;
  project: string;
  machine: string;
  cpuThrottling: number;
  /** Hash of the whole spec file the entries were recorded with (plan decision 10). */
  specHash: string;
  entries: HistoryEntry[];
}

export function specHash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
}

/** `<dir>/<spec path>/<test title>-<project>-<machine>-cpu<N>x.json`. */
export function historyPath(
  dir: string,
  specRelative: string,
  test: string,
  project: string,
  result: SmoothnessResult,
): string {
  const name = [
    slug(test, 80),
    project ? slug(project, 30) : '',
    machineSlug(result.machine),
    `cpu${result.cpuThrottling}x`,
  ]
    .filter(Boolean)
    .join('-');
  return join(dir, specRelative, `${name}.json`);
}

export function readHistory(path: string): HistoryFile | string | null {
  if (!existsSync(path)) return null;
  try {
    const h = JSON.parse(readFileSync(path, 'utf8')) as HistoryFile;
    if (h.kind !== HISTORY_KIND || h.schemaVersion !== 1)
      return `${path} isn't a ${PACKAGE_NAME} history file`;
    return h;
  } catch (err) {
    return `${path} couldn't be read: ${String(err)}`;
  }
}

/** Per-metric median over the most recent entries; metrics no entry measured are left out. */
export function medianMetrics(entries: HistoryEntry[]): BaselineMetrics {
  const out: BaselineMetrics = {};
  const names = new Set(entries.flatMap((e) => Object.keys(e.metrics)));
  for (const n of names) {
    const vals = entries.map((e) => e.metrics[n]).filter((v): v is number => typeof v === 'number');
    if (!vals.length) {
      out[n] = null;
      continue;
    }
    const s = [...vals].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    out[n] = s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  }
  return out;
}

function commitFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.GITHUB_SHA ?? env.CI_COMMIT_SHA ?? env.BUILD_SOURCEVERSION ?? env.CIRCLE_SHA1 ?? undefined;
}

/** Appends a run, keeping the newest `keep` entries. Written atomically. */
export function appendHistory(
  path: string,
  base: Omit<HistoryFile, 'entries' | 'schemaVersion' | 'kind'>,
  previous: HistoryEntry[],
  result: SmoothnessResult,
  keep: number,
): HistoryFile {
  const commit = commitFromEnv();
  const entry: HistoryEntry = {
    recordedAt: new Date().toISOString(),
    ...(commit ? { commit } : {}),
    browserVersion: result.browserVersion,
    metrics: metricsOf(result),
  };
  const file: HistoryFile = {
    schemaVersion: 1,
    kind: HISTORY_KIND,
    ...base,
    entries: [...previous, entry].slice(-keep),
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n');
  renameSync(tmp, path);
  return file;
}
