// Where Playwright Test keeps a test's baselines and results, in the plain form smoothness-core takes.
import type { TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import {
  RECORD_ENV,
  forwardSlashes,
  recordingBaselines,
  slug,
  type BaselineTarget,
  type SmoothnessResult,
  type UpdateMode,
} from 'smoothness-core';

/** The test's title without its file: `filters opens quickly`. */
const titleOf = (testInfo: TestInfo) => slug(testInfo.titlePath.slice(1).join(' '), 80);

/**
 * `<spec>-snapshots/smoothness/<test title>/<label>-<mode>-…json`, through the project's snapshot
 * template (which adds the project name and platform by default). The test title keeps two tests
 * in one file that use the same label apart; renaming a test starts a new baseline.
 */
export function baselineTarget(testInfo: TestInfo): BaselineTarget {
  const record = recordingBaselines();
  return {
    path: (fileName) => testInfo.snapshotPath('smoothness', titleOf(testInfo), fileName),
    root: testInfo.project.snapshotDir,
    project: testInfo.project.name,
    update: record ? 'all' : (testInfo.config.updateSnapshots as UpdateMode),
    describeUpdate: (mode) => (record ? `${RECORD_ENV} is set` : `--update-snapshots=${mode}`),
    mirrorToBaselineDir: record,
  };
}

/**
 * `test-results/smoothness/<test title>-<id>[-retryN]`. The test id keeps two tests with the same
 * title apart; the retry suffix keeps a retry from overwriting the first attempt.
 */
export function resultDir(testInfo: TestInfo): string {
  const id = createHash('sha256').update(testInfo.testId).digest('hex').slice(0, 8);
  const retry = testInfo.retry ? `-retry${testInfo.retry}` : '';
  return join(testInfo.project.outputDir, 'smoothness', `${titleOf(testInfo)}-${id}${retry}`);
}

export function testOf(testInfo: TestInfo): NonNullable<SmoothnessResult['test']> {
  return {
    title: testInfo.titlePath.slice(1).join(' › ') || testInfo.title,
    file: forwardSlashes(relative(testInfo.config.rootDir, testInfo.file)),
    project: testInfo.project.name,
  };
}
