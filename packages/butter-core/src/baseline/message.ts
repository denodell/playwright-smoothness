import { isAbsolute, relative } from 'node:path';
import type { BudgetCheck, Check, Comparison, HotFunction, SmoothnessResult, TopScript } from '../types.js';
import { CLI_NAME } from '../constants.js';
import { EVENT_TIMING_MIN_MS } from './compare.js';
import { round1 } from '../analysis/stats.js';
import { forwardSlashes } from '../output.js';

/** How many scripts a message names. */
const MESSAGE_SCRIPTS = 3;

const signed = (x: number) => (x > 0 ? `+${round1(x)}` : x < 0 ? `−${round1(-x)}` : '±0');

export function formatValue(v: number | null, unit: Check['unit']): string {
  if (v === null) return 'n/a';
  return unit === 'ms' ? `${round1(v)}ms` : unit === '%' ? `${round1(v)}%` : `${round1(v)}`;
}

/** The change on its own: `+20ms (+18%)`, `+2`, `−5 points`. Empty when not compared. */
export function formatDelta(c: Check): string {
  if (c.change === null) return '';
  if (c.unit === '%') return `${signed(c.change)} points`;
  const abs = c.unit === 'ms' ? `${signed(c.change)}ms` : signed(c.change);
  return c.changePercent === null ? abs : `${abs} (${signed(c.changePercent)}%)`;
}

/** `129ms (+20ms, +18%)`, `3 (+2)`, `92% (−5 points)`. */
export function formatChange(c: Check): string {
  if (c.current === null && c.status === 'pass') return `under ${EVENT_TIMING_MIN_MS}ms`;
  const now = formatValue(c.current, c.unit);
  if (c.change === null) return now;
  if (c.unit === '%') return `${now} (${signed(c.change)} points)`;
  const abs = c.unit === 'ms' ? `${signed(c.change)}ms` : signed(c.change);
  return c.changePercent === null ? `${now} (${abs})` : `${now} (${abs}, ${signed(c.changePercent)}%)`;
}

/** `app.js` from `http://localhost:4173/js/app.js?v=3`. */
export function shortSource(source: string): string {
  try {
    const u = new URL(source);
    return u.pathname.split('/').filter(Boolean).pop() ?? u.host;
  } catch {
    return source.split('/').pop() || source || 'unknown source';
  }
}

/** Relative to the working directory when inside it, absolute otherwise. */
function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return forwardSlashes(rel.startsWith('..') || isAbsolute(rel) ? path : rel);
}

/** How many callers a message shows for a hot function. */
const MESSAGE_CALLERS = 4;

/** `busyWait in work.js:3: 117.5ms self (149.9ms with calls), from onCheckout ← executeDispatch`. */
export function describeHotFunction(f: HotFunction): string {
  const where = f.url ? ` in ${shortSource(f.url)}${f.line ? `:${f.line}` : ''}` : '';
  const total = f.totalMs > f.selfMs ? ` (${round1(f.totalMs)}ms with calls)` : '';
  const from = f.callers.length
    ? `, from ${f.callers.slice(0, MESSAGE_CALLERS).join(' ← ')}${f.callers.length > MESSAGE_CALLERS ? ' ← …' : ''}`
    : '';
  return `${f.fn}${where}: ${round1(f.selfMs)}ms self${total}${from}`;
}

export function describeScript(s: TopScript): string {
  const fn = s.fn || '(anonymous)';
  const during = s.during.length ? `, during ${s.during.join(', ')}` : '';
  // Through a source map, the original file and line; otherwise the script as the page loaded it.
  const where = s.line ? `${shortSource(s.source)}:${s.line}` : shortSource(s.source);
  return `${fn} in ${where} (${s.invoker || s.invokerType}): ran ${round1(s.durationMs)}ms, ${round1(s.blockingMs)}ms of it blocking${during}`;
}

/** Left-aligned columns, indented two spaces. */
export function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map(
    (r) =>
      '  ' +
      r
        .map((cell, i) => cell.padEnd(widths[i]!))
        .join('  ')
        .trimEnd(),
  );
}

/**
 * The toBeSmooth() message. Leads with what got worse and which scripts were responsible,
 * then the numbers.
 */
