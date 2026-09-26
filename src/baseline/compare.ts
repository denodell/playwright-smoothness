import type { Check, SmoothnessResult } from '../types.js';
import { round1 } from '../analysis/stats.js';

/** The metrics a baseline stores, keyed by result field. Null means "not measured". */
export type BaselineMetrics = Record<string, number | null>;

interface MetricDef {
  metric: string;
  name: string;
  unit: Check['unit'];
  read: (r: SmoothnessResult) => number | null | undefined;
  /** Which `unavailable` measurement explains a null. */
  source: string;
  /**
   * Smallest change that can count as worse, in the metric's unit, so a zero or tiny baseline
   * doesn't turn one extra frame into an infinite increase.
   */
  floor: number;
  /**
   * Compare the complement (100 − value): for on-time frames the bad share is what should be
   * compared relatively, or 95% → 81% would fall inside a 15% allowance.
   */
  complement?: boolean;
  gated: (r: SmoothnessResult) => boolean;
}

/**
 * Input-to-paint floor: 16ms, two Event Timing steps. Event Timing reports durations in 8ms
 * steps, so an 8ms floor would trip on a single rounding step.
 */
export const INPUT_FLOOR_MS = 16;
const LONG_FRAME_FLOOR = 1;
const PERCENT_FLOOR_POINTS = 1;
/** Total blocking time floor: one LoAF's worth of blocking beyond the 50ms budget. */
const BLOCKING_FLOOR_MS = 50;

export const METRICS: MetricDef[] = [
  {
    metric: 'input.p95ToPaintMs',
    name: 'input-to-paint (p95)',
    unit: 'ms',
    read: (r) => r.input?.p95ToPaintMs,
    source: 'input',
    floor: INPUT_FLOOR_MS,
    gated: () => true,
  },
  {
    metric: 'longFrames.count',
    name: 'long frames',
    unit: 'count',
    read: (r) => r.longFrames?.count,
    source: 'longFrames',
    floor: LONG_FRAME_FLOOR,
    gated: () => true,
  },
  {
    metric: 'longFrames.totalBlockingMs',
    name: 'total blocking time',
    unit: 'ms',
    read: (r) => r.longFrames?.totalBlockingMs,
    source: 'longFrames',
    floor: BLOCKING_FLOOR_MS,
    gated: (r) => r.settings.gateTotalBlocking,
  },
  {
    metric: 'frames.onTimePercent',
    name: 'frames on time',
    unit: '%',
    read: (r) => r.frames?.onTimePercent,
    source: 'frames',
    floor: PERCENT_FLOOR_POINTS,
    complement: true,
    gated: () => true,
  },
  {
    metric: 'list.blankFramePercent',
    name: 'blank list frames',
    unit: '%',
    read: (r) => r.list?.blankFramePercent,
    source: 'list',
    floor: PERCENT_FLOOR_POINTS,
    gated: () => true,
  },
];

/** Every metric a baseline records: gated or not, so turning a gate on later has data. */
export function metricsOf(result: SmoothnessResult): BaselineMetrics {
  const out: BaselineMetrics = {};
  for (const m of METRICS) {
    const v = m.read(result);
    if (v !== undefined) out[m.metric] = v;
  }
  return out;
}

/** (max − min) / median across runs, as a percentage; undefined when unknown. */
function spreadPercent(result: SmoothnessResult, metric: string): number | undefined {
  const s = result.spread[metric];
  if (!s || s.median === 0) return undefined;
  return round1((100 * (s.max - s.min)) / Math.abs(s.median));
}

/**
 * Compares a result with baseline metrics. Pure: no files, no test state.
 * Checks are returned for every gated metric that either side measured.
 */
export function compareMetrics(
  result: SmoothnessResult,
  baseline: BaselineMetrics,
  maxIncrease: number,
): Check[] {
  const checks: Check[] = [];
  for (const m of METRICS) {
    if (!m.gated(result)) continue;
    const current = m.read(result) ?? null;
    const baseValue = m.metric in baseline ? baseline[m.metric]! : null;
    // A metric neither side measured (full-mode fields in quick mode, or p95 on a scroll with
    // no clicks) isn't a check at all.
    if (current === null && baseValue === null) continue;

    const check: Check = {
      metric: m.metric,
      name: m.name,
      unit: m.unit,
      current,
      baseline: baseValue,
      change: null,
      changePercent: null,
      allowed: null,
      status: 'pass',
    };
    if (current === null) {
      const why = result.unavailable.find((u) => u.measurement === m.source);
      check.status = 'unavailable';
      check.reason = why ? why.reason : 'not measured in this run';
      checks.push(check);
      continue;
    }
    if (baseValue === null) {
      check.status = 'not-compared';
      check.reason =
        m.metric in baseline
          ? 'the baseline has no value for this metric'
          : 'the baseline predates this metric';
      checks.push(check);
      continue;
    }

    // Compare the "bad" quantity: the value itself, or 100 − value for on-time percentages.
    const bad = (v: number) => (m.complement ? 100 - v : v);
    const worseBy = bad(current) - bad(baseValue);
    const allowed = Math.max(bad(baseValue) * maxIncrease, m.floor);
    check.change = round1(current - baseValue);
    check.changePercent =
      baseValue === 0 ? null : round1((100 * (current - baseValue)) / Math.abs(baseValue));
    check.allowed = round1(allowed);
    check.status = worseBy > allowed ? 'worse' : 'pass';

    const sp = spreadPercent(result, m.metric);
    if (sp !== undefined) {
      check.spreadPercent = sp;
      if (sp > maxIncrease * 100) check.noisy = true;
    }
    checks.push(check);
  }
  return checks;
}
