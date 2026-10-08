import { test, expect } from '@playwright/test';
import { findHitches } from '../../packages/butter-core/src/replay/encode.js';

const F = 1000 / 60;
const at = (frame: number, dropped = false) => ({ tMs: frame * F, dropped });

test('no dropped frames, no hitches', () => {
  expect(findHitches([at(0), at(1), at(2)])).toEqual([]);
});

test('a run of dropped frames holds the last picture until the next one', () => {
  expect(findHitches([at(0), at(1), at(2, true), at(3, true), at(4), at(5)])).toEqual([
    { startMs: 1 * F, endMs: 4 * F },
  ]);
});

test('separate runs are separate hitches', () => {
  expect(findHitches([at(0), at(1, true), at(2), at(3), at(4, true), at(5)])).toEqual([
    { startMs: 0, endMs: 2 * F },
    { startMs: 3 * F, endMs: 5 * F },
  ]);
});

test('after an idle spell, a freeze starts one frame before its first dropped frame', () => {
  const [h] = findHitches([at(0), at(60, true), at(61, true), at(62)]);
  expect(h!.startMs).toBeCloseTo(59 * F);
  expect(h!.endMs).toBe(62 * F);
});

test('a freeze at the end runs one frame past its last dropped frame', () => {
  expect(findHitches([at(0), at(1, true), at(2, true)])).toEqual([{ startMs: 0, endMs: 3 * F }]);
});

test('frames out of order are sorted first', () => {
  expect(findHitches([at(2), at(1, true), at(0)])).toEqual([{ startMs: 0, endMs: 2 * F }]);
});
