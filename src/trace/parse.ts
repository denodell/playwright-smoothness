// Parses a Chrome trace for frame delivery. The trace format is internal to Chrome and changes
// between versions, so nothing here is assumed: every event and field it needs is checked, and
// anything missing becomes an `unavailable` entry with the reason and the Chrome version.
// It never returns zero for "didn't see it".
import type { Budget120Result, FramesResult, Unavailable } from '../types.js';

/** performance.mark() names placed around each traced run. */
export const MARK_START = 'playwright-smoothness:start';
export const MARK_END = 'playwright-smoothness:end';

export interface TraceEvent {
  name: string;
  ph: string;
  ts: number;
  pid?: number;
  tid?: number;
  dur?: number;
  cat?: string;
  id?: string;
  id2?: { local?: string; global?: string };
  args?: Record<string, unknown>;
}

const PRESENTED = new Set(['STATE_PRESENTED_ALL', 'STATE_PRESENTED_PARTIAL']);
const DROPPED = 'STATE_DROPPED';
const NO_UPDATE = 'STATE_NO_UPDATE_DESIRED';
/** The 120Hz frame budget, ms. */
export const BUDGET_120_MS = 1000 / 120;

export interface ParseOptions {
  browserVersion: string;
  /** Also read AnimationFrame durations for the 120Hz prediction. */
  budget120: boolean;
  /** Also read the V8 CPU profile. */
  profile?: boolean;
}

export interface ProfileNode {
  fn: string;
  url: string;
  /** 1-based; 0 when unknown. */
  line: number;
  column: number;
  parent?: number;
}

/** The page main thread's CPU profile, with sample times on the page's performance.now() clock. */
export interface CpuProfile {
  nodes: Map<number, ProfileNode>;
  /** `t` is when the sample was taken (page ms); `ms` is the time it stands for. */
  samples: { t: number; ms: number; node: number }[];
}

export interface ParsedTrace {
  frames: FramesResult | null;
  budget120: Budget120Result | null;
  profile: CpuProfile | null;
  unavailable: Unavailable[];
  notes: string[];
}

type FrameReporter = {
  state?: unknown;
  frame_sequence?: unknown;
  frame_source?: unknown;
  layer_tree_host_id?: unknown;
};

interface Marks {
  window: [number, number];
  /** The start mark event: its pid/tid is the page's main thread, and it carries both clocks. */
  start: TraceEvent;
}

function findMarks(events: TraceEvent[]): Marks | null {
  let start: TraceEvent | undefined;
  let end: TraceEvent | undefined;
  for (const e of events) {
    if (e.name === MARK_START && !start) start = e;
    else if (e.name === MARK_END) end = e;
  }
  return start && end && end.ts >= start.ts ? { window: [start.ts, end.ts], start } : null;
}

type RawNode = {
  id?: number;
  parent?: number;
  callFrame?: { functionName?: string; url?: string; lineNumber?: number; columnNumber?: number };
};

/**
 * Reads the V8 CPU profile of the thread the marks came from (the page's main thread; workers
 * have their own profiles and are ignored). Sample times are converted to the page's clock
 * using the start mark, which records both its trace timestamp and its performance.now().
 */
function parseProfile(events: TraceEvent[], marks: Marks, chrome: string, out: ParsedTrace): void {
  const unavailable = (reason: string): void => {
    out.unavailable.push({ measurement: 'profile', reason: `${reason} (Chrome ${chrome})` });
  };
  const head = events.find(
    (e) =>
      e.name === 'Profile' && e.pid === marks.start.pid && e.tid === marks.start.tid && e.id !== undefined,
  );
  if (!head) return unavailable("the trace has no CPU profile for the page's main thread");
  const startUs = Number((head.args?.data as { startTime?: unknown } | undefined)?.startTime);
  const markPageMs = Number((marks.start.args?.data as { startTime?: unknown } | undefined)?.startTime);
  if (!Number.isFinite(startUs) || !Number.isFinite(markPageMs)) {
    return unavailable('the profile or start mark has no startTime to align clocks with');
  }
  // page ms = (trace µs − offset) / 1000, where the offset maps the mark's trace time to its page time.
  const offsetUs = marks.start.ts - markPageMs * 1000;

  const nodes = new Map<number, ProfileNode>();
  const raw: { t: number; node: number }[] = [];
  let t = startUs;
  for (const e of events) {
    if (e.name !== 'ProfileChunk' || e.pid !== head.pid || e.id !== head.id) continue;
    const data = e.args?.data as
      { cpuProfile?: { nodes?: RawNode[]; samples?: number[] }; timeDeltas?: number[] } | undefined;
    for (const n of data?.cpuProfile?.nodes ?? []) {
      if (typeof n.id !== 'number') continue;
      const cf = n.callFrame ?? {};
      nodes.set(n.id, {
        fn: cf.functionName || '(anonymous)',
        url: cf.url ?? '',
        line: typeof cf.lineNumber === 'number' && cf.lineNumber >= 0 ? cf.lineNumber + 1 : 0,
        column: typeof cf.columnNumber === 'number' && cf.columnNumber >= 0 ? cf.columnNumber + 1 : 0,
        ...(typeof n.parent === 'number' ? { parent: n.parent } : {}),
      });
    }
    const samples = data?.cpuProfile?.samples ?? [];
    const deltas = data?.timeDeltas ?? [];
    if (samples.length !== deltas.length) {
      return unavailable('a ProfileChunk has different numbers of samples and timeDeltas');
    }
    samples.forEach((node, i) => {
      t += deltas[i]!;
      raw.push({ t, node });
    });
  }
  if (raw.length === 0) return unavailable('the CPU profile has no samples');
  // Each sample stands for the time until the next one; the last gets the median interval.
  const gaps = raw
    .slice(1)
    .map((s, i) => s.t - raw[i]!.t)
    .sort((a, b) => a - b);
  const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 0;
  out.profile = {
    nodes,
    samples: raw.map((s, i) => ({
      t: (s.t - offsetUs) / 1000,
      ms: ((i + 1 < raw.length ? raw[i + 1]!.t - s.t : typical) || 0) / 1000,
      node: s.node,
    })),
  };
}

