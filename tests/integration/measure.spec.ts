import { test, expect } from '../../src/index.js';
import { attach } from '../detection/helpers.js';

test.use({ smoothnessOptions: { runs: 3 } });

test('a 150ms click handler: one long interaction frame per run, attributed to the handler', async ({
  page,
  smoothness,
}) => {
  await page.goto('/click.html?ms=150');
  const result = await smoothness.measure('heavy click', async () => {
    await page.click('#heavy');
  });
  await attach(result);

  expect(result.schemaVersion).toBe(1);
  expect(result.runs).toBe(3);
  expect(result.cpuThrottling).toBe(4);
  expect(result.headlessMode).toBe('new-headless');
  expect(result.unavailable).toEqual([]);
  expect(result.longFrames!.count).toBe(1);
  expect(result.longFrames!.worstMs).toBeGreaterThanOrEqual(150);
  expect(result.longFrames!.topScripts[0]).toMatchObject({
    invoker: 'BUTTON#heavy.onclick',
    invokerType: 'event-listener',
    fn: 'onHeavyClick',
    source: expect.stringMatching(/\/click\.js$/),
  });
  expect(result.input!.interactions).toBe(1);
  expect(result.input!.p95ToPaintMs).toBeGreaterThanOrEqual(150);
  expect(result.input!.byTarget[0]).toMatchObject({ target: 'button#heavy', event: 'click' });
  expect(result.spread['longFrames.count']).toEqual({ min: 1, median: 1, max: 1 });
});

test('a click on a nested span is reported against the button', async ({ page, smoothness }) => {
  await page.goto('/click.html?ms=80');
  const result = await smoothness.measure('nested', () => page.click('#nested .label'));
  await attach(result);
  expect(result.input!.byTarget.map((t) => t.target)).toEqual(['button#nested']);
});

test('a self-removing button is still named', async ({ page, smoothness }) => {
  await page.goto('/click.html?ms=80');
  const result = await smoothness.measure('vanish', () => page.click('#vanish'));
  await attach(result);
  expect(result.input!.byTarget.map((t) => t.target)).toEqual(['button#vanish']);
  expect(result.longFrames!.topScripts[0]!.invoker).toBe('BUTTON#vanish.onclick');
});

test('typing into a slow search box: one interaction per key', async ({ page, smoothness }) => {
  await page.goto('/search.html?ms=60');
  const result = await smoothness.measure('search typing', async () => {
    await page.focus('#search');
    await page.locator('#search').pressSequentially('abc', { delay: 100 });
  });
  await attach(result);
  expect(result.input!.interactions).toBe(3);
  expect(result.input!.byTarget).toEqual([
    expect.objectContaining({ target: 'input#search', event: 'keydown' }),
  ]);
  expect(result.input!.p95ToPaintMs).toBeGreaterThanOrEqual(56);
  expect(result.longFrames!.count).toBe(3);
  expect(result.longFrames!.topScripts[0]!.fn).toBe('onSearchKeydown');
});

test('scrolling: long frames counted, and no interactions means null, never zero', async ({
  page,
  smoothness,
}) => {
  await page.goto('/scroll.html?wait=70');
  const result = await smoothness.measure('scroll', async () => {
    await page.mouse.move(400, 400);
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 200);
      await page.waitForTimeout(100);
    }
  });
  await attach(result);
  expect(result.longFrames!.count).toBeGreaterThanOrEqual(4);
  expect(result.longFrames!.topScripts[0]!.invoker).toBe('DOMWindow.onscroll');
  expect(result.input!.interactions).toBe(0);
  expect(result.input!.p95ToPaintMs).toBeNull();
  expect(result.input!.worstMs).toBeNull();
  expect(result.spread['input.p95ToPaintMs']).toBeUndefined();
});

