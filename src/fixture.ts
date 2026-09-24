import { test as base, type Page, type TestInfo } from '@playwright/test';
import { installCollector } from './collector/collector.js';
import { browserEnvironment } from './environment.js';
import { resolveOptions } from './options.js';
import { COLLECTOR_CONFIG, emptyResult, measure } from './runner.js';
import { githubWarning, inGitHubActions } from './ci.js';
import type { SmoothnessOptions, SmoothnessResult } from './types.js';

export interface Smoothness {
  /**
   * Measures an interaction. `action` runs once as a warm-up and then `runs` more times,
   * with the page reset (reloaded, by default) and settled before each run.
   */
  measure(label: string, action: () => Promise<void>, options?: SmoothnessOptions): Promise<SmoothnessResult>;
}

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
  if (inGitHubActions()) console.log(githubWarning(message, { file: testInfo.file, line: testInfo.line }));
}

async function createSmoothness(
  page: Page,
  defaults: SmoothnessOptions,
  testInfo: TestInfo,
): Promise<Smoothness> {
  const environment = await browserEnvironment(page.context().browser());
  if (environment.browserName === 'chromium' && environment.headlessMode === 'headless-shell') {
    warn(
      testInfo,
      "Running in Chromium's headless shell. Measurements are closer to real Chrome in new headless: set channel: 'chromium'.",
    );
  }
  return {
    async measure(label, action, overrides) {
      const options = resolveOptions([defaults, overrides]);
      if (environment.browserName !== 'chromium') {
        const reason = `smoothness is measured in Chromium only; this is ${environment.browserName}`;
        annotateOnce(testInfo, 'smoothness-skipped', `${label}: ${reason}`);
        return emptyResult({ label, options, environment }, reason);
      }
      return measure({ page, label, options, environment }, action);
    },
  };
}

export const test = base.extend<SmoothnessFixtures>({
  smoothnessOptions: [{}, { option: true }],
  smoothness: async ({ page, smoothnessOptions }, use, testInfo) => {
    if (page.context().browser()?.browserType().name() === 'chromium') {
      await page.addInitScript(installCollector, COLLECTOR_CONFIG);
    }
    await use(await createSmoothness(page, smoothnessOptions, testInfo));
  },
});
