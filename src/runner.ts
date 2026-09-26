import type { Browser, Page } from '@playwright/test';
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
const SETTLE_TIMEOUT_MS = 5_000;

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

/** What every run of one measure() call shares, and the notes and gaps it collects. */
interface Measurement {
  ctx: MeasureContext;
  collector: ReturnType<typeof collector>;
  browser: Browser | null;
  categories: string[];
  notes: string[];
  unavailable: Unavailable[];
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
  const runs: RunData[] = [];
  const tally: RunTally = {
    navigated: 0,
    unsettled: 0,
    errors: new Set<string>(),
    overflow: { loaf: 0, events: 0, scrolls: 0 },
    supported: { loaf: true, event: true },
  };

  try {
    for (let run = 0; run <= ctx.options.runs; run++) {
      const data = await measureRun(m, cdp, tally, run, action);
      if (data) runs.push(data);
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
  return combineRuns(m, runs, tally.supported);
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
  return { ctx, collector: c, browser, categories, notes, unavailable };
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
): Promise<RunData | null> {
  const { ctx, browser, collector: c } = m;
  const { page, options } = ctx;
  if (run > 0) await resetPage(page, options);
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
  if (options.mode === 'full' && browser && ctx.list && run > 0) listPrepared = await ctx.list.prepare();
  if (options.mode === 'full' && browser) {
    const screenshots = listPrepared !== null && !('unavailable' in listPrepared);
    trace = await traceRun(
      browser,
      page,
      screenshots ? [...m.categories, ...SCREENSHOT_CATEGORIES] : m.categories,
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
  const { list, replay } = await analyzeListRun(m, listPrepared, trace);
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

  return summarizeRun(snapshot, trace, list, replay);
}

/**
 * One run's blank-row result, from the trace's screenshots, and its frames for a replay. The
 * screenshots are dropped from the trace afterwards.
 */
async function analyzeListRun(
  m: Measurement,
  listPrepared: ListPrepared | { unavailable: string } | null,
  trace: ParsedTrace | null,
): Promise<{ list: RunData['list']; replay: ReplayInput | null }> {
  const { ctx, notes } = m;
  let list: RunData['list'] = null;
  let replay: ReplayInput | null = null;
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
      if (ctx.options.replay !== 'off') {
        const t0 = trace.screenshotTimes[0] ?? 0;
        replay = {
          jpegs: trace.screenshots,
          timesMs: trace.screenshotTimes.map((t) => (t - t0) / 1000),
          drawn: analyzed.drawn,
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
  return { list, replay };
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
): Promise<SmoothnessResult> {
  const { ctx, notes, unavailable } = m;
  const { options } = ctx;
  const spreads: Record<string, Spread> = {};
  const addSpread: AddSpread = (name, values) => {
    const nums = values.filter((v): v is number => v !== null);
    if (nums.length) spreads[name] = spread(nums);
  };
  const { input, longFrames } = combineCollected(m, runs, supported, addSpread);
  const traced: TraceResults = options.mode === 'full' ? await combineTraces(m, runs, addSpread) : {};
  const { frames, budget120, profile, list } = traced;

  const classCount = (k: FrameClass) =>
    Math.round(median(runs.map((r) => r.classes.filter((c) => c === k).length)));
  const replaySource = pickReplaySource(runs, list);

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
  const { browser, notes, unavailable } = m;
  const perRun = runs.map((r) => r.trace?.frames ?? null).filter((f): f is FramesResult => f !== null);
  if (perRun.length === 0) {
    if (browser) for (const reason of reasons('frames')) unavailable.push({ measurement: 'frames', reason });
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
  const { ctx, browser, notes, unavailable } = m;
  const profiles = runs.map((r) => r.profile).filter((p): p is ProfileRun => p !== null);
  if (profiles.length === 0) {
    if (browser)
      for (const reason of reasons('profile')) unavailable.push({ measurement: 'profile', reason });
    return null;
  }
  if (profiles.length < runs.length) {
    notes.push(`The CPU profile was missing from ${runs.length - profiles.length} of ${runs.length} runs.`);
  }
  return combineProfiles(profiles, await resolveNames(ctx.page, profiles, notes));
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

/** The replay comes from the run whose blank-frame share is closest to the reported median. */
function pickReplaySource(runs: RunData[], list: ListResult | null | undefined): ReplayInput | null {
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
  return replaySource;
}
