// Snapshot tests for toBeSmooth() messages (brief M2 and M5). Update with --update-snapshots.
import { test, expect } from '@playwright/test';
import { formatChange, formatMessage, formatSummary, shortSource } from '../../src/baseline/message.js';
import type { Comparison } from '../../src/types.js';
import { compareMetrics, metricsOf } from '../../src/baseline/compare.js';
import { makeResult } from './result-factory.js';

const baseline = {
  path: '/repo/tests/checkout.spec.ts-snapshots/smoothness/open-filters-quick-60hz-cpu4x-amd-epyc-7763-4cpu-chromium-linux.json',
  source: 'snapshot' as const,
  recordedAt: '2026-09-20T10:00:00.000Z',
  browserVersion: '153.0.8010.12',
  machine: { cpuModel: 'AMD EPYC 7763 64-Core Processor', cpus: 4, platform: 'linux' },
};
const before = metricsOf(makeResult({ input: { p95ToPaintMs: 104 }, longFrames: { count: 0 } }));

function compared(
  overrides: Parameters<typeof makeResult>[0],
  status: Comparison['status'],
  notes: string[] = [],
) {
  const result = makeResult(overrides);
  const comparison: Comparison = {
    status,
    checks: compareMetrics(result, before, result.settings.maxIncrease),
    baseline,
    notes,
  };
  return { result, comparison };
}

test('formatChange', () => {
  const c = (p: object) =>
    ({
      metric: 'x',
      name: 'x',
      status: 'pass',
      allowed: 1,
      current: 0,
      baseline: 0,
      change: null,
      changePercent: null,
      unit: 'ms',
      ...p,
    }) as never;
  expect(formatChange(c({ current: 129, change: 20, changePercent: 18.3 }))).toBe('129ms (+20ms, +18.3%)');
  expect(formatChange(c({ unit: 'count', current: 3, change: 3, changePercent: null }))).toBe('3 (+3)');
  expect(formatChange(c({ unit: '%', current: 90, change: -5 }))).toBe('90% (−5 points)');
  expect(formatChange(c({ current: 12, change: null }))).toBe('12ms');
});

test('shortSource', () => {
  expect(shortSource('http://localhost:4173/js/app.js?v=3')).toBe('app.js');
  expect(shortSource('')).toBe('unknown source');
});

test('message: worse, with enforce warn', () => {
  const { result, comparison } = compared({ input: { p95ToPaintMs: 176 }, longFrames: { count: 1 } }, 'warn');
  expect(formatMessage(result, comparison, '/repo')).toMatchSnapshot('worse-warn.txt');
  expect(formatSummary(result, comparison)).toMatchSnapshot('worse-warn-summary.txt');
});

test('message: worse and noisy, with enforce fail', () => {
  const { result, comparison } = compared(
    {
      input: { p95ToPaintMs: 176 },
      longFrames: { count: 3 },
      settings: { enforce: 'fail' },
      spread: { 'input.p95ToPaintMs': { min: 120, median: 176, max: 200 } },
    },
    'fail',
  );
  expect(formatMessage(result, comparison, '/repo')).toMatchSnapshot('worse-fail-noisy.txt');
});

test('message: framework dispatcher blamed, element named', () => {
  const { result, comparison } = compared(
    {
      input: { p95ToPaintMs: 176, byTarget: [{ target: 'button#checkout', event: 'click', ms: 176 }] },
      longFrames: {
        count: 1,
        topScripts: [
          {
            source: 'http://localhost:4173/assets/index-3f9a.js',
            fn: 'QS',
            invoker: 'DIV#root.onclick',
            invokerType: 'event-listener',
            blockingMs: 121.4,
            durationMs: 171.4,
            during: ['click on button#checkout'],
          },
        ],
      },
    },
    'warn',
  );
  expect(formatMessage(result, comparison, '/repo')).toMatchSnapshot('framework.txt');
});

test('message: unavailable measurement and notes', () => {
  const { result, comparison } = compared(
    {
      longFrames: null,
      unavailable: [
        { measurement: 'longFrames', reason: 'Long Animation Frames are not supported in this browser' },
      ],
      notes: ["The page didn't go quiet within 5000ms before 2 run(s)."],
    },
    'pass',
    ['The baseline was recorded with chromium 152.0.1; this run used 153.0.8010.12.'],
  );
  expect(formatMessage(result, comparison, '/repo')).toMatchSnapshot('unavailable.txt');
});

test('message: baseline created', () => {
  const result = makeResult();
  const comparison: Comparison = {
    status: 'baseline-created',
    checks: [],
    baseline,
    notes: [
      'No baseline existed, so this result was recorded as the baseline. Later runs compare against it.',
    ],
  };
  expect(formatMessage(result, comparison, '/repo')).toMatchSnapshot('baseline-created.txt');
});
