// Section 3: trace AnimationFrame events give every main-thread frame's duration with no
// 50ms cutoff (used for the 120Hz prediction). Also: headless is fixed at ~60fps.
import { test, expect, chromium } from '@playwright/test';
import {
  save,
  traced,
  animationFrameDurations,
  tenWheelScrolls,
  warmUpWheel,
  PAGE_SETTLE_MS,
} from './helpers.js';

const CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'cc', 'benchmark'];

for (const wait of [0, 12, 25]) {
  test(`AnimationFrame durations with ${wait}ms scroll work`, async ({ page, browser }) => {
    await page.goto(`/scroll.html?wait=${wait}`);
    await page.waitForTimeout(PAGE_SETTLE_MS);
    await warmUpWheel(page);
    const { events } = await traced(browser, page, () => tenWheelScrolls(page), { categories: CATEGORIES });
    const d = animationFrameDurations(events);
    const over = (ms: number) => d.filter((x) => x > ms).length;
    const out = {
      wait,
      frames: d.length,
      over8_33ms: over(1000 / 120),
      over16_7ms: over(1000 / 60),
      over50ms: over(50),
      longestMs: Math.round(Math.max(0, ...d) * 10) / 10,
    };
    save(`animation-frame-${wait}ms`, out);
    expect(d.length, 'AnimationFrame events present').toBeGreaterThan(0);
    // Frames under 50ms are visible here but invisible to LoAF.
    if (wait === 25) expect(out.over16_7ms).toBeGreaterThanOrEqual(8);
    if (wait === 0) expect(out.over50ms, 'no long frames with no work, after warm-up').toBe(0);
  });
}

// Launches its own browsers, so it runs the three modes itself.
const FLAG_VARIANTS: Record<string, string[]> = {
  default: [],
  'disable-frame-rate-limit': ['--disable-frame-rate-limit'],
  'disable-gpu-vsync': ['--disable-gpu-vsync'],
};

test('headless Chrome runs at ~60fps and the frame-rate flags do not change it', async ({ baseURL }) => {
  test.setTimeout(90_000);
  const results: Record<string, number> = {};
  for (const [name, args] of Object.entries(FLAG_VARIANTS)) {
    const browser = await chromium.launch({ channel: 'chromium', headless: true, args });
    try {
      const page = await browser.newPage();
      await page.goto(`${baseURL}/scroll.html`);
      await page.addScriptTag({ url: '/lib/frame-sampler.js' }).catch(() => undefined);
      await page.waitForTimeout(300);
      await page.evaluate(() =>
        (window as unknown as { startFrameSampler(m: string): void }).startFrameSampler('now'),
      );
      await page.waitForTimeout(1000);
      const gaps = await page.evaluate(() =>
        (window as unknown as { stopFrameSampler(): number[] }).stopFrameSampler(),
      );
      results[name] = gaps.length;
    } finally {
      await browser.close();
    }
  }
  save('refresh-rate', { framesPerSecond: results });
  for (const [name, fps] of Object.entries(results)) {
    expect(fps, `${name}: frames in 1s`).toBeGreaterThanOrEqual(50);
    expect(fps, `${name}: frames in 1s`).toBeLessThanOrEqual(70);
  }
});
