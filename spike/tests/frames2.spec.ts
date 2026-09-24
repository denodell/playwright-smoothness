import { test } from '@playwright/test';
import * as fs from 'fs';
const collectLoaf = () => {
  (window as any).__loaf = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) (window as any).__loaf.push(Math.round(e.duration)); })
    .observe({ type: 'long-animation-frame', buffered: true });
};
for (const useNow of [false, true]) for (const wait of [0, 12, 25, 40, 70]) {
  test(`scroll handler blocks ${wait}ms, now=${useNow}`, async ({ page }) => {
    await page.addInitScript(collectLoaf);
    await page.goto(`/?wait=${wait}`);
    await page.waitForTimeout(500);
    await page.evaluate((n) => { (window as any).__useNow = n; }, useNow);
    await page.evaluate(() => { (window as any).__loaf = []; (window as any).startFrameSampler(); }, );
    await page.mouse.move(400, 400);
    for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 150); await page.waitForTimeout(80); }
    await page.waitForTimeout(200);
    const gaps: number[] = await page.evaluate(() => (window as any).stopFrameSampler());
    const loaf: number[] = await page.evaluate(() => (window as any).__loaf);
    const late = gaps.filter((g) => g > 16.7 * 1.5);
    const dropped = late.reduce((a, g) => a + Math.round(g / 16.7) - 1, 0);
    const out = { wait, frames: gaps.length, lateFrames: late.length, droppedFrames: dropped,
      onTimePct: Math.round(100 * (gaps.length - late.length) / gaps.length), loafEntries: loaf.length };
    fs.writeFileSync(`results/${test.info().project.name}--threshold-${wait}-${useNow ? 'now' : 'ts'}.json`, JSON.stringify(out));
  });
}
