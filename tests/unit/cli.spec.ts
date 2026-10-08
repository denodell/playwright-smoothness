import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../packages/playwright-butter/src/cli.js';
import { makeResult } from './result-factory.js';

let dir: string;
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smoothness-cli-'));
});
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const cwd = process.cwd();
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void err.push(a.join(' '));
  process.chdir(dir);
  try {
    const code = main(argv);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    process.chdir(cwd);
    console.log = log;
    console.error = error;
  }
}

test('no command prints the help and fails; --help succeeds', () => {
  expect(cli()).toMatchObject({ code: 1, out: expect.stringContaining('Commands:') });
  expect(cli('--help')).toMatchObject({ code: 0, out: expect.stringContaining('Commands:') });
});

test('an unknown command fails with the help', () => {
  expect(cli('nope')).toMatchObject({ code: 1, err: expect.stringContaining("Unknown command 'nope'") });
});

test('each command has its own help', () => {
  for (const [command, usage] of [
    ['summary', 'summary [options]'],
    ['brief', 'brief [options]'],
    ['init-agents', 'init-agents'],
    ['calibrate', 'calibrate [options]'],
  ]) {
    const r = cli(command!, '--help');
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Usage: npx playwright-butter ${usage}`);
  }
});

test('summary skips result files it cannot read', () => {
  const results = join(dir, 'test-results', 'smoothness', 'a-test');
  mkdirSync(results, { recursive: true });
  writeFileSync(join(results, 'good.json'), JSON.stringify(makeResult({ label: 'good' })));
  writeFileSync(join(results, 'bad.json'), 'not json');
  const r = cli('summary');
  expect(r.code).toBe(0);
  expect(r.out).toContain('Smoothness summary of 1 result(s)');
  expect(readFileSync(join(dir, 'test-results', 'smoothness', 'summary.md'), 'utf8')).toContain('"good"');
});

test('brief: nothing to fix, and writing the briefs to a file', () => {
  expect(cli('brief')).toMatchObject({ code: 0, err: expect.stringContaining('No fix briefs') });

  const results = join(dir, 'test-results', 'smoothness', 'a-test');
  mkdirSync(results, { recursive: true });
  writeFileSync(join(results, 'open-filters.fix.md'), '# Fix brief: open filters\n\nDetails.\n');
  const r = cli('brief', '--out', 'out/briefs.md');
  expect(r.code).toBe(0);
  expect(r.err).toContain('Fix briefs written to out/briefs.md');
  expect(readFileSync(join(dir, 'out', 'briefs.md'), 'utf8')).toContain('# Fix brief: open filters');
});

test('init-agents adds the skill where asked', () => {
  const r = cli('init-agents', '--dir', '.agents/skills', '--no-agents-md');
  expect(r.code).toBe(0);
  expect(r.out).toContain('.agents/skills/playwright-butter/');
  expect(existsSync(join(dir, '.agents', 'skills', 'playwright-butter', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
});

test('calibrate needs at least two runs, and Playwright in the project', () => {
  expect(cli('calibrate', '--runs', '1')).toMatchObject({ code: 1, err: expect.stringContaining('--runs') });
  expect(cli('calibrate')).toMatchObject({
    code: 1,
    err: expect.stringContaining("Couldn't find @playwright/test in this project"),
  });
});
