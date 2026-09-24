// The trace parser, without a browser: recorded Chrome traces plus synthetic broken ones.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { MARK_END, MARK_START, parseTrace, type TraceEvent } from '../../src/trace/parse.js';

const load = (name: string) =>
  JSON.parse(readFileSync(`tests/fixtures/traces/${name}.json`, 'utf8')) as {
    browserVersion: string;
    traceEvents: TraceEvent[];
  };

const mark = (name: string, ts: number): TraceEvent => ({ name, ph: 'I', ts, cat: 'blink.user_timing' });
const reporter = (ts: number, state: string | undefined, seq: number, host = 2): TraceEvent => ({
  name: 'PipelineReporter',
  ph: 'b',
  ts,
  args: {
    frame_reporter: {
      ...(state ? { state } : {}),
      frame_sequence: seq,
      frame_source: 1,
      layer_tree_host_id: host,
    },
  },
});
const opts = { browserVersion: '153.0.8010.12', budget120: false };

test('recorded trace, 12ms blocking: frames and a 120Hz prediction', () => {
  const t = load('scroll-12ms');
  const out = parseTrace(t.traceEvents, { browserVersion: t.browserVersion, budget120: true });
  expect(out.unavailable).toEqual([]);
  expect(out.frames!.total).toBeGreaterThan(0);
  expect(out.frames!.onTime).toBeGreaterThan(0);
  expect(out.budget120!.frames).toBeGreaterThan(0);
  expect(out.budget120!.framesOverBudget).toBeGreaterThanOrEqual(8); // 12ms > 8.33ms, ten scrolls
});

test('recorded trace, 25ms blocking: dropped frames', () => {
  const t = load('scroll-25ms');
  const out = parseTrace(t.traceEvents, { browserVersion: t.browserVersion, budget120: false });
  expect(out.frames!.dropped).toBeGreaterThan(0);
  expect(out.frames!.onTimePercent).toBeLessThan(100);
  expect(out.budget120).toBeNull();
});

test('counts presented and dropped inside the marks only, and computes on-time percent', () => {
  const out = parseTrace(
    [
      reporter(50, 'STATE_DROPPED', 5, 1), // before the start mark: Playwright's about:blank host
      mark(MARK_START, 100),
      reporter(110, 'STATE_PRESENTED_ALL', 10),
      reporter(120, 'STATE_PRESENTED_PARTIAL', 11),
      reporter(130, 'STATE_DROPPED', 12),
      reporter(140, 'STATE_NO_UPDATE_DESIRED', 13),
      mark(MARK_END, 200),
      reporter(210, 'STATE_DROPPED', 14),
    ],
    opts,
  );
  expect(out.frames).toEqual({ total: 3, onTime: 2, dropped: 1, onTimePercent: 66.7 });
  expect(out.notes).toEqual([]);
});

test('exact repeats are dropped; presented and dropped for the same frame both count', () => {
  const out = parseTrace(
    [
      mark(MARK_START, 0),
      reporter(10, 'STATE_NO_UPDATE_DESIRED', 1),
      reporter(10, 'STATE_NO_UPDATE_DESIRED', 1),
      reporter(20, 'STATE_PRESENTED_ALL', 2),
      reporter(20, 'STATE_PRESENTED_ALL', 2),
      reporter(30, 'STATE_PRESENTED_ALL', 3),
      reporter(30, 'STATE_DROPPED', 3),
      mark(MARK_END, 100),
    ],
    opts,
  );
  expect(out.frames).toEqual({ total: 3, onTime: 2, dropped: 1, onTimePercent: 66.7 });
});

test('no frame needed an update: on-time percent is null, not 100 or 0', () => {
  const out = parseTrace(
    [mark(MARK_START, 0), reporter(10, 'STATE_NO_UPDATE_DESIRED', 1), mark(MARK_END, 100)],
    opts,
  );
  expect(out.frames).toEqual({ total: 0, onTime: 0, dropped: 0, onTimePercent: null });
});

test('missing marks: unavailable, with the Chrome version', () => {
  const out = parseTrace([reporter(10, 'STATE_PRESENTED_ALL', 1)], { ...opts, budget120: true });
  expect(out.frames).toBeNull();
  expect(out.unavailable).toEqual([
    {
      measurement: 'frames',
      reason: expect.stringMatching(/no playwright-smoothness:start .* marks.*Chrome 153/),
    },
    { measurement: 'budget120', reason: 'the trace could not be windowed' },
  ]);
});

test('no PipelineReporter events: unavailable, never zero', () => {
  const out = parseTrace([mark(MARK_START, 0), mark(MARK_END, 100)], opts);
  expect(out.frames).toBeNull();
  expect(out.unavailable).toEqual([
    { measurement: 'frames', reason: 'the trace has no PipelineReporter events (Chrome 153.0.8010.12)' },
  ]);
});

test('PipelineReporter without a state field (a format change): unavailable', () => {
  const out = parseTrace([mark(MARK_START, 0), reporter(10, undefined, 1), mark(MARK_END, 100)], opts);
  expect(out.frames).toBeNull();
  expect(out.unavailable[0]!.reason).toMatch(/no args\.frame_reporter\.state/);
});

test('unknown states are excluded and noted; several compositors are noted', () => {
  const out = parseTrace(
    [
      mark(MARK_START, 0),
      reporter(10, 'STATE_PRESENTED_ALL', 1, 2),
      reporter(20, 'STATE_SOMETHING_NEW', 2, 2),
      reporter(30, 'STATE_PRESENTED_ALL', 1, 7),
      mark(MARK_END, 100),
    ],
    opts,
  );
  expect(out.frames).toEqual({ total: 2, onTime: 2, dropped: 0, onTimePercent: 100 });
  expect(out.notes).toEqual([
    expect.stringContaining('STATE_SOMETHING_NEW ×1'),
    expect.stringContaining('2 compositors'),
  ]);
});

test('120Hz: missing or unpairable AnimationFrame events are unavailable', () => {
  const none = parseTrace(
    [mark(MARK_START, 0), reporter(10, 'STATE_PRESENTED_ALL', 1), mark(MARK_END, 100)],
    {
      ...opts,
      budget120: true,
    },
  );
  expect(none.budget120).toBeNull();
  expect(none.unavailable).toEqual([
    { measurement: 'budget120', reason: expect.stringMatching(/no AnimationFrame events/) },
  ]);

  const unpaired = parseTrace(
    [mark(MARK_START, 0), { name: 'AnimationFrame', ph: 'b', ts: 10, id: 'a' }, mark(MARK_END, 100)],
    { ...opts, budget120: true },
  );
  expect(unpaired.unavailable.find((u) => u.measurement === 'budget120')!.reason).toMatch(
    /couldn't be paired/,
  );

  const ok = parseTrace(
    [
      mark(MARK_START, 0),
      { name: 'AnimationFrame', ph: 'b', ts: 10_000, id: 'a' },
      { name: 'AnimationFrame', ph: 'e', ts: 22_000, id: 'a' }, // 12ms
      { name: 'AnimationFrame', ph: 'b', ts: 30_000, id2: { local: 'b' } },
      { name: 'AnimationFrame', ph: 'e', ts: 35_000, id2: { local: 'b' } }, // 5ms
      mark(MARK_END, 100_000),
    ],
    { ...opts, budget120: true },
  );
  expect(ok.budget120).toEqual({ framesOverBudget: 1, frames: 2, predicted: true });
});
