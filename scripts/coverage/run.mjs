import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..', '..');
const work = join(repo, 'coverage', '.tmp');
const rawDir = join(work, 'raw');
const reportDir = join(work, 'report');
const pageDir = join(work, 'page');
const cacheDir = join(work, 'transform-cache');
rmSync(join(repo, 'coverage'), { recursive: true, force: true });
for (const d of [rawDir, pageDir, cacheDir]) mkdirSync(d, { recursive: true });

const run = (args, env = {}) =>
  spawnSync(process.execPath, args, { cwd: repo, stdio: 'inherit', env: { ...process.env, ...env } }).status;

const projects = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['--project=unit', '--project=integration', '--project=e2e'];
const status = run([join(repo, 'node_modules/@playwright/test/cli.js'), 'test', ...projects], {
  NODE_V8_COVERAGE: rawDir,
  COVERAGE_PAGE_DIR: pageDir,
  PWTEST_CACHE_DIR: cacheDir,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${join(repo, 'scripts/coverage/page-coverage.mjs')}`,
});
run([join(repo, 'scripts/coverage/merge.mjs'), rawDir, pageDir, cacheDir, reportDir]);
run([join(repo, 'node_modules/c8/bin/c8.js'), 'report', `--temp-directory=${reportDir}`]);
process.exit(status ?? 1);
