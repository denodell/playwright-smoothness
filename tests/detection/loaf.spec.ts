// Section 3, LoAF row: frames over 50ms are reported with script attribution;
// the 50ms threshold can't be lowered; an idle page reports nothing.
import { test, expect } from '@playwright/test';
import {
  installObservers,
  collected,
  clearCollected,
  save,
  PAGE_SETTLE_MS,
  ENTRY_DELIVERY_MS,
} from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installObservers);
});

test('a 200ms requestAnimationFrame callback is reported', async ({ page }) => {
  await page.goto('/raf.html?ms=200');
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await clearCollected(page);
  await page.evaluate(() => (window as unknown as { runHeavyFrame(): void }).runHeavyFrame());
  await page.waitForTimeout(ENTRY_DELIVERY_MS);
  const { loaf, errors } = await collected(page);
  save('loaf-raf-200ms', loaf);
  expect(errors).toEqual([]);
  const heavy = loaf.filter((f) => f.duration >= 200);
  expect(heavy).toHaveLength(1);
  const script = heavy[0]!.scripts[0]!;
  expect(script.invokerType).toBe('user-callback');
  expect(script.fn).toBe('heavyFrame');
});

test('a 150ms click handler is reported and attributed', async ({ page }) => {
  await page.goto('/click.html?ms=150');
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await clearCollected(page);
  await page.click('#heavy');
  await page.waitForTimeout(ENTRY_DELIVERY_MS);
  const { loaf } = await collected(page);
  save('loaf-click-150ms', loaf);
  const heavy = loaf.filter((f) => f.duration >= 150);
  expect(heavy).toHaveLength(1);
  expect(heavy[0]!.firstUI).toBeGreaterThan(0);
  expect(heavy[0]!.scripts).toContainEqual(
    expect.objectContaining({
      invoker: 'BUTTON#heavy.onclick',
      invokerType: 'event-listener',
      fn: 'onHeavyClick',
      source: expect.stringMatching(/\/click\.js$/),
    }),
  );
});

test('LoAF ignores durationThreshold: 12ms and 25ms clicks produce no entries', async ({ page }) => {
  for (const ms of [12, 25]) {
    await page.goto(`/click.html?ms=${ms}`);
    await page.waitForTimeout(PAGE_SETTLE_MS);
    await page.click('#heavy'); // warm-up: the first click on a page carries a one-off cost
    await page.waitForTimeout(ENTRY_DELIVERY_MS);
    await clearCollected(page);
    for (let i = 0; i < 5; i++) {
      await page.click('#heavy');
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(ENTRY_DELIVERY_MS);
    const { loaf } = await collected(page);
    save(`loaf-threshold-click-${ms}ms`, loaf);
    expect(loaf, `${ms}ms clicks`).toHaveLength(0);
  }
});

test('an idle page reports no long frames', async ({ page }) => {
  await page.goto('/scroll.html');
  await page.waitForTimeout(1000);
  await clearCollected(page);
  await page.waitForTimeout(1500);
  const { loaf } = await collected(page);
  save('loaf-idle', loaf);
  expect(loaf).toHaveLength(0);
});
