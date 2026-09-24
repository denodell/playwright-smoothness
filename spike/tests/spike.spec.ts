import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';

// Collect every long animation frame the page reports, from before the page loads.
const collectLoaf = () => {
  (window as any).__loaf = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) {
        (window as any).__loaf.push({
          start: Math.round(e.startTime), duration: e.duration, blocking: e.blockingDuration,
          scripts: (e.scripts || []).map((s: any) => ({
            invoker: s.invoker, invokerType: s.invokerType,
            source: s.sourceURL, fn: s.sourceFunctionName, duration: s.duration,
          })),
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch {}
};

const frames = (page: Page) => page.evaluate(() => (window as any).__loaf);
const reset = (page: Page) => page.evaluate(() => { (window as any).__loaf = []; });
const save = (name: string, data: unknown) =>
  fs.writeFileSync(`results/${test.info().project.name}--${name}.json`, JSON.stringify(data, null, 2));

test.beforeEach(async ({ page }) => { await page.addInitScript(collectLoaf); });

test('1 environment', async ({ page, browser }) => {
  await page.goto('/');
  const env = await page.evaluate(() => ({
    supported: PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'),
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
    userAgent: navigator.userAgent,
  }));
  save('environment', { browserVersion: browser.version(), ...env });
  expect(env.supported).toBe(true);
});

test('2 a 200ms requestAnimationFrame callback is reported', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(500);
  await reset(page);
  await page.evaluate(() => (window as any).busyWaitInRaf(200));
  await page.waitForTimeout(800);
  const f = await frames(page);
  save('raf-200ms', f);
  expect(f.some((e: any) => e.duration >= 200)).toBe(true);
});

test('3 a 150ms click handler is reported and attributed', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(500);
  await reset(page);
  await page.click('#heavy');
  await page.waitForTimeout(800);
  const f = await frames(page);
  save('click-150ms', f);
  const long = f.filter((e: any) => e.duration >= 150);
  expect(long.length).toBeGreaterThan(0);
  expect(long.flatMap((e: any) => e.scripts).some((s: any) => /click/i.test(s.invoker))).toBe(true);
});

test('4 an idle page reports no long frames', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(1000);
  await reset(page);
  await page.waitForTimeout(1500);
  const f = await frames(page);
  save('idle', f);
  expect(f.length).toBe(0);
});

// Scroll a list whose scroll handler does a fixed amount of work, five times over,
// with and without 4x CPU throttling, and record how much the results vary.
for (const rate of [1, 4]) {
  test(`5 scrolling, repeated five times, CPU ${rate}x`, async ({ page }) => {
    test.setTimeout(120_000);
    const runs: any[] = [];
    for (let run = 0; run < 5; run++) {
      await page.goto('/?work=1500000');
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      await page.waitForTimeout(500);
      await reset(page);
      await page.mouse.move(400, 400);
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(100);
      }
      await page.waitForTimeout(800);
      const f = await frames(page);
      runs.push({
        count: f.length,
        totalBlocking: Math.round(f.reduce((a: number, e: any) => a + e.blocking, 0)),
        worst: Math.round(Math.max(0, ...f.map((e: any) => e.duration))),
        topInvoker: f.flatMap((e: any) => e.scripts).sort((a: any, b: any) => b.duration - a.duration)[0]?.invoker ?? null,
      });
      await cdp.detach();
    }
    save(`scroll-cpu${rate}x`, runs);
    expect(runs.every((r) => r.count > 0)).toBe(true);
  });
}

test('6 layout-heavy frame, repeated five times, CPU 4x', async ({ page }) => {
  test.setTimeout(120_000);
  const runs: any[] = [];
  for (let run = 0; run < 5; run++) {
    await page.goto('/');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.waitForTimeout(500);
    await reset(page);
    await page.evaluate(() => (window as any).layoutThrashInRaf());
    await page.waitForTimeout(1500);
    const f = await frames(page);
    runs.push({ count: f.length, worst: Math.round(Math.max(0, ...f.map((e: any) => e.duration))),
      blocking: Math.round(f.reduce((a: number, e: any) => a + e.blocking, 0)),
      top: f[0]?.scripts?.[0] ? `${f[0].scripts[0].invoker} ${f[0].scripts[0].fn}` : null });
    await cdp.detach();
  }
  save('layout-cpu4x', runs);
  expect(runs.every((r) => r.count > 0)).toBe(true);
});