test('load and background frames are excluded; reload settles before each run', async ({
  page,
  smoothness,
}) => {
  // mixed.html blocks 120ms during load and 90ms in a timer 300ms after load.
  await page.goto('/mixed.html');
  const result = await smoothness.measure('buy', () => page.click('#buy .label'));
  await attach(result);
  expect(result.frameClasses).toEqual({ interaction: 1, load: 0, background: 0 });
  expect(result.longFrames!.count).toBe(1);
  expect(result.longFrames!.topScripts.map((s) => s.fn)).toEqual(['onBuy']);
  expect(result.notes).toEqual([]);
});

test('a page that never goes quiet: the run continues, background frames are excluded, and a note says so', async ({
  page,
  smoothness,
}) => {
  test.setTimeout(90_000);
  await page.goto('/mixed.html?bgevery=250');
  // Unthrottled: on Windows, Chrome's CPU throttling spaces timers irregularly (gaps of up to
  // 500ms for a 100ms interval), so a throttled page can go quiet between background jobs.
  const result = await smoothness.measure('buy on a busy page', () => page.click('#buy .label'), {
    runs: 2,
    cpuThrottling: 1,
  });
  await attach(result);
  expect(result.notes.join(' ')).toMatch(/didn't go quiet within 5000ms before 3 run/);
  expect(result.longFrames!.topScripts.map((s) => s.fn)).not.toContain('repeatingBackgroundJob');
  expect(result.longFrames!.topScripts.map((s) => s.fn)).toContain('onBuy');
});

test('CPU throttling slows iteration-based work', async ({ page, smoothness }) => {
  await page.goto('/click.html?ms=0&iter=3000000');
  const at1 = await smoothness.measure('iter click 1x', () => page.click('#heavy'), { cpuThrottling: 1 });
  const at4 = await smoothness.measure('iter click 4x', () => page.click('#heavy'), { cpuThrottling: 4 });
  await attach({ at1, at4 });
  expect(at4.input!.p95ToPaintMs!).toBeGreaterThan(2 * at1.input!.p95ToPaintMs!);
});

test("reset: 'reload' reloads before each run after the warm-up; 'none' never reloads; a function is called", async ({
  page,
  smoothness,
}) => {
  await page.goto('/click.html?ms=20');
  let loads = 0;
  page.on('load', () => loads++);

  await smoothness.measure('reload', () => page.click('#heavy'), { runs: 2 });
  expect(loads, 'reload: runs, not runs + 1 (the warm-up uses the page as it is)').toBe(2);

  loads = 0;
  await smoothness.measure('none', () => page.click('#heavy'), { runs: 2, reset: 'none' });
  expect(loads).toBe(0);

  let resets = 0;
  await smoothness.measure('custom', () => page.click('#heavy'), {
    runs: 2,
    reset: async ({ page }) => {
      resets++;
      await page.goto('/click.html?ms=20');
    },
  });
  expect(resets).toBe(2);
});

test('an action that navigates is reported, not measured', async ({ page, smoothness }) => {
  await page.goto('/click.html?ms=20');
  const result = await smoothness.measure(
    'navigates',
    () => page.goto('/search.html').then(() => undefined),
    {
      runs: 2,
    },
  );
  await attach(result);
  expect(result.runs).toBe(0);
  expect(result.input).toBeNull();
  expect(result.longFrames).toBeNull();
  expect(result.notes.join(' ')).toMatch(/navigated to a new document/);
});

test('a hostile element does not break the collector; the error is reported', async ({
  page,
  smoothness,
}) => {
  await page.goto('/click.html?ms=150&hostile=1');
  const result = await smoothness.measure('hostile', () => page.click('#heavy'), { runs: 2 });
  await attach(result);
  // The entry survives even though describing its target threw.
  expect(result.input!.interactions).toBe(1);
  expect(result.longFrames!.count).toBe(1);
  expect(result.unavailable).toEqual([
    expect.objectContaining({
      measurement: 'collector',
      reason: expect.stringContaining('hostile id getter'),
    }),
  ]);
});
