// M4 acceptance: smoothness.scroll() on the virtualized test list. Full mode, unthrottled and
// fast, like the spike's fling (20,000px at 6,000px/s).
import { test, expect } from '../../src/index.js';
import type { Page } from '@playwright/test';
import { save } from '../detection/helpers.js';
import { traceRun } from '../../src/trace/tracer.js';
import { FRAME_CATEGORIES, SCREENSHOT_CATEGORIES } from '../../src/trace/categories.js';
import { analyzeFrames } from '../../src/list/analyze.js';
import { blankColors, listGeometry, referenceShot } from '../../src/list/probe.js';

test.use({
  viewport: { width: 600, height: 600 },
  smoothnessOptions: { mode: 'full', cpuThrottling: 1, runs: 3 },
});
test.setTimeout(120_000);

const FLING = { speed: 'fast', distance: 20_000 } as const;
const list = (page: Page) => page.locator('#list');

test('a cheap list stays drawn: close to 0% blank frames', async ({ page, smoothness }) => {
  await page.goto('/list.html?cost=0&overscan=2');
  const r = await smoothness.scroll(list(page), FLING);
  save('list-cheap', r);
  expect(r.unavailable).toEqual([]);
  expect(r.list!.frames).toBeGreaterThanOrEqual(100);
  expect(r.list!.blankFramePercent).toBeLessThanOrEqual(5);
  expect(r.scroll).toMatchObject({
    input: 'wheel',
    direction: 'vertical',
    speedPxPerSec: 6000,
    requestedPx: 20000,
  });
  expect(r.scroll!.scrolledPx).toBeGreaterThanOrEqual(19_000);
});

test('a costly list (15ms per row, no overscan) is mostly blank, though frames barely drop', async ({
  page,
  smoothness,
}) => {
  await page.goto('/list.html?cost=15&overscan=0');
  const r = await smoothness.scroll(list(page), FLING);
  save('list-costly', r);
  expect(r.list!.blankFramePercent).toBeGreaterThan(50);
  expect(r.list!.leastDrawnPercent).toBeLessThan(20);
  // The headline: frame delivery looks fine while the list is blank.
  expect(r.frames!.onTimePercent!).toBeGreaterThan(90);
  // And the baseline gate catches it.
  expect(r.spread['list.blankFramePercent']).toBeDefined();
});

test('the blank-row gate fails a list that went from cheap to costly', async ({ page, smoothness }) => {
  await page.goto('/list.html?cost=0&overscan=2');
  const before = await smoothness.scroll(list(page), { ...FLING, label: 'catalogue' });
  expect(before).toBeSmooth();
  await page.goto('/list.html?cost=15&overscan=0');
  // Same label in a second test would be separate; compare by hand against the first result.
  const after = await smoothness.scroll(list(page), { ...FLING, label: 'catalogue costly' });
  const { compareMetrics, metricsOf } = await import('../../src/baseline/compare.js');
  const check = compareMetrics(after, metricsOf(before), 0.15).find(
    (c) => c.metric === 'list.blankFramePercent',
  )!;
  expect(check.status).toBe('worse');
});

test('placeholders: skeleton rows count as blank only when named', async ({ page, smoothness }) => {
  // Rows show a grey skeleton for 250ms before their content.
  await page.goto('/list.html?cost=0&overscan=0&skeleton=250');
  const without = await smoothness.scroll(list(page), { ...FLING, label: 'skeleton, not named' });
  const named = await smoothness.scroll(list(page), {
    ...FLING,
    label: 'skeleton, named',
    list: { background: 'auto', placeholders: ['#dddddd'] },
  });
  save('list-skeleton', { without: without.list, named: named.list });
  expect(named.list!.blankFramePercent).toBeGreaterThan(without.list!.blankFramePercent + 20);
});

test("background 'auto' reads the list's own colour (a dark list)", async ({ page, smoothness }) => {
  await page.goto('/list.html?cost=15&overscan=0&bg=%23202020');
  const r = await smoothness.scroll(list(page), FLING);
  expect(r.list!.blankFramePercent).toBeGreaterThan(50);
  expect(r.notes).toEqual([]);
});

