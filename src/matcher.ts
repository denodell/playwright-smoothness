import { expect as baseExpect, test } from '@playwright/test';
import type { SmoothnessResult } from './types.js';
import { CALIBRATE_ENV, SCHEMA_VERSION } from './constants.js';
import { evaluate, type MatcherOptions } from './baseline/evaluate.js';
import { formatMessage, formatSummary } from './baseline/message.js';
import { resultPath, writeResult, writtenPath } from './output.js';
import { warnInGitHubActions } from './ci.js';

function isResult(v: unknown): v is SmoothnessResult {
  return (
    !!v && typeof v === 'object' && (v as SmoothnessResult).schemaVersion === SCHEMA_VERSION && 'label' in v
  );
}

export const expect = baseExpect.extend({
  /**
   * Compares a result from `smoothness.measure()` or `smoothness.scroll()` with its stored baseline. With
   * `enforce: 'fail'` a regression fails the test; with `'warn'` (the default) it adds an
   * annotation and, in GitHub Actions, a `::warning` on the pull request.
   */
  toBeSmooth(received: SmoothnessResult, options?: MatcherOptions) {
    if (this.isNot) {
      throw new Error('expect(result).not.toBeSmooth() is not supported. Use toBeSmooth() with a baseline.');
    }
    if (!isResult(received)) {
      return {
        pass: false,
        name: 'toBeSmooth',
        message: () =>
          `toBeSmooth() expects a result from smoothness.measure() or scroll() (schemaVersion ${SCHEMA_VERSION}).`,
      };
    }
    const testInfo = test.info();
    const comparison = process.env[CALIBRATE_ENV]
      ? {
          status: 'not-compared' as const,
          checks: [],
          baseline: null,
          notes: ['Calibrating: not compared, and no baseline written.'],
        }
      : evaluate(received, testInfo, options);
    received.comparison = comparison;
    writeResult(received, writtenPath(received) ?? resultPath(testInfo, received.label));

    const message = formatMessage(received, comparison);
    const summary = formatSummary(received, comparison);
    const annotate = (type: string, description: string) => testInfo.annotations.push({ type, description });

    switch (comparison.status) {
      case 'fail':
        return { pass: false, name: 'toBeSmooth', message: () => message };
      case 'warn':
        annotate('smoothness-warning', summary);
        console.warn(message);
        warnInGitHubActions(summary, testInfo);
        break;
      case 'baseline-created':
        annotate(
          'smoothness-baseline-created',
          `"${received.label}": ${comparison.notes.at(-1) ?? 'baseline recorded'}`,
        );
        break;
      case 'baseline-updated':
        annotate(
          'smoothness-baseline-updated',
          `"${received.label}": baseline replaced (--update-snapshots)`,
        );
        break;
      case 'not-compared':
        if (process.env[CALIBRATE_ENV]) break;
        annotate('smoothness-not-compared', `"${received.label}": ${comparison.notes.join(' ')}`);
        break;
      case 'pass':
        break;
    }
    return { pass: true, name: 'toBeSmooth', message: () => message };
  },
});
