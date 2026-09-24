import { test } from '@playwright/test';
import * as fs from 'fs';
// Chrome's trace records an AnimationFrame event for every frame, with no 50ms cutoff.
for (const wait of [0, 5, 12, 25]) {
  test(`animation frame durations, ${wait}ms`, async ({ page, browser }) => {
    await page.goto(`/?wait=${wait}`);
    await page.waitForTimeout(500);
    await page.mouse.move(400, 400);
    await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'cc', 'benchmark'] });
    for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 150); await page.waitForTimeout(80); }
    const events: any[] = JSON.parse((await browser.stopTracing()).toString()).traceEvents;
    const af = events.filter((e) => e.name === 'AnimationFrame');
    const sample = af.slice(0, 3);
    // Pair async begin/end events by id to get each frame's duration.
    const open = new Map<string, number>(), durs: number[] = [];
    for (const e of af) {
      const id = e.id ?? e.id2?.local;
      if (e.ph === 'b') open.set(id, e.ts);
      else if (e.ph === 'e' && open.has(id)) { durs.push((e.ts - open.get(id)!) / 1000); open.delete(id); }
      else if (e.ph === 'X') durs.push(e.dur / 1000);
    }
    const over = (ms: number) => durs.filter((d) => d > ms).length;
    fs.writeFileSync(`results/${test.info().project.name}--aframe-${wait}.json`, JSON.stringify({
      wait, frames: durs.length, over8_3ms: over(8.33), over16_7ms: over(16.7), over50ms: over(50),
      longest: Math.round(Math.max(0, ...durs) * 10) / 10, phases: [...new Set(af.map((e) => e.ph))], cat: af[0]?.cat,
    }));
    if (wait === 12) fs.writeFileSync(`results/aframe-sample.json`, JSON.stringify(sample, null, 1));
  });
}
