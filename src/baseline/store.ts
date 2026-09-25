import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { BaselineInfo, SmoothnessResult, Spread } from '../types.js';
import { PACKAGE_NAME } from '../constants.js';
import { baselineFileName, baselinePrefix, sameKey, slug, type BaselineKey } from './key.js';
import { metricsOf, type BaselineMetrics } from './compare.js';

const BASELINE_KIND = `${PACKAGE_NAME}-baseline`;

/** What a baseline file holds. Versioned like results. */
export interface BaselineFile {
  schemaVersion: 1;
  kind: typeof BASELINE_KIND;
  key: BaselineKey;
  recordedAt: string;
  browserVersion: string;
  machine: SmoothnessResult['machine'];
  runs: number;
  metrics: BaselineMetrics;
  spread: Record<string, Spread>;
}

/** Where a baseline for this check lives: the snapshot path, and its baselineDir mirror. */
export interface BaselineLocation {
  snapshotPath: string;
  /** The same path relative to the project's snapshotDir, under baselineDir. */
  baselineDirPath: string | null;
}

interface SnapshotInfo {
  snapshotPath(...name: string[]): string;
  titlePath: string[];
  project: { snapshotDir: string };
}

/**
 * `<spec>-snapshots/smoothness/<test title>/<label>-<mode>-…json`. The test title keeps two tests in
 * one file that use the same label apart; renaming a test starts a new baseline.
 */
export function locateBaseline(
  key: BaselineKey,
  testInfo: SnapshotInfo,
  baselineDir: string | null,
): BaselineLocation {
  const title = slug(testInfo.titlePath.slice(1).join(' '), 80);
  const snapshotPath = testInfo.snapshotPath('smoothness', title, baselineFileName(key));
  const rel = relative(testInfo.project.snapshotDir, snapshotPath);
  return { snapshotPath, baselineDirPath: baselineDir ? join(baselineDir, rel) : null };
}

export type LoadOutcome =
  | { found: true; file: BaselineFile; info: BaselineInfo; notes: string[] }
  | { found: false; notes: string[] };

function readBaseline(path: string): BaselineFile | string {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as BaselineFile;
    if (data.kind !== BASELINE_KIND) return `${path} is not a ${PACKAGE_NAME} baseline`;
    if (data.schemaVersion !== 1)
      return `${path} has schemaVersion ${data.schemaVersion}; this version reads 1`;
    return data;
  } catch (err) {
    return `${path} could not be read: ${String(err)}`;
  }
}

/** Other machines' baselines for the same check, by their machine slug. */
function otherMachines(path: string, key: BaselineKey): string[] {
  const dir = dirname(path);
  if (!existsSync(dir)) return [];
  const prefix = baselinePrefix(key);
  const mine = basename(path);
  // The snapshot template may append `-<project>-<platform>` after our name; only files with
  // the same ending belong to this project and platform.
  if (!mine.startsWith(prefix + key.machine)) return [];
  const ending = mine.slice(prefix.length + key.machine.length);
  return readdirSync(dir)
    .filter((f) => f !== mine && f.startsWith(prefix) && f.endsWith(ending))
    .map((f) => f.slice(prefix.length, f.length - ending.length))
    .filter(Boolean);
}

/** Looks in baselineDir first, then the snapshot path. Reports anything it had to skip. */
export function loadBaseline(key: BaselineKey, where: BaselineLocation): LoadOutcome {
  const notes: string[] = [];
  const candidates: [string | null, BaselineInfo['source']][] = [
    [where.baselineDirPath, 'baselineDir'],
    [where.snapshotPath, 'snapshot'],
  ];
  for (const [path, source] of candidates) {
    if (!path || !existsSync(path)) continue;
    const file = readBaseline(path);
    if (typeof file === 'string') {
      notes.push(`Ignored a baseline: ${file}.`);
      continue;
    }
    if (!sameKey(file.key, key)) {
      notes.push(
        `Ignored ${path}: it was recorded for ${JSON.stringify(file.key)}, not ${JSON.stringify(key)}.`,
      );
      continue;
    }
    return {
      found: true,
      file,
      info: {
        path,
        source,
        recordedAt: file.recordedAt,
        browserVersion: file.browserVersion,
        machine: file.machine,
      },
      notes,
    };
  }
  const others = [
    ...new Set([
      ...(where.baselineDirPath ? otherMachines(where.baselineDirPath, key) : []),
      ...otherMachines(where.snapshotPath, key),
    ]),
  ];
  if (others.length) {
    notes.push(
      `No baseline for this machine (${key.machine}); baselines exist for ${others.join(', ')}. ` +
        'Runner speed differs between CPU models, so they are not compared (docs/measurements.md).',
    );
  }
  return { found: false, notes };
}

/** Writes the baseline atomically (write then rename), so a crash can't leave half a file. */
export function writeBaseline(path: string, key: BaselineKey, result: SmoothnessResult): BaselineInfo {
  const file: BaselineFile = {
    schemaVersion: 1,
    kind: BASELINE_KIND,
    key,
    recordedAt: new Date().toISOString(),
    browserVersion: result.browserVersion,
    machine: result.machine,
    runs: result.runs,
    metrics: metricsOf(result),
    spread: result.spread,
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n');
  renameSync(tmp, path);
  return {
    path,
    source: 'snapshot',
    recordedAt: file.recordedAt,
    browserVersion: file.browserVersion,
    machine: file.machine,
  };
}
