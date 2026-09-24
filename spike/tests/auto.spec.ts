import { test } from '@playwright/test';
import * as fs from 'fs';

// What an automatic fixture would inject into every page.
const observe = () => {
  const w = window as any;
  w.__events = []; w.__loaf = []; w.__scrolls = [];
  const describe = (n: any) => !n || !n.tagName ? null :
    n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).join('.') : '');
  new PerformanceObserver((l) => {
    for (const e of l.getEntries() as any[]) w.__events.push({
      name: e.name, interactionId: e.interactionId, start: e.startTime, duration: e.duration, target: describe(e.target) });
  }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as any);
  new PerformanceObserver((l) => {
    for (const e of l.getEntries() as any[]) w.__loaf.push({
      start: e.startTime, duration: e.duration, firstUI: e.firstUIEventTimestamp,
      scripts: e.scripts.map((s: any) => ({ invokerType: s.invokerType, invoker: s.invoker, fn: s.sourceFunctionName, src: (s.sourceURL || '').split('/').pop() })) });
  }).observe({ type: 'long-animation-frame', buffered: true });
  addEventListener('scroll', () => w.__scrolls.push(performance.now()), { capture: true, passive: true });
};

test('automatic interaction detection and load separation', async ({ page }) => {
  await page.addInitScript(observe);
  await page.goto('/auto.html');
  await page.waitForTimeout(1200);                  // let load and the background job finish
  await page.click('#buy .label');                  // click lands on the nested span
  await page.waitForTimeout(300);
  await page.click('#search'); await page.keyboard.type('abc', { delay: 120 });
  await page.waitForTimeout(300);
  await page.click('#vanish');                      // element removes itself
  await page.waitForTimeout(300);
  await page.hover('#feed');
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 200); await page.waitForTimeout(150); }
  await page.waitForTimeout(500);

  const data = await page.evaluate(() => {
    const nav: any = performance.getEntriesByType('navigation')[0];
    return { loadEnd: nav.loadEventEnd, events: (window as any).__events, loaf: (window as any).__loaf, scrolls: (window as any).__scrolls };
  });

  // Interactions, grouped automatically by interactionId, with the element that was used.
  const interactions = new Map<number, any>();
  for (const e of data.events.filter((e: any) => e.interactionId > 0)) {
    const cur = interactions.get(e.interactionId);
    if (!cur || e.duration > cur.duration) interactions.set(e.interactionId, e);
  }

  // Classify each long frame without any labels from the test.
  const windows = [...interactions.values()].map((e: any) => [e.start, e.start + e.duration]);
  const classify = (f: any) => {
    if (f.firstUI > 0) return 'interaction';
    if (windows.some(([a, b]) => f.start < b && f.start + f.duration > a)) return 'interaction';
    if (data.scrolls.some((t: number) => t >= f.start - 5 && t <= f.start + f.duration)) return 'interaction';
    if (f.start < data.loadEnd + 50) return 'load';
    return 'background';
  };
  const truth = (f: any) => {
    const s = f.scripts.map((x: any) => x.fn + ' ' + x.src).join(' ');
    if (/onBuy|onSearchKey|onVanish|onFeedScroll/.test(s)) return 'interaction';
    if (/load-work\.js/.test(s)) return 'load';
    if (/backgroundJob/.test(s)) return 'background';
    return 'unknown';
  };
  const frames = data.loaf.map((f: any) => ({ duration: Math.round(f.duration), firstUI: f.firstUI > 0,
    scripts: f.scripts.map((s: any) => `${s.invokerType}: ${s.invoker} (${s.fn || s.src})`), guess: classify(f), truth: truth(f) }));

  fs.writeFileSync(`results/${test.info().project.name}--auto.json`, JSON.stringify({
    rawEvents: data.events.map((e: any) => `${e.name}:${e.interactionId}:${Math.round(e.duration)}:${e.target}`),
    interactions: [...interactions.values()].map((e: any) => ({ event: e.name, target: e.target, ms: e.duration })),
    frames, correct: frames.filter((f: any) => f.guess === f.truth).length, total: frames.length,
  }, null, 1));
});
