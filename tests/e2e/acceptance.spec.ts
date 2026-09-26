// End to end: a user project is run in a child Playwright process, so baselines
// go through real snapshot paths, --update-snapshots and exit codes.
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SmoothnessResult } from '../../src/types.js';
import { files, PLAYWRIGHT_CLI } from './helpers.js';

const CONFIG = 'tests/e2e/fixture-project/playwright.config.ts';

let work: string;
test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'smoothness-e2e-'));
});
test.afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Runs the fixture project once and returns its exit code, output and result JSON. */
function run(env: Record<string, string>, args: string[] = []) {
  const out = join(work, 'out');
  // Drop the parent run's worker variables so the child is an ordinary top-level run.
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TEST_|PW_)/.test(k)));
  const child = spawnSync(process.execPath, [PLAYWRIGHT_CLI, 'test', '-c', CONFIG, ...args], {
    env: {
      ...clean,
      GITHUB_ACTIONS: '',
      SMOOTHNESS_E2E_OUT: out,
      SMOOTHNESS_E2E_SNAPSHOTS: join(work, 'snapshots'),
      ...env,
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const [jsonPath] = files(join(out, 'smoothness'), 'checkout.json');
  const result = jsonPath ? (JSON.parse(readFileSync(jsonPath, 'utf8')) as SmoothnessResult) : null;
  const output = `${child.stdout}\n${child.stderr}`;
  test
    .info()
    .attach(`run ${JSON.stringify(env)} ${args.join(' ')}`, { body: output, contentType: 'text/plain' });
  return { code: child.status, output, result };
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

test('first run records the baseline and passes', () => {
  const r = run({ CLICK_MS: '10' });
  expect(r.code, r.output).toBe(0);
  expect(r.result!.comparison!.status).toBe('baseline-created');
  expect(files(join(work, 'snapshots'), '.json')).toHaveLength(1);
});

test('an unchanged run (a change within noise) passes', () => {
  const r = run({ CLICK_MS: '10' });
  expect(r.code, r.output).toBe(0);
  expect(r.result!.comparison!.status).toBe('pass');
});

test("10ms → 60ms click work fails with enforce: 'fail', naming the element and the handler", () => {
  const r = run({ CLICK_MS: '60', ENFORCE: 'fail' });
  expect(r.code, r.output).toBe(1);
  expect(r.result!.comparison!.status).toBe('fail');
  expect(r.output).toContain('"checkout" is less smooth than its baseline');
  expect(r.output).toContain('click on button#heavy');
  expect(r.output).toContain('onHeavyClick in click.js');
});

test("the same regression with enforce: 'warn' passes, annotates, and warns on the pull request", () => {
  const r = run({ CLICK_MS: '60', GITHUB_ACTIONS: 'true' });
  expect(r.code, r.output).toBe(0);
  expect(r.result!.comparison!.status).toBe('warn');
  expect(r.output).toMatch(
    /::warning file=tests\/e2e\/fixture-project\/checkout\.spec\.ts,line=\d+,title=Smoothness::"checkout" got worse/,
  );
});

test('--update-snapshots replaces the baseline, and the new level then passes', () => {
  const updated = run({ CLICK_MS: '60', ENFORCE: 'fail' }, ['--update-snapshots']);
  expect(updated.code, updated.output).toBe(0);
  expect(updated.result!.comparison!.status).toBe('baseline-updated');
  const again = run({ CLICK_MS: '60', ENFORCE: 'fail' });
  expect(again.code, again.output).toBe(0);
  expect(again.result!.comparison!.status).toBe('pass');
});
