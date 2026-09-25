import type { Browser, Page } from '@playwright/test';
import { MARK_END, MARK_START, parseTrace, type ParsedTrace, type TraceEvent } from './parse.js';

/**
 * Traces `measured` and returns the parsed frame data. The trace buffer is parsed and dropped
 * here, never kept: with screenshots a trace is 12-22MB (docs/measurements.md).
 */
export async function traceRun(
  browser: Browser,
  page: Page,
  categories: string[],
  measured: () => Promise<void>,
  options: { browserVersion: string; budget120: boolean; profile: boolean; screenshots: boolean },
): Promise<ParsedTrace & { bytes: number }> {
  await browser.startTracing(page, { categories, screenshots: options.screenshots });
  let buffer: Buffer;
  try {
    // Two frames after tracing starts, so the start mark isn't inside tracing's own start-up.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.evaluate((name) => performance.mark(name), MARK_START);
    await measured();
    await page.evaluate((name) => performance.mark(name), MARK_END).catch(() => undefined);
  } finally {
    // Always stop, or the next run (and the next test in this worker) can't trace.
    buffer = await browser.stopTracing();
  }
  await page
    .evaluate(
      ([a, b]) => {
        performance.clearMarks(a);
        performance.clearMarks(b);
      },
      [MARK_START, MARK_END],
    )
    .catch(() => undefined);
  let events: TraceEvent[];
  try {
    events = (JSON.parse(buffer.toString('utf8')) as { traceEvents?: TraceEvent[] }).traceEvents ?? [];
  } catch (err) {
    return {
      frames: null,
      budget120: null,
      profile: null,
      screenshots: [],
      unavailable: [{ measurement: 'frames', reason: `the trace could not be parsed: ${String(err)}` }],
      notes: [],
      bytes: buffer.length,
    };
  }
  return { ...parseTrace(events, options), bytes: buffer.length };
}
