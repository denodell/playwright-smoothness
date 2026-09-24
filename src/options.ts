import type { ResolvedOptions, SmoothnessMode, SmoothnessOptions } from './types.js';

export const DEFAULT_RUNS = 5;
export const DEFAULT_CPU_THROTTLING = 4;
export const DEFAULT_MAX_INCREASE = 0.15;
export const DEFAULT_REFRESH_RATE = 60;

type Env = Record<string, string | undefined>;

/**
 * Scheduled-pipeline signals per CI provider. A scheduled run gets full mode by default,
 * because it has time for tracing; pull requests get quick mode. Documented in docs/mode-detection.md.
 */
const SCHEDULED_CI: { provider: string; variable: string; matches: (value: string) => boolean }[] = [
  { provider: 'GitHub Actions', variable: 'GITHUB_EVENT_NAME', matches: (v) => v === 'schedule' },
  { provider: 'GitLab CI', variable: 'CI_PIPELINE_SOURCE', matches: (v) => v === 'schedule' },
  { provider: 'Azure Pipelines', variable: 'BUILD_REASON', matches: (v) => v === 'Schedule' },
  {
    provider: 'CircleCI',
    variable: 'CIRCLE_PIPELINE_TRIGGER_SOURCE',
    matches: (v) => v === 'scheduled_pipeline',
  },
];

/** Picks the mode and says which rule chose it. */
export function detectMode(
  explicit: SmoothnessMode | undefined,
  env: Env,
): { mode: SmoothnessMode; source: string } {
  if (explicit) return { mode: explicit, source: 'option' };
  const fromEnv = env.SMOOTHNESS_MODE?.trim().toLowerCase();
  if (fromEnv === 'quick' || fromEnv === 'full') return { mode: fromEnv, source: 'SMOOTHNESS_MODE' };
  if (fromEnv) {
    throw new Error(`SMOOTHNESS_MODE must be 'quick' or 'full', got '${env.SMOOTHNESS_MODE}'.`);
  }
  for (const rule of SCHEDULED_CI) {
    const value = env[rule.variable];
    if (value !== undefined && rule.matches(value)) {
      return { mode: 'full', source: `scheduled CI (${rule.provider}: ${rule.variable}=${value})` };
    }
  }
  return { mode: 'quick', source: 'default' };
}

/** Applies defaults and validates. Later sources override earlier ones. */
export function resolveOptions(
  sources: (SmoothnessOptions | undefined)[],
  env: Env = process.env,
): ResolvedOptions {
  const o: SmoothnessOptions = Object.assign({}, ...sources.filter(Boolean));
  const { mode, source } = detectMode(o.mode, env);
  const runs = o.runs ?? DEFAULT_RUNS;
  if (!Number.isInteger(runs) || runs < 1)
    throw new Error(`smoothness: runs must be a positive integer, got ${runs}.`);
  const cpuThrottling = o.cpuThrottling ?? DEFAULT_CPU_THROTTLING;
  if (!(cpuThrottling >= 1))
    throw new Error(`smoothness: cpuThrottling must be 1 or more, got ${cpuThrottling}.`);
  const maxIncrease = o.maxIncrease ?? DEFAULT_MAX_INCREASE;
  if (!(maxIncrease >= 0)) throw new Error(`smoothness: maxIncrease must be 0 or more, got ${maxIncrease}.`);
  const refreshRate = o.refreshRate ?? DEFAULT_REFRESH_RATE;
  if (refreshRate !== 60 && refreshRate !== 120) {
    throw new Error(`smoothness: refreshRate must be 60 or 120, got ${refreshRate}.`);
  }
  const enforce = o.enforce ?? 'warn';
  if (enforce !== 'warn' && enforce !== 'fail') {
    throw new Error(`smoothness: enforce must be 'warn' or 'fail', got '${enforce}'.`);
  }
  return {
    mode,
    modeSource: source,
    runs,
    cpuThrottling,
    maxIncrease,
    refreshRate,
    enforce,
    baselineDir: o.baselineDir,
    list: { background: o.list?.background ?? 'auto', placeholders: o.list?.placeholders ?? [] },
    reset: o.reset ?? 'reload',
  };
}
