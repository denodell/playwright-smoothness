import { test, expect } from '@playwright/test';
import { lineCoverage, type CoverageOptions } from '../../src/list/coverage.js';
import { summarizeList, BLANK_FRAME_SHARE } from '../../src/list/summarize.js';
import { defaultScrollLabel, END_CAP_PX, resolveScroll, scrollDistance, SPEEDS } from '../../src/scroll.js';

const WHITE: [number, number, number] = [255, 255, 255];
const opts = (o: Partial<CoverageOptions> = {}): CoverageOptions => ({
  direction: 'vertical',
  blank: [WHITE],
  tolerance: 24,
  minContentShare: 0.01,
  ...o,
});

/** A width × height RGBA image, white, with the given pixels painted. */
function image(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number] | null,
) {
  const d = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = paint(x, y) ?? WHITE;
      d.set([...c, 255], 4 * (y * width + x));
    }
  }
  return d;
}

test('a drawn row of the test list: content on 70 of 80 lines', () => {
  // A 56px poster, 70px tall, at the left of an 80px row.
  const img = image(200, 80, (x, y) => (x < 56 && y >= 5 && y < 75 ? [200, 30, 30] : null));
  expect(lineCoverage(img, 200, 80, opts())).toBeCloseTo(70 / 80);
});

test('lines that count as blank', () => {
  expect(
    lineCoverage(
      image(100, 10, () => null),
      100,
      10,
      opts(),
    ),
  ).toBe(0);
  expect(
    lineCoverage(
      image(100, 10, () => [240, 250, 245]),
      100,
      10,
      opts(),
    ),
  ).toBe(0); // JPEG noise, within tolerance
  // One non-blank pixel per line is under the 2-pixel minimum.
  expect(
    lineCoverage(
      image(100, 10, (x) => (x === 0 ? [0, 0, 0] : null)),
      100,
      10,
      opts(),
    ),
  ).toBe(0);
  expect(
    lineCoverage(
      image(100, 10, (x) => (x < 2 ? [0, 0, 0] : null)),
      100,
      10,
      opts(),
    ),
  ).toBe(1);
});

test('placeholder colors count as blank', () => {
  const skeleton = image(100, 10, () => [221, 221, 221]);
  expect(lineCoverage(skeleton, 100, 10, opts())).toBe(1);
  expect(lineCoverage(skeleton, 100, 10, opts({ blank: [WHITE, [221, 221, 221]] }))).toBe(0);
});

test('horizontal scrolling measures columns', () => {
  // Content in the left 30 of 100 columns, on every row.
  const img = image(100, 20, (x) => (x < 30 ? [0, 0, 0] : null));
  expect(lineCoverage(img, 100, 20, opts({ direction: 'horizontal' }))).toBeCloseTo(0.3);
  expect(lineCoverage(img, 100, 20, opts({ direction: 'vertical' }))).toBe(1);
});

test('summarizeList: frames against the at-rest reference', () => {
  const reference = 0.875;
  const s = summarizeList([0.875, 0.8, reference * BLANK_FRAME_SHARE - 0.01, 0, 0.9], reference);
  expect(s).toEqual({ frames: 5, blankFrames: 2, blankFramePercent: 40, leastDrawnPercent: 0 });
  expect(summarizeList([0.9, 0.95], reference).leastDrawnPercent).toBe(100); // capped at the reference
});

test('scroll options', () => {
  expect(resolveScroll({})).toEqual({
    distance: 'end',
    direction: 'vertical',
    input: 'wheel',
    speedPxPerSec: SPEEDS.normal,
  });
  expect(resolveScroll({ speed: 'fast' }).speedPxPerSec).toBe(6000);
  expect(resolveScroll({ speed: 1234 }).speedPxPerSec).toBe(1234);
  expect(() => resolveScroll({ speed: 0 })).toThrow(/speed/);
  expect(() => resolveScroll({ distance: -5 })).toThrow(/distance/);
});

test('default scroll labels', () => {
  const target = { toString: () => "getByRole('list', { name: 'Trending' })" } as never;
  expect(defaultScrollLabel(target, resolveScroll({}))).toBe(
    "scroll getByRole('list', { name: 'Trending' })",
  );
  expect(
    defaultScrollLabel(
      target,
      resolveScroll({ input: 'touch', speed: 'fast', direction: 'horizontal', distance: 5000 }),
    ),
  ).toBe("scroll getByRole('list', { name: 'Trending' }) horizontal touch 6000px/s 5000px");
  expect(defaultScrollLabel(target, resolveScroll({ input: 'keys', speed: 'fast' }))).toBe(
    "scroll getByRole('list', { name: 'Trending' }) keys",
  );
});

test("scrollDistance: the 'end' cap", () => {
  expect(scrollDistance({ distance: 'end' }, 16_000)).toEqual({ px: 16_000 });
  expect(scrollDistance({ distance: 'end' }, END_CAP_PX)).toEqual({ px: END_CAP_PX });
  expect(scrollDistance({ distance: 'end' }, 399_400)).toEqual({ px: END_CAP_PX, toEnd: 399_400 });
  expect(scrollDistance({ distance: 100_000 }, 399_400)).toEqual({ px: 100_000 });
});
