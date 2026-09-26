// Event Timing: durations, targets and which interactions it reports
// (docs/measurements.md, Event Timing and LoAF).
import { test, expect } from '@playwright/test';
import {
  installObservers,
  collected,
  clearCollected,
  save,
  tenWheelScrolls,
  PAGE_SETTLE_MS,
  ENTRY_DELIVERY_MS,
} from './helpers.js';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installObservers);
});

test('a 25ms click: Event Timing sees it, LoAF misses it', async ({ page }) => {
  // Event Timing reports from 16ms, in 8ms steps; LoAF only from 50ms.
  await page.goto('/click.html?ms=25');
  await page.waitForTimeout(PAGE_SETTLE_MS);
  // The first click on a page carries a one-off cost (see 'first interaction' below).
  await page.click('#heavy');
  await page.waitForTimeout(ENTRY_DELIVERY_MS);
  await clearCollected(page);
  for (let i = 0; i < 5; i++) {
    await page.click('#heavy');
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(ENTRY_DELIVERY_MS);
  const { events, loaf } = await collected(page);
  const clicks = events.filter((e) => e.name === 'click');
  save('event-click-25ms', { clicks, loafCount: loaf.length });
  expect(clicks).toHaveLength(5);
  for (const c of clicks) {
    expect(c.duration % 8, `duration ${c.duration} is a multiple of 8`).toBe(0);
    expect(c.duration).toBeGreaterThanOrEqual(24);
    expect(c.interactionId).toBeGreaterThan(0);
    expect(c.target).toBe('button#heavy');
  }
  expect(loaf).toHaveLength(0);
});

test('a click on a nested span', async ({ page }) => {
  await page.goto('/click.html?ms=80');
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await clearCollected(page);
  await page.click('#nested .label');
  await page.waitForTimeout(ENTRY_DELIVERY_MS);
  const { events } = await collected(page);
  const click = events.find((e) => e.name === 'click');
  save('event-nested', events);
  expect(click?.target).toBe('span.label');
  // The library walks up to the nearest interactive ancestor. Confirm that's the button.
  const ancestor = await page.evaluate(
    () =>
      document
        .querySelector('#nested .label')!
        .closest('button, a, input, select, textarea, [role], [tabindex]')?.id,
  );
  expect(ancestor).toBe('nested');
});

test('a self-removing button', async ({ page }) => {
  await page.goto('/click.html?ms=70');
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await clearCollected(page);
  await page.click('#vanish');
  await page.waitForTimeout(ENTRY_DELIVERY_MS);
  const { events, loaf } = await collected(page);
  save('event-vanish', { events, loaf });
  const click = events.find((e) => e.name === 'click');
  expect(click).toBeDefined();
  expect(click!.target).toBeNull();
  expect(loaf.flatMap((f) => f.scripts).map((s) => s.invoker)).toContain('BUTTON#vanish.onclick');
});

test('a 60ms keydown handler is reported per key with its target', async ({ page }) => {
  await page.goto('/search.html?ms=60');
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await page.click('#search');
  await clearCollected(page);
  await page.keyboard.type('abc', { delay: 120 });
  await page.waitForTimeout(ENTRY_DELIVERY_MS);
  const { events } = await collected(page);
  const keydowns = events.filter((e) => e.name === 'keydown');
  save('event-keydown-60ms', keydowns);
  expect(keydowns).toHaveLength(3);
  expect(new Set(keydowns.map((k) => k.interactionId)).size).toBe(3);
  for (const k of keydowns) {
    expect(k.target).toBe('input#search');
    expect(k.duration).toBeGreaterThanOrEqual(56);
  }
});

test('wheel scrolling has no Event Timing entries', async ({ page }) => {
  await page.goto('/scroll.html?wait=40');
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await clearCollected(page);
  await tenWheelScrolls(page);
  await page.waitForTimeout(ENTRY_DELIVERY_MS);
  const { events, scrolls, loaf } = await collected(page);
  const names = [...new Set(events.map((e) => e.name))];
  save('event-wheel', { names, scrollTimestamps: scrolls.length, loaf: loaf.length });
  expect(names).not.toContain('wheel');
  expect(names).not.toContain('scroll');
  expect(events.filter((e) => e.interactionId > 0)).toHaveLength(0);
  // The capture-phase scroll listener is what sees scrolling instead.
  expect(scrolls.length).toBeGreaterThanOrEqual(10);
});

test('the first interaction on a page', async ({ page }) => {
  // It costs more than later clicks. Recorded, not gated on: it informs the warm-up run and
  // single-run automatic mode.
  await page.goto('/click.html?ms=25');
  await page.waitForTimeout(PAGE_SETTLE_MS);
  await clearCollected(page);
  for (let i = 0; i < 4; i++) {
    await page.click('#heavy');
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(ENTRY_DELIVERY_MS);
  const { events, loaf } = await collected(page);
  const clicks = events.filter((e) => e.name === 'click').map((e) => e.duration);
  save('event-first-interaction', { clickDurations: clicks, loafCount: loaf.length });
  expect(clicks).toHaveLength(4);
});
