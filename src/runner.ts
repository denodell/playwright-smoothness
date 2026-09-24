import type { Page } from '@playwright/test';
import { cpus, platform } from 'node:os';
import {
  COLLECTOR_KEY,
  installCollector,
  type CollectorApi,
  type CollectorConfig,
  type CollectorSnapshot,
} from './collector/collector.js';
import { PageCdp } from './cdp.js';
import { classifyFrames, type FrameClass } from './analysis/classify.js';
import { groupInteractions } from './analysis/interactions.js';
import {
  attributeFrames,
  combineInput,
  combineLongFrames,
  type AttributedFrame,
  summarizeInput,
  summarizeLongFrames,
} from './analysis/aggregate.js';
import { median, spread } from './analysis/stats.js';
import type { BrowserEnvironment } from './environment.js';
import { SCHEMA_VERSION } from './constants.js';
import type {
  InputResult,
  LongFramesResult,
  ResolvedOptions,
  SmoothnessResult,
  Spread,
  Unavailable,
} from './types.js';

export const COLLECTOR_CONFIG: CollectorConfig = {
  eventThresholdMs: 16,
  maxRecords: 20_000,
  interactiveSelector: 'button, a, input, select, textarea, [role], [tabindex]',
};

/**
 * Quiet period required after load before a run starts: no long animation frame may end
 * within it. Long enough to cover a timer fired shortly after load (the mixed test page's
 * background job fires 300ms after load) and the delay before its LoAF entry is delivered.
 */
export const SETTLE_QUIET_MS = 500;

/** Longest we wait for the page to go quiet. If it never does, the run continues with a note. */
export const SETTLE_TIMEOUT_MS = 5_000;

interface RunData {
  snapshot: CollectorSnapshot;
  classes: FrameClass[];
  interactionFrames: AttributedFrame[];
  input: InputResult;
  longFrames: LongFramesResult;
}

export interface MeasureContext {
  page: Page;
  label: string;
  options: ResolvedOptions;
  environment: BrowserEnvironment;
}

// Calls into the in-page collector. Each is a plain page.evaluate (no eval in the page, so
// pages with a strict Content-Security-Policy work). The key is passed in because these
// functions run in the page and can't see module scope.
type Win = Record<string, CollectorApi>;
function collector(page: Page) {
  const key = COLLECTOR_KEY;
  return {
    installed: () => page.evaluate((k) => k in window, key),
    now: () => page.evaluate((k) => (window as unknown as Win)[k]!.now(), key),
    settle: (quietMs: number, timeoutMs: number) =>
      page.evaluate(
        ([k, q, t]) => (window as unknown as Win)[k as string]!.settle(q as number, t as number),
        [key, quietMs, timeoutMs] as const,
      ),
    flush: () => page.evaluate((k) => (window as unknown as Win)[k]!.flush(), key),
    snapshot: (from: number, to: number) =>
      page.evaluate(
        ([k, f, t]) => (window as unknown as Win)[k as string]!.snapshot(f as number, t as number),
        [key, from, to] as const,
      ),
  };
}

/** Describes this machine. Playwright runs the browser locally, so it's the browser's machine too. */
export function machine(): SmoothnessResult['machine'] {
  const list = cpus();
  return { cpuModel: list[0]?.model.trim() ?? 'unknown', cpus: list.length, platform: platform() };
}

/** A result with nothing measured, for browsers or pages where measurement isn't possible. */
export function emptyResult(ctx: Omit<MeasureContext, 'page'>, reason: string): SmoothnessResult {
  return {
    schemaVersion: SCHEMA_VERSION,
    label: ctx.label,
    mode: ctx.options.mode,
    runs: 0,
    browserName: ctx.environment.browserName,
    browserVersion: ctx.environment.browserVersion,
    headlessMode: ctx.environment.headlessMode,
    machine: machine(),
    cpuThrottling: ctx.options.cpuThrottling,
    refreshRate: ctx.options.refreshRate,
    input: null,
    longFrames: null,
    spread: {},
    frameClasses: { interaction: 0, load: 0, background: 0 },
    unavailable: [
      { measurement: 'input', reason },
      { measurement: 'longFrames', reason },
    ],
    notes: [],
  };
}

async function resetPage(page: Page, options: ResolvedOptions): Promise<void> {
  const reset = options.reset;
  if (reset === 'none') return;
  if (reset === 'reload') await page.reload({ waitUntil: 'load' });
  else await reset({ page });
}

/**
 * Runs `action` once as a warm-up and then `options.runs` times, resetting and settling the
 * page before each run, and returns the median result. Only frames classified as caused by
 * the interaction count towards `longFrames`.
 */
