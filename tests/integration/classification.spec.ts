// Load, interaction and background frames classified correctly on the mixed
// page in at least 19 of 20 runs, using the library's collector and classifier.
// With RECORD_FIXTURES=1, the first run is saved as a unit-test fixture.
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import {
  COLLECTOR_KEY,
  installCollector,
  type CollectorApi,
  type CollectorSnapshot,
  type LoafRecord,
} from '../../src/collector/collector.js';
import { COLLECTOR_CONFIG } from '../../src/runner.js';
import { groupInteractions } from '../../src/analysis/interactions.js';
import { classifyFrames, type FrameClass } from '../../src/analysis/classify.js';

const RUNS = 20;
const REQUIRED = 19;

/** Ground truth from the test page's function names. */
function truth(f: LoafRecord): FrameClass | 'unknown' {
  const s = f.scripts.map((x) => `${x.sourceFunctionName} ${x.sourceURL}`).join(' ');
  if (/onBuy|onSearchKey|onVanish|onFeedScroll/.test(s)) return 'interaction';
  if (/loadTimeWork|mixed-load\.js/.test(s)) return 'load';
  if (/backgroundJob/.test(s)) return 'background';
  return 'unknown';
}

test(`classification is correct in at least ${REQUIRED} of ${RUNS} runs`, async ({ browser }) => {
  test.setTimeout(240_000);
  const outcomes: {
    run: number;
    correct: boolean;
    frames: { guess: FrameClass; truth: string; ms: number }[];
  }[] = [];
  for (let run = 0; run < RUNS; run++) {
    const page = await browser.newPage();
    await page.addInitScript(installCollector, COLLECTOR_CONFIG);
    await page.goto('/mixed.html');
    await page.waitForTimeout(1200); // past load work and the background job
    await page.click('#buy .label');
    await page.waitForTimeout(300);
    await page.click('#search');
    await page.keyboard.type('abc', { delay: 120 });
    await page.waitForTimeout(300);
    await page.click('#vanish');
    await page.waitForTimeout(300);
    await page.hover('#feed');
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 200);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(500);
    const snapshot: CollectorSnapshot = await page.evaluate(async (key) => {
      const api = (window as unknown as Record<string, CollectorApi>)[key]!;
      await api.flush();
      return api.snapshot(0, api.now());
    }, COLLECTOR_KEY);
    await page.close();

    if (run === 0 && process.env.RECORD_FIXTURES) {
      writeFileSync('tests/fixtures/classification/mixed-run.json', JSON.stringify(snapshot, null, 1));
    }
    const interactions = groupInteractions(snapshot.events, snapshot.loaf);
    const classes = classifyFrames({
      loaf: snapshot.loaf,
      interactions,
      scrolls: snapshot.scrolls,
      loadEventEnd: snapshot.loadEventEnd,
    });
    const frames = snapshot.loaf.map((f, i) => ({
      guess: classes[i]!,
      truth: truth(f),
      ms: Math.round(f.duration),
    }));
    const hasAll = ['load', 'background', 'interaction'].every((k) => frames.some((f) => f.truth === k));
    outcomes.push({ run, correct: hasAll && frames.every((f) => f.guess === f.truth), frames });
  }
  await test
    .info()
    .attach('outcomes', { body: JSON.stringify(outcomes, null, 1), contentType: 'application/json' });
  const correct = outcomes.filter((o) => o.correct).length;
  expect(
    correct,
    JSON.stringify(
      outcomes.filter((o) => !o.correct),
      null,
      1,
    ),
  ).toBeGreaterThanOrEqual(REQUIRED);
});
