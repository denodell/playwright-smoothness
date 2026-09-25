// TEMPORARY (M4): why does a synthetic touch scroll move 0px on Linux runners?
import { test } from '@playwright/test';
import { save } from './helpers.js';

type Variant = { name: string; ctx: Record<string, unknown>; emulate?: boolean; source?: string; manual?: boolean };
const VARIANTS: Variant[] = [
  { name: 'touch-plain', ctx: {} },
  { name: 'touch-hasTouch', ctx: { hasTouch: true } },
  { name: 'touch-mobile', ctx: { hasTouch: true, isMobile: true } },
  { name: 'touch-emulation', ctx: {}, emulate: true },
  { name: 'default-source-hasTouch', ctx: { hasTouch: true }, source: 'default' },
  { name: 'manual-dispatchTouchEvent-hasTouch', ctx: { hasTouch: true }, manual: true },
  { name: 'mouse', ctx: {}, source: 'mouse' },
];

test('touch scrolling variants', async ({ browser }) => {
  test.setTimeout(120_000);
  const out: Record<string, unknown> = { platform: process.platform, version: browser.version() };
  for (const v of VARIANTS) {
    const ctx = await browser.newContext({ viewport: { width: 600, height: 600 }, ...v.ctx });
    const page = await ctx.newPage();
    await page.goto('/list.html?rows=300&cost=0');
    await page.waitForTimeout(300);
    const cdp = await ctx.newCDPSession(page);
    let error: string | null = null;
    try {
      if (v.emulate) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      if (v.manual) {
        const pts = (y: number) => [{ x: 300, y }];
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(500) });
        for (let y = 480; y >= 100; y -= 20) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(y) });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await cdp.send('Input.synthesizeScrollGesture', {
          x: 300,
          y: 300,
          yDistance: -2000,
          speed: 3000,
          gestureSourceType: (v.source ?? 'touch') as 'touch',
        });
      }
    } catch (err) {
      error = String(err).split('\n')[0]!;
    }
    await page.waitForTimeout(800);
    out[v.name] = {
      scrollTop: await page.evaluate(() => document.getElementById('list')!.scrollTop),
      maxTouchPoints: await page.evaluate(() => navigator.maxTouchPoints),
      error,
    };
    await ctx.close();
  }
  save('touch-probe', out);
  console.log('TOUCH PROBE', JSON.stringify(out));
});
