import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendHistory,
  historyPath,
  medianMetrics,
  outsideRecentRange,
  readHistory,
  specHash,
} from '../../packages/butter-core/src/auto/history.js';
import {
  analyzeDocs,
  defaultHistoryDir,
  type DocData,
} from '../../packages/playwright-butter/src/withButter.js';
import { onMainBranch } from '../../packages/butter-core/src/ci.js';
import { makeResult } from './result-factory.js';

test('medianMetrics skips unmeasured runs', () => {
  const e = (p95: number | null, count: number) => ({
    recordedAt: '',
    browserVersion: '',
    metrics: { 'input.p95ToPaintMs': p95, 'longFrames.count': count },
  });
  expect(medianMetrics([e(100, 1), e(null, 3), e(120, 2)])).toEqual({
    'input.p95ToPaintMs': 110,
    'longFrames.count': 2,
  });
  expect(medianMetrics([e(null, 0)])).toEqual({ 'input.p95ToPaintMs': null, 'longFrames.count': 0 });
});

test("outsideRecentRange: worse than the median only counts outside the test's own recent runs", () => {
  const e = (p95: number, count: number) => ({
    recordedAt: '',
    browserVersion: '',
    metrics: { 'input.p95ToPaintMs': p95, 'longFrames.count': count },
  });
  // The median is 56ms and 1 long frame; the recent runs reached 80ms and 3.
  const recent = [e(56, 1), e(48, 1), e(80, 3), e(56, 1), e(64, 2)];
  const check = (metric: string, current: number, baseline: number) =>
    ({
      metric,
      name: metric,
      unit: metric === 'longFrames.count' ? 'count' : 'ms',
      current,
      baseline,
      change: current - baseline,
      changePercent: null,
      allowed: 16,
      status: 'worse',
    }) as const;
  const [inRange, justOutside, clearlyOutside] = outsideRecentRange(
    [
      check('input.p95ToPaintMs', 96, 56),
      check('input.p95ToPaintMs', 97, 56),
      check('longFrames.count', 13, 1),
    ],
    recent,
  );
  expect(inRange!.status).toBe('pass'); // 96 is within the floor (16ms) of the worst recent run
  expect(inRange!.reason).toBe("within this test's recent runs on main (worst: 80ms)");
  expect(justOutside!.status).toBe('worse');
  expect(clearlyOutside!.status).toBe('worse');
  const pass = { ...check('input.p95ToPaintMs', 50, 56), status: 'pass' as const };
  expect(outsideRecentRange([pass], recent)[0]).toBe(pass);
});

