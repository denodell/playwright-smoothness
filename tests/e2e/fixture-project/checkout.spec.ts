import { test, expect } from '../../../packages/playwright-butter/src/index.js';

test.use({
  butterOptions: { runs: 3, enforce: process.env.ENFORCE === 'fail' ? 'fail' : 'warn' },
});

test('checkout click', async ({ page, butter }) => {
  await page.goto(`/click.html?ms=${process.env.CLICK_MS}`);
  const result = await butter.measure('checkout', () => page.click('#heavy'));
  expect(result).toBeSmooth();
});
