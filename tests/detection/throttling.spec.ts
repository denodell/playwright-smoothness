// Section 3, "CPU throttling and noise".
import { test, expect } from '@playwright/test';
import {
  installObservers,
  collected,
  clearCollected,
  save,
  throttle,
  median,
  PAGE_SETTLE_MS,
  ENTRY_DELIVERY_MS,
} from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installObservers);
});

/** Iterations per scroll event. The spike's value: long frames at 4x, usually none at 1x on a fast machine. */
const SCROLL_WORK = 1_500_000;

async function scrollRun(page: import('@playwright/test').Page, rate: number) {
  await page.goto(`/scroll.html?work=${SCROLL_WORK}`);
  const cdp = await throttle(page, rate);
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await clearCollected(page);
  await page.mouse.move(400, 400);
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(800);
  const { loaf } = await collected(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp.detach();
  return {
    count: loaf.length,
    totalBlockingMs: Math.round(loaf.reduce((a, f) => a + f.blocking, 0)),
    worstMs: Math.round(Math.max(0, ...loaf.map((f) => f.duration))),
    topInvoker: loaf.flatMap((f) => f.scripts).sort((a, b) => b.duration - a.duration)[0]?.invoker ?? null,
  };
}

test('iteration-based scroll work: 4x throttling produces long frames, five runs, with spread', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const at1 = [];
  const at4 = [];
  for (let run = 0; run < 5; run++) at1.push(await scrollRun(page, 1));
  for (let run = 0; run < 5; run++) at4.push(await scrollRun(page, 4));
  const spread = (xs: number[]) => {
    const m = median(xs);
    return {
      min: Math.min(...xs),
      median: m,
      max: Math.max(...xs),
      spreadPct: m ? Math.round((100 * (Math.max(...xs) - Math.min(...xs))) / 2 / m) : null,
    };
  };
  const summary = {
    cpu1x: {
      runs: at1,
      count: spread(at1.map((r) => r.count)),
      totalBlockingMs: spread(at1.map((r) => r.totalBlockingMs)),
    },
    cpu4x: {
      runs: at4,
      count: spread(at4.map((r) => r.count)),
      totalBlockingMs: spread(at4.map((r) => r.totalBlockingMs)),
    },
  };
  save('throttling-scroll', summary);
  expect(
    at4.every((r) => r.count > 0),
    'every 4x run has long frames',
  ).toBe(true);
  expect(median(at4.map((r) => r.count))).toBeGreaterThan(median(at1.map((r) => r.count)));
  expect(at4.every((r) => r.topInvoker === 'DOMWindow.onscroll')).toBe(true);
});

test('wall-clock busy-waits are not slowed by throttling; iteration work is', async ({ page }) => {
  test.setTimeout(60_000);
  // Measure the click handler's own script duration from LoAF at 1x and 4x.
  const scriptMs = async (query: string, rate: number) => {
    await page.goto(`/click.html?${query}`);
    const cdp = await throttle(page, rate);
    await page.waitForTimeout(PAGE_SETTLE_MS);
    await clearCollected(page);
    await page.click('#heavy');
    await page.waitForTimeout(ENTRY_DELIVERY_MS * 2);
    const { loaf } = await collected(page);
    await cdp.detach();
    const s = loaf.flatMap((f) => f.scripts).find((x) => x.fn === 'onHeavyClick');
    return s?.duration ?? NaN;
  };
  const wall1 = await scriptMs('ms=100', 1);
  const wall4 = await scriptMs('ms=100', 4);
  // Enough iterations for ~60ms+ at 1x on a CI runner, so it's over LoAF's 50ms floor.
  const iter1 = await scriptMs('ms=0&iter=6000000', 1);
  const iter4 = await scriptMs('ms=0&iter=6000000', 4);
  save('throttling-wall-vs-iter', { wall1, wall4, iter1, iter4 });
  expect(wall4 / wall1, 'wall-clock work unchanged by 4x').toBeLessThan(1.25);
  expect(iter4 / iter1, 'iteration work slowed by 4x').toBeGreaterThan(2);
});
