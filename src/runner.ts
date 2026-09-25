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
import { medianOf } from './analysis/aggregate.js';
import { traceRun } from './trace/tracer.js';
import {
  ANIMATION_FRAME_CATEGORIES,
  FRAME_CATEGORIES,
  PROFILE_CATEGORIES,
  SCREENSHOT_CATEGORIES,
} from './trace/categories.js';
import type { ListMeasurement, ListPrepared } from './list/measure.js';
import { BLANK_FRAME_SHARE } from './list/summarize.js';
import type { ReplayInput } from './replay/encode.js';
import { setReplaySource } from './replay/source.js';
import {
  attributeProfile,
  combineProfiles,
  frameKey,
  namedFrames,
  type ProfileRun,
} from './analysis/profile.js';
import { NameResolver, type ResolvedFrame } from './sourcemap/resolve.js';
import { pageFetcher } from './sourcemap/fetch.js';
import type { ParsedTrace } from './trace/parse.js';
import type { BrowserEnvironment } from './environment.js';
import { SCHEMA_VERSION } from './constants.js';
import type {
  Budget120Result,
  FramesResult,
  ListResult,
  ProfileResult,
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
 * within it. Long enough to cover a timer fired a few hundred ms after load, and the delay before
 * its LoAF entry is delivered.
 */
const SETTLE_QUIET_MS = 500;

/** Longest we wait for the page to go quiet. If it never does, the run continues with a note. */
export const SETTLE_TIMEOUT_MS = 5_000;

interface RunData {
  snapshot: CollectorSnapshot;
  classes: FrameClass[];
  interactionFrames: AttributedFrame[];
  input: InputResult;
  longFrames: LongFramesResult;
  /** Full mode only. */
  trace: ParsedTrace | null;
  /** Full mode only: CPU time inside this run's interaction windows. */
  profile: ProfileRun | null;
  /** scroll() in full mode only. */
  list: ListResult | { unavailable: string } | null;
  /** scroll() in full mode: the frames, for a replay. */
  replay: ReplayInput | null;
}

export interface MeasureContext {
  page: Page;
  label: string;
  options: ResolvedOptions;
  environment: BrowserEnvironment;
  /** Set by scroll(): blank-row detection for a list (full mode). */
  list?: ListMeasurement;
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

/**
 * Maps minified names in the profile back to source names with the page's source maps. Pages
 * without source maps are left as they are (their names are already the real ones); a map
 * that's referenced but can't be used gets a note.
 */
async function resolveNames(
  page: Page,
  profiles: ProfileRun[],
  notes: string[],
): Promise<Map<string, ResolvedFrame>> {
  const resolver = new NameResolver(pageFetcher(page));
  const resolved = new Map<string, ResolvedFrame>();
  for (const frame of namedFrames(profiles)) {
    const r = await resolver.resolve(frame).catch(() => null);
    if (r) resolved.set(frameKey(frame), r);
  }
  const failures = (await resolver.failures()).filter((f) => !f.endsWith('it has no sourceMappingURL'));
  if (failures.length)
    notes.push(`Source maps couldn't be used, so some names may be minified: ${failures.join('; ')}.`);
  return resolved;
}

/** Describes this machine. Playwright runs the browser locally, so it's the browser's machine too. */
export function machine(): SmoothnessResult['machine'] {
  const list = cpus();
  return { cpuModel: list[0]?.model.trim() ?? 'unknown', cpus: list.length, platform: platform() };
}

/** The options that decide how a result is compared, as recorded in the result. */
export function settingsOf(options: ResolvedOptions): SmoothnessResult['settings'] {
  return {
    maxIncrease: options.maxIncrease,
    enforce: options.enforce,
    gateTotalBlocking: options.gateTotalBlocking,
    baselineDir: options.baselineDir ?? null,
    modeSource: options.modeSource,
    replay: options.replay,
  };
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
    settings: settingsOf(ctx.options),
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

  const browser = page.context().browser();
  const categories = [
    ...FRAME_CATEGORIES,
    ...PROFILE_CATEGORIES,
    ...(options.refreshRate === 120 ? ANIMATION_FRAME_CATEGORIES : []),
  ];
  if (options.mode === 'full' && !browser) {
    unavailable.push({
      measurement: 'frames',
      reason: 'full mode needs Browser.startTracing, which a persistent context has no Browser for',
    });
  }
  if (options.mode === 'quick' && ctx.list) {
    notes.push("Blank rows in lists are measured in full mode only (mode: 'full'); this was quick mode.");
  }
  if (options.mode === 'quick' && options.refreshRate === 120) {
    notes.push('refreshRate 120 adds a prediction in full mode only; this was quick mode.');
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

      const originBefore = await page.evaluate(() => performance.timeOrigin);
      let start = 0;
      let end = 0;
      let flushed = true;
      const measured = async () => {
        start = await c.now();
        await action();
        try {
          await c.flush();
          end = await c.now();
        } catch {
          flushed = false; // the action navigated away; handled below
        }
      };
      let trace: ParsedTrace | null = null;
      // Blank-row detection: prepared after the page settles and before tracing (the reference
      // screenshot must not land inside the trace). Skipped on the warm-up run.
      let listPrepared: ListPrepared | { unavailable: string } | null = null;
      if (options.mode === 'full' && browser && ctx.list && run > 0) listPrepared = await ctx.list.prepare();
      if (options.mode === 'full' && browser) {
        const screenshots = listPrepared !== null && !('unavailable' in listPrepared);
        trace = await traceRun(
          browser,
          page,
          screenshots ? [...categories, ...SCREENSHOT_CATEGORIES] : categories,
          measured,
          {
            browserVersion: ctx.environment.browserVersion,
            budget120: options.refreshRate === 120,
            profile: true,
            screenshots,
          },
        );
      } else {
        await measured();
      }
      let list: RunData['list'] = null;
      let replay: ReplayInput | null = null;
      if (listPrepared && 'unavailable' in listPrepared) list = listPrepared;
      else if (listPrepared && trace) {
        for (const n of listPrepared.notes) if (!notes.includes(n)) notes.push(n);
        const analysed = trace.screenshots.length
          ? await ctx.list!.analyze(listPrepared, trace.screenshots)
          : {
              unavailable:
                trace.unavailable.find((u) => u.measurement === 'list')?.reason ?? 'no screenshots',
            };
        if ('unavailable' in analysed) list = analysed;
        else {
          list = analysed.result;
          if (options.replay !== 'off') {
            const t0 = trace.screenshotTimes[0] ?? 0;
            replay = {
              jpegs: trace.screenshots,
              timesMs: trace.screenshotTimes.map((t) => (t - t0) / 1000),
              drawn: analysed.drawn,
              blankShare: BLANK_FRAME_SHARE,
              rect: listPrepared.geometry.rect,
              viewport: listPrepared.geometry.viewport,
              title: ctx.label,
            };
          }
        }
        trace.screenshots = []; // several MB per run; kept only in `replay`, if at all
        trace.screenshotTimes = [];
      }
      let snapshot: CollectorSnapshot;
      try {
        if (!flushed) throw new Error('navigated');
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
        trace,
        list,
        replay,
        // The interaction's windows: its long frames, and each Event Timing interaction (which
        // covers work under LoAF's 50ms threshold too).
        profile: trace?.profile
          ? attributeProfile(trace.profile, [
              ...interactionFrames.map((f) => [f.start, f.start + f.duration] as [number, number]),
              ...interactions.map((i) => [i.start, i.start + i.duration] as [number, number]),
            ])
          : null,
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

  // Full mode: combine each run's trace. A measurement missing from every run is unavailable
  // (with each distinct reason); missing from some runs, it's the median of the rest, with a note.
  let frames: FramesResult | null | undefined;
  let budget120: Budget120Result | null | undefined;
  let profile: ProfileResult | null | undefined;
  let list: ListResult | null | undefined;
  if (options.mode === 'full') {
    const traces = runs.map((r) => r.trace);
    const reasons = (measurement: string) => [
      ...new Set(
        traces.flatMap(
          (t) => t?.unavailable.filter((u) => u.measurement === measurement).map((u) => u.reason) ?? [],
        ),
      ),
    ];
    for (const n of new Set(traces.flatMap((t) => t?.notes ?? []))) notes.push(n);

    const perRun = traces.map((t) => t?.frames ?? null).filter((f): f is FramesResult => f !== null);
    if (perRun.length === 0) {
      frames = null;
      if (browser)
        for (const reason of reasons('frames')) unavailable.push({ measurement: 'frames', reason });
    } else {
      if (perRun.length < runs.length) {
        notes.push(
          `Frame data was missing from ${runs.length - perRun.length} of ${runs.length} runs: ${reasons('frames').join('; ')}.`,
        );
      }
      frames = {
        total: Math.round(median(perRun.map((f) => f.total))),
        onTime: Math.round(median(perRun.map((f) => f.onTime))),
        dropped: Math.round(median(perRun.map((f) => f.dropped))),
        onTimePercent: medianOf(perRun.map((f) => f.onTimePercent)),
      };
      addSpread(
        'frames.onTimePercent',
        perRun.map((f) => f.onTimePercent),
      );
      addSpread(
        'frames.dropped',
        perRun.map((f) => f.dropped),
      );
    }

    const profiles = runs.map((r) => r.profile).filter((p): p is ProfileRun => p !== null);
    if (profiles.length === 0) {
      profile = null;
      if (browser)
        for (const reason of reasons('profile')) unavailable.push({ measurement: 'profile', reason });
    } else {
      if (profiles.length < runs.length) {
        notes.push(
          `The CPU profile was missing from ${runs.length - profiles.length} of ${runs.length} runs.`,
        );
      }
      profile = combineProfiles(profiles, await resolveNames(page, profiles, notes));
    }

    if (ctx.list) {
      const perRun = runs.map((r) => r.list);
      const ok = perRun.filter((l): l is ListResult => l !== null && !('unavailable' in l));
      const why = [...new Set(perRun.flatMap((l) => (l && 'unavailable' in l ? [l.unavailable] : [])))];
      if (ok.length === 0) {
        list = null;
        for (const reason of why.length ? why : ['no run produced list data'])
          unavailable.push({ measurement: 'list', reason });
      } else {
        if (ok.length < runs.length)
          notes.push(
            `List data was missing from ${runs.length - ok.length} of ${runs.length} runs: ${why.join('; ')}.`,
          );
        list = {
          frames: Math.round(median(ok.map((l) => l.frames))),
          blankFrames: Math.round(median(ok.map((l) => l.blankFrames))),
          blankFramePercent: medianOf(ok.map((l) => l.blankFramePercent))!,
          leastDrawnPercent: medianOf(ok.map((l) => l.leastDrawnPercent))!,
        };
        addSpread(
          'list.blankFramePercent',
          ok.map((l) => l.blankFramePercent),
        );
      }
    }

    if (options.refreshRate === 120) {
      const b = traces.map((t) => t?.budget120 ?? null).filter((x): x is Budget120Result => x !== null);
      if (b.length === 0) {
        budget120 = null;
        for (const reason of reasons('budget120')) unavailable.push({ measurement: 'budget120', reason });
      } else {
        budget120 = {
          framesOverBudget: Math.round(median(b.map((x) => x.framesOverBudget))),
          frames: Math.round(median(b.map((x) => x.frames))),
          predicted: true,
        };
        addSpread(
          'budget120.framesOverBudget',
          b.map((x) => x.framesOverBudget),
        );
      }
    }
  }

  const classCount = (k: FrameClass) =>
    Math.round(median(runs.map((r) => r.classes.filter((c) => c === k).length)));

  // The replay comes from the run whose blank-frame share is closest to the reported median.
  let replaySource: ReplayInput | null = null;
  if (list) {
    let best = Infinity;
    for (const r of runs) {
      if (!r.replay || !r.list || 'unavailable' in r.list) continue;
      const d = Math.abs(r.list.blankFramePercent - list.blankFramePercent);
      if (d < best) {
        best = d;
        replaySource = r.replay;
      }
    }
  }

  const result: SmoothnessResult = {
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
    settings: settingsOf(options),
    ...(frames !== undefined ? { frames } : {}),
    ...(budget120 !== undefined ? { budget120 } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(list !== undefined ? { list } : {}),
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
  if (replaySource) setReplaySource(result, replaySource);
  return result;
}
