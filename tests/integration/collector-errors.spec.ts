import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { COLLECTOR_KEY, installCollector } from '../../packages/butter-core/src/collector/collector.js';
import { COLLECTOR_CONFIG } from '../../packages/butter-core/src/runner.js';

interface Snapshot {
  supported: { loaf: boolean; event: boolean };
  loadEventEnd: number;
  errors: string[];
}

async function run(page: Page, sabotage: () => void, binding: 'records' | 'throws' = 'records') {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.addInitScript((mode) => {
    const w = window as unknown as Record<string, unknown>;
    w.__batches = [];
    w.__stream = (batch: unknown) => {
      if (mode === 'throws') throw new Error('binding failed');
      (w.__batches as unknown[]).push(batch);
    };
  }, binding);
  await page.addInitScript(sabotage);
  await page.addInitScript(installCollector, { ...COLLECTOR_CONFIG, stream: '__stream' });
  await page.goto('/click.html?ms=60');
  await page.click('#heavy');
  await page.evaluate(() => (document.body.style.minHeight = '3000px'));
  await page.mouse.move(100, 100);
  await page.mouse.wheel(0, 200);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  const state = await page.evaluate((key) => {
    const w = window as unknown as Record<string, unknown>;
    const api = w[key] as { snapshot(from: number, to: number): Snapshot } | undefined;
    const batches = w.__batches as { errors: string[] }[];
    return {
      installed: !!api,
      snapshot: api?.snapshot(0, 1e12) ?? null,
      streamedErrors: batches.flatMap((b) => b.errors),
    };
  }, COLLECTOR_KEY);
  return { ...state, pageErrors };
}

const errorsOf = (s: Snapshot | null) => (s?.errors ?? []).map((e) => e.split(':')[0]);

test('no supported entry types: nothing observed, nothing thrown', async ({ page }) => {
  const r = await run(page, () => {
    Object.defineProperty(PerformanceObserver, 'supportedEntryTypes', {
      get() {
        throw new Error('blocked');
      },
    });
  });
  expect(r.pageErrors).toEqual([]);
  expect(r.snapshot!.supported).toEqual({ loaf: false, event: false });
});

test('observers that refuse to observe are recorded as unsupported', async ({ page }) => {
  const r = await run(page, () => {
    PerformanceObserver.prototype.observe = () => {
      throw new Error('blocked');
    };
  });
  expect(r.pageErrors).toEqual([]);
  expect(r.snapshot!.supported).toEqual({ loaf: false, event: false });
  expect(errorsOf(r.snapshot)).toEqual(expect.arrayContaining(['loaf observe', 'event observe']));
  expect(r.streamedErrors.map((e) => e.split(':')[0])).toEqual(
    expect.arrayContaining(['loaf observe', 'event observe']),
  );
});

test('entry lists that throw are recorded', async ({ page }) => {
  const r = await run(page, () => {
    PerformanceObserverEntryList.prototype.getEntries = () => {
      throw new Error('blocked');
    };
  });
  expect(r.pageErrors).toEqual([]);
  expect(errorsOf(r.snapshot)).toEqual(expect.arrayContaining(['loaf getEntries', 'event getEntries']));
});

test('entries whose fields throw are recorded and skipped', async ({ page }) => {
  const r = await run(page, () => {
    const throwing = (proto: object, name: string) =>
      Object.defineProperty(proto, name, {
        get() {
          throw new Error('blocked');
        },
      });
    const w = window as unknown as Record<string, { prototype: object }>;
    throwing(w.PerformanceScriptTiming!.prototype, 'invoker');
    throwing(w.PerformanceEventTiming!.prototype, 'processingStart');
  });
  expect(r.pageErrors).toEqual([]);
  expect(errorsOf(r.snapshot)).toEqual(expect.arrayContaining(['loaf script', 'event entry']));
});

test('a long frame whose scripts throw is recorded and skipped', async ({ page }) => {
  const r = await run(page, () => {
    const w = window as unknown as Record<string, { prototype: object }>;
    Object.defineProperty(w.PerformanceLongAnimationFrameTiming!.prototype, 'scripts', {
      get() {
        throw new Error('blocked');
      },
    });
  });
  expect(r.pageErrors).toEqual([]);
  expect(errorsOf(r.snapshot)).toContain('loaf entry');
});

test('elements that throw when matched are recorded', async ({ page }) => {
  const r = await run(page, () => {
    Element.prototype.closest = () => {
      throw new Error('blocked');
    };
  });
  expect(r.pageErrors).toEqual([]);
  expect(errorsOf(r.snapshot)).toContain('ancestor');
});

test('scroll events whose target throws are recorded', async ({ page }) => {
  const r = await run(page, () => {
    Object.defineProperty(Event.prototype, 'target', {
      get() {
        throw new Error('blocked');
      },
    });
  });
  expect(r.pageErrors).toEqual([]);
  expect(errorsOf(r.snapshot)).toContain('scroll');
});

test('navigation timing that throws reads as not loaded yet', async ({ page }) => {
  const r = await run(page, () => {
    performance.getEntriesByType = () => {
      throw new Error('blocked');
    };
  });
  expect(r.pageErrors).toEqual([]);
  expect(r.snapshot!.loadEventEnd).toBe(0);
});

test('listeners, navigation timing and installing can all fail without breaking the page', async ({
  page,
}) => {
  const r = await run(page, () => {
    const add = window.addEventListener;
    window.addEventListener = function (this: Window, type: string, ...rest: unknown[]) {
      if (['scroll', 'pointerdown', 'keydown', 'load'].includes(type)) throw new Error('blocked');
      return (add as (...a: unknown[]) => void).call(this, type, ...rest);
    } as typeof window.addEventListener;
    performance.getEntriesByType = () => {
      throw new Error('blocked');
    };
    const define = Object.defineProperty;
    Object.defineProperty = function (o: object, key: PropertyKey, d: PropertyDescriptor) {
      if (o === window && key === '__playwrightSmoothness') throw new Error('blocked');
      return define(o, key, d);
    } as typeof Object.defineProperty;
  });
  expect(r.pageErrors).toEqual([]);
  expect(r.installed).toBe(false);
  expect(r.streamedErrors.map((e) => e.split(':')[0])).toEqual(
    expect.arrayContaining(['scroll listen', 'input listen', 'load listen', 'install']),
  );
});

test('a stream binding that throws, and a page without queueMicrotask', async ({ page }) => {
  const throwing = await run(
    page,
    () => {
      Element.prototype.closest = () => {
        throw new Error('blocked');
      };
    },
    'throws',
  );
  expect(throwing.pageErrors).toEqual([]);
  expect(errorsOf(throwing.snapshot)).toEqual(expect.arrayContaining(['stream', 'ancestor']));

  const page2 = await page.context().newPage();
  const noMicrotasks = await run(page2, () => {
    window.queueMicrotask = () => {
      throw new Error('blocked');
    };
  });
  expect(noMicrotasks.pageErrors).toEqual([]);
  expect(errorsOf(noMicrotasks.snapshot)).toContain('stream');
});
