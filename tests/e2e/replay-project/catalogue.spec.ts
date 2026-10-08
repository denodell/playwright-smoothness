import { test, expect } from '../../../packages/playwright-butter/src/index.js';

test('catalogue fast scroll', async ({ page, butter }) => {
  await page.goto(
    `/list.html?cost=${process.env.ROW_COST ?? '0'}&overscan=${process.env.ROW_COST ? '0' : '2'}`,
  );
  const result = await butter.scroll(page.locator('#list'), {
    mode: 'full',
    speed: 'fast',
    distance: 20_000,
    runs: 2,
    cpuThrottling: 1,
    label: 'catalogue',
  });
  expect(result).toBeSmooth();
});
