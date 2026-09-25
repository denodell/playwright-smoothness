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

test('recorded trace, 12ms blocking: the CPU profile names the scroll handler', () => {
  const t = load('scroll-12ms');
  const out = parseTrace(t.traceEvents, {
    browserVersion: t.browserVersion,
    budget120: false,
    profile: true,
  });
  expect(out.unavailable).toEqual([]);
  const p = out.profile!;
  expect(p.samples.length).toBeGreaterThan(100);
  const fns = new Set(p.samples.map((s) => p.nodes.get(s.node)?.fn));
  expect(fns).toContain('busyWait');
  expect([...p.nodes.values()].map((n) => n.fn)).toContain('onWindowScroll');
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

// ---- CPU profile ----

const MAIN = { pid: 10, tid: 1 };
const startMark = (ts: number, pageMs: number): TraceEvent => ({
  ...mark(MARK_START, ts),
  ...MAIN,
  args: { data: { startTime: pageMs } },
});
const node = (id: number, fn: string, parent?: number, url = 'http://x/app.js') => ({
  id,
  ...(parent ? { parent } : {}),
  callFrame: { functionName: fn, url, lineNumber: id * 10 - 1, columnNumber: 4 },
});
const profileHead = (id: string, where: { pid: number; tid: number }, startUs: number): TraceEvent => ({
  name: 'Profile',
  ph: 'P',
  ts: startUs,
  id,
  ...where,
  args: { data: { startTime: startUs } },
});
const chunk = (
  id: string,
  pid: number,
  nodes: object[],
  samples: number[],
  deltas: number[],
): TraceEvent => ({
  name: 'ProfileChunk',
  ph: 'P',
  ts: 0,
  id,
  pid,
  tid: 99, // chunks come from the sampler thread, not the sampled one
  args: { data: { cpuProfile: { nodes, samples }, timeDeltas: deltas } },
});

test('profile: the main thread is chosen by the start mark, and times convert to page ms', () => {
  // Trace clock 1,000,000µs is page time 500ms, so page ms = (µs − 500,000) / 1000.
  const out = parseTrace(
    [
      startMark(1_000_000, 500),
      profileHead('0x1', { pid: 10, tid: 2 }, 900_000), // a worker in the same process
      profileHead('0x2', MAIN, 900_000),
      chunk('0x1', 10, [node(1, '(root)'), node(2, 'workerSpin', 1)], [2], [150_000]),
      chunk(
        '0x2',
        10,
        [node(1, '(root)'), node(2, 'onClick', 1), node(3, 'busyWait', 2)],
        [3, 3, 2],
        [110_000, 1_000, 1_000],
      ),
      { ...mark(MARK_END, 1_200_000), ...MAIN },
    ],
    { ...opts, profile: true },
  );
  expect(out.unavailable.filter((u) => u.measurement === 'profile')).toEqual([]);
  const p = out.profile!;
  expect([...p.nodes.values()].map((n) => n.fn)).toEqual(['(root)', 'onClick', 'busyWait']);
  expect(p.nodes.get(3)).toMatchObject({ fn: 'busyWait', line: 30, column: 5, parent: 2 });
  // First sample at 900,000 + 110,000 = 1,010,000µs → page 510ms; it stands for the 1ms to the next.
  expect(p.samples.map((s) => [s.t, s.ms, s.node])).toEqual([
    [510, 1, 3],
    [511, 1, 3],
    [512, 1, 2], // the last sample gets the typical interval
  ]);
});

test('profile: missing, misaligned or malformed profiles are unavailable', () => {
  const base = [startMark(1_000, 1), { ...mark(MARK_END, 2_000), ...MAIN }];
  const none = parseTrace(base, { ...opts, profile: true });
  expect(none.unavailable).toContainEqual({
    measurement: 'profile',
    reason: expect.stringMatching(/no CPU profile for the page's main thread.*Chrome 153/),
  });
  const onlyWorker = parseTrace([...base, profileHead('0x1', { pid: 10, tid: 2 }, 0)], {
    ...opts,
    profile: true,
  });
  expect(onlyWorker.profile).toBeNull();
  const mismatched = parseTrace(
    [...base, profileHead('0x2', MAIN, 0), chunk('0x2', 10, [node(1, '(root)')], [1, 1], [5])],
    { ...opts, profile: true },
  );
  expect(mismatched.unavailable.find((u) => u.measurement === 'profile')!.reason).toMatch(
    /different numbers of samples/,
  );
  const empty = parseTrace([...base, profileHead('0x2', MAIN, 0)], { ...opts, profile: true });
  expect(empty.unavailable.find((u) => u.measurement === 'profile')!.reason).toMatch(/no samples/);
});

test('frames from other processes are not counted: the browser silently, other renderers with a note', () => {
  const inProcess = (pid: number, ts: number, state: string, seq: number): TraceEvent => ({
    ...reporter(ts, state, seq),
    pid,
  });
  const out = parseTrace(
    [
      { name: 'process_name', ph: 'M', ts: 0, pid: 1, args: { name: 'Browser' } },
      { name: 'process_name', ph: 'M', ts: 0, pid: 10, args: { name: 'Renderer' } },
      { name: 'process_name', ph: 'M', ts: 0, pid: 20, args: { name: 'Renderer' } },
      startMark(100, 1),
      inProcess(10, 110, 'STATE_PRESENTED_ALL', 1),
      inProcess(10, 120, 'STATE_DROPPED', 2),
      inProcess(1, 130, 'STATE_PRESENTED_ALL', 1), // the browser's own compositor, after a reload
      inProcess(20, 140, 'STATE_DROPPED', 1), // an out-of-process iframe
      { ...mark(MARK_END, 200), ...MAIN },
    ],
    opts,
  );
  expect(out.frames).toEqual({ total: 2, onTime: 1, dropped: 1, onTimePercent: 50 });
  expect(out.notes).toEqual([
    expect.stringContaining("1 other renderer process(es), such as out-of-process iframes, weren't counted"),
  ]);
});