test('horizontal lists', async ({ page, smoothness }) => {
  await page.goto('/list.html?axis=x&cost=0&overscan=2');
  const cheap = await smoothness.scroll(list(page), { ...FLING, direction: 'horizontal', label: 'h cheap' });
  await page.goto('/list.html?axis=x&cost=15&overscan=0');
  const costly = await smoothness.scroll(list(page), {
    ...FLING,
    direction: 'horizontal',
    label: 'h costly',
  });
  save('list-horizontal', {
    cheap: cheap.list,
    costly: costly.list,
    scrolled: [cheap.scroll, costly.scroll],
  });
  expect(cheap.scroll!.scrolledPx).toBeGreaterThanOrEqual(19_000);
  expect(cheap.list!.blankFramePercent).toBeLessThanOrEqual(5);
  expect(costly.list!.blankFramePercent).toBeGreaterThan(50);
});

test('touch input flings, and distance end scrolls to the end', async ({ page, smoothness }) => {
  await page.goto('/list.html?rows=300&cost=0');
  const r = await smoothness.scroll(list(page), { input: 'touch', speed: 'fast', runs: 2 });
  const max = await list(page).evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(r.scroll).toMatchObject({ input: 'touch', requestedPx: max, scrolledPx: max });
  expect(r.label).toBe("scroll locator('#list') touch 6000px/s");
});

test('arrow keys: presses are measured by Event Timing (those of 16ms or more)', async ({
  page,
  smoothness,
}) => {
  // 15ms per new row, and a new row every couple of presses: some presses cross 16ms.
  await page.goto('/list.html?cost=15&overscan=0');
  const r = await smoothness.scroll(list(page), { input: 'keys', distance: 400, mode: 'quick', runs: 2 });
  save('list-keys', r);
  expect(r.scroll).toMatchObject({ input: 'keys', speedPxPerSec: null, requestedPx: 400, keyPresses: 10 });
  expect(r.scroll!.scrolledPx).toBeGreaterThan(0);
  expect(r.input!.interactions).toBeGreaterThanOrEqual(3);
  expect(r.input!.interactions).toBeLessThanOrEqual(10);
  expect(r.input!.byTarget[0]!.event).toBe('keydown');
  expect(r.input!.p95ToPaintMs!).toBeGreaterThanOrEqual(16);
});

test('quick mode: no list data, and a note says blank rows need full mode', async ({ page, smoothness }) => {
  await page.goto('/list.html?cost=0');
  const r = await smoothness.scroll(list(page), { ...FLING, mode: 'quick', runs: 1 });
  expect('list' in r).toBe(false);
  expect(r.notes.join(' ')).toMatch(/Blank rows in lists are measured in full mode only/);
});

test('200 frames are analysed in under 2 seconds', async ({ page, browser }) => {
  await page.goto('/list.html?cost=15&overscan=0');
  await page.waitForTimeout(500);
  const target = list(page);
  const geometry = await listGeometry(target);
  const { colors } = await blankColors(target, { background: 'auto', placeholders: [] });
  const referencePng = await referenceShot(page, geometry);
  const cdp = await page.context().newCDPSession(page);
  const trace = await traceRun(
    browser,
    page,
    [...FRAME_CATEGORIES, ...SCREENSHOT_CATEGORIES],
    async () => {
      await cdp.send('Input.synthesizeScrollGesture', {
        x: 300,
        y: 300,
        yDistance: -20000,
        speed: 6000,
        gestureSourceType: 'mouse',
      });
    },
    { browserVersion: browser.version(), budget120: false, profile: false, screenshots: true },
  );
  expect(trace.screenshots.length).toBeGreaterThanOrEqual(200);
  const jpegs = trace.screenshots.slice(0, 200);
  const t0 = performance.now();
  const a = await analyzeFrames(browser, {
    jpegs,
    referencePng,
    geometry,
    direction: 'vertical',
    blank: colors,
  });
  const ms = performance.now() - t0;
  save('list-analysis-time', {
    frames: jpegs.length,
    ms: Math.round(ms),
    bytes: jpegs.reduce((n, j) => n + j.length, 0),
  });
  expect(a.frames).toHaveLength(200);
  expect(a.failed).toBe(0);
  expect(ms).toBeLessThan(2000);
});
