// butter.scroll() on the virtualized test list. Full mode, unthrottled and fast, like the
// scroll in docs/measurements.md (Fast scroll through a long list: 20,000px at 6,000px/s).
import { test, expect } from '../../packages/playwright-butter/src/index.js';
import type { Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { notesApartFromThrottling, save } from '../detection/helpers.js';
import { traceRun } from '../../packages/butter-core/src/trace/tracer.js';
import { FRAME_CATEGORIES, SCREENSHOT_CATEGORIES } from '../../packages/butter-core/src/trace/categories.js';
import { analyzeFrames } from '../../packages/butter-core/src/list/analyze.js';
import { locatorTarget, playwrightDriver } from '../../packages/playwright-butter/src/driver.js';
import { blankColors, listGeometry, referenceShot } from '../../packages/butter-core/src/list/probe.js';
import { compareMetrics, metricsOf } from '../../packages/butter-core/src/baseline/compare.js';

test.use({
  viewport: { width: 600, height: 600 },
  butterOptions: { mode: 'full', cpuThrottling: 1, runs: 3 },
});
test.setTimeout(120_000);

const FAST_SCROLL = { speed: 'fast', distance: 20_000 } as const;
const list = (page: Page) => page.locator('#list');

test('a cheap list stays drawn: close to 0% blank frames', async ({ page, butter }) => {
  await page.goto('/list.html?cost=0&overscan=2');
  const r = await butter.scroll(list(page), FAST_SCROLL);
  save('list-cheap', r);
  expect(r.unavailable).toEqual([]);
  expect(r.list!.frames).toBeGreaterThanOrEqual(100);
  expect(r.list!.blankFramePercent).toBeLessThanOrEqual(5);
  expect(r.list!.virtualized).toBe(true); // the test list removes rows that scroll out of view
  expect(r.scroll).toMatchObject({
    input: 'wheel',
    direction: 'vertical',
    speedPxPerSec: 6000,
    requestedPx: 20000,
  });
  expect(r.scroll!.scrolledPx).toBeGreaterThanOrEqual(19_000);
});

test('a costly list is mostly blank', async ({ page, butter }) => {
  await page.goto('/list.html?cost=15&overscan=0');
  const r = await butter.scroll(list(page), FAST_SCROLL);
  save('list-costly', r);
  expect(r.list!.blankFramePercent).toBeGreaterThan(50);
  expect(r.list!.leastDrawnPercent).toBeLessThan(20);
  // The headline: frame delivery looks fine while the list is blank.
  expect(r.frames!.onTimePercent!).toBeGreaterThan(90);
  // And the baseline gate catches it.
  expect(r.spread['list.blankFramePercent']).toBeDefined();
});

test('the blank-row gate catches a regression', async ({ page, butter }) => {
  await page.goto('/list.html?cost=0&overscan=2');
  const before = await butter.scroll(list(page), { ...FAST_SCROLL, label: 'catalogue' });
  expect(before).toBeSmooth();
  await page.goto('/list.html?cost=15&overscan=0');
  // Same label in a second test would be separate; compare by hand against the first result.
  const after = await butter.scroll(list(page), { ...FAST_SCROLL, label: 'catalogue costly' });
  const check = compareMetrics(after, metricsOf(before), 0.15).find(
    (c) => c.metric === 'list.blankFramePercent',
  )!;
  expect(check.status).toBe('worse');
});

test('placeholders: skeleton rows count as blank only when named', async ({ page, butter }) => {
  // Rows show a grey skeleton for 250ms before their content.
  await page.goto('/list.html?cost=0&overscan=0&skeleton=250');
  const without = await butter.scroll(list(page), { ...FAST_SCROLL, label: 'skeleton, not named' });
  const named = await butter.scroll(list(page), {
    ...FAST_SCROLL,
    label: 'skeleton, named',
    list: { background: 'auto', placeholders: ['#dddddd'] },
  });
  save('list-skeleton', { without: without.list, named: named.list });
  expect(named.list!.blankFramePercent).toBeGreaterThan(without.list!.blankFramePercent + 20);
});

test("background 'auto' reads the list's own color (a dark list)", async ({ page, butter }) => {
  await page.goto('/list.html?cost=15&overscan=0&bg=%23202020');
  const r = await butter.scroll(list(page), FAST_SCROLL);
  expect(r.list!.blankFramePercent).toBeGreaterThan(50);
  expect(notesApartFromThrottling(r.notes)).toEqual([]);
});

test('horizontal lists', async ({ page, butter }) => {
  await page.goto('/list.html?axis=x&cost=0&overscan=2');
  const cheap = await butter.scroll(list(page), {
    ...FAST_SCROLL,
    direction: 'horizontal',
    label: 'h cheap',
  });
  await page.goto('/list.html?axis=x&cost=15&overscan=0');
  const costly = await butter.scroll(list(page), {
    ...FAST_SCROLL,
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

test.describe('touch', () => {
  test.use({ hasTouch: true });
  test('touch input swipes, and distance end scrolls to the end', async ({ page, butter }) => {
    await page.goto('/list.html?rows=200&cost=0'); // about 16,000px: within the 'end' cap
    const r = await butter.scroll(list(page), { input: 'touch', speed: 'fast', runs: 2 });
    const max = await list(page).evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(r.scroll).toMatchObject({ input: 'touch', requestedPx: max, scrolledPx: max });
    expect(r.label).toBe("scroll locator('#list') touch 6000px/s");
  });
});

test("distance 'end' on a very long list", async ({ page, butter }) => {
  await page.goto('/list.html?cost=0');
  const r = await butter.scroll(list(page), { speed: 'fast', mode: 'quick', runs: 1 });
  const max = await list(page).evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(max).toBeGreaterThan(100_000);
  expect(r.scroll!.requestedPx).toBe(20_000);
  expect(r.scroll!.scrolledPx).toBeGreaterThanOrEqual(19_000);
  expect(r.notes.join(' ')).toContain(
    `distance: 'end' stopped at 20,000px; the end of the list was ${max.toLocaleString('en-US')}px away.`,
  );
});

test('touch input without a touch context', async ({ page, butter }) => {
  await page.goto('/list.html?rows=300&cost=0');
  await expect(butter.scroll(list(page), { input: 'touch' })).rejects.toThrow(
    /needs a touch-enabled browser context/,
  );
});

test("a locator that doesn't scroll", async ({ page, butter }) => {
  await page.goto('/list.html?cost=15&overscan=0');
  // The spacer inside the list isn't the scroller; scrolling "it" moves nothing.
  const r = await butter.scroll(page.locator('#spacer'), { ...FAST_SCROLL, distance: 2000, runs: 2 });
  expect(r.list).toBeNull();
  expect(r.unavailable).toContainEqual({
    measurement: 'list',
    reason: expect.stringMatching(/didn't move the list in any run/),
  });
});

test('arrow keys', async ({ page, butter }) => {
  // 25ms per new row, and a new row every couple of presses. Arrow keys scroll smoothly over
  // several frames, so a row is often built after the press's own paint, and how many presses
  // Event Timing counts as slow varies with frame timing (2 on some CI runs, 5 on others). The test
  // checks that key presses are measured at all, not how many.
  await page.goto('/list.html?cost=25&overscan=0');
  const r = await butter.scroll(list(page), { input: 'keys', distance: 400, mode: 'quick', runs: 2 });
  save('list-keys', r);
  expect(r.scroll).toMatchObject({ input: 'keys', speedPxPerSec: null, requestedPx: 400, keyPresses: 10 });
  expect(r.scroll!.scrolledPx).toBeGreaterThan(0);
  expect(r.input!.interactions).toBeGreaterThanOrEqual(1);
  expect(r.input!.interactions).toBeLessThanOrEqual(10);
  // A key press is one interaction (keydown, keypress, keyup), but Event Timing only reports the
  // entries that took 16ms or more, so the slowest press may be known only by its keyup.
  expect(['keydown', 'keyup']).toContain(r.input!.byTarget[0]!.event);
  expect(r.input!.p95ToPaintMs!).toBeGreaterThanOrEqual(16);
});

test('quick mode has no list data', async ({ page, butter }) => {
  await page.goto('/list.html?cost=0');
  const r = await butter.scroll(list(page), { ...FAST_SCROLL, mode: 'quick', runs: 1 });
  expect('list' in r).toBe(false);
  expect(r.notes.join(' ')).toMatch(/Blank rows in lists are measured in full mode only/);
});

test('200 frames are analyzed in under 2 seconds', async ({ page, browser }) => {
  await page.goto('/list.html?cost=15&overscan=0');
  await page.waitForTimeout(500);
  const target = list(page);
  const geometry = await listGeometry(locatorTarget(target));
  const { colors } = await blankColors(locatorTarget(target), {
    background: 'auto',
    placeholders: [],
    virtualized: 'auto' as const,
  });
  const driver = playwrightDriver(page);
  const referencePng = await referenceShot(driver, geometry);
  const cdp = await page.context().newCDPSession(page);
  const trace = await traceRun(
    driver.tracer()!,
    driver,
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
  // A slow runner can capture fewer than 200 frames in the fast scroll (187 on a Windows runner), so
  // captured frames are reused to make 200. Each one costs the same to analyze.
  expect(trace.screenshots.length).toBeGreaterThanOrEqual(100);
  const jpegs = Array.from({ length: 200 }, (_, i) => trace.screenshots[i % trace.screenshots.length]!);
  const t0 = performance.now();
  const a = await analyzeFrames(driver, {
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

// ---- replays ----

async function playable(page: Page, file: string) {
  const bytes = readFileSync(file).toString('base64');
  await page.goto('/raf.html'); // any page on localhost (a secure context)
  return page.evaluate(async (b64) => {
    const blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'video/webm' });
    const v = document.createElement('video');
    v.muted = true;
    v.src = URL.createObjectURL(blob);
    await new Promise((res, rej) => {
      v.onloadedmetadata = res;
      v.onerror = () => rej(new Error(v.error?.message));
    });
    v.currentTime = v.duration / 2;
    await new Promise((res) => (v.onseeked = res));
    return { duration: v.duration, width: v.videoWidth, height: v.videoHeight, seekedTo: v.currentTime };
  }, bytes);
}

/** The files a test left in test-results/smoothness/, found by the start of its title. */
async function outputOf(titleStart: string) {
  const root = join(test.info().project.outputDir, 'smoothness');
  const dir = existsSync(root) ? readdirSync(root).find((d) => d.startsWith(titleStart)) : undefined;
  return dir ? readdirSync(join(root, dir)).map((f) => join(root, dir, f)) : [];
}

// Replays are encoded and attached in fixture teardown, after the test body and its hooks, so
// each check reads the files the previous test left behind.
test.describe('replays', () => {
  test.describe.configure({ mode: 'serial' });

  test("'on': a replay even when nothing got worse", async ({ page, butter }) => {
    await page.goto('/list.html?cost=15&overscan=0');
    const r = await butter.scroll(list(page), { ...FAST_SCROLL, replay: 'on', runs: 2 });
    expect(r).toBeSmooth(); // the first run creates the baseline; 'on' attaches a replay anyway
  });

  test("the 'on' replay is a playable WebM", async ({ page }) => {
    const files = await outputOf('replays-on-a-replay-even');
    const webm = files.find((f) => f.endsWith('.replay.webm'))!;
    expect(webm).toBeTruthy();
    const json = JSON.parse(
      readFileSync(
        files.find((f) => f.endsWith('.json'))!,
        'utf8',
      ),
    );
    expect(webm.endsWith(json.replay)).toBe(true);
    expect(statSync(webm).size).toBeGreaterThan(50_000);
    const info = await playable(page, webm);
    expect(info.width).toBe(658); // the 600px viewport, with the 500px panel's 24px margins scaled to match
    expect(info.duration).toBeGreaterThan(12); // a 3.3s fast scroll at 1/4 speed, plus a 1s hold
    expect(info.seekedTo).toBeGreaterThan(info.duration / 4); // seeking works
  });

  test("'on-regression' (the default): no replay when nothing got worse", async ({ page, butter }) => {
    await page.goto('/list.html?cost=15&overscan=0');
    const r = await butter.scroll(list(page), { ...FAST_SCROLL, runs: 2 });
    expect(r).toBeSmooth(); // the first run records the baseline
    expect(r.comparison!.status).toBe('baseline-created');
  });

  test("'on-regression' left no replay", async () => {
    const files = await outputOf('replays-on-regression-the-default');
    expect(files.some((f) => f.endsWith('.json'))).toBe(true);
    expect(files.some((f) => f.endsWith('.replay.webm'))).toBe(false);
  });

  test("measure(): 'on' makes a replay of the interaction", async ({ page, butter }) => {
    await page.goto('/click.html?ms=80');
    const r = await butter.measure('heavy click', () => page.click('#heavy'), {
      mode: 'full',
      replay: 'on',
      runs: 2,
    });
    expect(r).toBeSmooth();
  });

  test('the measure() replay is a playable WebM', async ({ page }) => {
    const files = await outputOf('replays-measure-on-makes');
    const webm = files.find((f) => f.endsWith('.replay.webm'))!;
    expect(webm).toBeTruthy();
    const info = await playable(page, webm);
    expect(info.width).toBe(658); // the 600px viewport, with the 500px panel's 24px margins scaled to match
    expect(info.duration).toBeGreaterThan(1);
  });

  test('quick mode has no frames to replay', async ({ page, butter }) => {
    await page.goto('/list.html?cost=0');
    const r = await butter.scroll(list(page), { ...FAST_SCROLL, mode: 'quick', replay: 'on', runs: 1 });
    expect(r).toBeSmooth();
  });

  test('quick mode left no replay', async () => {
    const files = await outputOf('replays-quick-mode-has-no-frames');
    expect(files.some((f) => f.endsWith('.replay.webm'))).toBe(false);
  });
});

test('a page that scrolls itself starts each run from the same place too', async ({ page, butter }) => {
  // The page keeps its own position, starting from wherever it loaded. With Chrome's scroll
  // restoration, that was where the last run stopped, and it put the page back there.
  await page.goto('/scroll.html?smooth=1');
  const r = await butter.scroll(page.locator('html'), { mode: 'quick', runs: 3, distance: 3000 });
  expect(r.notes.join(' ')).not.toContain("didn't all start");
  expect(r.scroll!.scrolledPx).toBeGreaterThanOrEqual(2900);
});

test('a scrolling document starts each run from the same place', async ({ page, butter }) => {
  // Chrome restores a document's scroll position on reload. Without putting it back, every run
  // after the warm-up would start at the end of the page and scroll nothing.
  await page.goto('/scroll.html');
  const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  const r = await butter.scroll(page.locator('html'), { mode: 'quick', runs: 2 });
  const expected = Math.min(max, 20_000); // 'end' stops at 20,000px
  expect(r.scroll!.requestedPx).toBe(expected);
  expect(r.scroll!.scrolledPx).toBeGreaterThanOrEqual(expected - 1);
  expect(r.notes.join(' ')).not.toContain('already at its end');
});

test("a page that isn't virtualized: blank frames reported but not gated, with a note", async ({
  page,
  butter,
}) => {
  await page.goto('/scroll.html');
  const r = await butter.scroll(page.locator('html'), { distance: 3000, runs: 2 });
  expect(r.list!.virtualized).toBe(false);
  expect(r.notes.join(' ')).toContain("doesn't appear to be virtualized");
  expect(r).toBeSmooth(); // records the baseline
  expect(r.comparison!.checks.some((c) => c.metric === 'list.blankFramePercent')).toBe(false);
});

test('list.virtualized overrides the detection', async ({ page, butter }) => {
  await page.goto('/scroll.html');
  const r = await butter.scroll(page.locator('html'), {
    distance: 3000,
    runs: 1,
    list: { virtualized: true },
  });
  expect(r.list!.virtualized).toBe(true);
  expect(r.notes.join(' ')).not.toContain('virtualized');
});
