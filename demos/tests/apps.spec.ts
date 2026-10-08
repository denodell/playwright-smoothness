import { test, expect } from 'playwright-butter';

// Same tests, same labels, different app version: APP_VARIANT=good records baselines,
// APP_VARIANT=bad is compared against them.
const v = process.env.APP_VARIANT ?? 'good';
test.use({
  butterOptions: { mode: 'full', replay: process.env.REPLAY === 'on' ? 'on' : 'on-regression' },
});

test('invoice search', async ({ page, butter }) => {
  await page.goto(`/invoices/?v=${v}`);
  const search = page.locator('#search');
  const result = await butter.measure('type a customer name', async () => {
    await search.fill('');
    await search.pressSequentially('acme', { delay: 60 });
  });
  expect(result).toBeSmooth();
});

test('kanban sort', async ({ page, butter }) => {
  await page.goto(`/kanban/?v=${v}`);
  await page.locator('#sort').waitFor();
  const result = await butter.measure('sort by priority', () => page.click('#sort .label'));
  expect(result).toBeSmooth();
});

test('parallax article', async ({ page, butter }) => {
  await page.goto(`/parallax/?v=${v}`);
  const result = await butter.scroll(page.locator('html'), { distance: 8000, speed: 'normal' });
  expect(result).toBeSmooth();
});

test('usage drawer', async ({ page, butter }) => {
  await page.goto(`/drawer/?v=${v}`);
  const result = await butter.measure('open the usage panel', async () => {
    await page.click('#open .label');
    await page.waitForTimeout(700); // the slide-in takes 600ms
  });
  expect(result).toBeSmooth();
});

test('social feed', async ({ page, butter }) => {
  await page.goto(`/feed/?v=${v}`);
  const result = await butter.scroll(page.getByRole('feed'), { distance: 12_000, speed: 'fast' });
  expect(result).toBeSmooth();
});

test('journal scroll', async ({ page, butter }) => {
  await page.goto(`/journal/?v=${v}`);
  const result = await butter.scroll(page.locator('html'), { distance: 3000, speed: 'normal' });
  expect(result).toBeSmooth();
});

test('design board drag', async ({ page, butter }) => {
  await page.goto(`/board/?v=${v}`);
  const card = page.locator('#hero-card');
  const cdp = await page.context().newCDPSession(page);
  const mouse = (type: string, x: number, y: number) =>
    cdp.send('Input.dispatchMouseEvent', { type: type as 'mouseMoved', x, y, button: 'left', buttons: 1 });
  const result = await butter.measure('drag a card', async () => {
    const box = (await card.boundingBox())!;
    const x0 = box.x + 40;
    const y0 = box.y + 20;
    await mouse('mousePressed', x0, y0);
    // A mouse sends moves at the screen's rate whether or not the page keeps up, so these go out
    // every 16ms without waiting for the page (page.mouse.move would wait for each one). Across
    // the board and back, as someone lining a card up would.
    const moves: Promise<unknown>[] = [];
    for (let i = 1; i <= 70; i++) {
      const t = i / 70;
      const x = x0 + 480 * Math.sin(t * Math.PI);
      const y = y0 + 320 * t;
      moves.push(new Promise((r) => setTimeout(r, i * 16)).then(() => mouse('mouseMoved', x, y)));
    }
    await Promise.all(moves);
    await mouse('mouseReleased', x0, y0 + 320);
  });
  expect(result).toBeSmooth();
});
