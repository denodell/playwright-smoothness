import type { PageDriver, Tracer } from './driver.js';
import { cpus, platform } from 'node:os';
import {
  COLLECTOR_KEY,
  GENERATED_ID,
  installCollector,
  type CollectorApi,
  type CollectorConfig,
  type CollectorSnapshot,
} from './collector/collector.js';
import { PageCdp, type ScreencastFrames } from './cdp.js';
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
import { median, medianOf, spread } from './analysis/stats.js';
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
import { NameResolver, resolveScripts, type ResolvedFrame } from './sourcemap/resolve.js';
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
  generatedId: GENERATED_ID.source,
};

/**
 * Installs the in-page collector in every document the page loads from now on. Call it before
 * the page's first navigation. Without it, the first measurement injects the collector late
 * (Event Timing can then miss earlier input) and says so in a note.
 */
export async function preparePage(page: PageDriver): Promise<void> {
  await page.addInitScript(installCollector, COLLECTOR_CONFIG);
}

/**
 * Quiet period required after load before a run starts: no long animation frame may end
 * within it. Long enough to cover a timer fired a few hundred ms after load, and the delay before
 * its LoAF entry is delivered.
 */
const SETTLE_QUIET_MS = 500;

/** Longest we wait for the page to go quiet. If it never does, the run continues with a note. */
const SETTLE_TIMEOUT_MS = 5_000;

/** A replay's recording is scaled down to fit this many CSS pixels on its longer side. */
const REPLAY_MAX_SIDE = 1280;

/** The viewport assumed when the library doesn't know it. */
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

interface RunData {
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
  /** Full mode: the frames, for a replay. */
  replay: ReplayInput | null;
}

export interface MeasureContext {
  page: PageDriver;
  label: string;
  options: ResolvedOptions;
  environment: BrowserEnvironment;
  /** Set by scroll(): blank-row detection for a list (full mode). */
  list?: ListMeasurement;
  /** Called before each run (0 is the warm-up), after the page is reset and before it settles. */
  beforeRun?: (run: number) => Promise<void>;
}

// Calls into the in-page collector. Each is a plain page.evaluate (no eval in the page, so
// pages with a strict Content-Security-Policy work). The key is passed in because these
// functions run in the page and can't see module scope.
type Win = Record<string, CollectorApi>;
function collector(page: PageDriver) {
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
  resolver: NameResolver,
  profiles: ProfileRun[],
): Promise<Map<string, ResolvedFrame>> {
  const resolved = new Map<string, ResolvedFrame>();
  for (const frame of namedFrames(profiles)) {
    const r = await resolver.resolve(frame).catch(() => null);
    if (r) resolved.set(frameKey(frame), r);
  }
  return resolved;
}

/** Notes which source maps couldn't be used. Scripts without a map are left as they are. */
async function noteMapFailures(resolver: NameResolver, notes: string[]): Promise<void> {
  const failures = (await resolver.failures()).filter((f) => !f.endsWith('it has no sourceMappingURL'));
  if (failures.length)
    notes.push(`Source maps couldn't be used, so some names may be minified: ${failures.join('; ')}.`);
}

/** Describes this machine. The browser runs locally, so it's the browser's machine too. */
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

async function resetPage(page: PageDriver, options: ResolvedOptions): Promise<void> {
  const reset = options.reset;
  if (reset === 'none') return;
  if (reset === 'reload') await page.reload();
  else await reset({ page: page.native });
}

/** What every run of one measure() call shares, and the notes and gaps it collects. */
interface Measurement {
  ctx: MeasureContext;
  collector: ReturnType<typeof collector>;
  /** Null when the page's browser can't be traced: full mode is then unavailable. */
  tracer: Tracer | null;
  categories: string[];
  notes: string[];
  unavailable: Unavailable[];
  /** Names scripts and profiled functions through the page's source maps; fetches each map once. */
  resolver: NameResolver;
}

/** What happened across the runs, reported once they're all done. */
interface RunTally {
  navigated: number;
  unsettled: number;
  errors: Set<string>;
  overflow: { loaf: number; events: number; scrolls: number };
  supported: { loaf: boolean; event: boolean };
}

type AddSpread = (name: string, values: (number | null)[]) => void;
type Reasons = (measurement: string) => string[];

/**
 * Runs `action` once as a warm-up and then `options.runs` times, resetting and settling the
 * page before each run, and returns the median result. Only frames classified as caused by
 * the interaction count towards `longFrames`.
 */
