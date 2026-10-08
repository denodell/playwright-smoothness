import { createHash } from 'node:crypto';
import type { SmoothnessResult } from '../types.js';

/** Everything a baseline must match to be comparable. */
export interface BaselineKey {
  label: string;
  project: string;
  platform: string;
  mode: SmoothnessResult['mode'];
  refreshRate: number;
  cpuThrottling: number;
  /** Short machine name, such as `amd-epyc-7763-4cpu`. Runner speed varies ~2x between CPU models. */
  machine: string;
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 6);
}

/** Lower-case, dash-separated, filesystem-safe. */
export function slug(s: string, max = 60): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out.slice(0, max).replace(/-+$/, '') || 'x';
}

/**
 * A label's file-name form. Different labels can slug the same ("Open filters" and
 * "open-filters"), so a short hash of the exact label is added whenever the slug differs from it.
 */
export function labelSlug(label: string): string {
  const s = slug(label);
  return s === label ? s : `${s}-${hash(label)}`;
}

/** `AMD EPYC 7763 64-Core Processor` with 4 CPUs → `amd-epyc-7763-4cpu`. */
export function machineSlug(machine: SmoothnessResult['machine']): string {
  const model = machine.cpuModel
    .replace(/\((R|TM)\)/gi, '')
    .replace(/@.*$/, '')
    .replace(/\b\d+-Core\b/gi, '')
    .replace(/\b(CPU|Processor)\b/gi, '');
  return `${slug(model, 40)}-${machine.cpus}cpu`;
}

export function baselineKey(result: SmoothnessResult, project: string): BaselineKey {
  return {
    label: result.label,
    project,
    platform: result.machine.platform,
    mode: result.mode,
    refreshRate: result.refreshRate,
    cpuThrottling: result.cpuThrottling,
    machine: machineSlug(result.machine),
  };
}

/** The part of the file name shared by every machine's baseline for this check. */
export function baselinePrefix(key: BaselineKey): string {
  return `${labelSlug(key.label)}-${key.mode}-${key.refreshRate}hz-cpu${key.cpuThrottling}x-`;
}

/**
 * The name passed to testInfo.snapshotPath(). Playwright's default snapshot template adds the
 * project name and platform, so those don't repeat here; they're checked inside the file instead.
 */
export function baselineFileName(key: BaselineKey): string {
  return `${baselinePrefix(key)}${key.machine}.json`;
}

export function sameKey(a: BaselineKey, b: BaselineKey): boolean {
  return (Object.keys(a) as (keyof BaselineKey)[]).every((k) => a[k] === b[k]);
}
