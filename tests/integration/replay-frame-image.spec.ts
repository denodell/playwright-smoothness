// Records the replay that docs/replay-frame.png is taken from: a costly list scrolled fast so its rows
// go blank. demos/make-images.mjs runs it and takes the still.
// Opt-in: REPLAY_FRAME_IMAGE=1 npx playwright test --project=integration replay-frame-image
import { test } from '../../packages/playwright-butter/src/index.js';

test.use({ viewport: { width: 600, height: 600 }, butterOptions: { replay: 'on', runs: 1 } });

test('replay frame image', async ({ page, butter }) => {
  test.skip(!process.env.REPLAY_FRAME_IMAGE, 'set REPLAY_FRAME_IMAGE=1 to record the replay');
  test.setTimeout(120_000);
  await page.goto('/list.html?cost=15&overscan=0');
  await butter.scroll(page.locator('#list'), {
    speed: 'fast',
    distance: 20_000,
    mode: 'full',
    label: 'catalog fast scroll',
  });
});
