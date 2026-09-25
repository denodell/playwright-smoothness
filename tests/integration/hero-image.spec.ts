// Generates docs/hero.png for the README: a frame from a cheap list's fling next to the
// least-drawn frame from a costly list's, with the real numbers from the same runs.
// Opt-in: HERO_IMAGE=1 npx playwright test --project=integration hero-image
import { test, expect } from '../../src/index.js';
import type { Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { traceRun } from '../../src/trace/tracer.js';
import { FRAME_CATEGORIES, SCREENSHOT_CATEGORIES } from '../../src/trace/categories.js';
import { analyzeFrames } from '../../src/list/analyze.js';
import { blankColors, listGeometry, referenceShot } from '../../src/list/probe.js';

test.use({
  viewport: { width: 600, height: 600 },
  smoothnessOptions: { mode: 'full', cpuThrottling: 1, runs: 3 },
});

async function flingFrames(page: Page, url: string) {
  await page.goto(url);
  await page.waitForTimeout(500);
  const target = page.locator('#list');
  const geometry = await listGeometry(target);
  const { colors } = await blankColors(target, { background: 'auto', placeholders: [] });
  const referencePng = await referenceShot(page, geometry);
  const cdp = await page.context().newCDPSession(page);
  const browser = page.context().browser()!;
  const trace = await traceRun(
    browser,
    page,
    [...FRAME_CATEGORIES, ...SCREENSHOT_CATEGORIES],
    () =>
      cdp
        .send('Input.synthesizeScrollGesture', {
          x: 300,
          y: 300,
          yDistance: -20000,
          speed: 6000,
          gestureSourceType: 'mouse',
        })
        .then(() => undefined),
    { browserVersion: browser.version(), budget120: false, profile: false, screenshots: true },
  );
  const a = await analyzeFrames(browser, {
    jpegs: trace.screenshots,
    referencePng,
    geometry,
    direction: 'vertical',
    blank: colors,
  });
  return { jpegs: trace.screenshots, coverage: a.frames };
}

test('hero image', async ({ page, smoothness }) => {
  test.skip(!process.env.HERO_IMAGE, 'set HERO_IMAGE=1 to regenerate docs/hero.png');
  test.setTimeout(180_000);
  // The numbers, measured the way a user would.
  await page.goto('/list.html?cost=0&overscan=2');
  const cheap = await smoothness.scroll(page.locator('#list'), {
    speed: 'fast',
    distance: 20000,
    label: 'cheap',
  });
  await page.goto('/list.html?cost=15&overscan=0');
  const costly = await smoothness.scroll(page.locator('#list'), {
    speed: 'fast',
    distance: 20000,
    label: 'costly',
  });
  // The pictures: a mid-fling frame from each.
  const c = await flingFrames(page, '/list.html?cost=0&overscan=2');
  const x = await flingFrames(page, '/list.html?cost=15&overscan=0');
  const mid = Math.floor(c.jpegs.length / 2);
  const worst = x.coverage.indexOf(Math.min(...x.coverage.slice(20, -20)), 20);
  const png = await page.evaluate(
    async ({ left, right, labels }) => {
      const load = async (b64: string) =>
        createImageBitmap(
          new Blob([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], { type: 'image/jpeg' }),
        );
      const [a, b] = await Promise.all([load(left), load(right)]);
      const pad = 32;
      const head = 96;
      const w = a.width + b.width + pad * 3;
      const h = a.height + head + pad * 2;
      const canvas = new OffscreenCanvas(w, h);
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#f4f4f5';
      g.fillRect(0, 0, w, h);
      [a, b].forEach((img, i) => {
        const x0 = pad + i * (a.width + pad);
        g.fillStyle = '#18181b';
        g.font = '600 22px system-ui, sans-serif';
        g.fillText(labels[i]![0]!, x0, pad + 26);
        g.fillStyle = '#52525b';
        g.font = '17px system-ui, sans-serif';
        g.fillText(labels[i]![1]!, x0, pad + 56);
        g.fillText(labels[i]![2]!, x0, pad + 80);
        g.drawImage(img, x0, pad + head);
        g.strokeStyle = '#d4d4d8';
        g.lineWidth = 2;
        g.strokeRect(x0, pad + head, img.width, img.height);
      });
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (const byte of bytes) s += String.fromCharCode(byte);
      return btoa(s);
    },
    {
      left: c.jpegs[mid]!,
      right: x.jpegs[worst]!,
      labels: [
        [
          'Rows drawn while scrolling',
          `${cheap.list!.blankFramePercent}% blank frames`,
          `${cheap.frames!.onTimePercent}% of frames on time`,
        ],
        [
          'Rows blank while scrolling',
          `${costly.list!.blankFramePercent}% blank frames`,
          `${costly.frames!.onTimePercent}% of frames on time`,
        ],
      ],
    },
  );
  writeFileSync('docs/hero.png', Buffer.from(png, 'base64'));
  expect(costly.list!.blankFramePercent).toBeGreaterThan(50);
});
