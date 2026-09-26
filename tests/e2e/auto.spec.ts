// Automatic mode, end to end: an existing Playwright project, with nothing changed but its
// fixtures file, produces a result and a baseline history; editing the spec file resets that
// history.
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { SmoothnessResult } from '../../src/types.js';
import type { HistoryFile } from '../../src/auto/history.js';
import { files, PLAYWRIGHT_CLI } from './helpers.js';

const repo = process.cwd();
const project = join(repo, '.tmp-e2e', `auto-${process.pid}`);
const PLAIN = `import { test as base } from '@playwright/test';\nexport const test = base;\nexport { expect } from '@playwright/test';\n`;
const withSmoothness = () => {
  const lib = relative(project, join(repo, 'src', 'index.js')).replace(/\\/g, '/');
  return [
    `import { test as base } from '@playwright/test';`,
    `import { withSmoothness } from '${lib.startsWith('.') ? lib : './' + lib}';`,
    `export const test = withSmoothness(base, {`,
    `  auto: true,`,
    `  minHistory: 2,`,
    `  enforce: process.env.SMOOTHNESS_ENFORCE === 'fail' ? 'fail' : 'warn',`,
    `  historyDir: process.env.HISTORY_DIR,`,
    `  record: process.env.RECORD === 'yes' ? true : process.env.RECORD === 'no' ? false : undefined,`,
    `});`,
    `export { expect } from '@playwright/test';`,
    '',
  ].join('\n');
};

function run(env: Record<string, string> = {}) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(TEST_|PW_|GITHUB_|SMOOTHNESS_)/.test(k)),
  );
  const child = spawnSync(
    process.execPath,
    [PLAYWRIGHT_CLI, 'test', '-c', join(project, 'playwright.config.ts')],
    {
      cwd: project,
      env: { ...clean, SMOOTHNESS_TEST_PAGES: join(repo, 'test-pages'), ...env },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  const output = `${child.stdout}\n${child.stderr}`;
  test.info().attach(`run ${JSON.stringify(env)}`, { body: output, contentType: 'text/plain' });
  const results = files(join(project, 'test-results', 'smoothness'), 'auto.json').map(
    (f) => JSON.parse(readFileSync(f, 'utf8')) as SmoothnessResult,
  );
  const histories = files(join(project, 'smoothness-history'), '.json').map(
    (f) => JSON.parse(readFileSync(f, 'utf8')) as HistoryFile,
  );
  return { code: child.status, output, results, histories };
}

const BUY = 'buy, then search';
const buy = (r: ReturnType<typeof run>) => r.results.find((x) => x.label === BUY)!;
const buyHistory = (r: ReturnType<typeof run>) => r.histories.find((h) => h.test === BUY)!;

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);
test.beforeAll(() => {
  rmSync(project, { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  cpSync(resolve('tests/e2e/auto-project'), project, { recursive: true });
  writeFileSync(join(project, 'fixtures.ts'), PLAIN);
});
test.afterAll(() => rmSync(project, { recursive: true, force: true }));

test('the plain project runs, and nothing is measured', () => {
  const r = run();
  expect(r.code, r.output).toBe(0);
  expect(r.results).toEqual([]);
});

test('changing only the fixtures file: every page-using test gets a result, and main records a history', () => {
  writeFileSync(join(project, 'fixtures.ts'), withSmoothness());
  const r = run({ SMOOTHNESS_RECORD: '1' });
  expect(r.code, r.output).toBe(0);
  expect(r.results).toHaveLength(2); // 'no page at all' opens no page, so it isn't measured
  const result = buy(r);
  expect(result.runs).toBe(1);
  // Across a navigation: clicks on the first page, typing on the second.
  expect(result.auto!.documents).toBe(2);
  expect(result.auto!.interactions.map((i) => `${i.event} on ${i.target}`)).toEqual([
    'click on button#heavy',
    'click on button#nested',
    'keydown on input#search',
    'keydown on input#search',
  ]);
  expect(result.input!.byTarget.map((t) => t.target)).toEqual(
    expect.arrayContaining(['button#heavy', 'button#nested', 'input#search']),
  );
  expect(result.longFrames!.topScripts.map((s) => s.fn)).toEqual(
    expect.arrayContaining(['onHeavyClick', 'onNestedClick', 'onSearchKeydown']),
  );
  expect(result.notes.join(' ')).not.toContain("wasn't measured");
  // A click whose handler navigates unloads the page before it paints: never measured, and reported.
  const leave = r.results.find((x) => x.label === 'leave from a button that navigates')!;
  expect(leave.auto!.interactions.map((i) => `${i.event} on ${i.target}`)).toEqual(['click on button#heavy']);
  expect(leave.notes.join(' ')).toContain(
    "The last input before a navigation (pointerdown on http://localhost:4175/click.html?ms=80) wasn't measured",
  );
  expect(result.frameClasses.load).toBe(0); // load work isn't the test's interactions
  expect(result.comparison!.status).toBe('not-compared');
  expect(result.comparison!.notes.join(' ')).toMatch(/Building history: 0 of 2/);
  expect(r.histories).toHaveLength(2);
  expect(r.histories.map((h) => h.entries.length)).toEqual([1, 1]);
});

test('once the history is long enough, runs are compared with its median; pull requests do not record', () => {
  expect(buyHistory(run({ SMOOTHNESS_RECORD: '1' })).entries).toHaveLength(2);
  const r = run(); // not main: compare only
  expect(r.code, r.output).toBe(0);
  expect(buy(r).comparison!.status).toBe('pass');
  expect(buy(r).comparison!.baseline!.source).toBe('history');
  expect(buyHistory(r).entries).toHaveLength(2);
});

test("a regression fails with enforce: 'fail', naming the element and the handler", () => {
  const r = run({ CLICK_MS: '400', SMOOTHNESS_ENFORCE: 'fail' });
  expect(r.code, r.output).toBe(1);
  expect(r.output).toContain('"buy, then search" is less smooth than its baseline');
  expect(r.output).toContain('click on button#heavy');
  expect(r.output).toContain('onHeavyClick');
});

test('editing the spec file resets its history instead of failing', () => {
  appendFileSync(join(project, 'app.spec.ts'), '\n// An edit.\n');
  const r = run({ CLICK_MS: '400', SMOOTHNESS_ENFORCE: 'fail', SMOOTHNESS_RECORD: '1' });
  expect(r.code, r.output).toBe(0);
  expect(buy(r).comparison!.status).toBe('not-compared');
  expect(buy(r).comparison!.notes.join(' ')).toMatch(/spec file changed/);
  expect(buyHistory(r).entries).toHaveLength(1);
});

test('historyDir and record: an explicit folder, and an explicit decision to record or not', () => {
  const custom = join(project, 'custom-history');
  // record: false wins over SMOOTHNESS_RECORD=1
  run({ HISTORY_DIR: 'custom-history', RECORD: 'no', SMOOTHNESS_RECORD: '1' });
  expect(files(custom, '.json')).toEqual([]);
  // record: true records without any main-branch or environment signal
  const r = run({ HISTORY_DIR: 'custom-history', RECORD: 'yes' });
  expect(r.code, r.output).toBe(0);
  const written = files(custom, '.json');
  expect(written.length).toBe(2);
  expect(written.every((f) => f.startsWith(custom))).toBe(true);
});
