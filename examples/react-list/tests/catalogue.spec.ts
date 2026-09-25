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
  expect(result.list!.blankFramePercent).toBeLessThan(10);
});

// The same list with expensive rows: it goes blank, and the CPU profile names the component
// doing the work through the source map, although the bundle is minified. (V8 inlines the
// small expensiveFormat() into Row, so the time is Row's; DevTools shows the same.)
test('expensive rows go blank, and the profile names them', async ({ page, smoothness }) => {
  await page.goto('/?slowRows=1');
  const result = await smoothness.scroll(page.getByRole('list', { name: 'Catalogue' }), {
    mode: 'full',
    input: 'touch',
    speed: 'fast',
    distance: 20_000,
    runs: 3,
    label: 'catalogue with slow rows',
  });
  expect(result.list!.blankFramePercent).toBeGreaterThan(50);
  const top = result.profile!.hotFunctions[0]!;
  expect(top.fn).toBe('Row');
  expect(top.url).toMatch(/src\/main\.jsx$/);
  expect(top.generated!.fn).not.toBe('Row'); // minified in the bundle
});
