// Turns several runs of the same suite into a suggested maxIncrease per check. Pure: the CLI
// does the running and file reading.
import type { SmoothnessResult } from '../types.js';
import { METRICS } from '../baseline/compare.js';
import { table } from '../baseline/message.js';
import { median } from '../analysis/stats.js';
import { DEFAULT_MAX_INCREASE } from '../options.js';

/** Suggestions are multiples of this, so small wobbles don't change the advice, and never less than one step. */
const SUGGESTION_STEP = 0.05;

export interface MetricCalibration {
  metric: string;
  name: string;
  gated: boolean;
  unit: string;
  runs: number;
  min: number;
  median: number;
  max: number;
  /** (max − min) / min × 100, on the quantity the check compares; null when min is 0. */
  spreadPercent: number | null;
  /** True when max − min fits within the metric's floor, so noise alone can't fail the check. */
  withinFloor: boolean;
  /** The smallest step-multiple above the spread; null when the floor already covers it. */
  suggestedMaxIncrease: number | null;
  warning?: string;
}

export interface CheckCalibration {
  /** Stable id: the result's path under test-results/smoothness/. */
  id: string;
  label: string;
  metrics: MetricCalibration[];
  /** The largest suggestion among gated metrics: what this check's maxIncrease should be. */
  suggestedMaxIncrease: number;
}

const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

/** The smallest multiple of SUGGESTION_STEP strictly above `fraction`. */
export function stepAbove(fraction: number): number {
  const steps = Math.floor(fraction / SUGGESTION_STEP + 1e-9) + 1;
  return round(steps * SUGGESTION_STEP, 2);
}

/** `runs` is one map per invocation of the suite, from result id to result. */
export function calibrate(runs: Map<string, SmoothnessResult>[]): CheckCalibration[] {
  const ids = [...new Set(runs.flatMap((r) => [...r.keys()]))].sort();
  const out: CheckCalibration[] = [];
  for (const id of ids) {
    const results = runs.map((r) => r.get(id)).filter((r): r is SmoothnessResult => !!r && r.runs > 0);
    if (results.length < 2) continue;
    const metrics: MetricCalibration[] = [];
    for (const m of METRICS) {
      const values = results.map((r) => m.read(r)).filter((v): v is number => typeof v === 'number');
      if (values.length < 2) continue;
      // Compare what the check compares: the bad share for on-time percentages.
      const bad = values.map((v) => (m.complement ? 100 - v : v));
      const min = Math.min(...bad);
      const max = Math.max(...bad);
      const range = max - min;
      const withinFloor = range <= m.floor;
      const fraction = min > 0 ? range / min : null;
      const gated = m.gated(results[0]!);
      const cal: MetricCalibration = {
        metric: m.metric,
        name: m.name,
        gated,
        unit: m.unit,
        runs: values.length,
        min: round(Math.min(...values)),
        median: round(median(values)),
        max: round(Math.max(...values)),
        spreadPercent: fraction === null ? null : round(fraction * 100),
        withinFloor,
        suggestedMaxIncrease: withinFloor ? null : fraction === null ? null : stepAbove(fraction),
      };
      if (!withinFloor && fraction === null) {
        cal.warning = `${m.name} went from 0 to ${round(max)} between runs, more than its floor (${m.floor}); no maxIncrease can absorb that. Try more \`runs\`, or a quieter machine.`;
      } else if (cal.suggestedMaxIncrease !== null && cal.suggestedMaxIncrease > DEFAULT_MAX_INCREASE) {
        cal.warning = `${m.name} varied ${cal.spreadPercent}% between runs on unchanged code, so it needs maxIncrease ${cal.suggestedMaxIncrease}, above the default ${DEFAULT_MAX_INCREASE}. It's noisy here: more \`runs\` or a dedicated runner would tighten it.`;
      }
      metrics.push(cal);
    }
    const gatedSuggestions = metrics
      .filter((c) => c.gated)
      .map((c) => c.suggestedMaxIncrease ?? SUGGESTION_STEP);
    out.push({
      id,
      label: results[0]!.label,
      metrics,
      suggestedMaxIncrease: gatedSuggestions.length ? Math.max(...gatedSuggestions) : SUGGESTION_STEP,
    });
  }
  return out;
}

export function formatCalibration(checks: CheckCalibration[], invocations: number): string {
  const lines: string[] = [`Calibration over ${invocations} runs of the suite on unchanged code.`, ''];
  if (!checks.length) {
    lines.push('No check produced results in at least two runs.');
    return lines.join('\n');
  }
  for (const c of checks) {
    lines.push(`"${c.label}"  (${c.id})`);
    const rows = [['check', 'min', 'median', 'max', 'spread', 'suggested maxIncrease']];
    for (const m of c.metrics) {
      const suffix = m.unit === 'ms' ? 'ms' : m.unit === '%' ? '%' : '';
      rows.push([
        `${m.name}${m.gated ? '' : ' (not gated)'}`,
        `${m.min}${suffix}`,
        `${m.median}${suffix}`,
        `${m.max}${suffix}`,
        m.withinFloor ? 'within floor' : m.spreadPercent === null ? 'from 0' : `${m.spreadPercent}%`,
        m.suggestedMaxIncrease === null ? '-' : String(m.suggestedMaxIncrease),
      ]);
    }
    lines.push(...table(rows));
    for (const m of c.metrics) if (m.warning) lines.push(`  Warning: ${m.warning}`);
    const gated = c.metrics.filter((m) => m.gated);
    if (gated.length && gated.every((m) => m.withinFloor)) {
      lines.push(
        "  Every change between runs was within the checks' floors, so noise alone can't fail this check. Keep the default maxIncrease " +
          `(${DEFAULT_MAX_INCREASE}), or anything above ${c.suggestedMaxIncrease}.`,
        '',
      );
    } else {
      lines.push(`  Suggested maxIncrease for this check: ${c.suggestedMaxIncrease}`, '');
    }
  }
  return lines.join('\n');
}
