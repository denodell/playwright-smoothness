// End to end through the built package (npm run build first):
// the reporter loaded by package name, and calibrate's stability over two invocations.
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { PLAYWRIGHT_CLI } from './helpers.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckCalibration } from '../../packages/butter-core/src/calibrate/analyze.js';

const CONFIG = 'tests/e2e/fixture-project/playwright.config.ts';
const built =
  existsSync('packages/playwright-butter/dist/cli.js') &&
  existsSync('packages/playwright-butter/dist/reporter.js');
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TEST_|PW_)/.test(k)));

let work: string;
test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'smoothness-reporter-'));
});
test.afterAll(() => rmSync(work, { recursive: true, force: true }));
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

test('the reporter writes the markdown summary and the job summary', () => {
  // By path here; examples/plain-site loads it by package name (scripts/verify-ci-recipe.sh).
  test.skip(!built, 'run npm run build first');
  const step = join(work, 'step-summary.md');
  const child = spawnSync(
    process.execPath,
    [
      PLAYWRIGHT_CLI,
      'test',
      '-c',
      CONFIG,
      `--reporter=list,${join(process.cwd(), 'packages/playwright-butter/dist', 'reporter.js')}`,
    ],
    {
      env: {
        ...clean(),
        CLICK_MS: '60',
        SMOOTHNESS_E2E_OUT: join(work, 'out'),
        SMOOTHNESS_E2E_SNAPSHOTS: join(work, 'snapshots'),
        GITHUB_STEP_SUMMARY: step,
        GITHUB_ACTIONS: '',
      },
      encoding: 'utf8',
    },
  );
  expect(child.status, child.stdout + child.stderr).toBe(0);
  const md = readFileSync(join(work, 'out', 'smoothness', 'summary.md'), 'utf8');
  expect(md).toContain('## Smoothness');
  expect(md).toContain('1 new baseline');
  expect(md).toContain('checkout click › "checkout": new baseline recorded');
  expect(readFileSync(step, 'utf8')).toBe(md + '\n');
  expect(child.stdout).toContain('Smoothness summary:');
});

test('the summary command writes the same summary from the result files alone', () => {
  test.skip(!built, 'run npm run build first');
  const out = join(work, 'from-files.md');
  const step = join(work, 'step-summary-cli.md');
  const child = spawnSync(
    process.execPath,
    [
      'packages/playwright-butter/dist/cli.js',
      'summary',
      '--results',
      join(work, 'out'),
      '--out',
      out,
      '--github-summary',
    ],
    { env: { ...clean(), GITHUB_STEP_SUMMARY: step }, encoding: 'utf8' },
  );
  expect(child.status, child.stdout + child.stderr).toBe(0);
  const fromReporter = readFileSync(join(work, 'out', 'smoothness', 'summary.md'), 'utf8');
  expect(readFileSync(out, 'utf8')).toBe(fromReporter);
  expect(readFileSync(step, 'utf8')).toBe(fromReporter + '\n');
  expect(child.stdout).toContain('Smoothness summary of 1 result(s)');
});

test('a check that got worse writes a fix brief, and the brief command collects it', () => {
  test.skip(!built, 'run npm run build first');
  const out = join(work, 'out-slow');
  const run = spawnSync(process.execPath, [PLAYWRIGHT_CLI, 'test', '-c', CONFIG, '--reporter=line'], {
    env: {
      ...clean(),
      CLICK_MS: '300',
      SMOOTHNESS_E2E_OUT: out,
      SMOOTHNESS_E2E_SNAPSHOTS: join(work, 'snapshots'),
      GITHUB_ACTIONS: '',
    },
    encoding: 'utf8',
  });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const child = spawnSync(
    process.execPath,
    ['packages/playwright-butter/dist/cli.js', 'brief', '--results', out],
    { env: clean(), encoding: 'utf8' },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain('# Fix brief: "checkout"');
  expect(child.stdout).toContain('input-to-paint (p95)');
  expect(child.stdout).toMatch(/npx playwright test \S+:\d+/);
});

test('calibrate is repeatable', () => {
  test.skip(!built, 'run npm run build first');
  const once = (n: number) => {
    const out = join(work, `calibration-${n}.json`);
    const child = spawnSync(
      process.execPath,
      [
        'packages/playwright-butter/dist/cli.js',
        'calibrate',
        '--runs',
        '3',
        '--out',
        out,
        '--',
        '-c',
        CONFIG,
      ],
      {
        env: { ...clean(), CLICK_MS: '60', SMOOTHNESS_E2E_SNAPSHOTS: join(work, 'snapshots-cal') },
        encoding: 'utf8',
      },
    );
    test.info().attach(`calibrate ${n}`, { body: child.stdout + child.stderr, contentType: 'text/plain' });
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(child.stdout).toMatch(/Suggested maxIncrease for this check|Keep the default maxIncrease/);
    return JSON.parse(readFileSync(out, 'utf8')) as { invocations: number; checks: CheckCalibration[] };
  };
  const a = once(1);
  const b = once(2);
  expect(a.invocations).toBe(3);
  expect(a.checks.map((c) => c.label)).toEqual(['checkout']);
  expect(b.checks.map((c) => c.label)).toEqual(['checkout']);
  for (const [i, c] of a.checks.entries()) {
    expect(Math.abs(c.suggestedMaxIncrease - b.checks[i]!.suggestedMaxIncrease)).toBeLessThanOrEqual(
      0.05 + 1e-9,
    );
  }
  // Calibrating must not have written baselines.
  expect(existsSync(join(work, 'snapshots-cal'))).toBe(false);
});
