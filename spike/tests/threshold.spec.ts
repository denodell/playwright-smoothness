import { test } from '@playwright/test';
import * as fs from 'fs';

// Try to lower LoAF's threshold, and compare with Event Timing, which does accept a lower one.
const observe = () => {
  const w = window as any;
  w.__loaf = []; w.__events = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__loaf.push(Math.round(e.duration)); })
    .observe({ type: 'long-animation-frame', buffered: true, durationThreshold: 16 } as any);
  new PerformanceObserver((l) => {
    for (const e of l.getEntries() as any[]) w.__events.push({ name: e.name, duration: e.duration, interactionId: e.interactionId });
  }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as any);
};

for (const wait of [12, 25, 40]) {
  test(`${wait}ms blocking, click and scroll`, async ({ page }) => {
    await page.addInitScript(observe);
    await page.goto(`/?wait=${wait}&clickwait=${wait}`);
    await page.waitForTimeout(500);
    await page.evaluate(() => { (window as any).__loaf = []; (window as any).__events = []; });
    for (let i = 0; i < 5; i++) { await page.click('#heavy'); await page.waitForTimeout(100); }
    const afterClicks = await page.evaluate(() => ({ loaf: [...(window as any).__loaf], events: [...(window as any).__events] }));
    await page.evaluate(() => { (window as any).__loaf = []; (window as any).__events = []; });
    await page.mouse.move(400, 400);
    for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 150); await page.waitForTimeout(100); }
    await page.waitForTimeout(300);
    const afterScroll = await page.evaluate(() => ({ loaf: [...(window as any).__loaf], events: [...(window as any).__events] }));
    const sum = (r: any) => ({
      loafEntries: r.loaf.length,
      eventTypes: [...new Set(r.events.map((e: any) => e.name))],
      clickEntries: r.events.filter((e: any) => e.name === 'click').map((e: any) => e.duration),
    });
    fs.writeFileSync(`results/${test.info().project.name}--lowthreshold-${wait}.json`,
      JSON.stringify({ wait, clicks: sum(afterClicks), scroll: sum(afterScroll) }));
  });
}
