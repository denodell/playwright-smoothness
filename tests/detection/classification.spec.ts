// Load, interaction and background frames, classified with no labels from the test, from
// raw LoAF and Event Timing entries. The library's classifier (src/analysis/classify.ts) refines
// this rule; tests/integration/classification.spec.ts checks it over 20 runs.
import { test, expect } from '@playwright/test';
import { installObservers, collected, save, type LoafRecord } from './helpers.js';

/**
 * Frames starting before loadEventEnd + this are load frames. The same value as LOAD_GRACE_MS in
 * src/analysis/classify.ts, not imported because this suite is independent of src/.
 */
const LOAD_GRACE_MS = 50;

test('classifying load, interaction and background frames', async ({ page }) => {
  await page.addInitScript(installObservers);
  await page.goto('/mixed.html');
  await page.waitForTimeout(1200); // past load work and the background job at +300ms
  await page.click('#buy .label');
  await page.waitForTimeout(300);
  await page.click('#search');
  await page.keyboard.type('abc', { delay: 120 });
  await page.waitForTimeout(300);
  await page.click('#vanish');
  await page.waitForTimeout(300);
  await page.hover('#feed');
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(500);

  const data = await collected(page);
  const loadEnd = await page.evaluate(
    () => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).loadEventEnd,
  );

  const longest = new Map<number, { start: number; duration: number }>();
  for (const e of data.events.filter((e) => e.interactionId > 0)) {
    const cur = longest.get(e.interactionId);
    if (!cur || e.duration > cur.duration) longest.set(e.interactionId, e);
  }
  const windows = [...longest.values()].map((e) => [e.start, e.start + e.duration] as const);

  const classify = (f: LoafRecord) => {
    if (f.firstUI > 0) return 'interaction';
    if (windows.some(([a, b]) => f.start < b && f.start + f.duration > a)) return 'interaction';
    if (data.scrolls.some((t) => t >= f.start - 5 && t <= f.start + f.duration)) return 'interaction';
    if (f.start < loadEnd + LOAD_GRACE_MS) return 'load';
    return 'background';
  };
  const truth = (f: LoafRecord) => {
    const s = f.scripts.map((x) => `${x.fn} ${x.source}`).join(' ');
    if (/onBuy|onSearchKey|onVanish|onFeedScroll/.test(s)) return 'interaction';
    if (/loadTimeWork|mixed-load\.js/.test(s)) return 'load';
    if (/backgroundJob/.test(s)) return 'background';
    return 'unknown';
  };
  const frames = data.loaf.map((f) => ({
    duration: Math.round(f.duration),
    scripts: f.scripts.map((s) => `${s.invokerType}: ${s.invoker} (${s.fn || s.source})`),
    guess: classify(f),
    truth: truth(f),
  }));
  save('classification', { loadEnd, frames, errors: data.errors });

  const byTruth = (t: string) => frames.filter((f) => f.truth === t).length;
  expect(byTruth('load'), 'a load frame').toBeGreaterThanOrEqual(1);
  expect(byTruth('background'), 'a background frame').toBeGreaterThanOrEqual(1);
  expect(byTruth('interaction'), 'interaction frames').toBeGreaterThanOrEqual(5);
  expect(
    frames.filter((f) => f.truth === 'unknown'),
    'every frame has known ground truth',
  ).toEqual([]);
  expect(
    frames.filter((f) => f.guess !== f.truth),
    'misclassified frames',
  ).toEqual([]);
});
