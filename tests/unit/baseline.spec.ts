import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineKey, labelSlug, machineSlug, slug, baselineFileName } from '../../src/baseline/key.js';
import { compareMetrics, metricsOf, INPUT_FLOOR_MS } from '../../src/baseline/compare.js';
import { evaluate, type EvaluateInfo } from '../../src/baseline/evaluate.js';
import { writeBaseline } from '../../src/baseline/store.js';
import { makeResult } from './result-factory.js';

// ---- keys ----

test('slugs', () => {
  expect(slug('Open Filters!')).toBe('open-filters');
  expect(labelSlug('open-filters')).toBe('open-filters');
  expect(labelSlug('Open filters')).toMatch(/^open-filters-[0-9a-f]{6}$/);
  expect(labelSlug('Open filters')).not.toBe(labelSlug('open  filters'));
});

test('machine slugs', () => {
  expect(machineSlug({ cpuModel: 'AMD EPYC 7763 64-Core Processor', cpus: 4, platform: 'linux' })).toBe(
    'amd-epyc-7763-4cpu',
  );
  expect(
    machineSlug({ cpuModel: 'Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz', cpus: 2, platform: 'linux' }),
  ).toBe('intel-xeon-platinum-8370c-2cpu');
  expect(machineSlug({ cpuModel: 'Apple M1 Pro', cpus: 10, platform: 'darwin' })).toBe('apple-m1-pro-10cpu');
});

test('the baseline key separates mode, refresh rate, throttling and machine', () => {
  const key = baselineKey(makeResult(), 'chromium');
  expect(key).toEqual({
    label: 'open filters',
    project: 'chromium',
    platform: 'linux',
    mode: 'quick',
    refreshRate: 60,
    cpuThrottling: 4,
    machine: 'amd-epyc-7763-4cpu',
  });
  expect(baselineFileName(key)).toBe(`${labelSlug('open filters')}-quick-60hz-cpu4x-amd-epyc-7763-4cpu.json`);
  const full = baselineFileName(baselineKey(makeResult({ mode: 'full', cpuThrottling: 1 }), 'chromium'));
  expect(full).toContain('-full-60hz-cpu1x-');
});

// ---- compareMetrics ----

const base = metricsOf(makeResult());

test('within maxIncrease passes; beyond it is worse', () => {
  const ok = compareMetrics(makeResult({ input: { p95ToPaintMs: 128 } }), base, 0.15);
  expect(ok.find((c) => c.metric === 'input.p95ToPaintMs')).toMatchObject({
    status: 'pass',
    change: 16,
    changePercent: 14.3,
    allowed: 16.8,
  });
  const bad = compareMetrics(makeResult({ input: { p95ToPaintMs: 200 } }), base, 0.15);
  expect(bad.find((c) => c.metric === 'input.p95ToPaintMs')).toMatchObject({ status: 'worse', change: 88 });
});

test('floors: one extra long frame over a zero baseline, or one Event Timing step, is not a regression', () => {
  const zero = metricsOf(makeResult({ longFrames: { count: 0 }, input: { p95ToPaintMs: 24 } }));
  const checks = compareMetrics(
    makeResult({ longFrames: { count: 1 }, input: { p95ToPaintMs: 40 } }),
    zero,
    0.15,
  );
  expect(checks.find((c) => c.metric === 'longFrames.count')).toMatchObject({
    status: 'pass',
    allowed: 1,
    changePercent: null,
  });
  // 24 → 40 is +16ms: exactly the floor (two 8ms steps), so not worse.
  expect(checks.find((c) => c.metric === 'input.p95ToPaintMs')).toMatchObject({
    status: 'pass',
    allowed: INPUT_FLOOR_MS,
  });
  const two = compareMetrics(makeResult({ longFrames: { count: 2 } }), zero, 0.15);
  expect(two.find((c) => c.metric === 'longFrames.count')!.status).toBe('worse');
});

test('10ms to 60ms click work fails (the end-to-end baseline scenario, as numbers)', () => {
  const before = metricsOf(makeResult({ input: { p95ToPaintMs: 24 }, longFrames: { count: 0 } }));
  const after = compareMetrics(
    makeResult({ input: { p95ToPaintMs: 72 }, longFrames: { count: 1 } }),
    before,
    0.15,
  );
  expect(after.find((c) => c.metric === 'input.p95ToPaintMs')!.status).toBe('worse');
});

