import {
  test as base,
  type Fixtures,
  type Locator,
  type Page,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type TestInfo,
} from '@playwright/test';
import { median } from './analysis/stats.js';
import { listMeasurement } from './list/measure.js';
import {
  defaultScrollLabel,
  performScroll,
  restoreScroll,
  scrollPosition,
  resolveScroll,
  END_CAP_PX,
  MAX_KEY_PRESSES,
  PX_PER_ARROW_KEY,
  type ScrollOptions,
} from './scroll.js';
import { basename } from 'node:path';
import { writeFileSync } from 'node:fs';
import { encodeReplay } from './replay/encode.js';
import { takeReplaySource } from './replay/source.js';
import { installCollector } from './collector/collector.js';
import { browserEnvironment } from './environment.js';
import { resolveOptions } from './options.js';
import { COLLECTOR_CONFIG, emptyResult, measure, type MeasureContext } from './runner.js';
import { warnInGitHubActions } from './ci.js';
import { resultPath, writeResult } from './output.js';
import type { SmoothnessOptions, SmoothnessResult } from './types.js';

export interface Smoothness {
  /**
   * Measures an interaction. `action` runs once as a warm-up and then `runs` more times,
   * with the page reset (reloaded, by default) and settled before each run. The label names
   * the baseline, so it must be unique within a test.
   */
  measure(label: string, action: () => Promise<void>, options?: SmoothnessOptions): Promise<SmoothnessResult>;
  /**
   * Scrolls a list (or the page) and measures it: long frames and input in quick mode, plus
   * dropped frames and blank rows from trace screenshots in full mode. Each run reloads the page,
   * so the list starts from the top.
   */
  scroll(target: Locator, options?: ScrollOptions & SmoothnessOptions): Promise<SmoothnessResult>;
}

/**
 * The option fixture on its own, for typing `playwright.config.ts`:
 * `defineConfig<SmoothnessTestOptions>({ use: { smoothnessOptions: { ... } } })`.
 */
export type SmoothnessTestOptions = Pick<SmoothnessFixtures, 'smoothnessOptions'>;

export interface SmoothnessFixtures {
  /** Options for every measurement in the test. Set with `test.use({ smoothnessOptions: {...} })`. */
  smoothnessOptions: SmoothnessOptions;
  smoothness: Smoothness;
}

/** Adds an annotation to the test once per type and description. */
function annotateOnce(testInfo: TestInfo, type: string, description: string): void {
  if (!testInfo.annotations.some((a) => a.type === type && a.description === description)) {
    testInfo.annotations.push({ type, description });
  }
}

function warn(testInfo: TestInfo, message: string): void {
  annotateOnce(testInfo, 'smoothness-warning', message);
  warnInGitHubActions(message, testInfo);
}