test("the default history folder: the project's nearest node_modules, else next to the config", () => {
  const root = mkdtempSync(join(tmpdir(), 'smoothness-project-'));
  const at = (...p: string[]) => join(root, ...p);
  const make = (...p: string[]) => mkdirSync(at(...p), { recursive: true });
  try {
    make('app', 'node_modules');
    writeFileSync(at('app', 'package-lock.json'), '{}');
    expect(defaultHistoryDir(at('app'))).toEqual({
      dir: at('app', 'node_modules', '.cache', 'playwright-smoothness', 'history'),
      watched: false,
    });
    make('mono', 'node_modules');
    make('mono', 'packages', 'web');
    writeFileSync(at('mono', 'package-lock.json'), '{}');
    expect(defaultHistoryDir(at('mono', 'packages', 'web')).dir).toBe(
      at('mono', 'node_modules', '.cache', 'playwright-smoothness', 'history'),
    );
    make('node_modules');
    make('pnp');
    writeFileSync(at('pnp', 'yarn.lock'), '');
    expect(defaultHistoryDir(at('pnp'))).toEqual({ dir: at('pnp', 'smoothness-history'), watched: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('history files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoothness-history-'));
  try {
    const result = makeResult();
    const path = historyPath(dir, 'tests/app.spec.ts', 'buy › then search', 'chromium', result);
    expect(path).toBe(
      join(dir, 'tests/app.spec.ts', 'buy-then-search-chromium-amd-epyc-7763-4cpu-cpu4x.json'),
    );
    const base = {
      test: 'buy › then search',
      project: 'chromium',
      machine: 'AMD EPYC 7763',
      cpuThrottling: 4,
      specHash: 'abc',
    };
    let file = appendHistory(path, base, [], result, 2);
    file = appendHistory(path, base, file.entries, result, 2);
    file = appendHistory(path, base, file.entries, makeResult({ input: { p95ToPaintMs: 999 } }), 2);
    expect(file.entries).toHaveLength(2);
    expect(file.entries[1]!.metrics['input.p95ToPaintMs']).toBe(999);
    expect(readHistory(path)).toEqual(file);
    writeFileSync(path, '{"kind":"other"}');
    expect(readHistory(path)).toMatch(/isn't a playwright-smoothness history file/);
    writeFileSync(path, 'not json');
    expect(readHistory(path)).toMatch(/couldn't be read: SyntaxError/);
    expect(readHistory(join(dir, 'missing.json'))).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('specHash changes when the file changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoothness-spec-'));
  try {
    const f = join(dir, 'a.spec.ts');
    writeFileSync(f, 'test(1)');
    const a = specHash(f);
    writeFileSync(f, 'test(1) // edit');
    expect(specHash(f)).not.toBe(a);
    expect(readFileSync(f, 'utf8')).toContain('edit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('onMainBranch for each CI provider', () => {
  expect(onMainBranch({})).toBe(false);
  expect(onMainBranch({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'main' })).toBe(
    true,
  );
  expect(
    onMainBranch({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'schedule', GITHUB_REF_NAME: 'main' }),
  ).toBe(true);
  expect(
    onMainBranch({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF_NAME: '42/merge' }),
  ).toBe(false);
  expect(
    onMainBranch({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'feature' }),
  ).toBe(false);
  expect(onMainBranch({ GITLAB_CI: 'true', CI_COMMIT_BRANCH: 'trunk', CI_DEFAULT_BRANCH: 'trunk' })).toBe(
    true,
  );
  expect(
    onMainBranch({
      GITLAB_CI: 'true',
      CI_COMMIT_BRANCH: 'trunk',
      CI_DEFAULT_BRANCH: 'trunk',
      CI_MERGE_REQUEST_IID: '7',
    }),
  ).toBe(false);
  expect(
    onMainBranch({ TF_BUILD: 'True', BUILD_REASON: 'IndividualCI', BUILD_SOURCEBRANCHNAME: 'main' }),
  ).toBe(true);
  expect(
    onMainBranch({ TF_BUILD: 'True', BUILD_REASON: 'PullRequest', BUILD_SOURCEBRANCHNAME: 'main' }),
  ).toBe(false);
  expect(onMainBranch({ CIRCLECI: 'true', CIRCLE_BRANCH: 'master' })).toBe(true);
  expect(
    onMainBranch({ CIRCLECI: 'true', CIRCLE_BRANCH: 'master', CIRCLE_PULL_REQUEST: 'https://x/pull/1' }),
  ).toBe(false);
});

const doc = (p: Partial<DocData>): DocData => ({
  url: 'http://x/a',
  timeOrigin: 1_000_000,
  page: 0,
  loaf: [],
  events: [],
  scrolls: [],
  loadEventEnd: 50,
  errors: [],
  ...p,
});
const click = (start: number, duration: number) => ({
  name: 'click',
  interactionId: 1,
  start,
  processingStart: start,
  processingEnd: start + duration - 8,
  duration,
  target: 'button#go',
  rawTarget: 'button#go',
});

test('analyzeDocs: navigating away before paint', () => {
  // Input at 900ms on the first document; the next document on the same page started 60ms later.
  const docs = new Map([
    [1_000_000, doc({ lastInput: { at: 900, type: 'pointerdown' } })],
    [1_000_960, doc({ url: 'http://x/b', timeOrigin: 1_000_960 })],
  ]);
  expect(analyzeDocs(docs).unmeasured).toEqual(['pointerdown on http://x/a']);
});

test('analyzeDocs: an overlapping earlier click', () => {
  // A slow click at 780ms is measured until 910ms; the navigating click at 900ms never paints.
  const docs = new Map([
    [1_000_000, doc({ lastInput: { at: 900, type: 'pointerdown' }, events: [click(780, 130)] })],
    [1_000_960, doc({ url: 'http://x/b', timeOrigin: 1_000_960 })],
  ]);
  expect(analyzeDocs(docs).unmeasured).toEqual(['pointerdown on http://x/a']);
});

test("analyzeDocs: inputs that aren't reported", () => {
  const measured = new Map([
    [1_000_000, doc({ lastInput: { at: 900, type: 'pointerdown' }, events: [click(899, 40)] })],
    [1_000_960, doc({ timeOrigin: 1_000_960 })],
  ]);
  expect(analyzeDocs(measured).unmeasured).toEqual([]);
  const later = new Map([
    [1_000_000, doc({ lastInput: { at: 900, type: 'keydown' } })],
    [1_002_000, doc({ timeOrigin: 1_002_000 })], // 1.1s later: plenty of time to paint
  ]);
  expect(analyzeDocs(later).unmeasured).toEqual([]);
  const otherTab = new Map([
    [1_000_000, doc({ lastInput: { at: 900, type: 'keydown' } })],
    [1_000_960, doc({ timeOrigin: 1_000_960, page: 1 })],
  ]);
  expect(analyzeDocs(otherTab).unmeasured).toEqual([]);
});

test('withSmoothness() still works under its old name', async () => {
  const lib = await import('../../packages/playwright-butter/src/index.js');
  expect(lib.withSmoothness).toBe(lib.withButter);
});
