import { isAbsolute, relative } from 'node:path';
import type { BudgetCheck, Check, Comparison, SmoothnessResult } from '../types.js';
import { round1 } from '../analysis/stats.js';
import { forwardSlashes } from '../output.js';
import { formatChange, formatValue, limitText, missedBudget } from './message.js';

const BRIEF_SCRIPTS = 5;
const BRIEF_FUNCTIONS = 8;

export interface BriefContext {
  rerun: string;
  resultFile: string;
  cwd?: string;
}

export function needsBrief(comparison: Comparison): boolean {
  return comparison.checks.some((c) => c.status === 'worse') || missedBudget(comparison).length > 0;
}

export function sourcePath(source: string): string {
  if (!source) return 'unknown source';
  try {
    const u = new URL(source);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:') {
      return decodeURIComponent(u.pathname);
    }
    return `${u.host}${decodeURIComponent(u.pathname)}`.replace(/^\/+/, '');
  } catch {
    return source;
  }
}

function where(source: string, line?: number): string {
  const path = sourcePath(source);
  return line ? `${path}:${line}` : path;
}

function show(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return forwardSlashes(rel.startsWith('..') || isAbsolute(rel) ? path : rel);
}

function worseLine(c: Check): string {
  const limit = c.allowed ?? 0;
  const allowed =
    c.unit === '%' ? `, allowed ${round1(limit)} points` : `, allowed +${formatValue(limit, c.unit)}`;
  return `- ${c.name}: ${formatChange(c)} against a baseline of ${formatValue(c.baseline, c.unit)}${allowed}`;
}

function budgetLine(b: BudgetCheck): string {
  if (b.status === 'unavailable') return `- ${b.name}: couldn't be checked (${b.reason ?? 'not measured'})`;
  return `- ${b.name}: ${formatValue(b.current, b.unit)}, budget ${limitText(b)}`;
}

export function formatBrief(result: SmoothnessResult, comparison: Comparison, ctx: BriefContext): string {
  const cwd = ctx.cwd ?? process.cwd();
  const worse = comparison.checks.filter((c) => c.status === 'worse');
  const missed = missedBudget(comparison);
  const testName = result.test
    ? `${result.test.title}${result.test.file ? ` (${result.test.file})` : ''}`
    : '';
  const lines: string[] = [`# Fix brief: "${result.label}"`, ''];
  if (testName) lines.push(`Test: ${testName}`);
  lines.push(
    `Measured: ${result.mode} mode, CPU slowed ${result.cpuThrottling}x, ${result.runs} runs, ${result.browserName} ${result.browserVersion}`,
    '',
  );

  lines.push('## What got worse', '');
  for (const c of worse) lines.push(worseLine(c));
  for (const b of missed) lines.push(budgetLine(b));
  lines.push('');

  lines.push('## Where', '');
  const targets = result.input?.byTarget ?? [];
  if (targets.length) {
    lines.push('Slowest interactions:', '');
    for (const t of targets.slice(0, 3))
      lines.push(`- ${t.event} on \`${t.target}\`: ${round1(t.ms)}ms to the next paint`);
    lines.push('');
  }
  const scripts = (result.longFrames?.topScripts ?? []).filter((s) => s.source).slice(0, BRIEF_SCRIPTS);
  if (scripts.length) {
    lines.push('Scripts running in the long frames:', '');
    for (const s of scripts) {
      const during = s.during.length ? `, during ${s.during.join(', ')}` : '';
      lines.push(
        `- \`${s.fn || '(anonymous)'}\` at ${where(s.source, s.line)}, run by ${s.invoker || s.invokerType}: ${round1(s.durationMs)}ms, ${round1(s.blockingMs)}ms of it blocking${during}`,
      );
    }
    lines.push('');
  }
  const hot = (result.profile?.hotFunctions ?? []).filter((f) => f.url).slice(0, BRIEF_FUNCTIONS);
  if (hot.length) {
    lines.push('Where the CPU time went (sampled):', '');
    for (const f of hot) {
      const from = f.callers.length ? `, called from ${f.callers.slice(0, 4).join(' ← ')}` : '';
      lines.push(
        `- \`${f.fn}\` at ${where(f.url, f.line || undefined)}: ${round1(f.selfMs)}ms itself, ${round1(f.totalMs)}ms with what it called${from}`,
      );
    }
    const builtins = (result.profile?.hotFunctions ?? []).filter(
      (f) => !f.url && !f.fn.startsWith('(') && f.selfMs >= 1,
    );
    if (builtins.length) {
      lines.push(
        `- Browser APIs that used time: ${builtins
          .slice(0, 5)
          .map((f) => `\`${f.fn}\` (${round1(f.selfMs)}ms${f.callers[0] ? `, from ${f.callers[0]}` : ''})`)
          .join(', ')}`,
      );
    }
    lines.push('');
  }
  if (result.frames && result.frames.total) {
    lines.push(
      `Frames: ${result.frames.onTime} of ${result.frames.total} on time, ${result.frames.dropped} dropped.`,
    );
  }
  if (result.list) {
    lines.push(
      `List: blank in ${result.list.blankFrames} of ${result.list.frames} frames; the emptiest frame was ${round1(result.list.leastDrawnPercent)}% drawn.${result.list.virtualized ? ' The list is virtualized.' : ''}`,
    );
  }
  if ((result.frames && result.frames.total) || result.list) lines.push('');
  if (!targets.length && !scripts.length && !hot.length && !result.frames && !result.list) {
    lines.push('Nothing pointed at specific code. Running it in full mode adds a CPU profile.', '');
  }

  lines.push('## Check a fix', '');
  lines.push(
    '1. Run the check on the unchanged code first. Baselines belong to the machine they were recorded on, so this records one for yours:',
    '',
    '   ```',
    `   ${ctx.rerun} --update-snapshots=all`,
    '   ```',
    '',
    '2. Make the change.',
    '3. Run it again, without updating:',
    '',
    '   ```',
    `   ${ctx.rerun}`,
    '   ```',
    '',
    "Leave the baseline files these runs write out of the commit: they're for this machine only.",
    '',
  );
  const fromMain = worse.map((c) => `${c.name} ${formatValue(c.baseline, c.unit)}`);
  const budgets = missed.filter((b) => b.status === 'over').map((b) => `${b.name} ${limitText(b)}`);
  lines.push(
    "It's fixed when the second run is clearly better than the first." +
      (fromMain.length
        ? ` The baseline had ${fromMain.join(' and ')}. A baseline from CI was measured on a different machine, so treat it as a direction rather than a target.`
        : '') +
      (budgets.length ? ` The budget asks for ${budgets.join(' and ')}.` : '') +
      ` The numbers are in \`${show(ctx.resultFile, cwd)}\`.`,
  );
  if (result.replay) lines.push('', `A slowed-down replay of the run is next to it: \`${result.replay}\`.`);
  return lines.join('\n') + '\n';
}
