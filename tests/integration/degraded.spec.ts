import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  encodeReplay,
  measure,
  measureScroll,
  takeReplaySource,
  preparePage,
  resolveOptions,
  resolveScroll,
  type CdpSession,
  type PageDriver,
  type ScratchPage,
  type SmoothnessOptions,
  type Tracer,
} from '../../packages/smoothness-core/src/index.js';
import { locatorTarget, playwrightDriver } from '../../packages/playwright-smoothness/src/driver.js';

test.setTimeout(120_000);

async function setUp(page: Page, url: string, change: (d: PageDriver) => Partial<PageDriver> = () => ({})) {
  const real = playwrightDriver(page);
  const driver: PageDriver = { ...real, ...change(real) };
  await preparePage(driver);
  await page.goto(url);
  return driver;
}

async function context(driver: PageDriver, label: string, options: SmoothnessOptions) {
  return {
    page: driver,
    label,
    options: resolveOptions([{ runs: 2, cpuThrottling: 1 }, options]),
    environment: await driver.environment(),
  };
}

const emptyTrace = Buffer.from(JSON.stringify({ traceEvents: [] }));

function tracerThat(real: Tracer | null, change: (trace: Buffer, call: number) => Buffer): Tracer {
  let calls = 0;
  return {
    start: (categories, options) => real!.start(categories, options),
    stop: async () => change(await real!.stop(), calls++),
  };
}

test('full mode on a page that cannot be traced says why frames are missing', async ({ page }) => {
  const driver = await setUp(page, '/click.html?ms=60', () => ({ tracer: () => null }));
  const r = await measure(await context(driver, 'untraceable', { mode: 'full' }), () => page.click('#heavy'));
  expect(r.frames).toBeNull();
  expect(r.unavailable).toContainEqual({
    measurement: 'frames',
    reason: expect.stringMatching(/full mode needs a trace/),
  });
  expect(r.input!.interactions).toBe(1);
});

test('traces that come back empty in every run leave frames and the profile unavailable', async ({
  page,
}) => {
  const driver = await setUp(page, '/click.html?ms=60', (d) => ({
    tracer: () => tracerThat(d.tracer(), () => emptyTrace),
  }));
  const r = await measure(await context(driver, 'empty traces', { mode: 'full', refreshRate: 120 }), () =>
    page.click('#heavy'),
  );
  expect(r.frames).toBeNull();
  expect(r.profile).toBeNull();
  expect(r.budget120).toBeNull();
  const missing = r.unavailable.map((u) => u.measurement);
  expect(missing).toEqual(expect.arrayContaining(['frames', 'profile', 'budget120']));
});

test('a trace missing from one run is noted, and the other runs are used', async ({ page }) => {
  const driver = await setUp(page, '/click.html?ms=60', (d) => ({
    tracer: () => tracerThat(d.tracer(), (trace, call) => (call === 1 ? emptyTrace : trace)),
  }));
  const r = await measure(await context(driver, 'one empty trace', { mode: 'full', runs: 3 }), () =>
    page.click('#heavy'),
  );
  expect(r.frames).not.toBeNull();
  expect(r.profile).not.toBeNull();
  expect(r.notes.join(' ')).toMatch(/Frame data was missing from 1 of 3 runs/);
  expect(r.notes.join(' ')).toMatch(/The CPU profile was missing from 1 of 3 runs/);
});

test('a trace that is not JSON leaves frames unavailable, with the reason', async ({ page }) => {
  const driver = await setUp(page, '/click.html?ms=60', (d) => ({
    tracer: () => tracerThat(d.tracer(), () => Buffer.from('not json')),
  }));
  const r = await measure(await context(driver, 'unparseable', { mode: 'full', runs: 1 }), () =>
    page.click('#heavy'),
  );
  expect(r.frames).toBeNull();
  expect(r.unavailable).toContainEqual({
    measurement: 'frames',
    reason: expect.stringMatching(/the trace could not be parsed/),
  });
});

