// npx playwright-smoothness calibrate [--runs 5] [--out smoothness-calibration.json] [-- <playwright test args>]
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { forwardSlashes } from './output.js';
import type { SmoothnessResult } from './types.js';
import { calibrate, formatCalibration } from './calibrate/analyze.js';
import { CALIBRATE_ENV, PACKAGE_NAME } from './constants.js';

const HELP = `Usage: npx ${PACKAGE_NAME} calibrate [options] [-- <playwright test arguments>]

Runs your Playwright suite several times on unchanged code, and prints how much each
smoothness check varies between runs, with a suggested maxIncrease for each.

Options:
  --runs <n>     How many times to run the suite (default 5, at least 2)
  --out <file>   Where to write the results as JSON (default smoothness-calibration.json)
  --help         Show this help

Example:
  npx ${PACKAGE_NAME} calibrate --runs 5 -- --project=chromium tests/lists.spec.ts
`;

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? jsonFiles(p) : p.endsWith('.json') ? [p] : [];
  });
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

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    console.log(HELP);
    return command ? 0 : 1;
  }
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
    console.log(HELP);
    return 0;
  }
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 2) {
    console.error('--runs must be a whole number, 2 or more.');
    return 1;
  }

  const work = mkdtempSync(join(tmpdir(), 'smoothness-calibrate-'));
  const collected: Map<string, SmoothnessResult>[] = [];
  try {
    for (let i = 1; i <= runs; i++) {
      const outputDir = join(work, `run-${i}`);
      console.log(`Run ${i} of ${runs}…`);
      const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      const child = spawnSync(npx, ['playwright', 'test', `--output=${outputDir}`, ...passthrough], {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...process.env, [CALIBRATE_ENV]: '1' },
      });
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
      { schemaVersion: 1, kind: `${PACKAGE_NAME}-calibration`, invocations: runs, checks },
      null,
      2,
    ) + '\n',
  );
  console.log(`Written to ${values.out}`);
  return 0;
}
