import { test } from '@playwright/test';
import * as fs from 'fs';

const CATEGORIES = [
  'devtools.timeline', 'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame', 'benchmark', 'cc', 'viz', 'gpu',
];

for (const wait of [0, 12, 25, 40, 70]) {
  test(`trace, scroll handler blocks ${wait}ms`, async ({ page, browser }) => {
    await page.goto(`/?wait=${wait}`);
    await page.waitForTimeout(500);
    await page.mouse.move(400, 400);
    await browser.startTracing(page, { categories: CATEGORIES });
    for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 150); await page.waitForTimeout(80); }
    await page.waitForTimeout(200);
    const buf = await browser.stopTracing();
    const events: any[] = JSON.parse(buf.toString()).traceEvents;
    const counts: Record<string, number> = {};
    for (const e of events) counts[e.name] = (counts[e.name] || 0) + 1;
    const states: Record<string, number> = {};
    for (const e of events.filter((e) => e.name === 'PipelineReporter' && e.ph === 'b')) {
      const fr = e.args?.frame_reporter ?? {};
      const s = (fr.state ?? 'unknown') + (fr.affects_smoothness ? ' (affects smoothness)' : '');
      states[s] = (states[s] || 0) + 1;
    }
    const pick = ['BeginFrame', 'DrawFrame', 'DroppedFrame', 'Commit', 'PipelineReporter', 'AnimationFrame',
      'Screenshot', 'NeedsBeginFrameChanged', 'ActivateLayerTree'];
    fs.writeFileSync(`results/${test.info().project.name}--trace-${wait}.json`, JSON.stringify({
      wait, totalEvents: events.length, sizeKB: Math.round(buf.length / 1024),
      counts: Object.fromEntries(pick.map((k) => [k, counts[k] || 0])), pipelineStates: states,
    }));
    if (wait === 25) fs.writeFileSync(`results/${test.info().project.name}--trace-25-names.json`,
      JSON.stringify(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 60)));
  });
}