export async function measure(ctx: MeasureContext, action: () => Promise<void>): Promise<SmoothnessResult> {
  const m = await prepare(ctx);
  const cdp = await PageCdp.open(ctx.page);
  if (ctx.options.cpuThrottling > 1) await checkThrottling(m, cdp, ctx.options.cpuThrottling);
  const runs: RunData[] = [];
  const tally: RunTally = {
    navigated: 0,
    unsettled: 0,
    errors: new Set<string>(),
    overflow: { loaf: 0, events: 0, scrolls: 0 },
    supported: { loaf: true, event: true },
  };

  let extraReplay: ReplayInput | null = null;
  try {
    for (let run = 0; run <= ctx.options.runs; run++) {
      const data = await measureRun(m, cdp, tally, run, action);
      if (data) runs.push(data);
    }
    // One more run, recorded only for a replay. Recording frames costs the compositor time, so
    // it's kept out of the runs that are measured.
    if (ctx.options.mode === 'full' && ctx.options.replay !== 'off' && m.tracer && runs.length) {
      const scratch: RunTally = { ...tally, errors: new Set(), overflow: { loaf: 0, events: 0, scrolls: 0 } };
      extraReplay = (await measureRun(m, cdp, scratch, ctx.options.runs + 1, action, true))?.replay ?? null;
    }
  } finally {
    await cdp.close();
  }

  noteTally(m, tally);
  if (runs.length === 0) {
    const empty = emptyResult(
      ctx,
      tally.navigated ? 'every run navigated to a new document' : 'no runs completed',
    );
    return {
      ...empty,
      notes: [...m.notes, ...empty.notes],
      unavailable: [...empty.unavailable, ...m.unavailable],
    };
  }
  return combineRuns(m, runs, tally.supported, extraReplay);
}

/**
 * Times a fixed loop in the page unthrottled and throttled, and notes when throttling didn't slow
 * it. Chrome occasionally doesn't apply CPU throttling (seen on a Windows CI runner, where 4x left
 * the work almost unslowed), and nothing else would say so.
 */
async function checkThrottling(m: Measurement, cdp: PageCdp, rate: number): Promise<void> {
  const loop = () =>
    m.ctx.page
      .evaluate(() => {
        const start = performance.now();
        let x = 0;
        for (let k = 0; k < 3_000_000; k++) x = (x * 31 + k) | 0;
        return x === 0.5 ? 0 : performance.now() - start; // uses x, so the loop isn't optimized away
      })
      .catch(() => null);
  await cdp.throttle(1);
  const base = await loop();
  await cdp.throttle(rate);
  const slowed = await loop();
  if (base !== null && slowed !== null && base > 0 && slowed < base * Math.max(1.5, rate / 2)) {
    m.notes.push(
      `CPU throttling didn't take effect: a fixed loop took ${Math.round(slowed)}ms at ${rate}x against ${Math.round(base)}ms unthrottled, so these numbers are close to unthrottled.`,
    );
  }
}

/** Makes sure the collector is in the page and notes what this mode and browser can't measure. */
async function prepare(ctx: MeasureContext): Promise<Measurement> {
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

  const tracer = page.tracer();
  const categories = [
    ...FRAME_CATEGORIES,
    ...PROFILE_CATEGORIES,
    ...(options.refreshRate === 120 ? ANIMATION_FRAME_CATEGORIES : []),
  ];
  if (options.mode === 'full' && !tracer) {
    unavailable.push({
      measurement: 'frames',
      reason:
        "full mode needs a trace, and this page's browser can't be traced (a Playwright persistent context has no Browser to trace with)",
    });
  }
  if (options.mode === 'quick' && ctx.list) {
    notes.push("Blank rows in lists are measured in full mode only (mode: 'full'); this was quick mode.");
  }
  if (options.mode === 'quick' && options.refreshRate === 120) {
    notes.push('refreshRate 120 adds a prediction in full mode only; this was quick mode.');
  }
  return {
    ctx,
    collector: c,
    tracer,
    categories,
    notes,
    unavailable,
    resolver: new NameResolver(page.fetchText),
  };
}

/**
 * One run: resets (after the warm-up), throttles and settles the page, runs `action` (traced in
 * full mode), and returns the run's data. Returns null for the warm-up and for a run that navigated.
 */