test.describe('lists', () => {
  test.use({ viewport: { width: 600, height: 600 } });
  const scroll = resolveScroll({ distance: 3000, speed: 'fast' });

  test('a list trace without screenshots has no list data, and says so', async ({ page }) => {
    const noScreenshots = (trace: Buffer) => {
      const json = JSON.parse(trace.toString()) as { traceEvents: { name: string }[] };
      json.traceEvents = json.traceEvents.filter((e) => e.name !== 'Screenshot');
      return Buffer.from(JSON.stringify(json));
    };
    const driver = await setUp(page, '/list.html?cost=0&overscan=2', (d) => ({
      tracer: () => tracerThat(d.tracer(), noScreenshots),
    }));
    const r = await measureScroll(
      await context(driver, 'no screenshots', { mode: 'full' }),
      locatorTarget(page.locator('#list')),
      scroll,
    );
    expect(r.list ?? null).toBeNull();
    expect(r.unavailable).toContainEqual({
      measurement: 'list',
      reason: expect.stringMatching(/no Screenshot events/),
    });
  });

  test('a list that cannot be prepared reports why', async ({ page }) => {
    const driver = await setUp(page, '/list.html?cost=0&overscan=2', () => ({
      screenshot: () => Promise.reject(new Error('screenshot failed')),
    }));
    const r = await measureScroll(
      await context(driver, 'no reference shot', { mode: 'full', runs: 1 }),
      locatorTarget(page.locator('#list')),
      scroll,
    );
    expect(r.unavailable).toContainEqual({
      measurement: 'list',
      reason: expect.stringMatching(/the list couldn't be prepared: Error: screenshot failed/),
    });
  });

  test('screenshots that cannot be decoded are skipped', async ({ page }) => {
    const someCorrupt = (trace: Buffer) => {
      const json = JSON.parse(trace.toString()) as {
        traceEvents: { name: string; args?: { snapshot?: string } }[];
      };
      let n = 0;
      for (const e of json.traceEvents) {
        if (e.name === 'Screenshot' && e.args?.snapshot && n++ % 2 === 0)
          e.args.snapshot = 'bm90IGEganBlZw==';
      }
      return Buffer.from(JSON.stringify(json));
    };
    const driver = await setUp(page, '/list.html?cost=0&overscan=2', (d) => ({
      tracer: () => tracerThat(d.tracer(), someCorrupt),
    }));
    const r = await measureScroll(
      await context(driver, 'corrupt screenshots', { mode: 'full', runs: 1 }),
      locatorTarget(page.locator('#list')),
      scroll,
    );
    expect(r.list).toBeTruthy();
    expect(r.notes.join(' ')).toMatch(
      /screenshots couldn't be decoded, so blank frames were judged from the rest/,
    );
  });

  test('list data missing from one run is noted', async ({ page }) => {
    const driver = await setUp(page, '/list.html?cost=0&overscan=2', (d) => ({
      tracer: () => tracerThat(d.tracer(), (trace, call) => (call === 1 ? emptyTrace : trace)),
    }));
    const r = await measureScroll(
      await context(driver, 'one run without list data', { mode: 'full', runs: 3 }),
      locatorTarget(page.locator('#list')),
      scroll,
    );
    expect(r.list).toBeTruthy();
    expect(r.notes.join(' ')).toMatch(/List data was missing from 1 of 3 runs/);
  });
});

test('CPU throttling that does not take effect is noted', async ({ page }) => {
  const driver = await setUp(page, '/click.html?ms=60', (d) => ({
    cdp: async (): Promise<CdpSession> => {
      const real = await d.cdp();
      return {
        send: (method, params) =>
          method === 'Emulation.setCPUThrottlingRate' ? Promise.resolve({}) : real.send(method, params),
        on: (e, h) => real.on(e, h),
        off: (e, h) => real.off(e, h),
        detach: () => real.detach(),
      };
    },
  }));
  const r = await measure(await context(driver, 'unthrottled', { cpuThrottling: 4 }), () =>
    page.click('#heavy'),
  );
  expect(r.notes.join(' ')).toMatch(/CPU throttling didn't take effect/);
});

test('a browser without Long Animation Frames reports long frames as unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    const types = PerformanceObserver.supportedEntryTypes.filter((t) => t !== 'long-animation-frame');
    Object.defineProperty(PerformanceObserver, 'supportedEntryTypes', { get: () => types });
  });
  const driver = await setUp(page, '/click.html?ms=60');
  const r = await measure(await context(driver, 'no loaf', {}), () => page.click('#heavy'));
  expect(r.longFrames).toBeNull();
  expect(r.unavailable).toContainEqual({
    measurement: 'longFrames',
    reason: 'Long Animation Frames are not supported in this browser',
  });
});