function parseFrames(events: TraceEvent[], window: [number, number], chrome: string, out: ParsedTrace): void {
  const unavailable = (reason: string): void => {
    out.unavailable.push({ measurement: 'frames', reason: `${reason} (Chrome ${chrome})` });
  };
  const reporters = events.filter((e) => e.name === 'PipelineReporter' && e.ph === 'b');
  if (reporters.length === 0) return unavailable('the trace has no PipelineReporter events');
  const withState = reporters.filter(
    (e) => typeof (e.args?.frame_reporter as FrameReporter | undefined)?.state === 'string',
  );
  if (withState.length === 0) return unavailable('PipelineReporter events have no args.frame_reporter.state');

  // Each frame can be reported more than once. Exact repeats (same host, source, sequence and
  // state) are dropped. A frame reported both presented and dropped keeps both: the compositor
  // presented while the main thread missed its update, which is what a blocked handler looks like.
  const seen = new Set<string>();
  const hosts = new Set<string>();
  const unknown = new Map<string, number>();
  let onTime = 0;
  let dropped = 0;
  for (const e of withState) {
    if (e.ts < window[0] || e.ts > window[1]) continue;
    const f = e.args!.frame_reporter as FrameReporter;
    const state = f.state as string;
    const key = [f.layer_tree_host_id, f.frame_source, f.frame_sequence, state].join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    hosts.add(String(f.layer_tree_host_id));
    if (PRESENTED.has(state)) onTime++;
    else if (state === DROPPED) dropped++;
    else if (state !== NO_UPDATE) unknown.set(state, (unknown.get(state) ?? 0) + 1);
  }
  if (unknown.size) {
    out.notes.push(
      `Frame states this version doesn't know were ignored: ${[...unknown].map(([s, n]) => `${s} ×${n}`).join(', ')} (Chrome ${chrome}).`,
    );
  }
  if (hosts.size > 1) {
    out.notes.push(
      `Frames came from ${hosts.size} compositors (for example iframes in other processes); they're counted together.`,
    );
  }
  const total = onTime + dropped;
  out.frames = {
    total,
    onTime,
    dropped,
    onTimePercent: total ? Math.round((1000 * onTime) / total) / 10 : null,
  };
}

function parseAnimationFrames(
  events: TraceEvent[],
  window: [number, number],
  chrome: string,
  out: ParsedTrace,
): void {
  const open = new Map<string, number>();
  const durations: number[] = [];
  let seen = 0;
  for (const e of events) {
    if (e.name !== 'AnimationFrame') continue;
    seen++;
    const id = e.id ?? e.id2?.local ?? e.id2?.global;
    if (e.ph === 'b' && id !== undefined) open.set(id, e.ts);
    else if (e.ph === 'e' && id !== undefined && open.has(id)) {
      const start = open.get(id)!;
      open.delete(id);
      if (start >= window[0] && start <= window[1]) durations.push((e.ts - start) / 1000);
    } else if (e.ph === 'X' && e.dur !== undefined && e.ts >= window[0] && e.ts <= window[1])
      durations.push(e.dur / 1000);
  }
  if (seen === 0) {
    out.unavailable.push({
      measurement: 'budget120',
      reason: `the trace has no AnimationFrame events (Chrome ${chrome})`,
    });
    return;
  }
  if (durations.length === 0) {
    out.unavailable.push({
      measurement: 'budget120',
      reason: `AnimationFrame events couldn't be paired into durations (Chrome ${chrome})`,
    });
    return;
  }
  out.budget120 = {
    framesOverBudget: durations.filter((d) => d > BUDGET_120_MS).length,
    frames: durations.length,
    predicted: true,
  };
}

export function parseTrace(events: TraceEvent[], options: ParseOptions): ParsedTrace {
  const out: ParsedTrace = { frames: null, budget120: null, profile: null, unavailable: [], notes: [] };
  const marks = findMarks(events);
  if (!marks) {
    out.unavailable.push({
      measurement: 'frames',
      reason: `the trace has no ${MARK_START} / ${MARK_END} marks to window it (Chrome ${options.browserVersion})`,
    });
    if (options.budget120)
      out.unavailable.push({ measurement: 'budget120', reason: 'the trace could not be windowed' });
    if (options.profile)
      out.unavailable.push({ measurement: 'profile', reason: 'the trace could not be windowed' });
    return out;
  }
  const window = marks.window;
  parseFrames(events, window, options.browserVersion, out);
  if (options.budget120) parseAnimationFrames(events, window, options.browserVersion, out);
  if (options.profile) parseProfile(events, marks, options.browserVersion, out);
  return out;
}
