import { test, expect } from 'playwright-smoothness';

// In CI, SLOW=80 simulates a regression in the filters button.
const query = process.env.SLOW ? `?slow=${process.env.SLOW}` : '';

test('filters open smoothly', async ({ page, smoothness }) => {
  await page.goto(`/${query}`);
  const result = await smoothness.measure('open filters', async () => {
    await page.getByRole('button', { name: 'Filters' }).click();
  });
  expect(result).toBeSmooth();
});

test('the article list stays drawn while flung', async ({ page, smoothness }) => {
  await page.goto(`/${query}`);
  const result = await smoothness.scroll(page.getByRole('list', { name: 'Articles' }), {
    mode: 'full',
    speed: 'fast',
    distance: 20_000,
    runs: 3,
  });
  expect(result).toBeSmooth();
});
