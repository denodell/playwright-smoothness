// Section 3, "Measured behavior" table: a scroll handler blocks the main thread N ms per
// scroll, 10 scrolls, no CPU throttling (the spike measured this table unthrottled).
//
// Differences from the spike, all from evidence recorded in docs/measurements.md:
// - One warm-up wheel before measuring: the first wheel on a page costs a 46-58ms frame.
// - Trace drops are counted inside the input window only: tracing start adds a dropped frame.
// - The trace column is the median of TRACE_RUNS runs: with only ~12-14 presented frames per
//   run, one or two stray drops swing a single run.
import { test, expect } from '@playwright/test';
import {
  installObservers,
  collected,
  clearCollected,
  save,
  traced,
  pipelineStates,
  inputWindow,
  median,
  tenWheelScrolls,
  warmUpWheel,
  LATE_GAP_MS,
  PAGE_SETTLE_MS,
  ENTRY_DELIVERY_MS,
} from './helpers.js';

const BLOCKING_MS = [0, 12, 25, 40, 70] as const;
const TRACE_RUNS = 5;

interface Row {
  wait: number;
  traceDroppedMedian: number;
  traceDroppedRuns: number[];
  tracePresentedMedian: number;
  traceKB: number;
  loaf: number;
  rafTimestampLate: number;
  rafNowLate: number;
}
const rows: Row[] = [];

for (const wait of BLOCKING_MS) {
  test(`scroll handler blocks ${wait}ms`, async ({ page, browser }) => {
    test.setTimeout(120_000);
    await page.addInitScript(installObservers);

    // Trace column.
    const dropped: number[] = [];
    const presented: number[] = [];
    let traceKB = 0;
    for (let run = 0; run < TRACE_RUNS; run++) {
      await page.goto(`/scroll.html?wait=${wait}`);
      await page.waitForTimeout(PAGE_SETTLE_MS);
      await warmUpWheel(page);
      const trace = await traced(browser, page, async () => {
        await tenWheelScrolls(page);
        await page.waitForTimeout(200);
      });
      const window = inputWindow(trace.events);
      expect(window, 'trace has EventLatency events for the inputs').not.toBeNull();
      const states = pipelineStates(trace.events, window);
      expect(states.MISSING_STATE ?? 0, 'PipelineReporter events have a state').toBe(0);
      dropped.push(states.STATE_DROPPED ?? 0);
      presented.push((states.STATE_PRESENTED_ALL ?? 0) + (states.STATE_PRESENTED_PARTIAL ?? 0));
      traceKB = Math.round(trace.bytes / 1024);
    }

    // rAF columns, with LoAF collected alongside.
    const raf = { timestamp: { late: 0, loaf: 0 }, now: { late: 0, loaf: 0 } };
    for (const mode of ['timestamp', 'now'] as const) {
      await page.goto(`/scroll.html?wait=${wait}`);
      await page.waitForTimeout(PAGE_SETTLE_MS);
      await warmUpWheel(page);
      await clearCollected(page);
      await page.evaluate(
        (m) => (window as unknown as { startFrameSampler(m: string): void }).startFrameSampler(m),
        mode,
      );
      await tenWheelScrolls(page);
      await page.waitForTimeout(200);
      const gaps = await page.evaluate(() =>
        (window as unknown as { stopFrameSampler(): number[] }).stopFrameSampler(),
      );
      await page.waitForTimeout(ENTRY_DELIVERY_MS);
      const { loaf } = await collected(page);
      raf[mode] = { late: gaps.filter((g) => g > LATE_GAP_MS).length, loaf: loaf.length };
    }

    const row: Row = {
      wait,
      traceDroppedMedian: median(dropped),
      traceDroppedRuns: dropped,
      tracePresentedMedian: median(presented),
      traceKB,
      loaf: Math.max(raf.timestamp.loaf, raf.now.loaf),
      rafTimestampLate: raf.timestamp.late,
      rafNowLate: raf.now.late,
    };
    rows.push(row);
    save(`scroll-table-${wait}ms`, row);

    expect(row.tracePresentedMedian, 'trace has presented frames').toBeGreaterThan(0);

    // Tolerances. Written before the first CI run; see docs/measurements.md for why they
    // are looser than the spike's single-run numbers.
    if (wait <= 12) {
      expect(row.traceDroppedMedian, 'trace: at most noise-level drops at ≤12ms').toBeLessThanOrEqual(2);
      expect(row.loaf, 'LoAF misses ≤12ms').toBe(0);
      expect(row.rafTimestampLate, 'rAF timestamps miss ≤12ms').toBe(0);
    }
    if (wait === 12) {
      // performance.now() in rAF flags frames that weren't dropped: the "wrong" column.
      expect(row.rafNowLate, 'performance.now() over-reports at 12ms').toBeGreaterThanOrEqual(8);
    }
    if (wait === 25) {
      expect(row.traceDroppedMedian, 'trace sees drops at 25ms').toBeGreaterThan(0);
      expect(row.loaf, 'LoAF misses 25ms').toBe(0);
      expect(row.rafTimestampLate, 'rAF timestamps miss 25ms').toBe(0);
    }
    if (wait >= 40) {
      expect(row.traceDroppedMedian).toBeGreaterThan(0);
      expect(row.loaf, 'LoAF sees ≥40ms').toBeGreaterThanOrEqual(8);
      expect(row.rafTimestampLate, 'rAF timestamps see ≥40ms').toBeGreaterThanOrEqual(8);
    }
  });
}

test('trace drops separate no work from heavy work (medians across runs)', () => {
  test.skip(rows.length !== BLOCKING_MS.length, 'needs every blocking row from this file');
  const by = Object.fromEntries(rows.map((r) => [r.wait, r.traceDroppedMedian]));
  save(
    'scroll-table',
    [...rows].sort((a, b) => a.wait - b.wait),
  );
  expect(by[25]!, '25ms drops more than 0ms').toBeGreaterThan(by[0]!);
  expect(by[70]!, '70ms drops more than 12ms').toBeGreaterThan(by[12]!);
  expect(by[70]!, '70ms drops at least as many as 25ms').toBeGreaterThanOrEqual(by[25]!);
});
