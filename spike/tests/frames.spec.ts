import { test } from '@playwright/test';
import * as fs from 'fs';

const collectLoaf = () => {
  (window as any).__loaf = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) (window as any).__loaf.push(e.duration); })
    .observe({ type: 'long-animation-frame', buffered: true });
};
const summarize = (gaps: number[]) => {
  const s = [...gaps].sort((a, b) => a - b);
  const pct = (p: number) => Math.round(s[Math.floor((s.length - 1) * p)] * 10) / 10;
  return { frames: gaps.length, median: pct(0.5), p95: pct(0.95), max: Math.round(s[s.length - 1]),
    over25ms: gaps.filter((g) => g > 25).length, over50ms: gaps.filter((g) => g > 50).length };
};

for (const scenario of [
  { name: 'idle', work: 0 },
  { name: 'mild-jank', work: 400000 },
]) {
  test(`frame cadence, ${scenario.name}, CPU 4x`, async ({ page }) => {
    await page.addInitScript(collectLoaf);
    await page.goto(`/?work=${scenario.work}`);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.waitForTimeout(500);
    await page.evaluate(() => { (window as any).__loaf = []; (window as any).startFrameSampler(); });
    await page.mouse.move(400, 400);
    for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, 150); await page.waitForTimeout(60); }
    await page.waitForTimeout(300);
    const gaps = await page.evaluate(() => (window as any).stopFrameSampler());
    const loaf = await page.evaluate(() => (window as any).__loaf.length);
    const out = { ...summarize(gaps), loafFrames: loaf };
    fs.writeFileSync(`results/${test.info().project.name}--cadence-${scenario.name}.json`, JSON.stringify(out));
  });
}
