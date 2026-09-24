// Measures through the built package, so the collector is serialized from esbuild's output
// rather than from the test runner's transform of src/. Needs `npm run build` first.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const distEntry = new URL('../../dist/index.js', import.meta.url);
const built = existsSync(fileURLToPath(distEntry));
const mod = built ? await import(distEntry.href) : await import('../../src/index.js');
const { test, expect } = mod as typeof import('../../src/index.js');

test('the built package measures a click end to end', async ({ page, smoothness }) => {
  test.skip(!built, 'dist/ not built; run npm run build');
  await page.goto('/click.html?ms=150');
  const result = await smoothness.measure('dist click', () => page.click('#heavy'), { runs: 1 });
  expect(result.unavailable).toEqual([]);
  expect(result.longFrames!.count).toBe(1);
  expect(result.input!.byTarget[0]!.target).toBe('button#heavy');
});
