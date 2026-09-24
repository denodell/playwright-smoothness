import { test as base, type Page, type TestInfo } from '@playwright/test';
import { relative } from 'node:path';
import { installCollector } from './collector/collector.js';
import { browserEnvironment } from './environment.js';
import { resolveOptions } from './options.js';
import { COLLECTOR_CONFIG, emptyResult, measure } from './runner.js';
import { githubWarning, inGitHubActions } from './ci.js';
import { resultPath, writeResult } from './output.js';
import type { SmoothnessOptions, SmoothnessResult } from './types.js';

export interface Smoothness {
  /**
   * Measures an interaction. `action` runs once as a warm-up and then `runs` more times,
   * with the page reset (reloaded, by default) and settled before each run. The label names
   * the baseline, so it must be unique within a test.
   */
  measure(label: string, action: () => Promise<void>, options?: SmoothnessOptions): Promise<SmoothnessResult>;
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
  if (inGitHubActions()) {
    console.log(
      githubWarning(message, { file: relative(process.cwd(), testInfo.file), line: testInfo.line }),
    );
  }
}

async function createSmoothness(
  page: Page,
  defaults: SmoothnessOptions,
  testInfo: TestInfo,
  outputs: Map<string, string>,
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
      if (outputs.has(label)) {
        throw new Error(
          `smoothness.measure(): the label "${label}" is already used in this test. Labels name baselines, so each must be unique.`,
        );
      }
      const options = resolveOptions([defaults, overrides]);
      let result: SmoothnessResult;
      if (environment.browserName !== 'chromium') {
        const reason = `smoothness is measured in Chromium only; this is ${environment.browserName}`;
        annotateOnce(testInfo, 'smoothness-skipped', `${label}: ${reason}`);
        result = emptyResult({ label, options, environment }, reason);
      } else {
        result = await measure({ page, label, options, environment }, action);
      }
      const path = resultPath(testInfo, label);
      writeResult(result, path);
      outputs.set(label, path);
      return result;
    },
  };
}

export const test = base.extend<SmoothnessFixtures>({
  smoothnessOptions: [{}, { option: true }],
  smoothness: async ({ page, smoothnessOptions }, use, testInfo) => {
    if (page.context().browser()?.browserType().name() === 'chromium') {
      await page.addInitScript(installCollector, COLLECTOR_CONFIG);
    }
    const outputs = new Map<string, string>();
    await use(await createSmoothness(page, smoothnessOptions, testInfo, outputs));
    // Attached after the test body, so each file includes toBeSmooth()'s comparison.
    for (const [label, path] of outputs) {
      await testInfo.attach(`smoothness: ${label}`, { path, contentType: 'application/json' });
    }
  },
});