async function measureRun(
  m: Measurement,
  cdp: PageCdp,
  tally: RunTally,
  run: number,
  action: () => Promise<void>,
  forReplay = false,
): Promise<RunData | null> {
  const { ctx, tracer, collector: c } = m;
  const { page, options } = ctx;
  if (run > 0) await resetPage(page, options);
  if (ctx.beforeRun) await ctx.beforeRun(run);
  await cdp.throttle(options.cpuThrottling);
  const settle = await c.settle(SETTLE_QUIET_MS, SETTLE_TIMEOUT_MS);
  if (!settle.settled) tally.unsettled++;

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
  if (options.mode === 'full' && tracer && ctx.list && run > 0) listPrepared = await ctx.list.prepare();
  // The extra run for a replay records a screencast, at the page's own size.
  let cast: ScreencastFrames | null = null;
  const castMeasured = async () => {
    const recording = await cdp.screencast(replaySize(page.viewport() ?? DEFAULT_VIEWPORT));
    try {
      await measured();
    } finally {
      cast = await recording.stop();
    }
  };
  if (options.mode === 'full' && tracer) {
    // Screenshots for blank-row detection.
    const screenshots = !forReplay && listPrepared !== null && !('unavailable' in listPrepared);
    trace = await traceRun(
      tracer,
      page,
      screenshots ? [...m.categories, ...SCREENSHOT_CATEGORIES] : m.categories,
      forReplay ? castMeasured : measured,
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
  const list = forReplay ? null : await analyzeListRun(m, listPrepared, trace);
  let snapshot: CollectorSnapshot;
  try {
    if (!flushed) throw new Error('navigated');
    snapshot = await c.snapshot(start, end);
  } catch {
    // The action navigated and the collector's page is gone, or the new page has none yet.
    tally.navigated++;
    return null;
  }
  if (snapshot.timeOrigin !== originBefore) {
    tally.navigated++;
    return null;
  }
  tally.supported = snapshot.supported;
  snapshot.errors.forEach((e) => tally.errors.add(e));
  tally.overflow.loaf += snapshot.overflow.loaf;
  tally.overflow.events += snapshot.overflow.events;
  tally.overflow.scrolls += snapshot.overflow.scrolls;
  if (run === 0) return null; // warm-up, discarded

  const replay =
    forReplay && trace && cast ? await replayOfRun(ctx, trace, snapshot, cast, listPrepared) : null;
  return summarizeRun(snapshot, trace, list, replay);
}

/** One run's blank-row result, from the trace's screenshots, which are dropped afterwards. */
async function analyzeListRun(
  m: Measurement,
  listPrepared: ListPrepared | { unavailable: string } | null,
  trace: ParsedTrace | null,
): Promise<RunData['list']> {
  const { ctx, notes } = m;
  let list: RunData['list'] = null;
  if (listPrepared && 'unavailable' in listPrepared) list = listPrepared;
  else if (listPrepared && trace) {
    for (const n of listPrepared.notes) if (!notes.includes(n)) notes.push(n);
    const analyzed = trace.screenshots.length
      ? await ctx.list!.analyze(listPrepared, trace.screenshots)
      : {
          unavailable: trace.unavailable.find((u) => u.measurement === 'list')?.reason ?? 'no screenshots',
        };
    if ('unavailable' in analyzed) list = analyzed;
    else {
      list = analyzed.result;
      for (const n of analyzed.notes) if (!notes.includes(n)) notes.push(n);
    }
    trace.screenshots = []; // several MB per run
    trace.screenshotTimes = [];
  }
  return list;
}

/**
 * The replay run's frames: its screencast, with the trace's frame timeline and the collector's
 * inputs and long frames placed on the same clock. For scroll(), each frame's drawn share, so
 * blank frames are marked. The frame timeline is dropped from the trace afterwards.
 */
async function replayOfRun(
  ctx: MeasureContext,
  trace: ParsedTrace,
  snapshot: CollectorSnapshot,
  cast: ScreencastFrames,
  listPrepared: ListPrepared | { unavailable: string } | null,
): Promise<ReplayInput | null> {
  const offset = trace.pageOffsetUs;
  const frameTimeline = trace.frameTimeline;
  trace.frameTimeline = [];
  if (offset === null || cast.jpegs.length === 0) return null;
  // Trace time (µs) of a time on the page's clock (ms).
  const traceUs = (pageMs: number) => pageMs * 1000 + offset;
  const times = cast.epochMs.map((t) => traceUs(t - snapshot.timeOrigin));
  const t0 = times[0]!;
  const list = listPrepared && !('unavailable' in listPrepared) ? listPrepared : null;
  const analyzed = list ? await ctx.list!.analyze(list, cast.jpegs) : null;
  return {
    jpegs: cast.jpegs,
    timesMs: times.map((t) => (t - t0) / 1000),
    drawn: analyzed && !('unavailable' in analyzed) ? analyzed.drawn : [],
    blankShare: BLANK_FRAME_SHARE,
    rect: list ? list.geometry.rect : null,
    virtualized: list !== null, // scroll() corrects this once it knows
    viewport: list ? list.geometry.viewport : (ctx.page.viewport() ?? DEFAULT_VIEWPORT),
    title: ctx.label,
    frames: frameTimeline.map((f) => ({ tMs: (f.ts - t0) / 1000, dropped: f.dropped })),
    markers: {
      inputs: snapshot.events.filter((e) => e.interactionId > 0).map((e) => (traceUs(e.start) - t0) / 1000),
      longFrames: snapshot.loaf.map((f) => ({ tMs: (traceUs(f.start) - t0) / 1000, durMs: f.duration })),
    },
  };
}

/** A replay's recording size: the viewport, scaled down to fit REPLAY_MAX_SIDE. */
function replaySize(viewport: { width: number; height: number }): { width: number; height: number } {
  const scale = Math.min(1, REPLAY_MAX_SIDE / Math.max(viewport.width, viewport.height));
  return { width: viewport.width * scale, height: viewport.height * scale };
}

/** Classifies a run's frames and summarizes the ones the interaction caused. */
function summarizeRun(
  snapshot: CollectorSnapshot,
  trace: ParsedTrace | null,
  list: RunData['list'],
  replay: ReplayInput | null,
): RunData {
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
  return {
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
  };
}

/** Notes runs that didn't settle or navigated, collector errors, and dropped records. */
function noteTally(m: Measurement, tally: RunTally): void {
  const { notes, unavailable } = m;
  if (tally.unsettled) {
    notes.push(
      `The page didn't go quiet within ${SETTLE_TIMEOUT_MS}ms before ${tally.unsettled} run(s); ` +
        'background work may have overlapped the interaction (it is classified and excluded, but check the result).',
    );
  }
  if (tally.navigated) {
    notes.push(
      `${tally.navigated} run(s) navigated to a new document and were discarded; measuring across navigations isn't supported.`,
    );
  }
  if (tally.errors.size) {
    unavailable.push({
      measurement: 'collector',
      reason: `in-page collector errors: ${[...tally.errors].slice(0, 5).join('; ')}`,
    });
  }
  for (const [kind, n] of Object.entries(tally.overflow)) {
    if (n) notes.push(`${n} ${kind} records were dropped because the in-page buffer was full.`);
  }
}

/** Combines the measured runs into the result: medians, spreads, and the replay source. */
async function combineRuns(
  m: Measurement,
  runs: RunData[],
  supported: RunTally['supported'],
  extraReplay: ReplayInput | null,
): Promise<SmoothnessResult> {
  const { ctx, notes, unavailable } = m;
  const { options } = ctx;
  const spreads: Record<string, Spread> = {};
  const addSpread: AddSpread = (name, values) => {
    const nums = values.filter((v): v is number => v !== null);
    if (nums.length) spreads[name] = spread(nums);
  };
  const { input, longFrames } = combineCollected(m, runs, supported, addSpread);
  // Scripts named through the page's source maps, in any mode: LoAF gives each one's position.
  if (longFrames) longFrames.topScripts = await resolveScripts(longFrames.topScripts, m.resolver);
  const traced: TraceResults = options.mode === 'full' ? await combineTraces(m, runs, addSpread) : {};
  await noteMapFailures(m.resolver, notes);
  const { frames, budget120, profile, list } = traced;

  const classCount = (k: FrameClass) =>
    Math.round(median(runs.map((r) => r.classes.filter((c) => c === k).length)));

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
  if (extraReplay) setReplaySource(result, extraReplay);
  return result;
}

/** The collector's measurements across runs: input and long frames, where the browser supports them. */
function combineCollected(
  m: Measurement,
  runs: RunData[],
  supported: RunTally['supported'],
  addSpread: AddSpread,
): { input: InputResult | null; longFrames: LongFramesResult | null } {
  const { unavailable } = m;
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
  return { input, longFrames };
}

/** The trace measurements, each left out when this measurement doesn't include it. */
interface TraceResults {
  frames?: FramesResult | null;
  budget120?: Budget120Result | null;
  profile?: ProfileResult | null;
  list?: ListResult | null;
}

/**
 * Full mode: combine each run's trace. A measurement missing from every run is unavailable
 * (with each distinct reason); missing from some runs, it's the median of the rest, with a note.
 */
async function combineTraces(m: Measurement, runs: RunData[], addSpread: AddSpread): Promise<TraceResults> {
  const { ctx, notes } = m;
  const traces = runs.map((r) => r.trace);
  const reasons: Reasons = (measurement) => [
    ...new Set(
      traces.flatMap(
        (t) => t?.unavailable.filter((u) => u.measurement === measurement).map((u) => u.reason) ?? [],
      ),
    ),
  ];
  for (const n of new Set(traces.flatMap((t) => t?.notes ?? []))) notes.push(n);

  const out: TraceResults = {};
  out.frames = combineFrames(m, runs, reasons, addSpread);
  out.profile = await combineProfile(m, runs, reasons);
  if (ctx.list) out.list = combineList(m, runs, addSpread);
  if (ctx.options.refreshRate === 120) out.budget120 = combineBudget120(m, runs, reasons, addSpread);
  return out;
}

/** The median of each run's frame counts. */
function combineFrames(
  m: Measurement,
  runs: RunData[],
  reasons: Reasons,
  addSpread: AddSpread,
): FramesResult | null {
  const { tracer, notes, unavailable } = m;
  const perRun = runs.map((r) => r.trace?.frames ?? null).filter((f): f is FramesResult => f !== null);
  if (perRun.length === 0) {
    if (tracer) for (const reason of reasons('frames')) unavailable.push({ measurement: 'frames', reason });
    return null;
  }
  if (perRun.length < runs.length) {
    notes.push(
      `Frame data was missing from ${runs.length - perRun.length} of ${runs.length} runs: ${reasons('frames').join('; ')}.`,
    );
  }
  const frames: FramesResult = {
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
  return frames;
}

/** The runs' CPU profiles combined, with names resolved through the page's source maps. */
async function combineProfile(
  m: Measurement,
  runs: RunData[],
  reasons: Reasons,
): Promise<ProfileResult | null> {
  const { tracer, notes, unavailable } = m;
  const profiles = runs.map((r) => r.profile).filter((p): p is ProfileRun => p !== null);
  if (profiles.length === 0) {
    if (tracer) for (const reason of reasons('profile')) unavailable.push({ measurement: 'profile', reason });
    return null;
  }
  if (profiles.length < runs.length) {
    notes.push(`The CPU profile was missing from ${runs.length - profiles.length} of ${runs.length} runs.`);
  }
  return combineProfiles(profiles, await resolveNames(m.resolver, profiles));
}

/** The median of each run's blank-row result. */
function combineList(m: Measurement, runs: RunData[], addSpread: AddSpread): ListResult | null {
  const { notes, unavailable } = m;
  const lists = runs.map((r) => r.list);
  const ok = lists.filter((l): l is ListResult => l !== null && !('unavailable' in l));
  const why = [...new Set(lists.flatMap((l) => (l && 'unavailable' in l ? [l.unavailable] : [])))];
  if (ok.length === 0) {
    for (const reason of why.length ? why : ['no run produced list data'])
      unavailable.push({ measurement: 'list', reason });
    return null;
  }
  if (ok.length < runs.length)
    notes.push(
      `List data was missing from ${runs.length - ok.length} of ${runs.length} runs: ${why.join('; ')}.`,
    );
  const list: ListResult = {
    frames: Math.round(median(ok.map((l) => l.frames))),
    blankFrames: Math.round(median(ok.map((l) => l.blankFrames))),
    blankFramePercent: medianOf(ok.map((l) => l.blankFramePercent))!,
    leastDrawnPercent: medianOf(ok.map((l) => l.leastDrawnPercent))!,
  };
  addSpread(
    'list.blankFramePercent',
    ok.map((l) => l.blankFramePercent),
  );
  return list;
}

/** The median of each run's 120Hz frame-budget prediction. */
function combineBudget120(
  m: Measurement,
  runs: RunData[],
  reasons: Reasons,
  addSpread: AddSpread,
): Budget120Result | null {
  const b = runs.map((r) => r.trace?.budget120 ?? null).filter((x): x is Budget120Result => x !== null);
  if (b.length === 0) {
    for (const reason of reasons('budget120')) m.unavailable.push({ measurement: 'budget120', reason });
    return null;
  }
  const budget120: Budget120Result = {
    framesOverBudget: Math.round(median(b.map((x) => x.framesOverBudget))),
    frames: Math.round(median(b.map((x) => x.frames))),
    predicted: true,
  };
  addSpread(
    'budget120.framesOverBudget',
    b.map((x) => x.framesOverBudget),
  );
  return budget120;
}
