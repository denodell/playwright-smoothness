import { test as base } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, withButter } from '../../packages/playwright-butter/src/index.js';
import type { SmoothnessResult } from '../../packages/butter-core/src/types.js';

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

const history = mkdtempSync(join(tmpdir(), 'smoothness-fixture-edges-'));
test.afterAll(() => rmSync(history, { recursive: true, force: true }));

function resultsLabelled(label: string): SmoothnessResult[] {
  const out: SmoothnessResult[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.json')) {
        const r = JSON.parse(readFileSync(p, 'utf8')) as SmoothnessResult;
        if (r.label === label) out.push(r);
      }
    }
  };
  walk(join(test.info().project.outputDir, 'smoothness'));
  return out;
}

const shell = test.extend<{ page: Page }>({
  page: async ({ playwright, baseURL }, use) => {
    const browser = await playwright.chromium.launch({ channel: 'chromium-headless-shell' });
    await use(await browser.newPage({ baseURL }));
    await browser.close();
  },
});

shell("Chromium's headless shell gets a warning", async ({ page, butter }) => {
  await page.goto('/click.html?ms=20');
  await butter.measure('click', () => page.click('#heavy'), { runs: 1, cpuThrottling: 1 });
  expect(test.info().annotations).toContainEqual({
    type: 'smoothness-warning',
    description: expect.stringContaining("Running in Chromium's headless shell"),
  });
});

const noCdp = test.extend<{ page: Page }>({
  page: async ({ playwright, baseURL }, use) => {
    const browser = await playwright.chromium.launch();
    browser.newBrowserCDPSession = async () => {
      throw new Error('blocked');
    };
    await use(await browser.newPage({ baseURL }));
    await browser.close();
  },
});

noCdp("a browser that won't say which headless mode it is gets no warning", async ({ butter }) => {
  void butter;
  expect(test.info().annotations.map((a) => a.type)).not.toContain('smoothness-warning');
});

const noBrowser = test.extend<{ page: Page }>({
  page: async ({ browser, baseURL }, use) => {
    const context = await browser.newContext({ baseURL });
    context.browser = () => null;
    await use(await context.newPage());
    await context.close();
  },
});

noBrowser('a context with no Browser is not measured or compared', async ({ page, butter }) => {
  await page.goto('/click.html?ms=20');
  const r = await butter.measure('click', () => page.click('#heavy'));
  expect(r.runs).toBe(0);
  expect(r.unavailable[0]!.reason).toBe('smoothness is measured in Chromium only; this is unknown');
  expect(r).toBeSmooth();
  expect(test.info().annotations.map((a) => a.type)).toEqual(
    expect.arrayContaining(['smoothness-skipped', 'smoothness-not-compared']),
  );
});

test('a label used twice in one test throws', async ({ page, butter }) => {
  await page.goto('/click.html?ms=0');
  await butter.measure('click', () => page.click('#heavy'), { runs: 1, cpuThrottling: 1 });
  await expect(butter.measure('click', () => page.click('#heavy'))).rejects.toThrow(
    'the label "click" is already used in this test',
  );
});

test('toBeSmooth() needs a result, and has no .not', () => {
  expect(() => expect({} as SmoothnessResult).toBeSmooth()).toThrow(/expects a result from butter/);
  expect(() => expect({} as SmoothnessResult).not.toBeSmooth()).toThrow(
    /not\.toBeSmooth\(\) is not supported/,
  );
});

const preexposed = withButter(
  base.extend<{ context: BrowserContext }>({
    context: async ({ context }, use) => {
      await context.exposeBinding('__playwrightSmoothnessStream', () => undefined);
      await use(context);
    },
  }),
  { auto: true, record: false, historyDir: history },
);

preexposed("automatic mode that can't start says so", async ({ page }) => {
  expect(test.info().annotations).toContainEqual({
    type: 'smoothness-warning',
    description: expect.stringContaining("automatic mode couldn't start"),
  });
  await page.goto('/click.html?ms=0');
});

const autoWithoutBrowser = withButter(
  base.extend<{ context: BrowserContext }>({
    context: async ({ context }, use) => {
      context.browser = () => null;
      await use(context);
    },
  }),
  { auto: true, record: false, historyDir: history },
);

autoWithoutBrowser('automatic mode skips a context with no Browser', async ({ page }) => {
  expect(test.info().annotations).toContainEqual({
    type: 'smoothness-skipped',
    description: 'automatic mode measures Chromium only; this is unknown',
  });
  await page.goto('/click.html?ms=0');
});

const auto = withButter(base, { auto: true, record: false, historyDir: history });
const BROKEN = 'a page that breaks the collector, with a missing source map';

auto(BROKEN, async ({ page }) => {
  await page.route('**/broken-bundle.html', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><button id="go">Go</button><script src="/broken-bundle.js"></script>',
    }),
  );
  await page.route('**/broken-bundle.js', (r) =>
    r.fulfill({
      contentType: 'text/javascript',
      body: [
        'document.getElementById("go").addEventListener("click", function busy() {',
        '  const end = performance.now() + 120;',
        '  while (performance.now() < end) {}',
        '});',
        '//# sourceMappingURL=broken-bundle.js.map',
      ].join('\n'),
    }),
  );
  await page.addInitScript(() => {
    Element.prototype.closest = () => {
      throw new Error('blocked');
    };
  });
  await page.goto('/broken-bundle.html');
  await page.click('#go');
  await page.waitForTimeout(300);
});

test('automatic mode reported the collector errors and the missing source map', () => {
  const [r] = resultsLabelled(BROKEN);
  expect(r!.unavailable).toContainEqual({
    measurement: 'collector',
    reason: expect.stringContaining('in-page collector errors: ancestor'),
  });
  expect(r!.notes.join(' ')).toContain("Source maps couldn't be used, so some names may be minified");
});

let newContext: unknown;
test.afterAll(({ browser }) => {
  if (newContext) browser.newContext = newContext as typeof browser.newContext;
});

test('a replay that has no page to render in', async ({ page, butter, browser }) => {
  await page.goto('/list.html?cost=15&overscan=0');
  await butter.scroll(page.locator('#list'), {
    label: 'replay without a page',
    distance: 2000,
    speed: 'fast',
    mode: 'full',
    runs: 1,
    cpuThrottling: 1,
    replay: 'on',
  });
  const original = browser.newContext;
  newContext = original;
  browser.newContext = async (...args: Parameters<typeof original>) => {
    const context = await original.apply(browser, args);
    context.newPage = async () => {
      throw new Error('blocked');
    };
    return context;
  };
});

test('says why there is no replay', ({ browser }) => {
  browser.newContext = newContext as typeof browser.newContext;
  newContext = undefined;
  const [r] = resultsLabelled('replay without a page');
  expect(r!.notes.join(' ')).toMatch(/No replay: .*blocked/);
});

test('the smoothness fixture still works under its old name', ({ smoothness, butter }) => {
  expect(smoothness).toBe(butter);
});

test.describe('smoothnessOptions under its old name', () => {
  test.use({ smoothnessOptions: { runs: 1, cpuThrottling: 1 } });

  test('still sets the options', async ({ page, butter }) => {
    await page.goto('/click.html?ms=0');
    const r = await butter.measure('click', () => page.click('#heavy'));
    expect(r.runs).toBe(1);
  });
});
