// npx playwright-butter calibrate [--runs 5] [--out smoothness-calibration.json] [-- <playwright test args>]
// npx playwright-butter summary [--results test-results] [--out <file>] [--title <title>] [--github-summary]
// npx playwright-butter brief [--results test-results] [--out <file>]
// npx playwright-butter init-agents [--dir <folder>]... [--no-agents-md]
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import {
  CALIBRATE_ENV,
  FORMAT_NAME,
  buildMarkdown,
  calibrate,
  formatCalibration,
  forwardSlashes,
  type ReportEntry,
  type SmoothnessResult,
} from 'butter-core';
import { PACKAGE_NAME } from './constants.js';
import { SKILL_DIRS, initAgents } from './init-agents.js';

const HELP = `Usage: npx ${PACKAGE_NAME} <command> [options]

Commands:
  calibrate   How much each check varies between runs, with a suggested maxIncrease
  summary     The Markdown summary of the last run, from its result files
  brief       Every fix brief from the last run, in one document for a coding agent
  init-agents  Add the skill that teaches coding agents to fix what the checks find

Run a command with --help for its options.
`;

const CALIBRATE_HELP = `Usage: npx ${PACKAGE_NAME} calibrate [options] [-- <playwright test arguments>]

Runs your Playwright suite several times on unchanged code, and prints how much each
smoothness check varies between runs, with a suggested maxIncrease for each.

Options:
  --runs <n>     How many times to run the suite (default 5, at least 2)
  --out <file>   Where to write the results as JSON (default smoothness-calibration.json)
  --help         Show this help

Example:
  npx ${PACKAGE_NAME} calibrate --runs 5 -- --project=chromium tests/lists.spec.ts
`;

function filesEndingIn(dir: string, ending: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesEndingIn(p, ending) : p.endsWith(ending) ? [p] : [];
  });
}

const jsonFiles = (dir: string) => filesEndingIn(dir, '.json');

function latestAttempts(files: string[]): string[] {
  const latest = new Map<string, { retry: number; files: string[] }>();
  for (const file of files) {
    const dir = dirname(file);
    const m = /^(.*)-retry(\d+)$/.exec(basename(dir));
    const key = m ? join(dirname(dir), m[1]!) : dir;
    const retry = m ? Number(m[2]) : 0;
    const seen = latest.get(key);
    if (!seen || retry > seen.retry) latest.set(key, { retry, files: [file] });
    else if (retry === seen.retry) seen.files.push(file);
  }
  return [...latest.values()].flatMap(({ files }) => files.sort());
}

function collect(outputDir: string): Map<string, SmoothnessResult> {
  const root = join(outputDir, 'smoothness');
  const results = new Map<string, SmoothnessResult>();
  for (const file of jsonFiles(root)) {
    const id = forwardSlashes(relative(root, file));
    if (/-retry\d+\//.test(id)) continue; // a retry is a different attempt, not another sample
    try {
      const r = JSON.parse(readFileSync(file, 'utf8')) as SmoothnessResult;
      if (r.schemaVersion === 1) results.set(id, r);
    } catch {
      // unreadable file: skipped
    }
  }
  return results;
}

const SUMMARY_HELP = `Usage: npx ${PACKAGE_NAME} summary [options]

Writes the Markdown summary of the last run from its result files, the same summary the
reporter writes, for runs that didn't use the reporter.

Options:
  --results <dir>    Playwright's output directory (default test-results)
  --out <file>       Where to write it (default <results>/smoothness/summary.md)
  --title <title>    The summary's heading (default Smoothness)
  --github-summary   Also add it to the GitHub Actions job summary
  --help             Show this help
`;

export function readResults(results: string): ReportEntry[] {
  const entries: ReportEntry[] = [];
  for (const file of latestAttempts(jsonFiles(join(results, 'smoothness')))) {
    try {
      const r = JSON.parse(readFileSync(file, 'utf8')) as SmoothnessResult;
      if (r.schemaVersion !== 1 || typeof r.label !== 'string') continue;
      entries.push({
        test: r.test?.title ?? basename(dirname(file)),
        file: r.test?.file ?? '',
        project: r.test?.project ?? '',
        result: r,
      });
    } catch {
      continue;
    }
  }
  return entries;
}

const BRIEF_HELP = `Usage: npx ${PACKAGE_NAME} brief [options]

Prints every fix brief from the last run as one document, for a coding agent. A brief is
written next to each check that got worse or missed its budget.

Options:
  --results <dir>   Playwright's output directory (default test-results)
  --out <file>      Write it to a file instead of printing it
  --help            Show this help
`;

export function collectBriefs(results: string): string {
  const briefs = latestAttempts(filesEndingIn(join(results, 'smoothness'), '.fix.md')).map((f) =>
    readFileSync(f, 'utf8').trimEnd(),
  );
  if (!briefs.length) return '';
  const head =
    briefs.length === 1
      ? ''
      : `# ${briefs.length} smoothness checks to fix\n\nEach section is one check. Fix and re-run them one at a time.\n\n`;
  return (
    head +
    briefs
      .map((b) =>
        briefs.length === 1 ? b : b.replace(/^# /gm, '## ').replace(/^## (?!Fix brief)/gm, '### '),
      )
      .join('\n\n') +
    '\n'
  );
}

function brief(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      results: { type: 'string', default: 'test-results' },
      out: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(BRIEF_HELP);
    return 0;
  }
  const md = collectBriefs(values.results!);
  if (!md) {
    console.error('No fix briefs: no smoothness check got worse or missed its budget in the last run.');
    return 0;
  }
  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, md);
    console.error(`Fix briefs written to ${values.out}`);
  } else {
    process.stdout.write(md);
  }
  return 0;
}

