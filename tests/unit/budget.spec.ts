import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBudget } from '../../packages/butter-core/src/baseline/budget.js';
import { evaluate } from '../../packages/butter-core/src/baseline/evaluate.js';
import {
  formatMessage,
  formatSummary,
  missedBudget,
} from '../../packages/butter-core/src/baseline/message.js';
import { buildMarkdown } from '../../packages/butter-core/src/reporter/markdown.js';
import type { BaselineTarget } from '../../packages/butter-core/src/baseline/store.js';
import { makeResult } from './result-factory.js';

const full = (overrides: Parameters<typeof makeResult>[0] = {}) =>
  makeResult({
    mode: 'full',
    frames: { total: 100, onTime: 90, dropped: 10, onTimePercent: 90 },
    ...overrides,
  });

const statuses = (checks: ReturnType<typeof checkBudget>) =>
  Object.fromEntries(checks.map((c) => [c.metric, c.status]));

test('max and min limits', () => {
  const result = full();
  expect(
    statuses(checkBudget(result, { maxInputToPaintMs: 112, maxLongFrames: 0, minOnTimePercent: 90 })),
  ).toEqual({ 'input.p95ToPaintMs': 'pass', 'longFrames.count': 'over', 'frames.onTimePercent': 'pass' });
  expect(statuses(checkBudget(result, { maxInputToPaintMs: 100, minOnTimePercent: 95 }))).toEqual({
    'input.p95ToPaintMs': 'over',
    'frames.onTimePercent': 'over',
  });
});

test('only the limits given are checked', () => {
  expect(checkBudget(full(), {})).toEqual([]);
  expect(checkBudget(full(), { maxLongFrames: 3 }).map((c) => c.metric)).toEqual(['longFrames.count']);
});

test('a full-mode budget in quick mode fails and says how to measure it', () => {
  const [check] = checkBudget(makeResult(), { minOnTimePercent: 95 });
  expect(check).toMatchObject({ status: 'unavailable', current: null });
  expect(check!.reason).toMatch(/mode: 'full'/);
});

test('an unmeasured metric fails with the reason the result gives', () => {
  const result = full({
    mode: 'full',
    list: null,
    unavailable: [{ measurement: 'list', reason: 'the list never moved' }],
  });
  const [check] = checkBudget(result, { maxBlankFramePercent: 2 });
  expect(check).toMatchObject({ status: 'unavailable', reason: 'the list never moved' });
});

test('no input-to-paint value means every interaction painted within 16ms', () => {
  const fast = makeResult({ input: { interactions: 0, p95ToPaintMs: null, worstMs: null, byTarget: [] } });
  expect(checkBudget(fast, { maxInputToPaintMs: 50 })[0]).toMatchObject({ status: 'pass', current: null });
  expect(checkBudget(fast, { maxInputToPaintMs: 10 })[0]!.status).toBe('unavailable');
});

test("a budget that can't mean anything throws", () => {
  expect(() => checkBudget(full(), { minOnTimePercent: 120 })).toThrow(/100 or less/);
  expect(() => checkBudget(full(), { maxLongFrames: -1 })).toThrow(/0 or more/);
  expect(() => checkBudget(full(), { maxFps: 60 } as never)).toThrow(/unknown budget "maxFps"/);
});

test.describe('with a baseline', () => {
  let dir: string;
  const target = (): BaselineTarget => ({ path: (name) => join(dir, name), root: dir, project: '' });
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smoothness-budget-'));
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('the budget is checked on the first run, and the baseline is still recorded', () => {
    const c = evaluate(full(), target(), { budget: { minOnTimePercent: 95 } });
    expect(c.status).toBe('baseline-created');
    expect(missedBudget(c).map((b) => b.metric)).toEqual(['frames.onTimePercent']);
  });

  test('status stays the baseline verdict; the budget is reported beside it', () => {
    evaluate(full(), target());
    const c = evaluate(full(), target(), { budget: { minOnTimePercent: 95 } });
    expect(c.status).toBe('pass');
    expect(missedBudget(c)).toHaveLength(1);
    const within = evaluate(full(), target(), { budget: { minOnTimePercent: 80 } });
    expect(missedBudget(within)).toHaveLength(0);
  });

  test('nothing measured (another browser) skips the budget', () => {
    const skipped = makeResult({ runs: 0, unavailable: [{ measurement: 'all', reason: 'Firefox' }] });
    expect(evaluate(skipped, target(), { budget: { maxLongFrames: 0 } }).budget).toBeUndefined();
  });
});

test('the message leads with the missed budget', () => {
  const result = full();
  const comparison = {
    status: 'pass' as const,
    checks: [],
    baseline: null,
    notes: [],
    budget: checkBudget(result, { minOnTimePercent: 95, maxLongFrames: 3 }),
  };
  const message = formatMessage(result, comparison, '/repo');
  expect(message.split('\n')[0]).toBe('"open filters" missed its budget:');
  expect(message).toContain('  frames on time 90% (budget: at least 95%)');
  expect(message).toMatch(/Budget:\n.*check.*now.*budget.*result/);
  expect(message).toContain('Scripts blocking the interaction:');
  expect(message).not.toContain("enforce: 'warn'");
  expect(formatSummary(result, comparison)).toContain('missed its budget: frames on time 90%');

  const markdown = buildMarkdown([
    { test: 'filters', file: 'a.spec.ts', project: '', result: { ...result, comparison } },
  ]);
  expect(markdown).toContain('**1 got worse**');
  expect(markdown).toContain(
    '| **Over budget** | filters › "open filters" | frames on time | 90% | budget: at least 95% | |',
  );
  expect(markdown).toContain('| OK | filters › "open filters" | long frames | 1 | budget: at most 3 | |');
});

test('a traced run with nothing to draw has no late frames', () => {
  const still = full({ frames: { total: 0, onTime: 0, dropped: 0, onTimePercent: null } });
  expect(checkBudget(still, { minOnTimePercent: 95 })[0]).toMatchObject({ status: 'pass', current: null });
});

test('a missed input budget names the slowest target; unrelated unavailable measurements are listed', () => {
  const result = makeResult({ unavailable: [{ measurement: 'frames', reason: 'quick mode' }] });
  const comparison = {
    status: 'pass' as const,
    checks: [],
    baseline: null,
    notes: [],
    budget: checkBudget(result, { maxInputToPaintMs: 50 }),
  };
  const message = formatMessage(result, comparison, '/repo');
  expect(message).toContain(', slowest: click on button#filters');
  expect(message).toContain('Unavailable:\n  frames: quick mode');
});