test('a run whose collector is gone after the action is counted as navigated', async ({ page }) => {
  let breakFlush = false;
  const driver = await setUp(page, '/click.html?ms=60', (d) => ({
    evaluate: ((fn: (arg: unknown) => unknown, arg?: unknown) => {
      if (breakFlush && String(fn).includes('.flush()')) {
        breakFlush = false;
        return Promise.reject(new Error('Execution context was destroyed'));
      }
      return d.evaluate(fn, arg);
    }) as PageDriver['evaluate'],
  }));
  let run = 0;
  const r = await measure(await context(driver, 'flush fails once', { runs: 3 }), async () => {
    await page.click('#heavy');
    if (run++ === 1) breakFlush = true;
  });
  expect(r.notes.join(' ')).toMatch(/navigat/);
  expect(r.runs).toBe(2);
});

test.describe('replays', () => {
  test.use({ viewport: { width: 600, height: 600 } });

  async function replaySource(page: Page) {
    const driver = await setUp(page, '/list.html?cost=0&overscan=2');
    const r = await measureScroll(
      await context(driver, 'replay', { mode: 'full', runs: 1, replay: 'on' }),
      locatorTarget(page.locator('#list')),
      resolveScroll({ distance: 2000, speed: 'fast' }),
    );
    return { driver, source: takeReplaySource(r)! };
  }

  function scratchThat(d: PageDriver, evaluate: (real: ScratchPage, fn: string) => Promise<unknown> | null) {
    return {
      ...d,
      openScratchPage: (o: { secure: boolean }) => {
        const opened = d.openScratchPage(o);
        return opened
          ? opened.then((real) => ({
              evaluate: ((fn: (a: unknown) => unknown, arg?: unknown) =>
                evaluate(real, String(fn)) ?? real.evaluate(fn, arg)) as ScratchPage['evaluate'],
              close: () => real.close(),
            }))
          : null;
      },
    };
  }

  test('a long title is cut to fit, and the replay is still made', async ({ page }) => {
    const { driver, source } = await replaySource(page);
    const video = await encodeReplay(driver, { ...source, title: 'a very long label '.repeat(20) });
    expect(video).toBeInstanceOf(Uint8Array);
  });

  test('replays need WebCodecs, an encoder that works, and a page to render in', async ({ page }) => {
    const { driver, source } = await replaySource(page);
    const noEncoder = scratchThat(driver, (_, fn) =>
      fn.includes('typeof VideoEncoder') ? Promise.resolve(false) : null,
    );
    expect(await encodeReplay(noEncoder, source)).toEqual({
      unavailable: "this browser has no WebCodecs VideoEncoder, so replays can't be encoded",
    });

    let installed = false;
    const failingEncoder = scratchThat(driver, (real) => {
      if (installed) return null;
      installed = true;
      return real
        .evaluate(() => {
          (window as unknown as { VideoEncoder: unknown }).VideoEncoder = class {
            constructor(private init: { error: (e: Error) => void }) {}
            configure() {}
            encode() {
              this.init.error(new Error('encoder failed'));
            }
            flush() {
              return Promise.resolve();
            }
            close() {}
          };
        })
        .then(() => true);
    });
    expect(await encodeReplay(failingEncoder, source)).toEqual({
      unavailable: expect.stringMatching(/the replay couldn't be encoded: Error: encoder failed/),
    });

    const renderFails = scratchThat(driver, (_, fn) =>
      fn.includes('typeof VideoEncoder') ? null : Promise.reject(new Error('page crashed')),
    );
    expect(await encodeReplay(renderFails, source)).toEqual({
      unavailable: "the replay couldn't be made: Error: page crashed",
    });
  });
});
