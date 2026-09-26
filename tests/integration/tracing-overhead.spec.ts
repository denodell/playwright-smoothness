// Does tracing change what's measured? The same interactions in quick and full mode, at the
// default 4x throttling. Numbers are saved for docs/trace-categories.md.
import { test, expect } from '../../src/index.js';
import type { Page } from '@playwright/test';
import { save } from '../detection/helpers.js';

const CASES: { name: string; url: string; action: (page: Page) => Promise<void> }[] = [
  { name: 'click 150ms', url: '/click.html?ms=150', action: (p) => p.click('#heavy') },
  {
    name: 'typing 60ms',
    url: '/search.html?ms=60',
    action: async (p) => {
      await p.focus('#search');
      await p.keyboard.type('abc', { delay: 100 });
    },
  },
  {
    name: 'scroll 70ms',
    url: '/scroll.html?wait=70',
    action: async (p) => {
      await p.mouse.move(400, 400);
      for (let i = 0; i < 5; i++) {
        await p.mouse.wheel(0, 200);
        await p.waitForTimeout(100);
      }
    },
  },
];

for (const c of CASES) {
  test(`quick and full mode agree: ${c.name}`, async ({ page, smoothness }) => {
    test.setTimeout(120_000);
    await page.goto(c.url);
    const t0 = Date.now();
    const quick = await smoothness.measure(`${c.name} quick`, () => c.action(page), { mode: 'quick' });
    const t1 = Date.now();
    const full = await smoothness.measure(`${c.name} full`, () => c.action(page), { mode: 'full' });
    const t2 = Date.now();
    const pick = (r: typeof quick) => ({
      longFrames: r.longFrames!.count,
      worstMs: r.longFrames!.worstMs,
      p95ToPaintMs: r.input!.p95ToPaintMs,
      interactions: r.input!.interactions,
    });
    save(`overhead-${c.name.replace(/\s+/g, '-')}`, {
      quick: { ...pick(quick), wallMs: t1 - t0 },
      full: { ...pick(full), wallMs: t2 - t1, frames: full.frames },
    });
    expect(full.longFrames!.count).toBe(quick.longFrames!.count);
    expect(full.input!.interactions).toBe(quick.input!.interactions);
    if (quick.input!.p95ToPaintMs !== null) {
      // Within one floor (16ms): the difference a baseline would already tolerate.
      expect(Math.abs(full.input!.p95ToPaintMs! - quick.input!.p95ToPaintMs)).toBeLessThanOrEqual(16);
    }
  });
}
