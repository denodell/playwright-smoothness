import { test, expect } from '@playwright/test';
import { attributeProfile, combineProfiles } from '../../src/analysis/profile.js';
import type { CpuProfile, ProfileNode } from '../../src/trace/parse.js';

const n = (fn: string, parent?: number): ProfileNode => ({
  fn,
  url: 'http://x/app.js',
  line: 1,
  column: 1,
  ...(parent ? { parent } : {}),
});

// (root) → dispatch → onCheckout → busyWait; plus (idle) and a timer outside the window.
const profile: CpuProfile = {
  nodes: new Map([
    [1, n('(root)')],
    [2, n('dispatch', 1)],
    [3, n('onCheckout', 2)],
    [4, n('busyWait', 3)],
    [5, n('(idle)', 1)],
    [6, n('timer', 1)],
  ]),
  samples: [
    { t: 100, ms: 10, node: 4 },
    { t: 110, ms: 10, node: 4 },
    { t: 120, ms: 5, node: 3 },
    { t: 125, ms: 20, node: 5 }, // idle: not work
    { t: 500, ms: 50, node: 6 }, // outside the interaction
  ],
};

test('self and total time within the windows', () => {
  const run = attributeProfile(profile, [[90, 200]]);
  expect(run.sampledMs).toBe(25);
  const byFn = Object.fromEntries([...run.functions.values()].map((f) => [f.fn, [f.selfMs, f.totalMs]]));
  expect(byFn).toEqual({ busyWait: [20, 20], onCheckout: [5, 25], dispatch: [0, 25] });
});

test('combining runs', () => {
  const a = attributeProfile(profile, [[90, 200]]);
  const b = attributeProfile(profile, [[90, 115]]); // only the two busyWait samples
  const result = combineProfiles([a, b]);
  expect(result.sampledMs).toBe(22.5);
  expect(result.hotFunctions).toEqual([
    {
      fn: 'busyWait',
      url: 'http://x/app.js',
      line: 1,
      column: 1,
      selfMs: 20,
      totalMs: 20,
      callers: ['onCheckout', 'dispatch'],
    },
    {
      fn: 'onCheckout',
      url: 'http://x/app.js',
      line: 1,
      column: 1,
      selfMs: 2.5,
      totalMs: 22.5,
      callers: ['dispatch'],
    },
  ]);
});

test('recursion counts once per sample in total time', () => {
  const rec: CpuProfile = {
    nodes: new Map([
      [1, n('(root)')],
      [2, n('walk', 1)],
      [3, n('walk', 2)],
    ]),
    samples: [{ t: 1, ms: 4, node: 3 }],
  };
  const f = [...attributeProfile(rec, [[0, 10]]).functions.values()][0]!;
  expect([f.selfMs, f.totalMs]).toEqual([4, 4]);
});
