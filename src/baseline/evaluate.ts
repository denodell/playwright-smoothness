import type { Comparison, Enforce, SmoothnessResult } from '../types.js';
import { baselineKey } from './key.js';
import { compareMetrics } from './compare.js';
import { loadBaseline, locateBaseline, writeBaseline } from './store.js';

export interface MatcherOptions {
  /** Overrides the result's maxIncrease for this assertion. */
  maxIncrease?: number;
  /** Overrides the result's enforce setting for this assertion. */
  enforce?: Enforce;
  /** Overrides whether total blocking time is gated. */
  gateTotalBlocking?: boolean;
}

export interface EvaluateInfo {
  snapshotPath(...name: string[]): string;
  titlePath: string[];
  project: { name: string; snapshotDir: string };
  config: { updateSnapshots: string };
}

/** Loads the baseline, compares, and creates or updates it as `--update-snapshots` says. */
export function evaluate(
  result: SmoothnessResult,
  info: EvaluateInfo,
  overrides: MatcherOptions = {},
): Comparison {
  const settings = { ...result.settings, ...definedOnly(overrides) };
  const effective: SmoothnessResult = { ...result, settings };
  const notes: string[] = [];

  if (result.runs === 0) {
    const why = [...new Set(result.unavailable.map((u) => u.reason))].join('; ');
    return { status: 'not-compared', checks: [], baseline: null, notes: [`Nothing was measured: ${why}.`] };
  }

  const key = baselineKey(result, info.project.name);
  const where = locateBaseline(key, info, settings.baselineDir);
  const update = info.config.updateSnapshots;
  const loaded = loadBaseline(key, where);

  if (!loaded.found) {
    notes.push(...loaded.notes);
    if (update === 'none') {
      notes.push(
        `No baseline exists at ${where.snapshotPath}, and --update-snapshots=none, so nothing was compared.`,
      );
      return { status: 'not-compared', checks: [], baseline: null, notes };
    }
    const baseline = writeBaseline(where.snapshotPath, key, result);
    notes.push(
      `No baseline existed, so this result was recorded as the baseline (${where.snapshotPath}). Later runs compare against it.`,
    );
    return { status: 'baseline-created', checks: [], baseline, notes };
  }

  notes.push(...loaded.notes);
  const checks = compareMetrics(effective, loaded.file.metrics, settings.maxIncrease);
  if (loaded.file.browserVersion !== result.browserVersion) {
    notes.push(
      `The baseline was recorded with ${result.browserName} ${loaded.file.browserVersion}; this run used ${result.browserVersion}. Browser updates can move these numbers.`,
    );
  }
  const worse = checks.some((c) => c.status === 'worse');

  if (update === 'all' || (update === 'changed' && worse)) {
    const baseline = writeBaseline(where.snapshotPath, key, result);
    notes.push(`--update-snapshots=${update}: the baseline was replaced with this result.`);
    return { status: 'baseline-updated', checks, baseline, notes };
  }

  const compared = checks.some((c) => c.status === 'pass' || c.status === 'worse');
  const status = worse
    ? settings.enforce === 'fail'
      ? 'fail'
      : 'warn'
    : compared || checks.length === 0
      ? 'pass'
      : 'not-compared';
  return { status, checks, baseline: loaded.info, notes };
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
