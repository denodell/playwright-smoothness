import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { CollectorSnapshot, EventRecord, LoafRecord } from '../../src/collector/collector.js';
import { elementFromInvoker, groupInteractions } from '../../src/analysis/interactions.js';
import { classifyFrame, classifyFrames, LOAD_GRACE_MS } from '../../src/analysis/classify.js';
import {
  attributeFrames,
  combineInput,
  combineLongFrames,
  scriptBlocking,
  summarizeInput,
  summarizeLongFrames,
} from '../../src/analysis/aggregate.js';
import { median, percentile, spread } from '../../src/analysis/stats.js';

const ev = (p: Partial<EventRecord>): EventRecord => ({
  name: 'click',
  interactionId: 1,
  start: 100,
  processingStart: 101,
  processingEnd: 150,
  duration: 56,
  target: 'button#a',
  rawTarget: 'button#a',
  ...p,
});
const frame = (p: Partial<LoafRecord>): LoafRecord => ({
  start: 0,
  duration: 60,
  blockingDuration: 10,
  firstUIEventTimestamp: 0,
  scripts: [],
  ...p,
});
const script = (p: Partial<LoafRecord['scripts'][number]>) => ({
  invoker: 'BUTTON#a.onclick',
  invokerType: 'event-listener',
  sourceURL: 'http://x/app.js',
  sourceFunctionName: 'onA',
  sourceCharPosition: 10,
  duration: 50,
  ...p,
});

test('stats', () => {
  expect(median([5, 1, 3])).toBe(3);
  expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  expect(
    percentile(
      Array.from({ length: 100 }, (_, i) => i + 1),
      95,
    ),
  ).toBe(95);
  expect(percentile([7], 95)).toBe(7);
  expect(spread([3, 1, 2])).toEqual({ min: 1, median: 2, max: 3 });
});

test('elementFromInvoker', () => {
  expect(elementFromInvoker('BUTTON#vanish.onclick')).toBe('button#vanish');
  expect(elementFromInvoker('DIV#feed.onscroll')).toBe('div#feed');
  expect(elementFromInvoker('INPUT.search.box.onkeydown')).toBe('input.search.box');
  expect(elementFromInvoker('DOMWindow.onscroll')).toBeNull();
  expect(elementFromInvoker('TimerHandler:setTimeout')).toBeNull();
  expect(elementFromInvoker('https://x/app.js')).toBeNull();
});

test('interactions: grouped by id, longest duration, named after what the user did', () => {
  const out = groupInteractions(
    [
      ev({ name: 'pointerdown', duration: 64 }),
      ev({ name: 'pointerup', duration: 64 }),
      ev({ name: 'click', duration: 56 }),
      ev({ name: 'keydown', interactionId: 2, start: 500, duration: 72, target: 'input#q' }),
      ev({ name: 'pointerover', interactionId: 0 }),
    ],
    [],
  );
  expect(out).toEqual([
    { id: 1, event: 'click', start: 100, duration: 64, target: 'button#a', targetSource: 'event-timing' },
    { id: 2, event: 'keydown', start: 500, duration: 72, target: 'input#q', targetSource: 'event-timing' },
  ]);
});

test('interactions: a removed target is named from another entry, then from the LoAF invoker', () => {
  const fromPointerdown = groupInteractions(
    [ev({ name: 'pointerdown', target: 'button#v' }), ev({ name: 'click', target: null })],
    [],
  );
  expect(fromPointerdown[0]!.target).toBe('button#v');

  const fromLoaf = groupInteractions(
    [ev({ target: null })],
    [frame({ start: 90, scripts: [script({ invoker: 'BUTTON#vanish.onclick' })] })],
  );
  expect(fromLoaf[0]).toMatchObject({ target: 'button#vanish', targetSource: 'loaf-invoker' });

  const unknown = groupInteractions([ev({ target: null })], []);
  expect(unknown[0]).toMatchObject({ target: 'unknown', targetSource: 'unknown' });
});

test('classify: each rule', () => {
  const base = { interactions: [], scrolls: [], loadEventEnd: 1000 };
  expect(classifyFrame(frame({ start: 2000, firstUIEventTimestamp: 1990 }), base)).toBe('interaction');
  expect(
    classifyFrame(frame({ start: 2000 }), {
      ...base,
      interactions: [
        { id: 1, event: 'click', start: 1990, duration: 80, target: 'x', targetSource: 'event-timing' },
      ],
    }),
  ).toBe('interaction');
  expect(classifyFrame(frame({ start: 2000 }), { ...base, scrolls: [{ t: 1997, target: 'document' }] })).toBe(
    'interaction',
  );
  expect(classifyFrame(frame({ start: 1000 + LOAD_GRACE_MS - 1 }), base)).toBe('load');
  expect(classifyFrame(frame({ start: 500 }), { ...base, loadEventEnd: 0 })).toBe('load');
  expect(classifyFrame(frame({ start: 2000, scripts: [script({})] }), base)).toBe('interaction');
  expect(
    classifyFrame(
      frame({
        start: 2000,
        scripts: [script({ invoker: 'TimerHandler:setTimeout', invokerType: 'user-callback' })],
      }),
      base,
    ),
  ).toBe('background');
});

