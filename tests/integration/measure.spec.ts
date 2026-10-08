import { test, expect } from '../../packages/playwright-butter/src/index.js';
import { attach, notesApartFromThrottling } from '../detection/helpers.js';

test.use({ butterOptions: { runs: 3 } });

test('a 150ms click handler', async ({ page, butter }) => {
  await page.goto('/click.html?ms=150');
  const result = await butter.measure('heavy click', async () => {
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

test('a click on a nested span is reported against the button', async ({ page, butter }) => {
  await page.goto('/click.html?ms=80');
  const result = await butter.measure('nested', () => page.click('#nested .label'));
  await attach(result);
  expect(result.input!.byTarget.map((t) => t.target)).toEqual(['button#nested']);
});

test('a self-removing button is still named', async ({ page, butter }) => {
  await page.goto('/click.html?ms=80');
  const result = await butter.measure('vanish', () => page.click('#vanish'));
  await attach(result);
  expect(result.input!.byTarget.map((t) => t.target)).toEqual(['button#vanish']);
  expect(result.longFrames!.topScripts[0]!.invoker).toBe('BUTTON#vanish.onclick');
});

test('typing into a slow search box: one interaction per key', async ({ page, butter }) => {
  await page.goto('/search.html?ms=60');
  const result = await butter.measure('search typing', async () => {
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

test('scrolling without interactions', async ({ page, butter }) => {
  await page.goto('/scroll.html?wait=70');
  const result = await butter.measure('scroll', async () => {
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

test('load and background frames are excluded', async ({ page, butter }) => {
  // mixed.html blocks 120ms during load and 90ms in a timer 300ms after load. No notes: the page
  // goes quiet after each reload, before its run.
  await page.goto('/mixed.html');
  const result = await butter.measure('buy', () => page.click('#buy .label'));
  await attach(result);
  expect(result.frameClasses).toEqual({ interaction: 1, load: 0, background: 0 });
  expect(result.longFrames!.count).toBe(1);
  expect(result.longFrames!.topScripts.map((s) => s.fn)).toEqual(['onBuy']);
  expect(notesApartFromThrottling(result.notes)).toEqual([]);
});

test('a page that never goes quiet', async ({ page, butter }) => {
  test.setTimeout(90_000);
  await page.goto('/mixed.html?bgevery=250');
  // Unthrottled: on Windows, Chrome's CPU throttling spaces timers irregularly (gaps of up to
  // 500ms for a 100ms interval), so a throttled page can go quiet between background jobs.
  const result = await butter.measure('buy on a busy page', () => page.click('#buy .label'), {
    runs: 2,
    cpuThrottling: 1,
  });
  await attach(result);
  expect(result.notes.join(' ')).toMatch(/didn't go quiet within 5000ms before 3 run/);
  expect(result.longFrames!.topScripts.map((s) => s.fn)).not.toContain('repeatingBackgroundJob');
  expect(result.longFrames!.topScripts.map((s) => s.fn)).toContain('onBuy');
});

test('CPU throttling slows iteration-based work', async ({ page, butter }) => {
  await page.goto('/click.html?ms=0&iter=3000000');
  const at1 = await butter.measure('iter click 1x', () => page.click('#heavy'), { cpuThrottling: 1 });
  const at4 = await butter.measure('iter click 4x', () => page.click('#heavy'), { cpuThrottling: 4 });
  await attach({ at1, at4 });
  // Chrome occasionally doesn't apply throttling (seen once on a Windows runner); the result
  // must then say so rather than pass off unthrottled numbers.
  const noted = at4.notes.join(' ').includes("CPU throttling didn't take effect");
  if (!noted) expect(at4.input!.p95ToPaintMs!).toBeGreaterThan(2 * at1.input!.p95ToPaintMs!);
  expect(at1.notes.join(' ')).not.toContain('CPU throttling');
});

test("reset: 'reload', 'none' and a function", async ({ page, butter }) => {
  // Quick mode: full mode (the default on scheduled CI) adds a run for the replay.
  const mode = 'quick';
  await page.goto('/click.html?ms=20');
  let loads = 0;
  page.on('load', () => loads++);

  await butter.measure('reload', () => page.click('#heavy'), { runs: 2, mode });
  expect(loads, 'reload: runs, not runs + 1 (the warm-up uses the page as it is)').toBe(2);

  loads = 0;
  await butter.measure('none', () => page.click('#heavy'), { runs: 2, mode, reset: 'none' });
  expect(loads).toBe(0);

  let resets = 0;
  await butter.measure('custom', () => page.click('#heavy'), {
    runs: 2,
    mode,
    reset: async ({ page }) => {
      resets++;
      await page.goto('/click.html?ms=20');
    },
  });
  expect(resets).toBe(2);
});

test('an action that navigates is reported, not measured', async ({ page, butter }) => {
  await page.goto('/click.html?ms=20');
  const result = await butter.measure('navigates', () => page.goto('/search.html').then(() => undefined), {
    runs: 2,
  });
  await attach(result);
  expect(result.runs).toBe(0);
  expect(result.input).toBeNull();
  expect(result.longFrames).toBeNull();
  expect(result.notes.join(' ')).toMatch(/navigated to a new document/);
});

test("a hostile element doesn't break the collector", async ({ page, butter }) => {
  await page.goto('/click.html?ms=150&hostile=1');
  const result = await butter.measure('hostile', () => page.click('#heavy'), { runs: 2 });
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

test('a control whose only id is generated is named by its text', async ({ page, butter }) => {
  await page.goto('/click.html?ms=80');
  const result = await butter.measure('filter click', () => page.click('text=Filter'), { runs: 2 });
  expect(result.input!.byTarget[0]!.target).toBe('button:has-text("Filter")');
  expect(result.longFrames!.topScripts[0]!.invoker).toBe('BUTTON.onclick');
});

// Some suites open their own pages (browser.newPage()) instead of using the page fixture.
test('a page the test opened itself: measure() with page, and scroll() on its locator', async ({
  browser,
  butter,
}) => {
  const own = await browser.newPage();
  try {
    await own.goto('/click.html?ms=80');
    const clicked = await butter.measure('own page click', () => own.click('#heavy'), {
      page: own,
      runs: 2,
    });
    expect(clicked.input!.byTarget[0]!.target).toBe('button#heavy');
    expect(clicked.longFrames!.topScripts[0]!.fn).toBe('onHeavyClick');

    await own.goto('/list.html?cost=0');
    const scrolled = await butter.scroll(own.locator('#list'), { mode: 'quick', runs: 1 });
    expect(scrolled.scroll!.scrolledPx).toBeGreaterThan(0);
  } finally {
    await own.close();
  }
});
