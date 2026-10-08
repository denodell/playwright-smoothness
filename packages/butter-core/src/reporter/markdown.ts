// The pull-request summary: every check's change against its baseline, the scripts behind
// anything that got worse, and everything that couldn't be measured or compared.
import { sep } from 'node:path';
import type { BudgetCheck, Check, SmoothnessResult } from '../types.js';
import { CLI_NAME } from '../constants.js';
import {
  describeBudget,
  describeHotFunction,
  describeScript,
  formatChange,
  formatValue,
  limitText,
  missedBudget,
} from '../baseline/message.js';

export interface ReportEntry {
  /** Test title path without the file, such as `filters › opens quickly`. */
  test: string;
  file: string;
  project: string;
  result: SmoothnessResult;
}

/** How many scripts and profile functions to name for each check that got worse. */
const REPORT_SCRIPTS = 3;

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = (s: string) => '`' + s.replace(/`/g, "'") + '`';

/** `129ms (+20ms, +18%)`, `129ms (no change)`, or just the value when not compared. */
export function changeCell(c: Check): string {
  return c.change === 0 ? `${formatValue(c.current, c.unit)} (no change)` : formatChange(c);
}

type Status = 'worse' | 'ok' | 'new' | 'updated' | 'not compared';

function statusOf(r: SmoothnessResult): Status {
  const s = r.comparison?.status;
  if (s === 'fail' || s === 'warn' || (r.comparison && missedBudget(r.comparison).length)) return 'worse';
  if (s === 'pass') return 'ok';
  if (s === 'baseline-created') return 'new';
  if (s === 'baseline-updated') return 'updated';
  return 'not compared';
}

/** Notes from automatic mode while a test has too few main-branch runs to compare against. */
const BUILDING_HISTORY = /^Building history: (\d+) of (\d+)/;

export function buildMarkdown(entries: ReportEntry[], title = 'Smoothness', cwd = process.cwd()): string {
  // With several projects (browsers, devices), the same test appears once per project. In
  // automatic mode the label is the test's own title, so it's named once.
  const projects = new Set(entries.map((e) => e.project));
  const name = (e: ReportEntry) =>
    `${e.result.label === e.test ? e.test : `${e.test} › "${e.result.label}"`}${projects.size > 1 && e.project ? ` [${e.project}]` : ''}`;
  // Paths in notes, relative to the project, as a reader would look for them.
  const roots = [...new Set([cwd + sep, cwd.replace(/\\/g, '/') + '/'])];
  const relative = (s: string) => roots.reduce((out, root) => out.split(root).join(''), s);
  const lines: string[] = [`## ${title}`, ''];
  if (entries.length === 0) {
    lines.push(
      'No smoothness measurements ran. Results come from `butter.measure()` and `butter.scroll()`, and in automatic mode from tests that load a page in Chromium, using a `test` wrapped with `withButter()`.',
    );
    return lines.join('\n') + '\n';
  }
  const by = (s: Status) => entries.filter((e) => statusOf(e.result) === s);
  const worse = by('worse');
  const counts = [
    worse.length ? `**${worse.length} got worse**` : '',
    by('ok').length ? `${by('ok').length} within baseline` : '',
    by('new').length ? `${by('new').length} new baseline${by('new').length === 1 ? '' : 's'}` : '',
    by('updated').length
      ? `${by('updated').length} baseline${by('updated').length === 1 ? '' : 's'} re-recorded`
      : '',
    by('not compared').length ? `${by('not compared').length} not compared` : '',
  ].filter(Boolean);
  lines.push(counts.join(', '), '');

  // The checks that got worse or couldn't be compared, worst first. Passing checks are folded
  // away underneath, so a large suite's summary leads with what needs attention.
  // A re-recorded baseline's checks compare with the baseline it replaced, so they're listed with
  // it below instead.
  const rows = entries
    .filter((e) => statusOf(e.result) !== 'updated')
    .flatMap((e) => (e.result.comparison?.checks ?? []).map((c) => ({ e, c })));
  const header = ['| | Measurement | Check | Now | Baseline | Allowed |', '|---|---|---|---|---|---|'];
  const row = ({ e, c }: { e: ReportEntry; c: Check }) => {
    const mark =
      c.status === 'worse'
        ? e.result.comparison?.status === 'fail'
          ? '**Failed**'
          : '**Worse**'
        : c.status === 'pass'
          ? 'OK'
          : c.status === 'unavailable'
            ? 'Unavailable'
            : 'Not compared';
    const allowed =
      c.allowed === null
        ? ''
        : c.unit === '%'
          ? `+${c.allowed} points`
          : `+${formatValue(c.allowed, c.unit)}`;
    return `| ${mark} | ${cell(name(e))} | ${c.name} | ${cell(changeCell(c))} | ${formatValue(c.baseline, c.unit)} | ${allowed} |`;
  };
  const budgets = entries.flatMap((e) => (e.result.comparison?.budget ?? []).map((b) => ({ e, b })));
  const budgetRow = ({ e, b }: { e: ReportEntry; b: BudgetCheck }) => {
    const mark =
      b.status === 'over' ? '**Over budget**' : b.status === 'pass' ? 'OK' : '**Unchecked budget**';
    const now =
      b.status === 'unavailable' ? cell(b.reason ?? 'not measured') : formatValue(b.current, b.unit);
    return `| ${mark} | ${cell(name(e))} | ${b.name} | ${now} | budget: ${limitText(b)} | |`;
  };
  const attention = rows.filter((r) => r.c.status !== 'pass');
  attention.sort((a, b) => (a.c.status === 'worse' ? 0 : 1) - (b.c.status === 'worse' ? 0 : 1));
  const budgetAttention = budgets.filter((x) => x.b.status !== 'pass');
  if (attention.length || budgetAttention.length) {
    lines.push(...header, ...budgetAttention.map(budgetRow), ...attention.map(row), '');
  }
  const passing = rows.filter((r) => r.c.status === 'pass');
  const budgetPassing = budgets.filter((x) => x.b.status === 'pass');
  const passCount = passing.length + budgetPassing.length;
  if (passCount) {
    lines.push(
      '<details>',
      `<summary>${passCount} check${passCount === 1 ? '' : 's'} within baseline${budgetPassing.length ? ' or budget' : ''}</summary>`,
      '',
      ...header,
      ...budgetPassing.map(budgetRow),
      ...passing.map(row),
      '',
      '</details>',
      '',
    );
  }

  if (worse.length) {
    lines.push('### What got worse', '');
    for (const e of worse) {
      const r = e.result;
      const missed = missedBudget(r.comparison!);
      const warning = r.comparison?.status === 'warn' && !missed.length;
      lines.push(`#### ${cell(name(e))}${warning ? ' (warning)' : ''}`, '');
      for (const b of missed) lines.push(`- ${cell(describeBudget(b))}`);
      for (const c of r.comparison!.checks.filter((x) => x.status === 'worse')) {
        const slowest =
          c.metric.startsWith('input.') && r.input?.byTarget[0]
            ? `; slowest: ${r.input.byTarget[0].event} on ${code(r.input.byTarget[0].target)}`
            : '';
        lines.push(`- ${c.name}: ${changeCell(c)}${slowest}`);
      }
      const scripts = r.longFrames?.topScripts.slice(0, REPORT_SCRIPTS) ?? [];
      if (scripts.length) {
        lines.push('', 'Scripts blocking the interaction:', '');
        scripts.forEach((s, i) => lines.push(`${i + 1}. ${cell(describeScript(s))}`));
      }
      const hot = r.profile?.hotFunctions.slice(0, REPORT_SCRIPTS) ?? [];
      if (hot.length) {
        lines.push('', 'Where the time went (CPU profile):', '');
        hot.forEach((f, i) => lines.push(`${i + 1}. ${cell(describeHotFunction(f))}`));
      }
      if (r.replay) {
        lines.push(
          '',
          `A replay of the scroll is attached to the test as \`smoothness replay: ${cell(r.label)}\` (${code(r.replay)}).`,
        );
      }
      const noisy = r.comparison!.checks.filter((c) => c.noisy);
      for (const c of noisy) {
        lines.push(
          '',
          `> ${c.name} varied ${c.spreadPercent}% across runs, more than the allowed ${Math.round(r.settings.maxIncrease * 100)}%. Run \`npx ${CLI_NAME} calibrate\`.`,
        );
      }
      lines.push('');
    }
  }

  // Everything that couldn't be measured or compared, so nothing passes silently.
  const gaps: string[] = [];
  let building = 0;
  let needed = 0;
  for (const e of entries) {
    const r = e.result;
    for (const u of r.unavailable)
      gaps.push(`- ${cell(name(e))}: ${u.measurement} unavailable: ${cell(relative(u.reason))}`);
    if (!r.comparison) gaps.push(`- ${cell(name(e))}: not compared, because \`toBeSmooth()\` wasn't called`);
    else if (r.comparison.status === 'not-compared') {
      const history = r.comparison.notes.map((n) => BUILDING_HISTORY.exec(n)).find(Boolean);
      if (history) {
        building++;
        needed = Number(history[2]);
        continue;
      }
      gaps.push(
        `- ${cell(name(e))}: not compared: ${cell(relative(r.comparison.notes.join(' ')) || 'no baseline')}`,
      );
    } else if (r.comparison.status === 'baseline-created') {
      gaps.push(
        `- ${cell(name(e))}: new baseline recorded (${e.project || 'default project'}, ${r.mode} mode, ${r.machine.cpuModel})`,
      );
    } else if (r.comparison.status === 'baseline-updated') {
      const worse = r.comparison.checks.filter((c) => c.status === 'worse');
      gaps.push(
        `- ${cell(name(e))}: baseline re-recorded` +
          (worse.length
            ? `; compared with the one it replaced: ${worse.map((c) => `${c.name} ${cell(changeCell(c))}`).join(', ')}`
            : ''),
      );
    }
  }
  if (building) {
    gaps.unshift(
      `- ${building} test${building === 1 ? ' is' : 's are'} building history in automatic mode: each needs ${needed} main-branch runs before it's compared.`,
    );
  }
  if (gaps.length) lines.push('### Not measured, not compared, or new', '', ...gaps, '');

  const machines = [
    ...new Set(entries.map((e) => `${e.result.machine.cpuModel} (${e.result.machine.cpus} CPUs)`)),
  ];
  const browsers = [
    ...new Set(
      entries.map((e) => `${e.result.browserName} ${e.result.browserVersion} (${e.result.headlessMode})`),
    ),
  ];
  lines.push(`<sub>${browsers.join(', ')}, on ${machines.join(', ')}</sub>`);
  return lines.join('\n') + '\n';
}
