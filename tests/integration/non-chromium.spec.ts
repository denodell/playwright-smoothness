// Principle 7: outside Chromium the measurement is skipped with a visible annotation.
import { test, expect } from '../../src/index.js';

test('Not Chromium: skipped with an annotation, nothing reported as zero', async ({ page, smoothness }) => {
  await page.goto('/click.html?ms=20');
  const result = await smoothness.measure('click', () => page.click('#heavy'));
  expect(result.browserName).not.toBe('chromium');
  expect(result.runs).toBe(0);
  expect(result.input).toBeNull();
  expect(result.longFrames).toBeNull();
  expect(result.unavailable.map((u) => u.measurement)).toEqual(['input', 'longFrames']);
  expect(test.info().annotations).toContainEqual({
    type: 'smoothness-skipped',
    description: expect.stringContaining('Chromium only'),
  });
});
