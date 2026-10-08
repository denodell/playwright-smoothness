import { test, expect } from '@playwright/test';
import { formatBrief, needsBrief, sourcePath } from '../../packages/butter-core/src/baseline/brief.js';
import { compareMetrics, metricsOf } from '../../packages/butter-core/src/baseline/compare.js';
import { checkBudget } from '../../packages/butter-core/src/baseline/budget.js';
import type { Comparison } from '../../packages/butter-core/src/types.js';
import { makeResult } from './result-factory.js';

const before = metricsOf(makeResult({ input: { p95ToPaintMs: 32 }, longFrames: { count: 0 } }));
const ctx = {
  rerun: 'npx playwright test tests/filters.spec.ts:6',
  resultFile: '/repo/test-results/smoothness/x/open-filters.json',
  cwd: '/repo',
};

function compared(overrides: Parameters<typeof makeResult>[0], extra: Partial<Comparison> = {}) {
  const result = makeResult(overrides);
  const comparison: Comparison = {
    status: 'warn',
    checks: compareMetrics(result, before, result.settings.maxIncrease),
    baseline: null,
    notes: [],
    ...extra,
  };
  return { result, comparison };
}

test('needsBrief: only when a check got worse or a budget was missed', () => {
  expect(needsBrief(compared({ input: { p95ToPaintMs: 34 }, longFrames: { count: 0 } }).comparison)).toBe(
    false,
  );
  expect(needsBrief(compared({}).comparison)).toBe(true);
  const r = makeResult({ input: { p95ToPaintMs: 34 }, longFrames: { count: 0 } });
  const withBudget: Comparison = {
    status: 'pass',
    checks: compareMetrics(r, before, 0.15),
    baseline: null,
    notes: [],
    budget: checkBudget(r, { maxInputToPaintMs: 20 }),
  };
  expect(needsBrief(withBudget)).toBe(true);
});

test('the brief names what got worse, where, and how to check a fix', () => {
  const { result, comparison } = compared({
    test: { title: 'filters › open smoothly', file: 'tests/filters.spec.ts', project: 'chromium' },
    longFrames: {
      topScripts: [
        {
          source: 'webpack://shop/src/Filters.tsx',
          fn: 'toggleFilters',
          invoker: 'BUTTON#filters.onclick',
          invokerType: 'event-listener',
          blockingMs: 58.6,
          durationMs: 80.6,
          during: ['click on button#filters'],
          line: 22,
        },
        {
          source: '',
          fn: '',
          invoker: 'PerformanceObserverCallback',
          invokerType: 'classic-script',
          blockingMs: 4,
          durationMs: 6,
          during: [],
        },
      ],
    },
  });
  const brief = formatBrief(result, comparison, ctx);
  expect(brief).toContain('# Fix brief: "open filters"');
  expect(brief).toContain('Test: filters › open smoothly (tests/filters.spec.ts)');
  expect(brief).toContain(
    '- input-to-paint (p95): 112ms (+80ms, +250%) against a baseline of 32ms, allowed +16ms',
  );
  expect(brief).toContain('- click on `button#filters`: 112ms to the next paint');
  expect(brief).toContain('- `toggleFilters` at shop/src/Filters.tsx:22, run by BUTTON#filters.onclick');
  expect(brief).not.toContain('PerformanceObserverCallback');
  expect(brief).toContain('   npx playwright test tests/filters.spec.ts:6 --update-snapshots=all');
  expect(brief).toContain('The baseline had input-to-paint (p95) 32ms.');
  expect(brief).toContain('`test-results/smoothness/x/open-filters.json`');
});

test('a missed budget is in the brief, with what the budget asks for', () => {
  const r = makeResult({ input: { p95ToPaintMs: 34 }, longFrames: { count: 0 } });
  const comparison: Comparison = {
    status: 'pass',
    checks: compareMetrics(r, before, 0.15),
    baseline: null,
    notes: [],
    budget: checkBudget(r, { maxInputToPaintMs: 20 }),
  };
  const brief = formatBrief(r, comparison, ctx);
  expect(brief).toContain('- input-to-paint (p95): 34ms, budget at most 20ms');
  expect(brief).toContain('The budget asks for input-to-paint (p95) at most 20ms.');
});

test('tiny browser-API entries from the test driver are left out', () => {
  const { result, comparison } = compared({
    mode: 'full',
    profile: {
      sampledMs: 100,
      hotFunctions: [
        {
          fn: 'onScroll',
          url: 'http://localhost:4173/app.js',
          line: 9,
          column: 3,
          selfMs: 40,
          totalMs: 60,
          callers: [],
        },
        {
          fn: 'getBoundingClientRect',
          url: '',
          line: 0,
          column: 0,
          selfMs: 14,
          totalMs: 14,
          callers: ['onScroll'],
        },
        {
          fn: 'elementsFromPoint',
          url: '',
          line: 0,
          column: 0,
          selfMs: 0.6,
          totalMs: 0.6,
          callers: ['expectHitTarget'],
        },
      ],
    },
  });
  const brief = formatBrief(result, comparison, ctx);
  expect(brief).toContain('- `onScroll` at /app.js:9: 40ms itself, 60ms with what it called');
  expect(brief).toContain('`getBoundingClientRect` (14ms, from onScroll)');
  expect(brief).not.toContain('elementsFromPoint');
});

test('sourcePath', () => {
  expect(sourcePath('http://localhost:4173/js/app.js?v=3')).toBe('/js/app.js');
  expect(sourcePath('webpack://shop/src/List.tsx')).toBe('shop/src/List.tsx');
  expect(sourcePath('src/List.tsx')).toBe('src/List.tsx');
  expect(sourcePath('')).toBe('unknown source');
});

test('nothing pointed at specific code', () => {
  const { result, comparison } = compared({
    input: { p95ToPaintMs: 200, byTarget: [] },
    longFrames: { count: 0, topScripts: [] },
  });
  expect(formatBrief(result, comparison, ctx)).toContain(
    'Nothing pointed at specific code. Running it in full mode adds a CPU profile.',
  );
});