export async function measure(ctx: MeasureContext, action: () => Promise<void>): Promise<SmoothnessResult> {
  const { page, options } = ctx;
  const c = collector(page);
  const notes: string[] = [];
  const unavailable: Unavailable[] = [];

  if (!(await c.installed())) {
    // The fixture injects the collector before navigation. If the page was opened some other
    // way, inject now: LoAF's buffered entries still arrive, but Event Timing may miss earlier input.
    await page.addInitScript(installCollector, COLLECTOR_CONFIG);
    await page.evaluate(installCollector, COLLECTOR_CONFIG);
    notes.push(
      'The collector was injected after the page loaded; later runs (after reset) have it from the start.',
    );
  }

  const cdp = await PageCdp.open(page);
  const runs: RunData[] = [];
  let navigatedRuns = 0;
  let unsettledRuns = 0;
  const errors = new Set<string>();
  const overflow = { loaf: 0, events: 0, scrolls: 0 };
  let supported = { loaf: true, event: true };

  try {
    for (let run = 0; run <= options.runs; run++) {
      if (run > 0) await resetPage(page, options);
      await cdp.throttle(options.cpuThrottling);
      const settle = await c.settle(SETTLE_QUIET_MS, SETTLE_TIMEOUT_MS);
      if (!settle.settled) unsettledRuns++;

      const start = await c.now();
      const originBefore = await page.evaluate(() => performance.timeOrigin);
      await action();
      let snapshot: CollectorSnapshot;
      try {
        await c.flush();
        const end = await c.now();
        snapshot = await c.snapshot(start, end);
      } catch {
        // The action navigated and the collector's page is gone, or the new page has none yet.
        navigatedRuns++;
        continue;
      }
      if (snapshot.timeOrigin !== originBefore) {
        navigatedRuns++;
        continue;
      }
      supported = snapshot.supported;
      snapshot.errors.forEach((e) => errors.add(e));
      overflow.loaf += snapshot.overflow.loaf;
      overflow.events += snapshot.overflow.events;
      overflow.scrolls += snapshot.overflow.scrolls;
      if (run === 0) continue; // warm-up, discarded

      const interactions = groupInteractions(snapshot.events, snapshot.loaf);
      const classes = classifyFrames({
        loaf: snapshot.loaf,
        interactions,
        scrolls: snapshot.scrolls,
        loadEventEnd: snapshot.loadEventEnd,
      });
      const interactionFrames = attributeFrames(
        snapshot.loaf.filter((_, i) => classes[i] === 'interaction'),
        interactions,
        snapshot.scrolls,
      );
      runs.push({
        snapshot,
        classes,
        interactionFrames,
        input: summarizeInput(interactions),
        longFrames: summarizeLongFrames(interactionFrames),
      });
    }
  } finally {
    await cdp.close();
  }

  if (unsettledRuns) {
    notes.push(
      `The page didn't go quiet within ${SETTLE_TIMEOUT_MS}ms before ${unsettledRuns} run(s); ` +
        'background work may have overlapped the interaction (it is classified and excluded, but check the result).',
    );
  }
  if (navigatedRuns) {
    notes.push(
      `${navigatedRuns} run(s) navigated to a new document and were discarded; measuring across navigations isn't supported.`,
    );
  }
  if (errors.size) {
    unavailable.push({
      measurement: 'collector',
      reason: `in-page collector errors: ${[...errors].slice(0, 5).join('; ')}`,
    });
  }
  for (const [kind, n] of Object.entries(overflow)) {
    if (n) notes.push(`${n} ${kind} records were dropped because the in-page buffer was full.`);
  }

  if (runs.length === 0) {
    const empty = emptyResult(
      ctx,
      navigatedRuns ? 'every run navigated to a new document' : 'no runs completed',
    );
    return {
      ...empty,
      notes: [...notes, ...empty.notes],
      unavailable: [...empty.unavailable, ...unavailable],
    };
  }

  const input = supported.event ? combineInput(runs.map((r) => r.input)) : null;
  if (!supported.event)
    unavailable.push({ measurement: 'input', reason: 'Event Timing is not supported in this browser' });
  const longFrames = supported.loaf
    ? combineLongFrames(
        runs.map((r) => r.longFrames),
        runs.map((r) => r.interactionFrames),
      )
    : null;
  if (!supported.loaf)
    unavailable.push({
      measurement: 'longFrames',
      reason: 'Long Animation Frames are not supported in this browser',
    });

  const spreads: Record<string, Spread> = {};
  const addSpread = (name: string, values: (number | null)[]) => {
    const nums = values.filter((v): v is number => v !== null);
    if (nums.length) spreads[name] = spread(nums);
  };
  if (input)
    addSpread(
      'input.p95ToPaintMs',
      runs.map((r) => r.input.p95ToPaintMs),
    );
  if (longFrames) {
    addSpread(
      'longFrames.count',
      runs.map((r) => r.longFrames.count),
    );
    addSpread(
      'longFrames.totalBlockingMs',
      runs.map((r) => r.longFrames.totalBlockingMs),
    );
    addSpread(
      'longFrames.worstMs',
      runs.map((r) => r.longFrames.worstMs),
    );
  }

  const classCount = (k: FrameClass) =>
    Math.round(median(runs.map((r) => r.classes.filter((c) => c === k).length)));

  return {
    schemaVersion: SCHEMA_VERSION,
    label: ctx.label,
    mode: options.mode,
    runs: runs.length,
    browserName: ctx.environment.browserName,
    browserVersion: ctx.environment.browserVersion,
    headlessMode: ctx.environment.headlessMode,
    machine: machine(),
    cpuThrottling: options.cpuThrottling,
    refreshRate: options.refreshRate,
    input,
    longFrames,
    spread: spreads,
    frameClasses: {
      interaction: classCount('interaction'),
      load: classCount('load'),
      background: classCount('background'),
    },
    unavailable,
    notes,
  };
}
