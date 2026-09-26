import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendHistory, historyPath, medianMetrics, readHistory, specHash } from '../../src/auto/history.js';
import { analyzeDocs, type DocData } from '../../src/auto/withSmoothness.js';
import { onMainBranch } from '../../src/ci.js';
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
