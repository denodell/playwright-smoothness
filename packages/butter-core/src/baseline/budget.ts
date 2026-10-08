import type { Budget, BudgetCheck, SmoothnessResult } from '../types.js';

interface BudgetDef {
  key: keyof Budget;
  metric: string;
  name: string;
  unit: BudgetCheck['unit'];
  kind: BudgetCheck['kind'];
  source: string;
  read: (r: SmoothnessResult) => number | null | undefined;
  fullOnly?: boolean;
}

const DEFS: BudgetDef[] = [
  {
    key: 'maxInputToPaintMs',
    metric: 'input.p95ToPaintMs',
    name: 'input-to-paint (p95)',
    unit: 'ms',
    kind: 'max',
    source: 'input',
    read: (r) => r.input?.p95ToPaintMs,
  },
  {
    key: 'maxLongFrames',
    metric: 'longFrames.count',
    name: 'long frames',
    unit: 'count',
    kind: 'max',
    source: 'longFrames',
    read: (r) => r.longFrames?.count,
  },
  {
    key: 'minOnTimePercent',
    metric: 'frames.onTimePercent',
    name: 'frames on time',
    unit: '%',
    kind: 'min',
    source: 'frames',
    read: (r) => r.frames?.onTimePercent,
    fullOnly: true,
  },
  {
    key: 'maxBlankFramePercent',
    metric: 'list.blankFramePercent',
    name: 'blank list frames',
    unit: '%',
    kind: 'max',
    source: 'list',
    read: (r) => r.list?.blankFramePercent,
    fullOnly: true,
  },
];

const KEYS = new Set<string>(DEFS.map((d) => d.key));

export function validateBudget(budget: Budget): void {
  for (const [key, value] of Object.entries(budget)) {
    if (value === undefined) continue;
    if (!KEYS.has(key)) {
      throw new Error(`toBeSmooth(): unknown budget "${key}". Budgets are ${[...KEYS].join(', ')}.`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`toBeSmooth(): budget ${key} must be a number of 0 or more, got ${String(value)}.`);
    }
    if (key.endsWith('Percent') && value > 100) {
      throw new Error(
        `toBeSmooth(): budget ${key} is a percentage, so it must be 100 or less, got ${value}.`,
      );
    }
  }
}

export function checkBudget(result: SmoothnessResult, budget: Budget): BudgetCheck[] {
  validateBudget(budget);
  const checks: BudgetCheck[] = [];
  for (const d of DEFS) {
    const limit = budget[d.key];
    if (limit === undefined) continue;
    const current = d.read(result) ?? null;
    const check: BudgetCheck = {
      metric: d.metric,
      name: d.name,
      unit: d.unit,
      kind: d.kind,
      limit,
      current,
      status: 'pass',
    };
    if (current === null) {
      const why = result.unavailable.find((u) => u.measurement === d.source);
      if (d.key === 'maxInputToPaintMs' && result.input && !why) {
        if (limit >= 16) {
          check.reason = 'every interaction painted within 16ms';
        } else {
          check.status = 'unavailable';
          check.reason =
            "the browser only reports interactions of 16ms or more, so a lower budget can't be checked";
        }
      } else if (d.key === 'minOnTimePercent' && result.frames && !why) {
        check.reason = 'no frame had an update to show';
      } else {
        check.status = 'unavailable';
        check.reason =
          d.fullOnly && result.mode === 'quick'
            ? "only measured in full mode; set mode: 'full'"
            : (why?.reason ?? 'not measured in this run');
      }
      checks.push(check);
      continue;
    }
    const within = d.kind === 'max' ? current <= limit : current >= limit;
    check.status = within ? 'pass' : 'over';
    checks.push(check);
  }
  return checks;
}