async function createSmoothness(
  page: Page,
  defaults: SmoothnessOptions,
  testInfo: TestInfo,
  outputs: Map<string, { path: string; result: SmoothnessResult }>,
): Promise<Smoothness> {
  const environment = await browserEnvironment(page.context().browser());
  if (environment.browserName === 'chromium' && environment.headlessMode === 'headless-shell') {
    warn(
      testInfo,
      "Running in Chromium's headless shell. Measurements are closer to real Chrome in new headless: set channel: 'chromium'.",
    );
  }
  const record = async (
    label: string,
    overrides: SmoothnessOptions | undefined,
    run: (ctx: MeasureContext) => Promise<SmoothnessResult>,
  ): Promise<SmoothnessResult> => {
    if (outputs.has(label)) {
      throw new Error(
        `smoothness: the label "${label}" is already used in this test. Labels name baselines, so each must be unique.`,
      );
    }
    const options = resolveOptions([defaults, overrides]);
    let result: SmoothnessResult;
    if (environment.browserName !== 'chromium') {
      const reason = `smoothness is measured in Chromium only; this is ${environment.browserName}`;
      annotateOnce(testInfo, 'smoothness-skipped', `${label}: ${reason}`);
      result = emptyResult({ label, options, environment }, reason);
    } else {
      result = await run({ page, label, options, environment });
    }
    const path = resultPath(testInfo, label);
    writeResult(result, path);
    outputs.set(label, { path, result });
    return result;
  };

  return {
    measure(label, action, overrides) {
      return record(label, overrides, (ctx) => measure(ctx, action));
    },

    async scroll(target, all = {}) {
      const { distance, direction, input, speed, label: givenLabel, ...overrides } = all;
      const s = resolveScroll({ distance, direction, input, speed });
      const label = givenLabel ?? defaultScrollLabel(target, s);
      const done: Awaited<ReturnType<typeof performScroll>>[] = [];
      return record(label, overrides, async (ctx) => {
        if (s.input === 'touch' && (await page.evaluate(() => navigator.maxTouchPoints)) === 0) {
          // Touch events on a page that reports no touch support aren't what a phone does:
          // pages branch on touch support (pointer: coarse, touch handlers).
          throw new Error(
            "smoothness.scroll(): input: 'touch' needs a touch-enabled browser context. Use test.use({ hasTouch: true }) or a mobile device, such as devices['Pixel 7'].",
          );
        }
        const cdp = await page.context().newCDPSession(page);
        const browser = page.context().browser();
        try {
          let origin: number | null = null;
          const result = await measure(
            {
              ...ctx,
              ...(browser
                ? { list: listMeasurement(page, browser, target, s.direction, ctx.options.list) }
                : {}),
              // Chrome restores a document's scroll position on reload, so without this each run
              // would start where the last one stopped. With reset: 'none', runs carry on instead.
              beforeRun: async (run) => {
                if (run === 0) origin = await scrollPosition(target, s);
                else if (ctx.options.reset !== 'none' && origin !== null)
                  await restoreScroll(target, s, origin);
              },
            },
            async () => {
              done.push(await performScroll(page, cdp, target, s));
            },
          );
          const measured = done.slice(1); // the first scroll is the warm-up
          if (measured.length && measured.every((d) => d.requested > 0 && d.scrolled === 0)) {
            // Nothing moved: blank-frame numbers would describe a still list, so they're withheld.
            const reason = `the scroll gesture didn't move the list in any run (asked for ${measured[0]!.requested}px)`;
            if ('list' in result) result.list = null;
            result.unavailable.push({ measurement: 'list', reason });
            result.notes.push(`Nothing scrolled: ${reason}. Is the locator the element that scrolls?`);
          }
          if (measured.length) {
            result.scroll = {
              input: s.input,
              direction: s.direction,
              speedPxPerSec: s.input === 'keys' ? null : s.speedPxPerSec,
              requestedPx: Math.round(median(measured.map((d) => d.requested))),
              scrolledPx: Math.round(median(measured.map((d) => d.scrolled))),
              ...(s.input === 'keys'
                ? { keyPresses: Math.round(median(measured.map((d) => d.presses ?? 0))) }
                : {}),
            };
            if (measured.every((d) => d.requested === 0)) {
              result.notes.push(
                "The list was already at its end, so nothing scrolled. With reset: 'none', later runs start where the last one stopped.",
              );
            }
            const toEnd = measured.find((d) => d.toEnd !== undefined)?.toEnd;
            if (toEnd !== undefined) {
              result.notes.push(
                `distance: 'end' stopped at ${END_CAP_PX.toLocaleString('en-US')}px; the end of the list was ${toEnd.toLocaleString('en-US')}px away. Pass a number of pixels to scroll further.`,
              );
            }
            if (
              s.input === 'keys' &&
              measured.some((d) => d.requested > MAX_KEY_PRESSES * PX_PER_ARROW_KEY)
            ) {
              result.notes.push(
                `Arrow keys were pressed at most ${MAX_KEY_PRESSES} times per run, which didn't reach the requested distance.`,
              );
            }
          }
          return result;
        } finally {
          await cdp.detach().catch(() => undefined);
        }
      });
    },
  };
}

/**
 * Encodes and attaches a scroll() replay when the result asks for one: always with
 * `replay: 'on'`, and when a check got worse with `'on-regression'` (the default).
 */
async function attachReplay(
  page: Page,
  testInfo: TestInfo,
  label: string,
  path: string,
  result: SmoothnessResult,
) {
  const source = takeReplaySource(result);
  const browser = page.context().browser();
  if (!source || !browser) return;
  const status = result.comparison?.status;
  const wanted =
    result.settings.replay === 'on' ||
    (result.settings.replay === 'on-regression' && (status === 'warn' || status === 'fail'));
  if (!wanted) return;
  const video = await encodeReplay(browser, source);
  if ('unavailable' in video) {
    result.notes.push(`No replay: ${video.unavailable}.`);
  } else {
    const file = path.replace(/\.json$/, '.replay.webm');
    writeFileSync(file, video);
    result.replay = basename(file);
    await testInfo.attach(`smoothness replay: ${label}`, { path: file, contentType: 'video/webm' });
  }
  writeResult(result, path);
}

/** The fixture definitions, shared by `test` and `withSmoothness()`. */
export const smoothnessFixtures: Fixtures<
  SmoothnessFixtures,
  object,
  PlaywrightTestArgs & PlaywrightTestOptions
> = {
  smoothnessOptions: [{}, { option: true }],
  smoothness: async ({ page, smoothnessOptions }, use, testInfo) => {
    if (page.context().browser()?.browserType().name() === 'chromium') {
      await page.addInitScript(installCollector, COLLECTOR_CONFIG);
    }
    const outputs = new Map<string, { path: string; result: SmoothnessResult }>();
    await use(await createSmoothness(page, smoothnessOptions, testInfo, outputs));
    // Attached after the test body, so each file includes toBeSmooth()'s comparison.
    for (const [label, { path, result }] of outputs) {
      await attachReplay(page, testInfo, label, path, result);
      await testInfo.attach(`smoothness: ${label}`, { path, contentType: 'application/json' });
    }
  },
};

export const test = base.extend<SmoothnessFixtures>(smoothnessFixtures);
