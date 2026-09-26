// docs/measurements.md, Long-list fling: Input.synthesizeScrollGesture produces a compositor fling;
// dropped frames barely move for a list that is mostly blank; has_missing_content fires
// even on a cheap list; trace screenshots are available for blank-frame analysis.
import { test, expect } from '@playwright/test';
import { save, traced, PAGE_SETTLE_MS } from './helpers.js';

const CATEGORIES = [
  'cc',
  'benchmark',
  'viz',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.screenshot',
];

const missingContentRate: Record<string, number> = {};

const SCENARIOS = [
  { name: 'cheap', cost: 0, overscan: 2 },
  { name: 'moderate', cost: 4, overscan: 2 },
  { name: 'costly', cost: 15, overscan: 0 },
];

for (const s of SCENARIOS) {
  test(`fast fling through a virtualized list, ${s.name} rows`, async ({ page, browser }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 600, height: 600 });
    await page.goto(`/list.html?cost=${s.cost}&overscan=${s.overscan}`);
    await page.waitForTimeout(PAGE_SETTLE_MS);
    const cdp = await page.context().newCDPSession(page);
    const scrollTopBefore = await page.evaluate(() => document.getElementById('list')!.scrollTop);
    const { events, bytes } = await traced(
      browser,
      page,
      async () => {
        await cdp.send('Input.synthesizeScrollGesture', {
          x: 300,
          y: 300,
          yDistance: -20000,
          speed: 6000,
          gestureSourceType: 'mouse',
          preventFling: false,
        });
        // Let the fling settle before the trace closes.
        await page.waitForTimeout(300);
      },
      { categories: CATEGORIES, screenshots: true },
    );
    const scrollTopAfter = await page.evaluate(() => document.getElementById('list')!.scrollTop);
    const reporters = events
      .filter((e) => e.name === 'PipelineReporter' && e.ph === 'b' && e.args?.frame_reporter)
      .map((e) => e.args!.frame_reporter);
    const count = (f: (x: Record<string, unknown>) => boolean) => reporters.filter(f).length;
    const screenshots = events.filter((e) => e.name === 'Screenshot' && e.args?.snapshot).length;
    const out = {
      scenario: s,
      scrolledPx: scrollTopAfter - scrollTopBefore,
      frames: reporters.length,
      presented: count((x) => x.state === 'STATE_PRESENTED_ALL' || x.state === 'STATE_PRESENTED_PARTIAL'),
      dropped: count((x) => x.state === 'STATE_DROPPED'),
      hasMissingContent: count((x) => !!x.has_missing_content),
      checkerboardedNeedsRaster: count((x) => !!x.checkerboarded_needs_raster),
      scrollStates: [...new Set(reporters.map((x) => x.scroll_state))],
      screenshots,
      traceKB: Math.round(bytes / 1024),
    };
    save(`list-fling-${s.name}`, out);

    expect(out.scrolledPx, 'the gesture scrolled the list').toBeGreaterThan(5000);
    expect(out.scrollStates, 'scrolling ran on the compositor').toContain('SCROLL_COMPOSITOR_THREAD');
    expect(out.screenshots, 'trace screenshots for blank-frame analysis').toBeGreaterThanOrEqual(100);
    // Dropped frames stay a small share even for the costly list, which is why scroll() uses
    // screenshots.
    expect(out.dropped / out.frames).toBeLessThan(0.1);
    missingContentRate[s.name] = out.hasMissingContent / out.frames;
  });
}

test("has_missing_content can't tell a blank list from a drawn one", () => {
  // Chrome 141: fired on ~78% of frames for every list. Chrome 153: 0% for every list.
  // Either way it says nothing about blank rows, so the library must not use it.
  test.skip(Object.keys(missingContentRate).length !== SCENARIOS.length, 'needs every fling from this file');
  save('list-fling-missing-content', missingContentRate);
  expect(Math.abs(missingContentRate.cheap! - missingContentRate.costly!)).toBeLessThan(0.3);
});
