import type { SmoothnessResult } from '../../src/types.js';

type DeepPartial<T> = {
  [K in keyof T]?: NonNullable<T[K]> extends unknown[]
    ? T[K]
    : NonNullable<T[K]> extends object
      ? DeepPartial<NonNullable<T[K]>> | Extract<T[K], null>
      : T[K];
};

/** A realistic quick-mode result, with overrides. */
export function makeResult(overrides: DeepPartial<SmoothnessResult> = {}): SmoothnessResult {
  const base: SmoothnessResult = {
    schemaVersion: 1,
    label: 'open filters',
    mode: 'quick',
    runs: 5,
    browserName: 'chromium',
    browserVersion: '153.0.8010.12',
    headlessMode: 'new-headless',
    machine: { cpuModel: 'AMD EPYC 7763 64-Core Processor', cpus: 4, platform: 'linux' },
    cpuThrottling: 4,
    refreshRate: 60,
    settings: {
      maxIncrease: 0.15,
      enforce: 'warn',
      gateTotalBlocking: false,
      baselineDir: null,
      modeSource: 'default',
    },
    input: {
      interactions: 1,
      p95ToPaintMs: 112,
      worstMs: 112,
      byTarget: [{ target: 'button#filters', event: 'click', ms: 112 }],
    },
    longFrames: {
      count: 1,
      totalBlockingMs: 58,
      worstMs: 108,
      topScripts: [
        {
          source: 'http://localhost:4173/js/app.js',
          fn: 'onFilterClick',
          invoker: 'BUTTON#filters.onclick',
          invokerType: 'event-listener',
          blockingMs: 58,
          durationMs: 108,
          during: ['click on button#filters'],
        },
      ],
    },
    spread: {
      'input.p95ToPaintMs': { min: 104, median: 112, max: 120 },
      'longFrames.count': { min: 1, median: 1, max: 1 },
    },
    frameClasses: { interaction: 1, load: 0, background: 0 },
    unavailable: [],
    notes: [],
  };
  return merge(base, overrides) as SmoothnessResult;
}

function merge(a: unknown, b: unknown): unknown {
  if (b === undefined) return a;
  if (b === null || typeof b !== 'object' || Array.isArray(b) || a === null || typeof a !== 'object')
    return b;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v);
  return out;
}
