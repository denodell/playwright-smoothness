// The default replay setting ('on-regression'): no replay while the list is fine, and a replay,
// named in the reporter's summary, once blank rows appear.
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { files, PLAYWRIGHT_CLI } from './helpers.js';

const CONFIG = 'tests/e2e/replay-project/playwright.config.ts';
const REPORTER = join(process.cwd(), 'dist', 'reporter.js');

let work: string;
test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'smoothness-replay-'));
});
test.afterAll(() => rmSync(work, { recursive: true, force: true }));
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

function run(env: Record<string, string> = {}) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(TEST_|PW_|GITHUB_)/.test(k)),
  );
  const out = join(work, 'out');
  const child = spawnSync(process.execPath, [PLAYWRIGHT_CLI, 'test', '-c', CONFIG], {
    env: {
      ...clean,
      SMOOTHNESS_E2E_OUT: out,
      SMOOTHNESS_E2E_SNAPSHOTS: join(work, 'snapshots'),
      SMOOTHNESS_REPORTER: REPORTER,
      ...env,
    },
    encoding: 'utf8',
    timeout: 200_000,
  });
  test.info().attach(`run ${JSON.stringify(env)}`, {
    body: `${child.stdout}\n${child.stderr}`,
    contentType: 'text/plain',
  });
  return { code: child.status, out };
}

test('a drawn list: baseline recorded, no replay', () => {
  test.skip(!existsSync(REPORTER), 'run npm run build first');
  const r = run();
  expect(r.code).toBe(0);
  expect(files(join(r.out, 'smoothness'), '.replay.webm')).toEqual([]);
});

test('blank rows appear: a warning and a replay', () => {
  test.skip(!existsSync(REPORTER), 'run npm run build first');
  const r = run({ ROW_COST: '15' });
  expect(r.code).toBe(0); // enforce: 'warn'
  const [webm] = files(join(r.out, 'smoothness'), '.replay.webm');
  expect(webm).toBeTruthy();
  expect(statSync(webm!).size).toBeGreaterThan(50_000);
  const summary = readFileSync(join(r.out, 'smoothness', 'summary.md'), 'utf8');
  expect(summary).toContain('blank list frames');
  expect(summary).toContain(
    'A replay of the scroll is attached to the test as `smoothness replay: catalogue`',
  );
});