const INIT_AGENTS_HELP = `Usage: npx ${PACKAGE_NAME} init-agents [options]

Adds the ${PACKAGE_NAME} skill to this project, so coding agents know how to fix a
check that got worse: read the fix brief, record a baseline, make the change, and prove it.
It goes in ${SKILL_DIRS.join(' and ')}, and AGENTS.md gets a short section pointing to it.
Run it again after upgrading to update the skill.

Options:
  --dir <folder>    Where skills go, instead of the defaults (repeat for more than one)
  --no-agents-md    Leave AGENTS.md alone
  --help            Show this help
`;

function initAgentsCommand(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: 'string', multiple: true },
      'no-agents-md': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(INIT_AGENTS_HELP);
    return 0;
  }
  const written = initAgents({
    cwd: process.cwd(),
    dirs: values.dir ?? SKILL_DIRS,
    agentsMd: !values['no-agents-md'],
  });
  console.log(`Added the ${PACKAGE_NAME} skill:\n${written.map((w) => `  ${w}`).join('\n')}`);
  return 0;
}

function summary(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      results: { type: 'string', default: 'test-results' },
      out: { type: 'string' },
      title: { type: 'string' },
      'github-summary': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(SUMMARY_HELP);
    return 0;
  }
  const entries = readResults(values.results!);
  const out = values.out ?? join(values.results!, 'smoothness', 'summary.md');
  const md = buildMarkdown(entries, values.title);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md);
  const jobSummary = process.env.GITHUB_STEP_SUMMARY;
  if (values['github-summary'] && jobSummary) appendFileSync(jobSummary, md + '\n');
  console.log(`Smoothness summary of ${entries.length} result(s): ${out}`);
  return 0;
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    console.log(HELP);
    return command ? 0 : 1;
  }
  if (command === 'summary') return summary(rest);
  if (command === 'brief') return brief(rest);
  if (command === 'init-agents') return initAgentsCommand(rest);
  if (command !== 'calibrate') {
    console.error(`Unknown command '${command}'.\n\n${HELP}`);
    return 1;
  }
  const dash = rest.indexOf('--');
  const own = dash < 0 ? rest : rest.slice(0, dash);
  const passthrough = dash < 0 ? [] : rest.slice(dash + 1);
  const { values } = parseArgs({
    args: own,
    options: {
      runs: { type: 'string', default: '5' },
      out: { type: 'string', default: 'smoothness-calibration.json' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(CALIBRATE_HELP);
    return 0;
  }
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 2) {
    console.error('--runs must be a whole number, 2 or more.');
    return 1;
  }

  // Playwright's CLI script, from the project being calibrated. It's run with node directly:
  // on Windows, Node won't spawn npx.cmd without a shell.
  let playwrightCli: string;
  try {
    playwrightCli = createRequire(join(process.cwd(), 'package.json')).resolve('@playwright/test/cli');
  } catch {
    console.error("Couldn't find @playwright/test in this project. Run calibrate from the project's folder.");
    return 1;
  }
  const work = mkdtempSync(join(tmpdir(), 'smoothness-calibrate-'));
  const collected: Map<string, SmoothnessResult>[] = [];
  try {
    for (let i = 1; i <= runs; i++) {
      const outputDir = join(work, `run-${i}`);
      console.log(`Run ${i} of ${runs}…`);
      const child = spawnSync(
        process.execPath,
        [playwrightCli, 'test', `--output=${outputDir}`, ...passthrough],
        {
          stdio: ['ignore', 'ignore', 'inherit'],
          env: { ...process.env, [CALIBRATE_ENV]: '1' },
        },
      );
      if (child.error) {
        console.error(`Couldn't run Playwright: ${child.error.message}`);
        return 1;
      }
      const results = collect(outputDir);
      if (child.status !== 0)
        console.warn(`  Run ${i}: some tests failed; their smoothness results are still used.`);
      console.log(`  ${results.size} smoothness result(s)`);
      collected.push(results);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const checks = calibrate(collected);
  console.log('\n' + formatCalibration(checks, runs));
  writeFileSync(
    values.out!,
    JSON.stringify(
      { schemaVersion: 1, kind: `${FORMAT_NAME}-calibration`, invocations: runs, checks },
      null,
      2,
    ) + '\n',
  );
  console.log(`Written to ${values.out}`);
  return 0;
}