test('on-time frames are compared on the missed share', () => {
  const b = metricsOf(makeResult({ frames: { total: 100, onTime: 95, dropped: 5, onTimePercent: 95 } }));
  // 95% → 94%: missed share 5 → 6 points; allowed max(5 × 0.15, 1) = 1 point.
  const ok = compareMetrics(
    makeResult({ frames: { total: 100, onTime: 94, dropped: 6, onTimePercent: 94 } }),
    b,
    0.15,
  );
  expect(ok.find((c) => c.metric === 'frames.onTimePercent')).toMatchObject({ status: 'pass', change: -1 });
  const bad = compareMetrics(
    makeResult({ frames: { total: 100, onTime: 90, dropped: 10, onTimePercent: 90 } }),
    b,
    0.15,
  );
  expect(bad.find((c) => c.metric === 'frames.onTimePercent')!.status).toBe('worse');
});

test('missing measurements are unavailable or not compared, never zero', () => {
  const now = makeResult({
    longFrames: null,
    unavailable: [{ measurement: 'longFrames', reason: 'LoAF is not supported' }],
  });
  const checks = compareMetrics(now, base, 0.15);
  expect(checks.find((c) => c.metric === 'longFrames.count')).toMatchObject({
    status: 'unavailable',
    current: null,
    reason: 'LoAF is not supported',
  });
  const noBaselineValue = compareMetrics(makeResult(), { 'longFrames.count': 1 }, 0.15);
  expect(noBaselineValue.find((c) => c.metric === 'input.p95ToPaintMs')).toMatchObject({
    status: 'not-compared',
    reason: 'the baseline predates this metric',
  });
});

test('metrics neither side measured are not checks', () => {
  const noInput = makeResult({ input: { interactions: 0, p95ToPaintMs: null, worstMs: null, byTarget: [] } });
  const checks = compareMetrics(noInput, metricsOf(noInput), 0.15);
  expect(checks.map((c) => c.metric)).toEqual(['longFrames.count']);
});

test('total blocking time is only gated when asked', () => {
  const heavier = makeResult({ longFrames: { totalBlockingMs: 500 } });
  expect(compareMetrics(heavier, base, 0.15).map((c) => c.metric)).not.toContain(
    'longFrames.totalBlockingMs',
  );
  const gated = makeResult({ longFrames: { totalBlockingMs: 500 }, settings: { gateTotalBlocking: true } });
  expect(
    compareMetrics(gated, base, 0.15).find((c) => c.metric === 'longFrames.totalBlockingMs')!.status,
  ).toBe('worse');
});

test('a spread wider than maxIncrease marks the check noisy', () => {
  const noisy = makeResult({ spread: { 'input.p95ToPaintMs': { min: 80, median: 112, max: 150 } } });
  const c = compareMetrics(noisy, base, 0.15).find((x) => x.metric === 'input.p95ToPaintMs')!;
  expect(c).toMatchObject({ noisy: true, spreadPercent: 62.5 });
  const steady = compareMetrics(makeResult(), base, 0.15).find((x) => x.metric === 'input.p95ToPaintMs')!;
  expect(steady.noisy).toBeUndefined();
  expect(steady.spreadPercent).toBe(14.3);
});

// ---- evaluate (files, update modes, enforce) ----

function fakeInfo(dir: string, updateSnapshots = 'missing'): EvaluateInfo {
  return {
    snapshotPath: (...name: string[]) =>
      join(dir, 'spec.ts-snapshots', ...name).replace(/\.json$/, '-chromium-linux.json'),
    titlePath: ['spec.ts', 'filters', 'opens quickly'],
    project: { name: 'chromium', snapshotDir: dir },
    config: { updateSnapshots },
  };
}

