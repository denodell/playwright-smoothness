import { test, expect } from '@playwright/test';
import { calibrate, stepAbove, formatCalibration } from '../../src/calibrate/analyze.js';
import type { SmoothnessResult } from '../../src/types.js';
import { makeResult } from './result-factory.js';

const run = (p95: number, count: number, extra: Parameters<typeof makeResult>[0] = {}) =>
  new Map<string, SmoothnessResult>([
    [
      'checkout-1a2b/pay.json',
      makeResult({ label: 'pay', input: { p95ToPaintMs: p95 }, longFrames: { count }, ...extra }),
    ],
  ]);

test('stepAbove: the smallest 0.05 step strictly above the spread', () => {
  expect(stepAbove(0)).toBe(0.05);
  expect(stepAbove(0.03)).toBe(0.05);
  expect(stepAbove(0.05)).toBe(0.1);
  expect(stepAbove(0.12)).toBe(0.15);
  expect(stepAbove(0.31)).toBe(0.35);
});

test('steady checks: changes within the floor need no allowance', () => {
  const [c] = calibrate([run(112, 1), run(120, 1), run(104, 1)]);
  const p95 = c!.metrics.find((m) => m.metric === 'input.p95ToPaintMs')!;
  expect(p95).toMatchObject({
    min: 104,
    median: 112,
    max: 120,
    withinFloor: true,
    suggestedMaxIncrease: null,
  });
  expect(c!.suggestedMaxIncrease).toBe(0.05);
});

test('a noisy metric: suggestion just above its spread, and a warning above 0.15', () => {
  const [c] = calibrate([run(200, 1), run(260, 1), run(230, 1)]);
  const p95 = c!.metrics.find((m) => m.metric === 'input.p95ToPaintMs')!;
  expect(p95.spreadPercent).toBe(30);
  expect(p95.suggestedMaxIncrease).toBe(0.35);
  expect(p95.warning).toMatch(/varied 30% between runs on unchanged code, so it needs maxIncrease 0.35/);
  expect(c!.suggestedMaxIncrease).toBe(0.35);
});

test('from zero, beyond the floor: no maxIncrease helps, and it says so', () => {
  const [c] = calibrate([run(100, 0), run(100, 3)]);
  const lf = c!.metrics.find((m) => m.metric === 'longFrames.count')!;
  expect(lf).toMatchObject({ spreadPercent: null, withinFloor: false, suggestedMaxIncrease: null });
  expect(lf.warning).toMatch(/went from 0 to 3/);
});

test('ungated metrics are reported but do not drive the suggestion', () => {
  const [c] = calibrate([
    run(100, 1, { longFrames: { totalBlockingMs: 100 } }),
    run(100, 1, { longFrames: { totalBlockingMs: 300 } }),
  ]);
  const tbt = c!.metrics.find((m) => m.metric === 'longFrames.totalBlockingMs')!;
  expect(tbt).toMatchObject({ gated: false, suggestedMaxIncrease: 2.05 });
  expect(c!.suggestedMaxIncrease).toBe(0.05);
});

test('checks seen in fewer than two runs, or unmeasured, are skipped', () => {
  const empty = new Map([['x/a.json', makeResult({ runs: 0, input: null, longFrames: null })]]);
  expect(calibrate([run(100, 1), new Map(), empty])).toEqual([]);
});

test('the printed table', () => {
  const text = formatCalibration(calibrate([run(200, 1), run(260, 2), run(230, 1)]), 3);
  expect(text).toContain('"pay"  (checkout-1a2b/pay.json)');
  expect(text).toMatch(/input-to-paint \(p95\)\s+200ms\s+230ms\s+260ms\s+30%\s+0.35/);
  expect(text).toContain('Suggested maxIncrease for this check: 0.35');
});

test('the printed advice when everything is within the floors', () => {
  const text = formatCalibration(calibrate([run(112, 1), run(120, 1)]), 2);
  expect(text).toContain(
    "within the checks' floors, so noise alone can't fail this check. Keep the default maxIncrease (0.15)",
  );
  expect(text).not.toContain('Suggested maxIncrease for this check');
});
