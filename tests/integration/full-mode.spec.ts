// Full mode reproduces the trace column of the scroll-blocking table (docs/measurements.md)
// through the library (12ms blocking: no dropped frames; 25ms: some). Unthrottled, as the table
// was measured.
// With RECORD_FIXTURES=1, trimmed traces are saved for the parser's unit tests.
import { test, expect } from '../../src/index.js';
import { writeFileSync } from 'node:fs';
import {
  FRAME_CATEGORIES,
  ANIMATION_FRAME_CATEGORIES,
  PROFILE_CATEGORIES,
} from '../../src/trace/categories.js';
import { MARK_END, MARK_START } from '../../src/trace/parse.js';
import { attach, tenWheelScrolls } from '../detection/helpers.js';

test.use({ smoothnessOptions: { mode: 'full', cpuThrottling: 1, runs: 5 } });

for (const wait of [12, 25]) {
  test(`scroll handler blocking ${wait}ms`, async ({ page, smoothness }) => {
    test.setTimeout(120_000);
    await page.goto(`/scroll.html?wait=${wait}`);
    const result = await smoothness.measure(`scroll ${wait}ms`, () => tenWheelScrolls(page));
    await attach(result);
    expect(result.mode).toBe('full');
    expect(result.unavailable).toEqual([]);
    expect(result.frames).toBeTruthy();
    expect(result.frames!.onTime).toBeGreaterThan(0);
    if (wait === 12) expect(result.frames!.dropped, JSON.stringify(result.spread)).toBe(0);
    else expect(result.frames!.dropped, JSON.stringify(result.spread)).toBeGreaterThan(0);
    expect(result.spread['frames.dropped']).toBeDefined();
  });
}

test('refreshRate 120 adds a reported-only prediction', async ({ page, smoothness }) => {
  await page.goto('/scroll.html?wait=12');
  const result = await smoothness.measure('scroll 120', () => tenWheelScrolls(page), {
    refreshRate: 120,
    runs: 2,
  });
  await attach(result);
  expect(result.budget120).toMatchObject({ predicted: true });
  expect(result.budget120!.frames).toBeGreaterThan(0);
  // 12ms of work per scroll fits 60Hz but not 120Hz.
  expect(result.budget120!.framesOverBudget).toBeGreaterThanOrEqual(8);
});

test('quick mode has no frames or 120Hz prediction', async ({ page, smoothness }) => {
  await page.goto('/scroll.html?wait=12');
  const result = await smoothness.measure('quick 120', () => tenWheelScrolls(page), {
    mode: 'quick',
    refreshRate: 120,
    runs: 1,
  });
  expect('frames' in result).toBe(false);
  expect('budget120' in result).toBe(false);
  expect(result.notes).toContain('refreshRate 120 adds a prediction in full mode only; this was quick mode.');
});

test('full mode gates on-time frames against the baseline', async ({ page, smoothness }) => {
  await page.goto('/scroll.html?wait=12');
  const result = await smoothness.measure('gated', () => tenWheelScrolls(page), { runs: 2 });
  expect(result).toBeSmooth();
  expect(result.comparison!.status).toBe('baseline-created');
});

// Records trimmed real traces (only the events the parser reads) as unit-test fixtures.
test('record trace fixtures', async ({ page, browser }) => {
  test.skip(!process.env.RECORD_FIXTURES, 'set RECORD_FIXTURES=1 to re-record');
  for (const wait of [12, 25]) {
    await page.goto(`/scroll.html?wait=${wait}`);
    await page.waitForTimeout(500);
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 150);
    await page.waitForTimeout(300);
    await browser.startTracing(page, {
      categories: [...FRAME_CATEGORIES, ...ANIMATION_FRAME_CATEGORIES, ...PROFILE_CATEGORIES],
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.evaluate((n) => performance.mark(n), MARK_START);
    await tenWheelScrolls(page);
    await page.waitForTimeout(200);
    await page.evaluate((n) => performance.mark(n), MARK_END);
    const events = (
      JSON.parse((await browser.stopTracing()).toString()) as { traceEvents: { name: string }[] }
    ).traceEvents;
    const keep = events.filter((e) =>
      ['PipelineReporter', 'AnimationFrame', 'Profile', 'ProfileChunk', MARK_START, MARK_END].includes(
        e.name,
      ),
    );
    writeFileSync(
      `tests/fixtures/traces/scroll-${wait}ms.json`,
      JSON.stringify({ browserVersion: browser.version(), traceEvents: keep }),
    );
  }
});
