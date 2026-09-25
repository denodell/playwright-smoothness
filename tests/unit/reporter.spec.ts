// Snapshot tests for the reporter's markdown (brief M5). Update with --update-snapshots.
import { test, expect } from '@playwright/test';
import { buildMarkdown, changeCell, type ReportEntry } from '../../src/reporter/markdown.js';
import { compareMetrics, metricsOf } from '../../src/baseline/compare.js';
import type { Comparison, SmoothnessResult } from '../../src/types.js';
import { makeResult } from './result-factory.js';

const baseline = {
  path: '/repo/tests/a.spec.ts-snapshots/smoothness/x.json',
  source: 'baselineDir' as const,
  recordedAt: '2026-09-20T10:00:00.000Z',
  browserVersion: '153.0.8010.12',
  machine: { cpuModel: 'AMD EPYC 7763 64-Core Processor', cpus: 4, platform: 'linux' },
};

function compared(
  r: SmoothnessResult,
  before: SmoothnessResult,
  status: Comparison['status'],
): SmoothnessResult {
  return {
    ...r,
    comparison: {
      status,
      checks: compareMetrics(r, metricsOf(before), r.settings.maxIncrease),
      baseline,
      notes: [],
    },
  };
}

const entry = (test: string, result: SmoothnessResult, project = 'chromium'): ReportEntry => ({
  test,
  file: 'tests/app.spec.ts',
  project,
  result,
});

const before = makeResult({ input: { p95ToPaintMs: 109 }, longFrames: { count: 1 } });

test('changeCell: the brief’s style', () => {
  const [c] = compareMetrics(makeResult({ input: { p95ToPaintMs: 129 } }), metricsOf(before), 0.15);
  expect(changeCell(c!)).toBe('129ms (+20ms, +18.3%)');
});

test('summary: a mix of results', () => {
  const entries = [
    entry(
      'filters › open',
      compared(makeResult({ label: 'open filters', input: { p95ToPaintMs: 176 } }), before, 'warn'),
    ),
    entry(
      'checkout',
      compared(
        makeResult({
          label: 'pay',
          input: { p95ToPaintMs: 112 },
          longFrames: { count: 3 },
          settings: { enforce: 'fail' },
        }),
        before,
        'fail',
      ),
    ),
    entry('search', compared(makeResult({ label: 'type', input: { p95ToPaintMs: 104 } }), before, 'pass')),
    entry('catalogue', {
      ...makeResult({
        label: 'fling',
        mode: 'full',
        list: { frames: 204, blankFrames: 188, blankFramePercent: 92.2, leastDrawnPercent: 0 },
      }),
      comparison: { status: 'baseline-created', checks: [], baseline, notes: [] },
    }),
    entry(
      'catalogue',
      {
        ...makeResult({
          label: 'fling',
          runs: 0,
          input: null,
          longFrames: null,
          browserName: 'firefox',
          browserVersion: '145.0',
        }),
        unavailable: [
          { measurement: 'input', reason: 'smoothness is measured in Chromium only; this is firefox' },
          { measurement: 'longFrames', reason: 'smoothness is measured in Chromium only; this is firefox' },
        ],
        comparison: {
          status: 'not-compared',
          checks: [],
          baseline: null,
          notes: ['Nothing was measured: Chromium only.'],
        },
      },
      'firefox',
    ),
    entry('menu', makeResult({ label: 'open menu' })), // toBeSmooth() never called
  ];
  expect(buildMarkdown(entries)).toMatchSnapshot('summary.md');
});

test('summary: nothing ran', () => {
  expect(buildMarkdown([])).toBe('## Smoothness\n\nNo smoothness measurements ran.\n');
});

test('summary: pipes in labels do not break the table', () => {
  const md = buildMarkdown([entry('a | b', compared(makeResult({ label: 'x | y' }), before, 'pass'))]);
  expect(md).toContain('a \\| b › "x \\| y"');
});
