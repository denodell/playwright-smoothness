// A plain Playwright test: nothing here knows about smoothness.
import { test, expect } from './fixtures';

test('buy, then search', async ({ page }) => {
  await page.goto(`/click.html?ms=${process.env.CLICK_MS ?? '80'}`);
  await page.click('#heavy');
  await page.click('#nested .label');
  await expect(page.locator('#status')).toHaveText('nested clicked');
  await page.waitForTimeout(200);
  await page.goto('/search.html?ms=60');
  await page.locator('#search').pressSequentially('ab', { delay: 100 });
  await expect(page.locator('#search')).toHaveValue('ab');
});

test('leave from a button that navigates', async ({ page }) => {
  await page.goto('/click.html?ms=80');
  await page.click('#heavy');
  await page.click('#leave');
  await expect(page).toHaveURL(/search\.html/);
});

test('no page at all', async () => {
  expect(1 + 1).toBe(2);
});