test('classify: a recorded run of the mixed test page', () => {
  const snap = JSON.parse(
    readFileSync('tests/fixtures/classification/mixed-run.json', 'utf8'),
  ) as CollectorSnapshot;
  const interactions = groupInteractions(snap.events, snap.loaf);
  const classes = classifyFrames({
    loaf: snap.loaf,
    interactions,
    scrolls: snap.scrolls,
    loadEventEnd: snap.loadEventEnd,
  });
  const byFn = snap.loaf.map((f, i) => [f.scripts.map((s) => s.sourceFunctionName).join('+'), classes[i]]);
  for (const [fns, cls] of byFn) {
    if (/onBuy|onSearchKey|onVanish|onFeedScroll/.test(fns!)) expect(cls, fns).toBe('interaction');
    else if (/backgroundJob/.test(fns!)) expect(cls, fns).toBe('background');
  }
  expect(classes.filter((c) => c === 'load').length).toBeGreaterThanOrEqual(1);
  expect(classes.filter((c) => c === 'background').length).toBe(1);
  expect(interactions.map((i) => i.target)).toEqual(
    expect.arrayContaining(['button#buy', 'input#search', 'button#vanish']),
  );
});

test('summarizeInput: nulls when there were no interactions, never zero', () => {
  expect(summarizeInput([])).toEqual({ interactions: 0, p95ToPaintMs: null, worstMs: null, byTarget: [] });
});

test('scriptBlocking: splits a frame’s blocking time by script duration', () => {
  const m = scriptBlocking([
    frame({
      blockingDuration: 90,
      scripts: [script({ duration: 60 }), script({ sourceFunctionName: 'b', duration: 30 })],
    }),
  ]);
  expect([...m.values()].map((s) => [s.fn, s.blockingMs])).toEqual([
    ['onA', 60],
    ['b', 30],
  ]);
});

test('summarizeLongFrames and combining runs', () => {
  const run1 = [frame({ duration: 100, blockingDuration: 50, scripts: [script({})] })];
  const run2 = [
    frame({ duration: 120, blockingDuration: 70, scripts: [script({})] }),
    frame({ duration: 60, blockingDuration: 10 }),
  ];
  const s1 = summarizeLongFrames(run1);
  const s2 = summarizeLongFrames(run2);
  expect(s1).toMatchObject({ count: 1, totalBlockingMs: 50, worstMs: 100 });
  expect(summarizeLongFrames([])).toEqual({ count: 0, totalBlockingMs: 0, worstMs: null, topScripts: [] });
  const combined = combineLongFrames([s1, s2, summarizeLongFrames([])], [run1, run2, []]);
  expect(combined.count).toBe(1);
  expect(combined.worstMs).toBe(110); // median of 100 and 120; the empty run has no worst frame
  expect(combined.topScripts[0]).toMatchObject({ fn: 'onA', blockingMs: 40 }); // (50 + 70) / 3 runs

  const i1 = summarizeInput([
    { id: 1, event: 'click', start: 0, duration: 40, target: 'a', targetSource: 'event-timing' },
  ]);
  const i2 = summarizeInput([
    { id: 1, event: 'click', start: 0, duration: 56, target: 'a', targetSource: 'event-timing' },
  ]);
  expect(combineInput([i1, i2, summarizeInput([])])).toEqual({
    interactions: 1,
    p95ToPaintMs: 48,
    worstMs: 48,
    byTarget: [{ target: 'a', event: 'click', ms: 48 }],
  });
});

test('attributeFrames links frames to the interactions and scrolls they served', () => {
  const frames = attributeFrames(
    [frame({ start: 100, duration: 80 }), frame({ start: 1000, duration: 60 }), frame({ start: 5000 })],
    [
      {
        id: 1,
        event: 'click',
        start: 90,
        duration: 120,
        target: 'button#checkout',
        targetSource: 'event-timing',
      },
    ],
    [{ t: 1010, target: 'div#feed' }],
  );
  expect(frames.map((f) => f.during)).toEqual([['click on button#checkout'], ['scroll on div#feed'], []]);
  const top = summarizeLongFrames([
    { ...frames[0]!, scripts: [script({ invoker: 'DIV#root.onclick', sourceFunctionName: 'QS' })] },
  ]).topScripts[0]!;
  expect(top).toMatchObject({ invoker: 'DIV#root.onclick', fn: 'QS', during: ['click on button#checkout'] });
});

test('classify: a background frame the input arrived during is not the interaction’s', () => {
  const click = {
    id: 1,
    event: 'click',
    start: 1030,
    duration: 120,
    target: 'button#buy',
    targetSource: 'event-timing' as const,
  };
  const base = { interactions: [click], scrolls: [], loadEventEnd: 100 };
  // A 70ms timer frame from 1000 to 1070: the click arrives at 1030, during it.
  expect(classifyFrame(frame({ start: 1000, duration: 70 }), base)).toBe('background');
  // The frame that handles the click starts after the input.
  expect(classifyFrame(frame({ start: 1071, duration: 80 }), base)).toBe('interaction');
  // Rounding: a frame starting 1ms "before" the input still counts.
  expect(classifyFrame(frame({ start: 1029, duration: 80 }), base)).toBe('interaction');
});

test('classify: firstUIEventTimestamp only marks input handling when the input was waiting at the frame’s start', () => {
  const base = { interactions: [], scrolls: [], loadEventEnd: 100 };
  // A frame that handles a queued click: the input was there when the frame started.
  expect(classifyFrame(frame({ start: 2000, firstUIEventTimestamp: 2000 }), base)).toBe('interaction');
  // A 70ms timer frame during which a click arrived: LoAF sets firstUIEventTimestamp too.
  const timer = frame({
    start: 2000,
    duration: 70,
    firstUIEventTimestamp: 2030,
    scripts: [
      script({
        invoker: 'TimerHandler:setInterval',
        invokerType: 'user-callback',
        sourceFunctionName: 'repeatingBackgroundJob',
      }),
    ],
  });
  expect(classifyFrame(timer, base)).toBe('background');
});
