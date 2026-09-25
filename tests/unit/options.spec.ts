import { test, expect } from '@playwright/test';
import { detectMode, resolveOptions } from '../../src/options.js';

test('defaults', () => {
  expect(resolveOptions([], {})).toEqual({
    mode: 'quick',
    modeSource: 'default',
    runs: 5,
    cpuThrottling: 4,
    maxIncrease: 0.15,
    refreshRate: 60,
    enforce: 'warn',
    baselineDir: undefined,
    list: { background: 'auto', placeholders: [] },
    reset: 'reload',
    gateTotalBlocking: false,
    replay: 'on-regression',
  });
});

test('later sources override earlier ones', () => {
  const o = resolveOptions([{ runs: 3, cpuThrottling: 2 }, { runs: 7 }], {});
  expect(o.runs).toBe(7);
  expect(o.cpuThrottling).toBe(2);
});

test('every option is accepted and kept', () => {
  const reset = async () => undefined;
  const o = resolveOptions(
    [
      {
        mode: 'full',
        runs: 2,
        cpuThrottling: 1,
        maxIncrease: 0.3,
        refreshRate: 120,
        enforce: 'fail',
        baselineDir: 'baselines',
        list: { background: '#fff', placeholders: ['.skeleton'] },
        reset,
        gateTotalBlocking: true,
        replay: 'on',
      },
    ],
    {},
  );
  expect(o).toMatchObject({
    mode: 'full',
    modeSource: 'option',
    runs: 2,
    cpuThrottling: 1,
    maxIncrease: 0.3,
    refreshRate: 120,
    enforce: 'fail',
    baselineDir: 'baselines',
    list: { background: '#fff', placeholders: ['.skeleton'] },
    gateTotalBlocking: true,
    replay: 'on',
  });
  expect(o.reset).toBe(reset);
});

test('invalid values are rejected with a clear message', () => {
  expect(() => resolveOptions([{ runs: 0 }], {})).toThrow(/runs must be a positive integer/);
  expect(() => resolveOptions([{ runs: 1.5 }], {})).toThrow(/runs/);
  expect(() => resolveOptions([{ cpuThrottling: 0.5 }], {})).toThrow(/cpuThrottling/);
  expect(() => resolveOptions([{ maxIncrease: -1 }], {})).toThrow(/maxIncrease/);
  expect(() => resolveOptions([{ refreshRate: 90 as 60 }], {})).toThrow(/refreshRate/);
  expect(() => resolveOptions([{ enforce: 'maybe' as 'warn' }], {})).toThrow(/enforce/);
  expect(() => resolveOptions([{ replay: 'sometimes' as 'on' }], {})).toThrow(/replay must be/);
});

test('mode: option beats SMOOTHNESS_MODE beats scheduled CI beats default', () => {
  const env = { SMOOTHNESS_MODE: 'quick', GITHUB_EVENT_NAME: 'schedule' };
  expect(detectMode('full', env)).toEqual({ mode: 'full', source: 'option' });
  expect(detectMode(undefined, env)).toEqual({ mode: 'quick', source: 'SMOOTHNESS_MODE' });
  expect(detectMode(undefined, { GITHUB_EVENT_NAME: 'schedule' }).mode).toBe('full');
  expect(detectMode(undefined, { GITHUB_EVENT_NAME: 'pull_request' })).toEqual({
    mode: 'quick',
    source: 'default',
  });
});

test('SMOOTHNESS_MODE is case-insensitive and rejects other values', () => {
  expect(detectMode(undefined, { SMOOTHNESS_MODE: ' FULL ' }).mode).toBe('full');
  expect(() => detectMode(undefined, { SMOOTHNESS_MODE: 'fast' })).toThrow(/'quick' or 'full'/);
});

for (const [variable, value] of [
  ['GITHUB_EVENT_NAME', 'schedule'],
  ['CI_PIPELINE_SOURCE', 'schedule'],
  ['BUILD_REASON', 'Schedule'],
  ['CIRCLE_PIPELINE_TRIGGER_SOURCE', 'scheduled_pipeline'],
] as const) {
  test(`scheduled CI detected from ${variable}=${value}`, () => {
    const { mode, source } = detectMode(undefined, { [variable]: value });
    expect(mode).toBe('full');
    expect(source).toContain(`${variable}=${value}`);
  });
}
