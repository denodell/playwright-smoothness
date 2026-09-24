import { test, chromium } from '@playwright/test';
import * as fs from 'fs';

// Can headless Chrome be made to produce frames faster than 60 per second?
const variants: Record<string, string[]> = {
  default: [],
  'disable-frame-rate-limit': ['--disable-frame-rate-limit'],
  'disable-gpu-vsync': ['--disable-gpu-vsync'],
  'both': ['--disable-frame-rate-limit', '--disable-gpu-vsync'],
};

for (const [name, args] of Object.entries(variants)) {
  test(`frame cadence with ${name}`, async ({}, testInfo) => {
    const headless = testInfo.project.name !== 'headed';
    const channel = testInfo.project.name === 'headless-shell' ? undefined : 'chromium';
    const browser = await chromium.launch({ headless, channel, args });
    const page = await browser.newPage();
    await page.goto('http://localhost:4173/');
    await page.waitForTimeout(300);
    await page.evaluate(() => { (window as any).__useNow = true; (window as any).startFrameSampler(); });
    await page.waitForTimeout(1000);
    const gaps: number[] = await page.evaluate(() => (window as any).stopFrameSampler());
    const s = [...gaps].sort((a, b) => a - b);
    const out = { variant: name, framesPerSecond: gaps.length, medianGapMs: Math.round(s[Math.floor(s.length / 2)] * 100) / 100 };
    fs.writeFileSync(`results/${testInfo.project.name}--refresh-${name}.json`, JSON.stringify(out));
    await browser.close();
  });
}
