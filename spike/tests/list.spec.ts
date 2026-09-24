import { test } from '@playwright/test';
import * as fs from 'fs';

const CATEGORIES = ['cc', 'benchmark', 'viz', 'devtools.timeline',
  'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-devtools.screenshot'];

for (const s of [
  { name: 'cheap-rows', cost: 0, overscan: 2 },
  { name: 'costly-rows', cost: 4, overscan: 2 },
  { name: 'very-costly-rows', cost: 15, overscan: 0 },
]) {
  test(`fast fling through a virtualized list, ${s.name}`, async ({ page, browser }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 600, height: 600 });
    await page.goto(`/list.html?cost=${s.cost}&overscan=${s.overscan}`);
    await page.waitForTimeout(500);
    const cdp = await page.context().newCDPSession(page);
    await browser.startTracing(page, { categories: CATEGORIES, screenshots: true });
    // A real scroll gesture: 20,000px down at 6,000px per second.
    await cdp.send('Input.synthesizeScrollGesture', {
      x: 300, y: 300, yDistance: -20000, speed: 6000, gestureSourceType: 'mouse', preventFling: false,
    } as any);
    await page.waitForTimeout(300);
    const buf = await browser.stopTracing();
    const events: any[] = JSON.parse(buf.toString()).traceEvents;

    const reporters = events.filter((e) => e.name === 'PipelineReporter' && e.ph === 'b' && e.args?.frame_reporter);
    const fr = reporters.map((e) => e.args.frame_reporter);
    const count = (f: (x: any) => boolean) => fr.filter(f).length;
    const shots = events.filter((e) => e.name === 'Screenshot').map((e) => e.args?.snapshot).filter(Boolean);
    fs.mkdirSync(`results/shots-${test.info().project.name}-${s.name}`, { recursive: true });
    shots.forEach((b64: string, i: number) =>
      fs.writeFileSync(`results/shots-${test.info().project.name}-${s.name}/${String(i).padStart(3, '0')}.jpg`, Buffer.from(b64, 'base64')));
    fs.writeFileSync(`results/${test.info().project.name}--list-${s.name}.json`, JSON.stringify({
      scenario: s, frames: fr.length,
      presented: count((x) => x.state === 'STATE_PRESENTED_ALL' || x.state === 'STATE_PRESENTED_PARTIAL'),
      dropped: count((x) => x.state === 'STATE_DROPPED'),
      missingContent: count((x) => x.has_missing_content),
      checkerboardRaster: count((x) => x.checkerboarded_needs_raster),
      checkerboardRecord: count((x) => x.checkerboarded_needs_record),
      scrollStates: [...new Set(fr.map((x) => x.scroll_state))],
      screenshots: shots.length,
    }, null, 1));
  });
}
