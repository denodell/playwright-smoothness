// M6 acceptance: an existing Playwright project, with nothing changed but its fixtures file,
// produces a result and a baseline history; editing the spec file resets that history.
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { SmoothnessResult } from '../../src/types.js';
import type { HistoryFile } from '../../src/auto/history.js';

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
    `});`,
    `export { expect } from '@playwright/test';`,
    '',
  ].join('\n');
};

function files(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p, suffix) : p.endsWith(suffix) ? [p] : [];
  });
}

function run(env: Record<string, string> = {}) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(TEST_|PW_|GITHUB_|SMOOTHNESS_)/.test(k)),
  );
  const child = spawnSync(
    join(repo, 'node_modules', '.bin', 'playwright'),
    ['test', '-c', join(project, 'playwright.config.ts')],
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
  expect(r.results).toHaveLength(1); // 'no page at all' opens no page, so it isn't measured
  const result = r.results[0]!;
  expect(result.label).toBe('buy, then search');
  expect(result.runs).toBe(1);
  // Across a navigation: clicks on the first page, typing on the second.
  expect(result.auto!.documents).toBe(2);
  expect(result.auto!.interactions.map((i) => `${i.event} on ${i.target}`)).toEqual([
    'click on button#heavy',
    'keydown on input#search',
    'keydown on input#search',
  ]);
  // The nested click is followed straight away by a navigation, so the browser never painted
  // it and never measured it. That's reported, not silently dropped.
  expect(result.notes.join(' ')).toContain(
    "The last input before a navigation (pointerdown on http://localhost:4175/click.html?ms=80) wasn't measured",
  );
  expect(result.longFrames!.topScripts.map((s) => s.fn)).toEqual(
    expect.arrayContaining(['onHeavyClick', 'onSearchKeydown']),
  );
  expect(result.frameClasses.load).toBe(0); // load work isn't the test's interactions
  expect(result.comparison!.status).toBe('not-compared');
  expect(result.comparison!.notes.join(' ')).toMatch(/Building history: 0 of 2/);
  expect(r.histories).toHaveLength(1);
  expect(r.histories[0]!.entries).toHaveLength(1);
});

test('once the history is long enough, runs are compared with its median; pull requests do not record', () => {
  expect(run({ SMOOTHNESS_RECORD: '1' }).histories[0]!.entries).toHaveLength(2);
  const r = run(); // not main: compare only
  expect(r.code, r.output).toBe(0);
  expect(r.results[0]!.comparison!.status).toBe('pass');
  expect(r.results[0]!.comparison!.baseline!.source).toBe('history');
  expect(r.histories[0]!.entries).toHaveLength(2);
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
  expect(r.results[0]!.comparison!.status).toBe('not-compared');
  expect(r.results[0]!.comparison!.notes.join(' ')).toMatch(/spec file changed/);
  expect(r.histories[0]!.entries).toHaveLength(1);
});
