// Helpers for the detection suite. Deliberately independent of src/: these tests check
// the browser's behavior, not the library's, so they must keep working if src/ is wrong.
import { test, type Browser, type Page, type CDPSession } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Default categories for traced(): broad, since these tests look beyond what the library records. */
const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'benchmark',
  'cc',
  'viz',
  'gpu',
];

/** Frame budget at 60Hz, and the "late frame" cut-off for rAF gaps (1.5 frames). */
const FRAME_MS = 1000 / 60;
export const LATE_GAP_MS = FRAME_MS * 1.5;

/**
 * Time for a page to finish its own start-up work before measuring. The detection pages
 * do at most ~120ms of load work, so 500ms is comfortably past it.
 */
export const PAGE_SETTLE_MS = 500;

/**
 * Time after the last input for Event Timing and LoAF entries to be delivered to observers.
 * Both are dispatched after the next paint; 300ms covers several frames at 60Hz, even at 4x throttling.
 */
export const ENTRY_DELIVERY_MS = 300;

/** Writes a JSON result to test-results/detection/<project>--<name>.json. */
export function save(name: string, data: unknown): void {
  const dir = join('test-results', 'detection');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${test.info().project.name}--${name}.json`), JSON.stringify(data, null, 1));
}

/** Attaches a result to the test's report as JSON. */
export function attach(result: unknown): Promise<void> {
  return test
    .info()
    .attach('result', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
}

export interface LoafRecord {
  start: number;
  duration: number;
  blocking: number;
  firstUI: number;
  scripts: {
    invoker: string;
    invokerType: string;
    source: string;
    fn: string;
    duration: number;
  }[];
}

interface EventRecord {
  name: string;
  interactionId: number;
  start: number;
  duration: number;
  target: string | null;
}

/**
 * In-page observers for LoAF, Event Timing (threshold 16) and scroll timestamps.
 * Each callback and each entry is wrapped in its own try/catch:
 * an exception inside a batch would otherwise silently drop the rest of the batch.
 */
export function installObservers(): void {
  const w = window as unknown as Record<string, unknown>;
  const loaf: unknown[] = [];
  const events: unknown[] = [];
  const scrolls: number[] = [];
  const errors: string[] = [];
  w.__det = { loaf, events, scrolls, errors };
  const describe = (n: Element | null): string | null => {
    if (!n || !n.tagName) return null;
    let s = n.tagName.toLowerCase();
    if (n.id) s += '#' + n.id;
    if (typeof n.className === 'string' && n.className.trim())
      s += '.' + n.className.trim().split(/\s+/).join('.');
    return s;
  };
  try {
    new PerformanceObserver((list) => {
      try {
        for (const e of list.getEntries() as unknown as Record<string, any>[]) {
          try {
            loaf.push({
              start: e.startTime,
              duration: e.duration,
              blocking: e.blockingDuration,
              firstUI: e.firstUIEventTimestamp,
              scripts: (e.scripts || []).map((s: Record<string, any>) => ({
                invoker: s.invoker,
                invokerType: s.invokerType,
                source: s.sourceURL,
                fn: s.sourceFunctionName,
                duration: s.duration,
              })),
            });
          } catch (err) {
            errors.push('loaf entry: ' + String(err));
          }
        }
      } catch (err) {
        errors.push('loaf callback: ' + String(err));
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch (err) {
    errors.push('loaf observe: ' + String(err));
  }
  try {
    new PerformanceObserver((list) => {
      try {
        for (const e of list.getEntries() as unknown as Record<string, any>[]) {
          try {
            events.push({
              name: e.name,
              interactionId: e.interactionId,
              start: e.startTime,
              duration: e.duration,
              target: describe(e.target),
            });
          } catch (err) {
            errors.push('event entry: ' + String(err));
          }
        }
      } catch (err) {
        errors.push('event callback: ' + String(err));
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  } catch (err) {
    errors.push('event observe: ' + String(err));
  }
  addEventListener(
    'scroll',
    () => {
      try {
        scrolls.push(performance.now());
      } catch {
        // never throw from the page
      }
    },
    { capture: true, passive: true },
  );
}

interface Collected {
  loaf: LoafRecord[];
  events: EventRecord[];
  scrolls: number[];
  errors: string[];
}

export async function collected(page: Page): Promise<Collected> {
  return page.evaluate(() => {
    const d = (window as unknown as { __det: Collected }).__det;
    return { loaf: [...d.loaf], events: [...d.events], scrolls: [...d.scrolls], errors: [...d.errors] };
  });
}

export async function clearCollected(page: Page): Promise<void> {
  await page.evaluate(() => {
    const d = (window as unknown as { __det: Collected }).__det;
    d.loaf.length = 0;
    d.events.length = 0;
    d.scrolls.length = 0;
  });
}

export async function throttle(page: Page, rate: number): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  return cdp;
}

/**
 * One wheel scroll, then a pause. The first wheel on a page costs a 46-58ms frame on
 * Chrome 153 even with no page work (docs/measurements.md), so measured scrolls come after it.
 */
export async function warmUpWheel(page: Page): Promise<void> {
  await page.mouse.move(400, 400);
  await page.mouse.wheel(0, 150);
  await page.waitForTimeout(300);
}

/** Ten wheel scrolls of 150px, 80ms apart, over the page center: the recipe the scroll tables in
 * docs/measurements.md were measured with. */
export async function tenWheelScrolls(page: Page): Promise<void> {
  await page.mouse.move(400, 400);
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, 150);
    await page.waitForTimeout(80);
  }
}

// ---- trace parsing (minimal, and independent of src/trace/parse.ts) ----

export interface TraceEvent {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  id?: string;
  id2?: { local?: string; global?: string };
  cat?: string;
  args?: Record<string, any>;
}

export async function traced(
  browser: Browser,
  page: Page,
  action: () => Promise<void>,
  opts: { screenshots?: boolean; categories?: string[] } = {},
): Promise<{ events: TraceEvent[]; bytes: number }> {
  await browser.startTracing(page, {
    categories: opts.categories ?? TRACE_CATEGORIES,
    screenshots: opts.screenshots ?? false,
  });
  let buf: Buffer;
  try {
    await action();
  } finally {
    // stopTracing must run even if the action fails, or the next test can't trace.
    buf = await browser.stopTracing();
  }
  const parsed = JSON.parse(buf.toString()) as { traceEvents: TraceEvent[] };
  return { events: parsed.traceEvents, bytes: buf.length };
}

/**
 * Frames presented after the last input still belong to it (scroll animation, the paint
 * that answers the input). 150ms is several frames at 60Hz.
 */
export const INPUT_TAIL_MS = 150;

/**
 * The trace time range covering the inputs: from the first input's EventLatency to the
 * last one plus INPUT_TAIL_MS. Counting outside it picks up a hitch when tracing starts
 * (seen in every run on Chrome 153; see docs/measurements.md).
 */
export function inputWindow(events: TraceEvent[]): [number, number] | null {
  const ts = events
    .filter((e) => e.name === 'EventLatency' && e.ph === 'b')
    .filter((e) => e.args?.event_latency?.event_type !== 'MOUSE_MOVED_EVENT')
    .map((e) => e.ts);
  if (ts.length === 0) return null;
  return [Math.min(...ts), Math.max(...ts) + INPUT_TAIL_MS * 1000];
}

/** Counts PipelineReporter frame states (async begin events only), optionally within a window. */
export function pipelineStates(
  events: TraceEvent[],
  window?: [number, number] | null,
): Record<string, number> {
  const states: Record<string, number> = {};
  for (const e of events) {
    if (e.name !== 'PipelineReporter' || e.ph !== 'b') continue;
    if (window && (e.ts < window[0] || e.ts > window[1])) continue;
    const state = (e.args?.frame_reporter ?? e.args?.chrome_frame_reporter)?.state ?? 'MISSING_STATE';
    states[state] = (states[state] ?? 0) + 1;
  }
  return states;
}

/** Durations in ms of AnimationFrame events, pairing async begin/end by id. */
export function animationFrameDurations(events: TraceEvent[]): number[] {
  const open = new Map<string, number>();
  const durations: number[] = [];
  for (const e of events) {
    if (e.name !== 'AnimationFrame') continue;
    const id = e.id ?? e.id2?.local ?? e.id2?.global ?? '';
    if (e.ph === 'b') open.set(id, e.ts);
    else if (e.ph === 'e' && open.has(id)) {
      durations.push((e.ts - open.get(id)!) / 1000);
      open.delete(id);
    } else if (e.ph === 'X' && e.dur !== undefined) durations.push(e.dur / 1000);
  }
  return durations;
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