test.describe('evaluate', () => {
  let dir: string;
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smoothness-'));
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('first run: records the baseline and passes', () => {
    const c = evaluate(makeResult(), fakeInfo(dir));
    expect(c.status).toBe('baseline-created');
    const file = JSON.parse(readFileSync(c.baseline!.path, 'utf8'));
    expect(file).toMatchObject({
      schemaVersion: 1,
      kind: 'playwright-smoothness-baseline',
      key: { label: 'open filters', machine: 'amd-epyc-7763-4cpu' },
      metrics: { 'input.p95ToPaintMs': 112, 'longFrames.count': 1, 'longFrames.totalBlockingMs': 58 },
    });
  });

  test('no baseline with --update-snapshots=none: not compared, nothing written', () => {
    const c = evaluate(makeResult(), fakeInfo(dir, 'none'));
    expect(c.status).toBe('not-compared');
    expect(c.notes.join(' ')).toMatch(/--update-snapshots=none/);
  });

  test('worse: warn by default, fail with enforce fail, and the matcher option overrides', () => {
    evaluate(makeResult(), fakeInfo(dir));
    const slower = makeResult({ input: { p95ToPaintMs: 200 } });
    expect(evaluate(slower, fakeInfo(dir)).status).toBe('warn');
    expect(
      evaluate(makeResult({ input: { p95ToPaintMs: 200 }, settings: { enforce: 'fail' } }), fakeInfo(dir))
        .status,
    ).toBe('fail');
    expect(evaluate(slower, fakeInfo(dir), { enforce: 'fail' }).status).toBe('fail');
    expect(evaluate(slower, fakeInfo(dir), { maxIncrease: 1 }).status).toBe('pass');
  });

  test('--update-snapshots=all replaces the baseline; changed only replaces it when worse', () => {
    evaluate(makeResult(), fakeInfo(dir));
    const slower = makeResult({ input: { p95ToPaintMs: 200 } });
    expect(evaluate(makeResult({ input: { p95ToPaintMs: 113 } }), fakeInfo(dir, 'changed')).status).toBe(
      'pass',
    );
    expect(evaluate(slower, fakeInfo(dir, 'changed')).status).toBe('baseline-updated');
    expect(evaluate(slower, fakeInfo(dir)).status).toBe('pass'); // the new baseline is 200
    expect(evaluate(makeResult(), fakeInfo(dir, 'all')).status).toBe('baseline-updated');
  });

  test('baselineDir is read first; the snapshot path is the fallback', () => {
    const ci = join(dir, 'from-main');
    const info = fakeInfo(dir);
    // Put a baseline where baselineDir would mirror the snapshot path.
    const path = evaluate(makeResult({ input: { p95ToPaintMs: 300 } }), info).baseline!.path;
    const mirrored = join(ci, path.slice(dir.length + 1));
    mkdirSync(join(mirrored, '..'), { recursive: true });
    writeFileSync(mirrored, readFileSync(path));
    writeBaseline(
      path,
      {
        label: 'open filters',
        project: 'chromium',
        platform: 'linux',
        mode: 'quick',
        refreshRate: 60,
        cpuThrottling: 4,
        machine: 'amd-epyc-7763-4cpu',
      },
      makeResult({ input: { p95ToPaintMs: 50 } }),
    );
    const c = evaluate(makeResult({ settings: { baselineDir: ci } }), info);
    expect(c.baseline!.source).toBe('baselineDir');
    expect(c.status).toBe('pass'); // 112 against 300, not against 50
  });

  test('a baseline from another machine is not used, and the note says which machines have one', () => {
    evaluate(makeResult({ machine: { cpuModel: 'AMD EPYC 9V74 80-Core Processor' } }), fakeInfo(dir));
    const c = evaluate(makeResult(), fakeInfo(dir));
    expect(c.status).toBe('baseline-created');
    expect(c.notes.join(' ')).toMatch(
      /No baseline for this machine \(amd-epyc-7763-4cpu\); baselines exist for amd-epyc-9v74-4cpu/,
    );
  });

  test('a different browser version is compared, with a note', () => {
    evaluate(makeResult({ browserVersion: '152.0.1' }), fakeInfo(dir));
    const c = evaluate(makeResult(), fakeInfo(dir));
    expect(c.status).toBe('pass');
    expect(c.notes.join(' ')).toMatch(/recorded with chromium 152\.0\.1; this run used 153/);
  });

  test('a corrupt or foreign baseline file is ignored with a note', () => {
    const path = evaluate(makeResult(), fakeInfo(dir)).baseline!.path;
    writeFileSync(path, '{"kind":"something-else"}');
    const c = evaluate(makeResult(), fakeInfo(dir));
    expect(c.status).toBe('baseline-created');
    expect(c.notes.join(' ')).toMatch(/is not a playwright-smoothness baseline/);
  });

  test('a result with nothing measured is not compared', () => {
    const empty = makeResult({
      runs: 0,
      input: null,
      longFrames: null,
      unavailable: [{ measurement: 'input', reason: 'Chromium only' }],
    });
    expect(evaluate(empty, fakeInfo(dir))).toMatchObject({
      status: 'not-compared',
      notes: ['Nothing was measured: Chromium only.'],
    });
  });
});

test('two tests in one file with the same label get separate baselines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smoothness-'));
  try {
    const a = evaluate(makeResult(), fakeInfo(dir));
    const b = evaluate(makeResult({ input: { p95ToPaintMs: 999 } }), {
      ...fakeInfo(dir),
      titlePath: ['spec.ts', 'another test'],
    });
    expect(b.status).toBe('baseline-created');
    expect(a.baseline!.path.replaceAll('\\', '/')).toContain('/filters-opens-quickly/');
    expect(b.baseline!.path.replaceAll('\\', '/')).toContain('/another-test/');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
