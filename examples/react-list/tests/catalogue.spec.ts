import { test, expect } from 'playwright-smoothness';

test('the catalogue stays drawn during a fast fling', async ({ page, smoothness }) => {
  await page.goto('/');
  const result = await smoothness.scroll(page.getByRole('list', { name: 'Catalogue' }), {
    mode: 'full',
    input: 'touch',
    speed: 'fast',
    distance: 20_000,
    runs: 3,
  });
  expect(result).toBeSmooth();
  // It really moved (a list that didn't would have no blank-frame data at all).
  expect(result.scroll!.scrolledPx).toBeGreaterThan(19_000);
  // Blank frames are compared with the baseline by toBeSmooth(), not with a fixed number.
});

// The same list with expensive rows, flung with the wheel: the compositor keeps scrolling while
// the main thread is busy rendering rows, so the list goes blank. (With touch on this page the
// list only moves as fast as rows render, so it stays drawn but scrolls slowly.) The CPU profile
// names the slow code through the source map, although the bundle is minified.
test('expensive rows go blank, and the profile names them', async ({ page, smoothness }) => {
  await page.goto('/?slowRows=1');
  const result = await smoothness.scroll(page.getByRole('list', { name: 'Catalogue' }), {
    mode: 'full',
    input: 'wheel',
    speed: 'fast',
    distance: 20_000,
    runs: 2,
    label: 'catalogue with slow rows',
  });
  expect(result.scroll!.scrolledPx).toBeGreaterThan(19_000);
  expect(result.list!.blankFramePercent).toBeGreaterThan(50);
  // The slow rows spin on performance.now(), so `now` itself can be the hottest function.
  const top = result.profile!.hotFunctions.find((f) => f.fn !== 'now')!;
  // V8 may inline the small expensiveFormat() into Row, and then the time is Row's.
  expect(['expensiveFormat', 'Row']).toContain(top.fn);
  expect(top.url).toMatch(/src\/main\.jsx$/);
  expect(top.generated!.fn).not.toBe(top.fn); // minified in the bundle
});
