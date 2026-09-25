// TEMPORARY: what does a frame look like on the runner when the background timer is blamed?
import { test } from '@playwright/test';
import { COLLECTOR_KEY, installCollector, type CollectorApi } from '../../src/collector/collector.js';
import { COLLECTOR_CONFIG } from '../../src/runner.js';
import { groupInteractions } from '../../src/analysis/interactions.js';
import { classifyFrames } from '../../src/analysis/classify.js';
import { summarizeLongFrames, attributeFrames } from '../../src/analysis/aggregate.js';

test('race probe', async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript(installCollector, COLLECTOR_CONFIG);
  const cdp = await page.context().newCDPSession(page);
  for (let run = 0; run < 12; run++) {
    await page.goto('/mixed.html?bgevery=250');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.waitForTimeout(700);
    const start = await page.evaluate((k) => (window as unknown as Record<string, CollectorApi>)[k]!.now(), COLLECTOR_KEY);
    await page.click('#buy .label');
    const snap = await page.evaluate(async ([k, s]) => {
      const api = (window as unknown as Record<string, CollectorApi>)[k as string]!;
      await api.flush();
      return api.snapshot(s as number, api.now());
    }, [COLLECTOR_KEY, start] as const);
    const interactions = groupInteractions(snap.events, snap.loaf);
    const classes = classifyFrames({ loaf: snap.loaf, interactions, scrolls: snap.scrolls, loadEventEnd: snap.loadEventEnd });
    const frames = attributeFrames(snap.loaf.filter((_, i) => classes[i] === 'interaction'), interactions, snap.scrolls);
    const blamed = summarizeLongFrames(frames).topScripts.map((s) => s.fn);
    if (blamed.includes('repeatingBackgroundJob')) {
      console.log('RACE', JSON.stringify({
        run,
        interactions: interactions.map((i) => ({ start: Math.round(i.start), dur: i.duration })),
        frames: snap.loaf.map((f, i) => ({
          cls: classes[i],
          start: Math.round(f.start),
          dur: Math.round(f.duration),
          firstUI: Math.round(f.firstUIEventTimestamp),
          scripts: f.scripts.map((s) => `${s.invokerType}:${s.sourceFunctionName}@${Math.round(s.start)}+${Math.round(s.duration)}`),
        })),
      }));
    }
  }
  console.log('RACE PROBE DONE');
});
