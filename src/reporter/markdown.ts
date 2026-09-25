// The pull-request summary: every check's change against its baseline, the scripts behind
// anything that got worse, and everything that couldn't be measured or compared.
import type { Check, SmoothnessResult } from '../types.js';
import { describeHotFunction, describeScript, formatDelta, formatValue } from '../baseline/message.js';

export interface ReportEntry {
  /** Test title path without the file, such as `filters › opens quickly`. */
  test: string;
  file: string;
  project: string;
  result: SmoothnessResult;
}

/** How many scripts and profile functions to name for each check that got worse. */
export const REPORT_SCRIPTS = 3;

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = (s: string) => '`' + s.replace(/`/g, "'") + '`';

/** `129ms (+20ms, +18%)`, the style the brief asks for; or just the value when not compared. */
export function changeCell(c: Check): string {
  if (c.change === 0) return `${formatValue(c.current, c.unit)} (no change)`;
  const delta = formatDelta(c);
  return delta
    ? `${formatValue(c.current, c.unit)} (${delta.replace(' (', ', ').replace(/\)$/, '')})`
    : formatValue(c.current, c.unit);
}

type Status = 'worse' | 'ok' | 'new' | 'not compared';

function statusOf(r: SmoothnessResult): Status {
  const s = r.comparison?.status;
  if (s === 'fail' || s === 'warn') return 'worse';
  if (s === 'pass' || s === 'baseline-updated') return 'ok';
  if (s === 'baseline-created') return 'new';
  return 'not compared';
}

export function buildMarkdown(entries: ReportEntry[], title = 'Smoothness'): string {
  // With several projects (browsers, devices), the same test appears once per project.
  const projects = new Set(entries.map((e) => e.project));
  const name = (e: ReportEntry) =>
    `${e.test} › "${e.result.label}"${projects.size > 1 && e.project ? ` [${e.project}]` : ''}`;
  const lines: string[] = [`## ${title}`, ''];
  if (entries.length === 0) {
    lines.push('No smoothness measurements ran.');
    return lines.join('\n') + '\n';
  }
  const by = (s: Status) => entries.filter((e) => statusOf(e.result) === s);
  const worse = by('worse');
  const counts = [
    worse.length ? `**${worse.length} got worse**` : '',
    by('ok').length ? `${by('ok').length} within baseline` : '',
    by('new').length ? `${by('new').length} new baseline${by('new').length === 1 ? '' : 's'}` : '',
    by('not compared').length ? `${by('not compared').length} not compared` : '',
  ].filter(Boolean);
  lines.push(counts.join(' · '), '');

  // Every compared check, worst first.
  const rows = entries.flatMap((e) => (e.result.comparison?.checks ?? []).map((c) => ({ e, c })));
  if (rows.length) {
    const rank = (c: Check) => (c.status === 'worse' ? 0 : c.status === 'pass' ? 2 : 1);
    rows.sort((a, b) => rank(a.c) - rank(b.c));
    lines.push('| | Measurement | Check | Now | Baseline | Allowed |', '|---|---|---|---|---|---|');
    for (const { e, c } of rows) {
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
      lines.push(
        `| ${mark} | ${cell(name(e))} | ${c.name} | ${cell(changeCell(c))} | ${formatValue(c.baseline, c.unit)} | ${allowed} |`,
      );
    }
    lines.push('');
  }

  if (worse.length) {
    lines.push('### What got worse', '');
    for (const e of worse) {
      const r = e.result;
      lines.push(`#### ${cell(name(e))}${r.comparison?.status === 'warn' ? ' (warning)' : ''}`, '');
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
      const noisy = r.comparison!.checks.filter((c) => c.noisy);
      for (const c of noisy) {
        lines.push(
          '',
          `> ${c.name} varied ${c.spreadPercent}% across runs, more than the allowed ${Math.round(r.settings.maxIncrease * 100)}%. Run \`npx playwright-smoothness calibrate\`.`,
        );
      }
      lines.push('');
    }
  }

  // Everything that couldn't be measured or compared, so nothing passes silently.
  const gaps: string[] = [];
  for (const e of entries) {
    const r = e.result;
    for (const u of r.unavailable)
      gaps.push(`- ${cell(name(e))}: ${u.measurement} unavailable: ${cell(u.reason)}`);
    if (!r.comparison) gaps.push(`- ${cell(name(e))}: not compared, because \`toBeSmooth()\` wasn't called`);
    else if (r.comparison.status === 'not-compared') {
      gaps.push(`- ${cell(name(e))}: not compared: ${cell(r.comparison.notes.join(' ') || 'no baseline')}`);
    } else if (r.comparison.status === 'baseline-created') {
      gaps.push(
        `- ${cell(name(e))}: new baseline recorded (${e.project || 'default project'}, ${r.mode} mode, ${r.machine.cpuModel})`,
      );
    }
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
  lines.push(`<sub>${browsers.join(', ')} · ${machines.join(', ')}</sub>`);
  return lines.join('\n') + '\n';
}