export function formatMessage(result: SmoothnessResult, comparison: Comparison, cwd = process.cwd()): string {
  const lines: string[] = [];
  const worse = comparison.checks.filter((c) => c.status === 'worse');
  const missed = missedBudget(comparison);
  const topTarget = result.input?.byTarget[0];

  if (missed.length) {
    lines.push(`"${result.label}" missed its budget:`);
    for (const b of missed) {
      const where =
        b.metric.startsWith('input.') && topTarget && b.status === 'over'
          ? `, slowest: ${topTarget.event} on ${topTarget.target}`
          : '';
      lines.push(`  ${describeBudget(b)}${where}`);
    }
    lines.push('');
  }

  if (comparison.status === 'baseline-created') {
    lines.push(`"${result.label}": baseline recorded. Nothing to compare yet.`);
  } else if (comparison.status === 'not-compared') {
    lines.push(`"${result.label}": not compared with a baseline.`);
  } else if (worse.length) {
    lines.push(`"${result.label}" is less smooth than its baseline:`);
    for (const c of worse) {
      const where =
        c.metric.startsWith('input.') && topTarget
          ? `, slowest: ${topTarget.event} on ${topTarget.target}`
          : '';
      lines.push(`  ${c.name} ${formatChange(c)}${where}`);
    }
  } else {
    lines.push(`"${result.label}" is within ${round1(result.settings.maxIncrease * 100)}% of its baseline.`);
  }

  const blame = worse.length > 0 || missed.some((b) => b.status === 'over');
  const scripts = result.longFrames?.topScripts.slice(0, MESSAGE_SCRIPTS) ?? [];
  if (blame && scripts.length) {
    lines.push('', 'Scripts blocking the interaction:');
    scripts.forEach((s, i) => lines.push(`  ${i + 1}. ${describeScript(s)}`));
  }

  const hot = result.profile?.hotFunctions.slice(0, MESSAGE_SCRIPTS) ?? [];
  if (blame && hot.length) {
    lines.push('', 'Where the time went (CPU profile):');
    hot.forEach((f, i) => lines.push(`  ${i + 1}. ${describeHotFunction(f)}`));
  }

  if (comparison.checks.length) {
    lines.push('', 'Checks:');
    const rows = [['check', 'now', 'baseline', 'change', 'allowed', 'result']];
    for (const c of comparison.checks) {
      const change = formatDelta(c);
      const allowed =
        c.allowed === null
          ? ''
          : c.unit === '%'
            ? `${round1(c.allowed)} points`
            : formatValue(c.allowed, c.unit);
      const status =
        c.status === 'worse'
          ? 'WORSE'
          : c.status === 'pass'
            ? 'ok'
            : `${c.status}${c.reason ? `: ${c.reason}` : ''}`;
      rows.push([
        c.name,
        formatValue(c.current, c.unit),
        formatValue(c.baseline, c.unit),
        change,
        allowed ? `+${allowed}` : '',
        status,
      ]);
    }
    lines.push(...table(rows));
  }

  if (comparison.budget?.length) {
    lines.push('', 'Budget:');
    const rows = [['check', 'now', 'budget', 'result']];
    for (const b of comparison.budget) {
      const status =
        b.status === 'over' ? 'MISSED' : b.status === 'pass' ? 'ok' : `unavailable: ${b.reason ?? ''}`;
      rows.push([b.name, formatValue(b.current, b.unit), limitText(b), status]);
    }
    lines.push(...table(rows));
  }

  const noisy = comparison.checks.filter((c) => c.noisy);
  if (noisy.length) {
    lines.push('');
    for (const c of noisy) {
      lines.push(
        `Noise: ${c.name} varied ${c.spreadPercent}% across ${result.runs} runs, more than the allowed ${round1(result.settings.maxIncrease * 100)}%. ` +
          `A change this size can be noise. Run \`npx ${CLI_NAME} calibrate\` to choose a maxIncrease this check can meet.`,
      );
    }
  }

  const unavailable = result.unavailable.filter(
    (u) => !comparison.checks.some((c) => c.status === 'unavailable' && c.reason === u.reason),
  );
  if (unavailable.length) {
    lines.push('', 'Unavailable:');
    for (const u of unavailable) lines.push(`  ${u.measurement}: ${u.reason}`);
  }
  const notes = [...result.notes, ...comparison.notes];
  if (notes.length) {
    lines.push('', 'Notes:');
    for (const n of notes) lines.push(`  ${n}`);
  }

  if (comparison.baseline) {
    const b = comparison.baseline;
    lines.push(
      '',
      `Baseline: ${displayPath(b.path, cwd)} (${b.source}, recorded ${b.recordedAt.slice(0, 10)}, ${result.browserName} ${b.browserVersion}, ${b.machine.cpuModel})`,
    );
  }
  if (comparison.status === 'warn' && !missed.length) {
    lines.push(
      `This is a warning (enforce: 'warn'). Set enforce: 'fail' to fail the test once you trust this check.`,
    );
  }
  return lines.join('\n');
}

/** One line for annotations and GitHub warnings. */
export function formatSummary(result: SmoothnessResult, comparison: Comparison): string {
  const worse = comparison.checks.filter((c) => c.status === 'worse');
  const missed = missedBudget(comparison);
  if (!worse.length && !missed.length) return `"${result.label}": ${comparison.status}`;
  const top = result.longFrames?.topScripts[0];
  const blame = top ? `; top script ${top.fn || '(anonymous)'} in ${shortSource(top.source)}` : '';
  const parts = [
    missed.length ? `missed its budget: ${missed.map(describeBudget).join(', ')}` : '',
    worse.length ? `got worse: ${worse.map((c) => `${c.name} ${formatChange(c)}`).join(', ')}` : '',
  ].filter(Boolean);
  return `"${result.label}" ${parts.join('; ')}${blame}`;
}

export function missedBudget(comparison: Comparison): BudgetCheck[] {
  return comparison.budget?.filter((b) => b.status !== 'pass') ?? [];
}

export function limitText(b: BudgetCheck): string {
  return `${b.kind === 'max' ? 'at most' : 'at least'} ${formatValue(b.limit, b.unit)}`;
}

export function describeBudget(b: BudgetCheck): string {
  if (b.status === 'unavailable') return `${b.name}: couldn't be checked (${b.reason ?? 'not measured'})`;
  return `${b.name} ${formatValue(b.current, b.unit)} (budget: ${limitText(b)})`;
}
