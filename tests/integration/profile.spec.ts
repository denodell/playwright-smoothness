// Full mode's CPU profile: attributed to the page's main thread only, and to the interaction.
import { test, expect } from '../../src/index.js';

test.use({ smoothnessOptions: { mode: 'full', runs: 2 } });

test('a busy web worker is never blamed for the main thread', async ({ page, smoothness }) => {
  await page.goto('/worker.html?ms=150');
  await page.waitForTimeout(300);
  const result = await smoothness.measure('click next to a busy worker', () => page.click('#heavy'));
  const fns = result.profile!.hotFunctions.map((f) => f.fn);
  expect(fns).not.toContain('workerSpin');
  expect(fns[0]).toBe('busyWait');
  expect(result.profile!.hotFunctions[0]!.callers[0]).toBe('onHeavyClick');
});

test('hot functions carry location, self and total time', async ({ page, smoothness }) => {
  await page.goto('/click.html?ms=150');
  const result = await smoothness.measure('profiled click', () => page.click('#heavy'));
  const top = result.profile!.hotFunctions[0]!;
  expect(top).toMatchObject({
    fn: 'busyWait',
    url: expect.stringMatching(/\/lib\/work\.js$/),
    callers: ['onHeavyClick'],
  });
  expect(top.line).toBeGreaterThan(0);
  expect(top.totalMs).toBeGreaterThanOrEqual(top.selfMs);
  expect(result.profile!.sampledMs).toBeGreaterThan(100);
});

test('quick mode has no profile', async ({ page, smoothness }) => {
  await page.goto('/click.html?ms=60');
  const result = await smoothness.measure('quick click', () => page.click('#heavy'), {
    mode: 'quick',
    runs: 1,
  });
  expect('profile' in result).toBe(false);
});
