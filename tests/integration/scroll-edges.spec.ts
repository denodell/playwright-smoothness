import { test, expect } from '../../packages/playwright-smoothness/src/index.js';
import type { Page } from '@playwright/test';

test.use({
  viewport: { width: 600, height: 600 },
  smoothnessOptions: { cpuThrottling: 1, runs: 2, mode: 'quick' },
});
test.setTimeout(120_000);

const list = (page: Page) => page.locator('#list');

test('a page that moves the list after it was put back is noted', async ({ page, smoothness }) => {
  await page.addInitScript(() => {
    addEventListener('load', () => {
      const el = document.querySelector<HTMLElement>('#list')!;
      if (sessionStorage.getItem('scrolled')) {
        const hold = () => {
          el.scrollTop = 300;
          requestAnimationFrame(hold);
        };
        hold();
      } else {
        el.addEventListener('scroll', () => sessionStorage.setItem('scrolled', '1'), { once: true });
      }
    });
  });
  await page.goto('/list.html?cost=0&overscan=2');
  const r = await smoothness.scroll(list(page), { distance: 1000 });
  expect(r.notes.join(' ')).toMatch(/Runs didn't all start where the first did/);
});

test('a list already at its end scrolls nothing, and says so', async ({ page, smoothness }) => {
  await page.goto('/list.html?cost=0&overscan=2');
  await list(page).evaluate((el) => (el.scrollTop = el.scrollHeight));
  const r = await smoothness.scroll(list(page), { distance: 'end', reset: 'none' });
  expect(r.scroll!.requestedPx).toBe(0);
  expect(r.notes.join(' ')).toMatch(/already at its end/);
});

test('arrow keys stop at the press limit', async ({ page, smoothness }) => {
  await page.goto('/list.html?cost=0&overscan=2');
  const r = await smoothness.scroll(list(page), { input: 'keys', distance: 6000, runs: 1 });
  expect(r.scroll!.keyPresses).toBe(100);
  expect(r.notes.join(' ')).toMatch(/Arrow keys were pressed at most 100 times/);
});

test("a list that won't take focus is clicked, so the arrow keys scroll it", async ({ page, smoothness }) => {
  await page.addInitScript(() => {
    addEventListener('DOMContentLoaded', () => {
      const list = document.querySelector<HTMLElement>('#list')!;
      list.addEventListener('focus', () => list.blur());
      list.addEventListener('click', () => ((window as unknown as { clicked: boolean }).clicked = true));
    });
  });
  await page.goto('/list.html?cost=0&overscan=2');
  const r = await smoothness.scroll(list(page), { input: 'keys', distance: 400, runs: 1 });
  expect(await page.evaluate(() => (window as unknown as { clicked?: boolean }).clicked)).toBe(true);
  expect(r.scroll!.scrolledPx).toBeGreaterThan(0);
});

test('list.virtualized: false is noted', async ({ page, smoothness }) => {
  await page.goto('/list.html?cost=0&overscan=2');
  const r = await smoothness.scroll(list(page), {
    distance: 2000,
    speed: 'fast',
    mode: 'full',
    runs: 1,
    list: { virtualized: false },
  });
  expect(r.notes.join(' ')).toMatch(/list\.virtualized is false/);
});

test('a document whose scroll restoration cannot be set is still measured', async ({ page, smoothness }) => {
  await page.addInitScript(() => {
    Object.defineProperty(History.prototype, 'scrollRestoration', {
      get: () => 'auto',
      set() {
        throw new Error('blocked');
      },
    });
  });
  await page.goto('/list.html?cost=0&overscan=2');
  const r = await smoothness.scroll(list(page), { distance: 1000, runs: 1 });
  expect(r.scroll!.scrolledPx).toBeGreaterThan(0);
});

test('a list that is blank at rest is not judged for blank frames', async ({ page, smoothness }) => {
  await page.addInitScript(() => {
    addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = '#list > * { visibility: hidden }';
      document.head.append(style);
    });
  });
  await page.goto('/list.html?cost=0&overscan=2');
  const r = await smoothness.scroll(list(page), { distance: 2000, speed: 'fast', mode: 'full', runs: 1 });
  expect(r.unavailable).toContainEqual({
    measurement: 'list',
    reason: expect.stringMatching(/too little to judge blank frames/),
  });
});

test('list colours that cannot be resolved are noted, not guessed', async ({ page, smoothness }) => {
  await page.goto('/list.html?cost=0&overscan=2');
  const r = await smoothness.scroll(list(page), {
    distance: 2000,
    speed: 'fast',
    mode: 'full',
    runs: 1,
    list: { background: 'not-a-colour', placeholders: ['[[nope', '.nothing-matches-this'] },
  });
  const notes = r.notes.join(' ');
  expect(notes).toMatch(/list\.background 'not-a-colour' isn't a CSS color; white is used/);
  expect(notes).toMatch(/list\.placeholders '\[\[nope' is neither a color nor a valid selector/);
  expect(notes).toMatch(/list\.placeholders '\.nothing-matches-this' matched no element/);
});
