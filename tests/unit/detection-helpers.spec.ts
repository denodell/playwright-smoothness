// The detection suite's numbers depend on these helpers, so they get unit tests.
import { test, expect } from '@playwright/test';
import {
  median,
  pipelineStates,
  inputWindow,
  animationFrameDurations,
  INPUT_TAIL_MS,
  type TraceEvent,
} from '../detection/helpers.js';

const reporter = (ts: number, state?: string): TraceEvent => ({
  name: 'PipelineReporter',
  ph: 'b',
  ts,
  args: state ? { frame_reporter: { state } } : {},
});
const latency = (ts: number, type: string): TraceEvent => ({
  name: 'EventLatency',
  ph: 'b',
  ts,
  args: { event_latency: { event_type: type } },
});

test('median of odd, even and empty lists', () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 2, 3])).toBe(2.5);
  expect(median([])).toBeNaN();
});

test('pipelineStates counts begin events only and flags a missing state', () => {
  const events = [
    reporter(1, 'STATE_DROPPED'),
    reporter(2, 'STATE_PRESENTED_ALL'),
    { ...reporter(3, 'STATE_DROPPED'), ph: 'e' },
    reporter(4),
  ];
  expect(pipelineStates(events)).toEqual({ STATE_DROPPED: 1, STATE_PRESENTED_ALL: 1, MISSING_STATE: 1 });
});

test('pipelineStates respects the window', () => {
  const events = [
    reporter(100, 'STATE_DROPPED'),
    reporter(200, 'STATE_DROPPED'),
    reporter(300, 'STATE_DROPPED'),
  ];
  expect(pipelineStates(events, [150, 250])).toEqual({ STATE_DROPPED: 1 });
});

test('inputWindow spans inputs, ignores mouse moves, and adds the tail', () => {
  const events = [latency(10, 'MOUSE_MOVED_EVENT'), latency(100, 'MOUSE_WHEEL'), latency(500, 'MOUSE_WHEEL')];
  expect(inputWindow(events)).toEqual([100, 500 + INPUT_TAIL_MS * 1000]);
  expect(inputWindow([latency(10, 'MOUSE_MOVED_EVENT')])).toBeNull();
});

test('animationFrameDurations pairs async begin/end by id and reads complete events', () => {
  const events: TraceEvent[] = [
    { name: 'AnimationFrame', ph: 'b', ts: 1000, id: 'a' },
    { name: 'AnimationFrame', ph: 'b', ts: 2000, id2: { local: 'b' } },
    { name: 'AnimationFrame', ph: 'e', ts: 21000, id: 'a' },
    { name: 'AnimationFrame', ph: 'e', ts: 10000, id2: { local: 'b' } },
    { name: 'AnimationFrame', ph: 'X', ts: 0, dur: 5000 },
    { name: 'AnimationFrame', ph: 'e', ts: 99000, id: 'unmatched' },
  ];
  expect(animationFrameDurations(events).sort((x, y) => x - y)).toEqual([5, 8, 20]);
});
