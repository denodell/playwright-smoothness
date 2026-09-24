import { test, expect } from '../../../src/index.js';

test.use({
  smoothnessOptions: { runs: 3, enforce: process.env.ENFORCE === 'fail' ? 'fail' : 'warn' },
});

test('checkout click', async ({ page, smoothness }) => {
  await page.goto(`/click.html?ms=${process.env.CLICK_MS}`);
  const result = await smoothness.measure('checkout', () => page.click('#heavy'));
  expect(result).toBeSmooth();
});
