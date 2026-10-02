// Snapshot tests for the reporter's markdown. Update with --update-snapshots.
import { test, expect } from '@playwright/test';
import {
  buildMarkdown,
  changeCell,
  type ReportEntry,
} from '../../packages/smoothness-core/src/reporter/markdown.js';
import { compareMetrics, metricsOf } from '../../packages/smoothness-core/src/baseline/compare.js';
import type { Comparison, SmoothnessResult } from '../../packages/smoothness-core/src/types.js';
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

test('changeCell: value, then absolute and relative change', () => {
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
        label: 'fast scroll',
        mode: 'full',
        list: { frames: 204, blankFrames: 188, blankFramePercent: 92.2, leastDrawnPercent: 0 },
      }),
      comparison: { status: 'baseline-created', checks: [], baseline, notes: [] },
    }),
    entry(
      'catalogue',
      {
        ...makeResult({
          label: 'fast scroll',
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

test('summary: re-recorded baselines are counted as such, not as within baseline', () => {
  const md = buildMarkdown([
    entry(
      'list',
      compared(makeResult({ label: 'scroll', longFrames: { count: 4 } }), before, 'baseline-updated'),
    ),
    entry('search', compared(makeResult({ label: 'type', input: { p95ToPaintMs: 104 } }), before, 'pass')),
  ]);
  expect(md).toContain('1 within baseline, 1 baseline re-recorded');
  expect(md).toContain(
    '- list › "scroll": baseline re-recorded; compared with the one it replaced: long frames 4 (+3, +300%)',
  );
  expect(md).not.toContain('**Worse**');
});

test('summary: nothing ran', () => {
  expect(buildMarkdown([])).toBe(
    '## Smoothness\n\nNo smoothness measurements ran. Results come from `smoothness.measure()` and `smoothness.scroll()`, and in automatic mode from tests that load a page in Chromium, using a `test` wrapped with `withSmoothness()`.\n',
  );
});

test('summary: pipes in labels do not break the table', () => {
  const md = buildMarkdown([entry('a | b', compared(makeResult({ label: 'x | y' }), before, 'pass'))]);
  expect(md).toContain('a \\| b › "x \\| y"');
});

// ---- the reporter's options ----
import SmoothnessReporter from '../../packages/playwright-smoothness/src/reporter.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runReporter(
  options: ConstructorParameters<typeof SmoothnessReporter>[0],
  dir: string,
  env: Record<string, string> = {},
) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const reporter = new SmoothnessReporter(options);
    const config = { rootDir: dir, projects: [{ outputDir: join(dir, 'test-results') }] } as never;
    reporter.onBegin(config);
    const resultFile = join(dir, 'r.json');
    writeFileSync(resultFile, JSON.stringify(makeResult({ label: 'x' })));
    const testCase = {
      title: 'a test',
      titlePath: () => ['', 'chromium', 'a.spec.ts', 'a test'],
      location: { file: join(dir, 'a.spec.ts') },
      parent: { project: () => ({ name: 'chromium' }) },
    } as never;
    reporter.onTestEnd(testCase, {
      attachments: [{ name: 'smoothness: x', path: resultFile, contentType: 'application/json' }],
    } as never);
    reporter.onEnd();
  } finally {
    process.env = saved;
  }
}

test('reporter: default output file, title and job summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoothness-reporter-'));
  try {
    const step = join(dir, 'step.md');
    runReporter({}, dir, { GITHUB_STEP_SUMMARY: step });
    const md = readFileSync(join(dir, 'test-results', 'smoothness', 'summary.md'), 'utf8');
    expect(md.startsWith('## Smoothness\n')).toBe(true);
    expect(md).toContain('a test › "x"');
    expect(readFileSync(step, 'utf8')).toBe(md + '\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reporter: outputFile, title, and githubSummary: false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoothness-reporter-'));
  try {
    const step = join(dir, 'step.md');
    mkdirSync(join(dir, 'out'));
    runReporter(
      { outputFile: join(dir, 'out', 'perf.md'), title: 'Performance', githubSummary: false },
      dir,
      {
        GITHUB_STEP_SUMMARY: step,
      },
    );
    expect(readFileSync(join(dir, 'out', 'perf.md'), 'utf8').startsWith('## Performance\n')).toBe(true);
    expect(existsSync(step)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summary: automatic mode at suite scale', () => {
  const cwd = '/work/app';
  const building = (title: string): ReportEntry =>
    entry(title, {
      ...makeResult({ label: title }),
      comparison: {
        status: 'not-compared',
        checks: [],
        baseline: null,
        notes: [
          `Building history: 1 of 3 main-branch runs recorded. This run was added to the history (${cwd}/smoothness-history/app.spec.ts/x.json).`,
        ],
      },
    });
  const passing = entry('search › types a query', {
    ...compared(
      makeResult({ label: 'search › types a query', input: { p95ToPaintMs: 110 } }),
      before,
      'pass',
    ),
  });
  const missing = entry('menu › opens', {
    ...makeResult({ label: 'menu › opens' }),
    comparison: {
      status: 'not-compared',
      checks: [],
      baseline: null,
      notes: [`No baseline exists at ${cwd}/tests/x.json.`],
    },
  });
  const md = buildMarkdown([building('a › one'), building('b › two'), passing, missing], 'Smoothness', cwd);
  // The label is the test's own title, so it's named once.
  expect(md).toContain('| OK | search › types a query |');
  expect(md).not.toContain('"search › types a query"');
  // Passing checks are folded away, and history-building tests are one line.
  expect(md).toContain('<summary>2 checks within baseline</summary>');
  expect(md).toContain(
    "- 2 tests are building history in automatic mode: each needs 3 main-branch runs before it's compared.",
  );
  expect(md).not.toContain('a › one');
  // Paths in notes are relative to the project.
  expect(md).toContain('No baseline exists at tests/x.json.');
  expect(md).not.toContain(cwd);
});
